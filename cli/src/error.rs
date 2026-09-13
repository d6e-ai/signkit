use crate::types::{ProblemDetail, ProblemValidationError};
use std::fmt;

/// Exact documented exit codes for the SignKit CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum ExitCode {
    /// Command completed successfully.
    Success = 0,
    /// Unspecified / unexpected internal error.
    GenericError = 1,
    /// Command-line usage, invalid arguments, local validation error, missing
    /// mandatory organization, missing API key, or invalid configuration.
    UsageError = 2,
    /// Authentication failure (HTTP 401): invalid, expired, revoked token or suspended owner.
    AuthenticationError = 3,
    /// Authorization failure (HTTP 403): missing organization grant, insufficient scope,
    /// or API key presented on a forbidden management surface.
    ForbiddenError = 4,
    /// Resource not found (HTTP 404): envelope not found in authorized organization.
    NotFoundError = 5,
    /// State conflict (HTTP 409): idempotency or concurrency conflict.
    ConflictError = 6,
    /// Server validation or client error (HTTP 400, 422, or any other unhandled 4xx).
    ValidationError = 7,
    /// Service unavailable, gateway failure, request timeout, or network connection error
    /// (HTTP 500, 502, 503, 504, connection refused, or timeout).
    UnavailableError = 8,
}

impl ExitCode {
    pub fn as_i32(self) -> i32 {
        self as i32
    }
}

/// SignKit CLI error conditions.
#[derive(Debug)]
pub enum CliError {
    /// An RFC 9457 problem document returned from the server.
    ServerProblem(Box<ProblemDetail>),
    /// Local usage or input validation failure (e.g. missing organization or API key).
    Usage {
        detail: String,
        errors: Option<Vec<ProblemValidationError>>,
    },
    /// Invalid or unsafe configuration (e.g. attempting to store secrets in config file).
    Config(String),
    /// Network connection failure (e.g. connection refused).
    Network(String),
    /// Request timed out.
    Timeout(String),
    /// Response exceeded the bounded size limit.
    ResponseTooLarge {
        limit: usize,
        received: Option<usize>,
    },
    /// An HTTP redirect was received and refused to prevent Authorization credential leakage.
    RedirectRefused(String),
    /// Underlying I/O error.
    Io(std::io::Error),
    /// JSON serialization or deserialization error.
    Json(serde_json::Error),
}

impl CliError {
    pub fn server_problem(problem: ProblemDetail) -> Self {
        Self::ServerProblem(Box::new(problem))
    }

    pub fn usage(detail: impl Into<String>) -> Self {
        Self::Usage {
            detail: detail.into(),
            errors: None,
        }
    }

    pub fn usage_with_errors(
        detail: impl Into<String>,
        errors: Vec<ProblemValidationError>,
    ) -> Self {
        Self::Usage {
            detail: detail.into(),
            errors: Some(errors),
        }
    }

    /// Map the error to the exact documented exit code.
    pub fn exit_code(&self) -> ExitCode {
        match self {
            Self::ServerProblem(problem) => match problem.status {
                401 => ExitCode::AuthenticationError,
                403 => ExitCode::ForbiddenError,
                404 => ExitCode::NotFoundError,
                409 => ExitCode::ConflictError,
                400..=499 => ExitCode::ValidationError,
                500 | 502 | 503 | 504 => ExitCode::UnavailableError,
                _ => ExitCode::GenericError,
            },
            Self::Usage { .. } => ExitCode::UsageError,
            Self::Config(_) => ExitCode::UsageError,
            Self::Network(_) => ExitCode::UnavailableError,
            Self::Timeout(_) => ExitCode::UnavailableError,
            Self::ResponseTooLarge { .. } => ExitCode::ValidationError,
            Self::RedirectRefused(_) => ExitCode::ForbiddenError,
            Self::Io(_) => ExitCode::GenericError,
            Self::Json(_) => ExitCode::GenericError,
        }
    }

    /// Convert the error to an RFC 9457 ProblemDetail document, preserving
    /// server details intact or synthesizing compliant problem documents for local errors.
    pub fn to_problem_detail(&self, instance: &str) -> ProblemDetail {
        match self {
            Self::ServerProblem(problem) => (**problem).clone(),
            Self::Usage { detail, errors } => ProblemDetail {
                r#type: "urn:signkit:cli:problem:usage-error".to_string(),
                title: "Usage error".to_string(),
                status: 400,
                detail: detail.clone(),
                instance: instance.to_string(),
                errors: errors.clone(),
                extra: Default::default(),
            },
            Self::Config(detail) => ProblemDetail {
                r#type: "urn:signkit:cli:problem:config-error".to_string(),
                title: "Configuration error".to_string(),
                status: 400,
                detail: detail.clone(),
                instance: instance.to_string(),
                errors: None,
                extra: Default::default(),
            },
            Self::Network(detail) => ProblemDetail {
                r#type: "urn:signkit:cli:problem:network-error".to_string(),
                title: "Network connection failed".to_string(),
                status: 503,
                detail: detail.clone(),
                instance: instance.to_string(),
                errors: None,
                extra: Default::default(),
            },
            Self::Timeout(detail) => ProblemDetail {
                r#type: "urn:signkit:cli:problem:request-timeout".to_string(),
                title: "Request timeout".to_string(),
                status: 504,
                detail: detail.clone(),
                instance: instance.to_string(),
                errors: None,
                extra: Default::default(),
            },
            Self::ResponseTooLarge { limit, received } => {
                let detail = match received {
                    Some(bytes) => format!(
                        "Response body exceeded maximum allowed limit of {limit} bytes (received {bytes} bytes)"
                    ),
                    None => format!(
                        "Response body exceeded maximum allowed limit of {limit} bytes"
                    ),
                };
                ProblemDetail {
                    r#type: "urn:signkit:cli:problem:response-too-large".to_string(),
                    title: "Response body too large".to_string(),
                    status: 413,
                    detail,
                    instance: instance.to_string(),
                    errors: None,
                    extra: Default::default(),
                }
            }
            Self::RedirectRefused(url) => ProblemDetail {
                r#type: "urn:signkit:cli:problem:redirect-refused".to_string(),
                title: "HTTP redirect refused".to_string(),
                status: 403,
                detail: format!(
                    "Server attempted to redirect to '{url}'. Redirects are strictly prohibited to prevent credential leakage."
                ),
                instance: instance.to_string(),
                errors: None,
                extra: Default::default(),
            },
            Self::Io(err) => ProblemDetail {
                r#type: "urn:signkit:cli:problem:io-error".to_string(),
                title: "I/O error".to_string(),
                status: 500,
                detail: err.to_string(),
                instance: instance.to_string(),
                errors: None,
                extra: Default::default(),
            },
            Self::Json(err) => ProblemDetail {
                r#type: "urn:signkit:cli:problem:json-error".to_string(),
                title: "JSON processing error".to_string(),
                status: 500,
                detail: err.to_string(),
                instance: instance.to_string(),
                errors: None,
                extra: Default::default(),
            },
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ServerProblem(p) => write!(f, "HTTP {}: {} ({})", p.status, p.title, p.detail),
            Self::Usage { detail, .. } => write!(f, "Usage error: {detail}"),
            Self::Config(detail) => write!(f, "Configuration error: {detail}"),
            Self::Network(detail) => write!(f, "Network error: {detail}"),
            Self::Timeout(detail) => write!(f, "Timeout error: {detail}"),
            Self::ResponseTooLarge { limit, received } => {
                if let Some(r) = received {
                    write!(
                        f,
                        "Response too large: received {r} bytes, max allowed is {limit}"
                    )
                } else {
                    write!(f, "Response too large: max allowed is {limit} bytes")
                }
            }
            Self::RedirectRefused(url) => write!(f, "Redirect refused to '{url}'"),
            Self::Io(err) => write!(f, "I/O error: {err}"),
            Self::Json(err) => write!(f, "JSON error: {err}"),
        }
    }
}

impl std::error::Error for CliError {}

impl From<std::io::Error> for CliError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}

impl From<serde_json::Error> for CliError {
    fn from(err: serde_json::Error) -> Self {
        Self::Json(err)
    }
}
