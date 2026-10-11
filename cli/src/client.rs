use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde::de::DeserializeOwned;
use std::borrow::Cow;
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

#[cfg(test)]
mod problem_contract_tests {
    use super::SignKitClient;
    use crate::error::CliError;
    use crate::types::ProblemDetail;
    use serde::Deserialize;
    use serde_json::Value;
    use std::collections::BTreeMap;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ProblemFixture {
        name: String,
        http_status: u16,
        path: String,
        body: BTreeMap<String, Value>,
        expected: BTreeMap<String, Value>,
    }

    fn take_problem(error: CliError) -> ProblemDetail {
        match error {
            CliError::ServerProblem(problem) => *problem,
            other => panic!("expected a server problem, got {other:?}"),
        }
    }

    #[test]
    fn browser_and_cli_share_problem_wire_fixtures() {
        let fixtures: Vec<ProblemFixture> =
            serde_json::from_str(include_str!("../tests/fixtures/http-problems.json")).unwrap();
        for fixture in fixtures {
            let bytes: Vec<u8> = serde_json::to_vec(&fixture.body).unwrap();
            let problem: ProblemDetail =
                take_problem(SignKitClient::problem_from_bytes_with_title(
                    &fixture.path,
                    fixture.http_status,
                    &bytes,
                    "HTTP Error",
                ));
            let actual: Value = serde_json::to_value(&problem).unwrap();
            for (field, expected) in fixture.expected {
                assert_eq!(actual[&field], expected, "{}: {field}", fixture.name);
            }
            // The CLI deliberately retains unknown fields; browser UI parsing
            // consumes only its known fields. Do not unify these policies.
            assert_eq!(
                problem.extra.get("requestId"),
                fixture.body.get("requestId")
            );
        }
    }

    #[test]
    fn json_and_binary_paths_keep_their_own_fallback_titles() {
        for bytes in [b"{}".as_slice(), b"not JSON".as_slice()] {
            let json_problem: ProblemDetail =
                take_problem(SignKitClient::problem_from_bytes_with_title(
                    "/api/v1/envelopes",
                    502,
                    bytes,
                    "Bad Gateway",
                ));
            let binary_problem: ProblemDetail = take_problem(SignKitClient::problem_from_bytes(
                "/api/v1/envelopes",
                502,
                bytes,
            ));
            assert_eq!(json_problem.title, "Bad Gateway");
            assert_eq!(binary_problem.title, "HTTP Error");
            assert_eq!(json_problem.status, 502);
            assert_eq!(binary_problem.status, 502);
            assert_eq!(json_problem.instance, "/api/v1/envelopes");
            assert_eq!(binary_problem.instance, "/api/v1/envelopes");
        }
        let problem: ProblemDetail = take_problem(SignKitClient::problem_from_bytes(
            "/api/v1/envelopes",
            503,
            br#"{"status":0,"title":"","instance":"","type":"urn:custom"}"#,
        ));
        assert_eq!(problem.status, 503);
        assert_eq!(problem.r#type, "urn:custom");
    }

    #[test]
    fn proxy_details_preserve_whitespace_and_utf8_safe_500_byte_bound() {
        let cases: Vec<(Vec<u8>, String)> = vec![
            (
                b"  \n".to_vec(),
                "HTTP request returned status 502".to_string(),
            ),
            (b" short ".to_vec(), " short ".to_string()),
            (vec![b'x'; 500], "x".repeat(500)),
            (
                format!("{}🦀extra", "x".repeat(499)).into_bytes(),
                format!("{}...", "x".repeat(499)),
            ),
            (vec![0xff], "�".to_string()),
        ];
        for (bytes, expected) in cases {
            let problem: ProblemDetail = take_problem(SignKitClient::problem_from_bytes(
                "/api/v1/envelopes",
                502,
                &bytes,
            ));
            assert_eq!(problem.detail, expected);
        }
    }
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
    pub const RECIPIENT_PDF: Self = Self {
        accept: "application/pdf, application/problem+json",
        max_bytes: crate::io::MAX_COMPLETION_PDF_BYTES,
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
            Err(Self::problem_from_bytes_with_title(
                path,
                status.as_u16(),
                &bytes,
                status.canonical_reason().unwrap_or("HTTP Error"),
            ))
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
            Err(Self::problem_from_bytes_with_title(
                path,
                status.as_u16(),
                &bytes,
                status.canonical_reason().unwrap_or("HTTP Error"),
            ))
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

    /// Applies recipient capability bearer authorization. Deliberately reads
    /// only `config.recipient_capability`, never `config.api_key`: a sender
    /// API key must never authorize a recipient command.
    fn apply_recipient_auth(&self, headers: &mut HeaderMap, token: &str) -> Result<(), CliError> {
        let auth_str = format!("Bearer {token}");
        let mut auth_val = HeaderValue::from_str(&auth_str).map_err(|_| {
            CliError::usage("Recipient capability contains invalid characters for HTTP header")
        })?;
        auth_val.set_sensitive(true);
        headers.insert(AUTHORIZATION, auth_val);
        Ok(())
    }

    /// Performs a safe, bounded GET request authenticated by the recipient
    /// capability token (never the sender API key).
    pub async fn get_recipient<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T, CliError> {
        let token = self.config.require_recipient_capability()?.to_string();
        self.get_recipient_inner(path, query, &token)
            .await
            .map_err(|err| Self::sanitize_recipient_error(err, &token))
    }

    async fn get_recipient_inner<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
        token: &str,
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
        self.apply_recipient_auth(&mut headers, token)?;

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

        let bytes = Self::read_bounded_body(response, MAX_RESPONSE_BYTES).await?;

        if status.is_success() {
            let value: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(CliError::Json)?;
            if Self::json_value_contains_token(&value, token) {
                return Err(CliError::Network(
                    "Recipient response echoed a credential; refusing to print it".to_string(),
                ));
            }
            let data: T = serde_json::from_value(value).map_err(CliError::Json)?;
            Ok(data)
        } else {
            Err(Self::problem_from_bytes(path, status.as_u16(), &bytes))
        }
    }

    /// Performs a safe, bounded JSON POST with a required Idempotency-Key,
    /// authenticated by the recipient capability token (never the sender API key).
    pub async fn post_recipient<T, B>(
        &self,
        path: &str,
        body: &B,
        idempotency_key: &str,
    ) -> Result<T, CliError>
    where
        T: DeserializeOwned,
        B: serde::Serialize,
    {
        let token = self.config.require_recipient_capability()?.to_string();
        self.post_recipient_inner(path, body, idempotency_key, &token)
            .await
            .map_err(|err| Self::sanitize_recipient_error(err, &token))
    }

    async fn post_recipient_inner<T, B>(
        &self,
        path: &str,
        body: &B,
        idempotency_key: &str,
        token: &str,
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
        self.apply_recipient_auth(&mut headers, token)?;

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
            let value: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(CliError::Json)?;
            if Self::json_value_contains_token(&value, token) {
                return Err(CliError::Network(
                    "Recipient response echoed a credential; refusing to print it".to_string(),
                ));
            }
            let data: T = serde_json::from_value(value).map_err(CliError::Json)?;
            Ok(data)
        } else {
            Err(Self::problem_from_bytes(path, status.as_u16(), &bytes))
        }
    }

    /// Bounded binary GET authenticated by the recipient capability token
    /// (never the sender API key). JSON problem documents still parse as errors.
    pub async fn get_bytes_recipient(
        &self,
        path: &str,
        query: &[(&str, &str)],
        spec: BinaryGetSpec,
    ) -> Result<BinaryResponse, CliError> {
        let token = self.config.require_recipient_capability()?.to_string();
        self.get_bytes_recipient_inner(path, query, spec, &token)
            .await
            .map_err(|err| Self::sanitize_recipient_error(err, &token))
    }

    async fn get_bytes_recipient_inner(
        &self,
        path: &str,
        query: &[(&str, &str)],
        spec: BinaryGetSpec,
        token: &str,
    ) -> Result<BinaryResponse, CliError> {
        let relative = path.trim_start_matches('/');
        let url = self
            .config
            .base_url
            .join(relative)
            .map_err(|e| CliError::usage(format!("Failed to construct request URL: {e}")))?;

        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static(spec.accept));
        self.apply_recipient_auth(&mut headers, token)?;

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

        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let bytes = Self::read_bounded_body(response, spec.max_bytes).await?;

        if status.is_success() {
            if spec == BinaryGetSpec::RECIPIENT_PDF
                && (content_type
                    .as_deref()
                    .and_then(|value| value.split(';').next())
                    .map(|value| !value.trim().eq_ignore_ascii_case("application/pdf"))
                    .unwrap_or(true)
                    || !bytes.starts_with(b"%PDF-"))
            {
                return Err(CliError::Network(
                    "Recipient document response is not a PDF; refusing to save it".to_string(),
                ));
            }
            return Ok(BinaryResponse {
                bytes,
                commit_sha: None,
                content_type,
            });
        }
        Err(Self::problem_from_bytes(path, status.as_u16(), &bytes))
    }

    fn json_value_contains_token(value: &serde_json::Value, token: &str) -> bool {
        match value {
            serde_json::Value::String(text) => text.contains(token),
            serde_json::Value::Array(items) => items
                .iter()
                .any(|item| Self::json_value_contains_token(item, token)),
            serde_json::Value::Object(items) => items.iter().any(|(key, item)| {
                key.contains(token) || Self::json_value_contains_token(item, token)
            }),
            _ => false,
        }
    }

    /// Defense in depth: strips any accidental echo of the recipient capability
    /// token from an error before it can reach stdout/stderr, in case a
    /// misbehaving or compromised server reflects the Authorization value back
    /// (e.g. in a problem `detail`, `instance`, a redirect `location`, or a raw
    /// network error string).
    fn sanitize_recipient_error(err: CliError, token: &str) -> CliError {
        fn redact(value: &str, token: &str) -> String {
            if value.contains(token) {
                value.replace(token, "[REDACTED]")
            } else {
                value.to_string()
            }
        }

        fn redact_json(value: &mut serde_json::Value, token: &str) {
            match value {
                serde_json::Value::String(text) => *text = redact(text, token),
                serde_json::Value::Array(items) => {
                    for item in items.iter_mut() {
                        redact_json(item, token);
                    }
                }
                serde_json::Value::Object(items) => {
                    let original = std::mem::take(items);
                    for (key, mut item) in original {
                        redact_json(&mut item, token);
                        items.insert(redact(&key, token), item);
                    }
                }
                _ => {}
            }
        }

        match err {
            CliError::ServerProblem(problem) => {
                let mut problem = *problem;
                problem.r#type = redact(&problem.r#type, token);
                problem.title = redact(&problem.title, token);
                problem.detail = redact(&problem.detail, token);
                problem.instance = redact(&problem.instance, token);
                if let Some(errors) = problem.errors.as_mut() {
                    for error in errors.iter_mut() {
                        error.path = redact(&error.path, token);
                        error.message = redact(&error.message, token);
                        let original = std::mem::take(&mut error.extra);
                        for (key, mut value) in original {
                            redact_json(&mut value, token);
                            error.extra.insert(redact(&key, token), value);
                        }
                    }
                }
                let original = std::mem::take(&mut problem.extra);
                for (key, mut value) in original {
                    redact_json(&mut value, token);
                    problem.extra.insert(redact(&key, token), value);
                }
                CliError::server_problem(problem)
            }
            CliError::RedirectRefused(location) => {
                CliError::RedirectRefused(redact(&location, token))
            }
            CliError::Network(detail) => CliError::Network(redact(&detail, token)),
            CliError::Timeout(detail) => CliError::Timeout(redact(&detail, token)),
            CliError::Usage { detail, errors } => CliError::Usage {
                detail: redact(&detail, token),
                errors,
            },
            other => other,
        }
    }

    fn problem_from_bytes(path: &str, status: u16, bytes: &[u8]) -> CliError {
        Self::problem_from_bytes_with_title(path, status, bytes, "HTTP Error")
    }

    /// Shared RFC 9457 problem parsing for both JSON and binary response
    /// paths. `default_title` lets GET/POST prefer the canonical HTTP reason
    /// phrase while every binary/recipient path keeps the literal "HTTP
    /// Error" default `problem_from_bytes` always used.
    fn problem_from_bytes_with_title(
        path: &str,
        status: u16,
        bytes: &[u8],
        default_title: &str,
    ) -> CliError {
        if let Ok(mut problem) = serde_json::from_slice::<ProblemDetail>(bytes) {
            if problem.status == 0 {
                problem.status = status;
            }
            if problem.title.is_empty() {
                problem.title = default_title.to_string();
            }
            if problem.instance.is_empty() {
                problem.instance = path.to_string();
            }
            return CliError::server_problem(problem);
        }
        let detail_text: Cow<'_, str> = String::from_utf8_lossy(bytes);
        let detail: String = if detail_text.trim().is_empty() {
            format!("HTTP request returned status {status}")
        } else {
            let max_len: usize = 500;
            if detail_text.len() > max_len {
                let mut end: usize = max_len;
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
            title: default_title.to_string(),
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
