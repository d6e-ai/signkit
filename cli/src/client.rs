use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION};
use serde::de::DeserializeOwned;
use std::time::Duration;

use crate::config::{ResolvedConfig, SIGNKIT_ORGANIZATION_HEADER};
use crate::error::CliError;
use crate::types::ProblemDetail;

/// Maximum response body limit: 10 MiB.
pub const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

/// Safe HTTP client for SignKit API interactions.
pub struct SignKitClient {
    http: reqwest::Client,
    config: ResolvedConfig,
}

impl SignKitClient {
    pub fn new(config: ResolvedConfig) -> Result<Self, CliError> {
        let user_agent = format!("signkit-cli/{}", env!("CARGO_PKG_VERSION"));

        // Enforce Policy::none() to strictly prevent any HTTP redirect from
        // accidentally transmitting sensitive Authorization headers to another
        // host or insecure endpoint.
        let http = reqwest::Client::builder()
            .user_agent(user_agent)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(config.timeout_secs))
            .build()
            .map_err(|e| CliError::Network(format!("Failed to build HTTP client: {e}")))?;

        Ok(Self { http, config })
    }

    pub fn config(&self) -> &ResolvedConfig {
        &self.config
    }

    /// Performs a safe, bounded GET request to the specified API path.
    ///
    /// URLs are constructed via `Url::join`. If `authenticated` is true,
    /// explicit organization selection and API key are verified before
    /// dispatching the request.
    pub async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
        authenticated: bool,
    ) -> Result<T, CliError> {
        let relative = path.trim_start_matches('/');
        let url = self
            .config
            .base_url
            .join(relative)
            .map_err(|e| CliError::usage(format!("Failed to construct request URL: {e}")))?;

        let mut headers = HeaderMap::new();
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/json, application/problem+json"),
        );

        if authenticated {
            let org_id = self.config.require_organization()?;
            let api_key = self.config.require_api_key()?;

            let org_header_name = HeaderName::from_static(SIGNKIT_ORGANIZATION_HEADER);
            let org_header_val = HeaderValue::from_str(org_id).map_err(|_| {
                CliError::usage("Organization ID contains invalid characters for HTTP header")
            })?;
            headers.insert(org_header_name, org_header_val);

            let auth_str = format!("Bearer {api_key}");
            let mut auth_val = HeaderValue::from_str(&auth_str).map_err(|_| {
                CliError::usage("API key contains invalid characters for HTTP header")
            })?;
            // Mark header value as sensitive to prevent leakage in debug formatters
            auth_val.set_sensitive(true);
            headers.insert(AUTHORIZATION, auth_val);
        }

        let mut request_builder = self.http.get(url).headers(headers);
        if !query.is_empty() {
            request_builder = request_builder.query(query);
        }

        let response = request_builder.send().await.map_err(|err| {
            if err.is_timeout() {
                CliError::Timeout(format!(
                    "Request to {path} timed out after {}s",
                    self.config.timeout_secs
                ))
            } else if err.is_redirect() {
                CliError::RedirectRefused(format!("Redirect requested for {path}"))
            } else {
                CliError::Network(format!("Request failed: {err}"))
            }
        })?;

        let status = response.status();

        // Check for redirects that the client did not follow
        if status.is_redirection() {
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("unknown")
                .to_string();
            return Err(CliError::RedirectRefused(location));
        }

        // Bounded response body reading
        let bytes = Self::read_bounded_body(response, MAX_RESPONSE_BYTES).await?;

        if status.is_success() {
            let data: T = serde_json::from_slice(&bytes).map_err(CliError::Json)?;
            Ok(data)
        } else {
            // Attempt to parse RFC 9457 problem detail; preserves partial problem documents
            // and any existing server `type` and extension fields intact.
            if let Ok(mut problem) = serde_json::from_slice::<ProblemDetail>(&bytes) {
                if problem.status == 0 {
                    problem.status = status.as_u16();
                }
                if problem.title.is_empty() {
                    problem.title = status
                        .canonical_reason()
                        .unwrap_or("HTTP Error")
                        .to_string();
                }
                if problem.instance.is_empty() {
                    problem.instance = path.to_string();
                }
                return Err(CliError::server_problem(problem));
            }

            // Fallback: synthesize RFC 9457 problem document only for non-JSON or proxy errors
            let detail_text = String::from_utf8_lossy(&bytes);
            let detail = if detail_text.trim().is_empty() {
                format!("HTTP request returned status {}", status.as_u16())
            } else {
                // Truncate detail if excessively long, backing off to the nearest
                // char boundary so the slice never lands inside a multi-byte
                // UTF-8 sequence.
                let max_len = 500;
                if detail_text.len() > max_len {
                    let mut end = max_len;
                    while end > 0 && !detail_text.is_char_boundary(end) {
                        end -= 1;
                    }
                    format!("{}...", &detail_text[..end])
                } else {
                    detail_text.to_string()
                }
            };

            let title = status
                .canonical_reason()
                .unwrap_or("HTTP Error")
                .to_string();
            let problem = ProblemDetail {
                r#type: format!("urn:signkit:problem:http-{}", status.as_u16()),
                title,
                status: status.as_u16(),
                detail,
                instance: path.to_string(),
                errors: None,
                extra: Default::default(),
            };
            Err(CliError::server_problem(problem))
        }
    }

    /// Reads an HTTP response body with an enforced maximum byte limit.
    async fn read_bounded_body(
        response: reqwest::Response,
        max_bytes: usize,
    ) -> Result<Vec<u8>, CliError> {
        if let Some(content_length) = response.content_length() {
            if content_length as usize > max_bytes {
                return Err(CliError::ResponseTooLarge {
                    limit: max_bytes,
                    received: Some(content_length as usize),
                });
            }
        }

        let mut stream = response.bytes_stream();
        let mut buffer = Vec::new();

        while let Some(chunk_res) = stream.next().await {
            let chunk = chunk_res.map_err(|e| {
                if e.is_timeout() {
                    CliError::Timeout("Timed out while reading response body".to_string())
                } else {
                    CliError::Network(format!("Error while streaming response body: {e}"))
                }
            })?;

            if buffer.len() + chunk.len() > max_bytes {
                return Err(CliError::ResponseTooLarge {
                    limit: max_bytes,
                    received: Some(buffer.len() + chunk.len()),
                });
            }

            buffer.extend_from_slice(&chunk);
        }

        Ok(buffer)
    }
}
