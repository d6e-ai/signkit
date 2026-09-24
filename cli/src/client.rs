use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde::de::DeserializeOwned;
use std::time::Duration;

use crate::config::ResolvedConfig;
use crate::error::CliError;
use crate::types::ProblemDetail;

/// Maximum JSON response body limit: 10 MiB.
pub const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

/// Accept header and byte bound for a binary GET.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BinaryGetSpec {
    pub accept: &'static str,
    pub max_bytes: usize,
}

impl BinaryGetSpec {
    pub const DOCX: Self = Self {
        accept: "application/vnd.openxmlformats-officedocument.wordprocessingml.document, application/problem+json",
        max_bytes: crate::io::MAX_DOCX_BYTES,
    };
    pub const EVIDENCE_JSON: Self = Self {
        accept: "application/json, application/problem+json",
        max_bytes: crate::io::MAX_EVIDENCE_BYTES,
    };
    pub const EVIDENCE_MARKDOWN: Self = Self {
        accept: "text/markdown, application/problem+json",
        max_bytes: crate::io::MAX_EVIDENCE_BYTES,
    };
    pub const PDF: Self = Self {
        accept: "application/pdf, application/problem+json",
        max_bytes: crate::io::MAX_COMPLETION_PDF_BYTES,
    };
    pub const SEALED_PDF: Self = Self {
        accept: "application/pdf, application/problem+json",
        max_bytes: crate::io::MAX_SEALED_PDF_BYTES,
    };
    pub const REVISION_DIFF_TEXT: Self = Self {
        accept: "text/plain, application/problem+json",
        max_bytes: MAX_RESPONSE_BYTES,
    };
}

/// Successful binary GET body plus optional commit pin header.
pub struct BinaryResponse {
    pub bytes: Vec<u8>,
    pub commit_sha: Option<String>,
    pub content_type: Option<String>,
}

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
    /// the API key is verified before dispatching the request.
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

        self.apply_auth(&mut headers, authenticated)?;

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

    /// Performs a safe, bounded JSON POST with a required Idempotency-Key.
    pub async fn post<T, B>(
        &self,
        path: &str,
        body: &B,
        idempotency_key: &str,
        authenticated: bool,
    ) -> Result<T, CliError>
    where
        T: DeserializeOwned,
        B: serde::Serialize,
    {
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
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let idempotency_val = HeaderValue::from_str(idempotency_key).map_err(|_| {
            CliError::usage("Idempotency-Key contains invalid characters for HTTP header")
        })?;
        headers.insert(HeaderName::from_static("idempotency-key"), idempotency_val);

        self.apply_auth(&mut headers, authenticated)?;

        let response = self
            .http
            .post(url)
            .headers(headers)
            .json(body)
            .send()
            .await
            .map_err(|err| {
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

        if status.is_redirection() {
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("unknown")
                .to_string();
            return Err(CliError::RedirectRefused(location));
        }

        let bytes = Self::read_bounded_body(response, MAX_RESPONSE_BYTES).await?;

        if status.is_success() {
            let data: T = serde_json::from_slice(&bytes).map_err(CliError::Json)?;
            Ok(data)
        } else {
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

            let detail_text = String::from_utf8_lossy(&bytes);
            let detail = if detail_text.trim().is_empty() {
                format!("HTTP request returned status {}", status.as_u16())
            } else {
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

    /// Bounded binary GET. JSON problem documents still parse as errors.
    pub async fn get_bytes(
        &self,
        path: &str,
        query: &[(&str, &str)],
        authenticated: bool,
        spec: BinaryGetSpec,
    ) -> Result<BinaryResponse, CliError> {
        let relative = path.trim_start_matches('/');
        let url = self
            .config
            .base_url
            .join(relative)
            .map_err(|e| CliError::usage(format!("Failed to construct request URL: {e}")))?;

        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static(spec.accept));
        self.apply_auth(&mut headers, authenticated)?;

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
        if status.is_redirection() {
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("unknown")
                .to_string();
            return Err(CliError::RedirectRefused(location));
        }

        let commit_sha = response
            .headers()
            .get("x-signkit-commit-sha")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let bytes = Self::read_bounded_body(response, spec.max_bytes).await?;

        if status.is_success() {
            return Ok(BinaryResponse {
                bytes,
                commit_sha,
                content_type,
            });
        }
        Err(Self::problem_from_bytes(path, status.as_u16(), &bytes))
    }

    /// Bounded binary POST with a required Idempotency-Key.
    /// Always authenticated; JSON receipts use `MAX_RESPONSE_BYTES`.
    pub async fn post_bytes<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
        body: Vec<u8>,
        content_type: &'static str,
        idempotency_key: &str,
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
        headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
        let idempotency_val = HeaderValue::from_str(idempotency_key).map_err(|_| {
            CliError::usage("Idempotency-Key contains invalid characters for HTTP header")
        })?;
        headers.insert(HeaderName::from_static("idempotency-key"), idempotency_val);
        self.apply_auth(&mut headers, true)?;

        let mut request_builder = self.http.post(url).headers(headers).body(body);
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
        if status.is_redirection() {
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("unknown")
                .to_string();
            return Err(CliError::RedirectRefused(location));
        }

        let bytes = Self::read_bounded_body(response, MAX_RESPONSE_BYTES).await?;
        if status.is_success() {
            let data: T = serde_json::from_slice(&bytes).map_err(CliError::Json)?;
            Ok(data)
        } else {
            Err(Self::problem_from_bytes(path, status.as_u16(), &bytes))
        }
    }

    fn apply_auth(&self, headers: &mut HeaderMap, authenticated: bool) -> Result<(), CliError> {
        if !authenticated {
            return Ok(());
        }
        let api_key = self.config.require_api_key()?;
        let auth_str = format!("Bearer {api_key}");
        let mut auth_val = HeaderValue::from_str(&auth_str)
            .map_err(|_| CliError::usage("API key contains invalid characters for HTTP header"))?;
        auth_val.set_sensitive(true);
        headers.insert(AUTHORIZATION, auth_val);
        Ok(())
    }

    fn problem_from_bytes(path: &str, status: u16, bytes: &[u8]) -> CliError {
        if let Ok(mut problem) = serde_json::from_slice::<ProblemDetail>(bytes) {
            if problem.status == 0 {
                problem.status = status;
            }
            if problem.title.is_empty() {
                problem.title = "HTTP Error".to_string();
            }
            if problem.instance.is_empty() {
                problem.instance = path.to_string();
            }
            return CliError::server_problem(problem);
        }
        let detail_text = String::from_utf8_lossy(bytes);
        let detail = if detail_text.trim().is_empty() {
            format!("HTTP request returned status {status}")
        } else {
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
        CliError::server_problem(ProblemDetail {
            r#type: format!("urn:signkit:problem:http-{status}"),
            title: "HTTP Error".to_string(),
            status,
            detail,
            instance: path.to_string(),
            errors: None,
            extra: Default::default(),
        })
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
