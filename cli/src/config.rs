use serde::{Deserialize, Serialize};
use std::env;
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use crate::error::CliError;

pub const DEFAULT_TIMEOUT_SECS: u64 = 30;
pub const SIGNKIT_ORGANIZATION_HEADER: &str = "signkit-organization-id";

/// Forbidden secret keys that must never appear in non-secret config files.
const FORBIDDEN_SECRET_KEYS: &[&str] = &[
    "api_key",
    "apikey",
    "api-key",
    "token",
    "secret",
    "password",
    "key",
    "bearer",
    "auth_token",
    "signkit_api_key",
];

/// Validates that an API key matches `^signkit_[A-Za-z0-9_-]{43}$`.
pub fn is_valid_api_key(key: &str) -> bool {
    if key.len() != 51 {
        return false;
    }
    if !key.starts_with("signkit_") {
        return false;
    }
    key[8..]
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// A wrapper around the API key secret that strictly redacts its value in `Debug` output.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretApiKey(String);

impl SecretApiKey {
    pub fn new(secret: String) -> Self {
        Self(secret)
    }

    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[REDACTED]")
    }
}

/// Non-secret configuration schema loaded from disk.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignKitConfigFile {
    pub base_url: Option<String>,
    pub organization_id: Option<String>,
    pub org: Option<String>,
    pub timeout_secs: Option<u64>,
}

/// Fully resolved CLI configuration with precedence applied:
/// Flags > Environment Variables > Non-Secret Config File.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedConfig {
    pub base_url: url::Url,
    pub organization_id: Option<String>,
    pub api_key: Option<SecretApiKey>,
    pub timeout_secs: u64,
}

impl ResolvedConfig {
    /// Require that an organization is explicitly configured, or fail fast.
    pub fn require_organization(&self) -> Result<&str, CliError> {
        match &self.organization_id {
            Some(org) if !org.trim().is_empty() => {
                let trimmed = org.trim();
                // Server rule: 1..200 visible ASCII characters
                if trimmed.is_empty()
                    || trimmed.len() > 200
                    || !trimmed.chars().all(|c| ('!'..='~').contains(&c))
                {
                    return Err(CliError::usage(
                        "Organization ID must contain 1-200 visible ASCII characters without whitespace.",
                    ));
                }
                Ok(trimmed)
            }
            _ => Err(CliError::usage(
                "An organization is required for this operation. Specify it via --org flag, SIGNKIT_ORG environment variable, or non-secret config file.",
            )),
        }
    }

    /// Require that an API key is configured from environment or secure stdin and
    /// matches the exact required format `^signkit_[A-Za-z0-9_-]{43}$`.
    pub fn require_api_key(&self) -> Result<&str, CliError> {
        match &self.api_key {
            Some(key) => {
                let secret = key.expose_secret();
                if !is_valid_api_key(secret) {
                    return Err(CliError::usage(
                        "Invalid API key format. SignKit API keys must start with 'signkit_' followed by 43 base64url characters (^signkit_[A-Za-z0-9_-]{43}$).",
                    ));
                }
                Ok(secret)
            }
            None => Err(CliError::usage(
                "API key is required for this operation. Provide it via the SIGNKIT_API_KEY environment variable or securely via --api-key-stdin. Storing keys in flags or config files is prohibited.",
            )),
        }
    }
}

/// Recursively inspects a TOML structure to ensure no forbidden secret keys exist
/// anywhere in tables or nested arrays.
fn check_forbidden_keys_recursive(value: &toml::Value, path: &str) -> Result<(), CliError> {
    match value {
        toml::Value::Table(table) => {
            for (k, v) in table {
                let full_key = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}.{k}")
                };
                let lower = k.to_lowercase();
                for forbidden in FORBIDDEN_SECRET_KEYS {
                    if lower == *forbidden || lower.contains("secret") || lower.contains("api_key")
                    {
                        return Err(CliError::Config(format!(
                            "Config file contains forbidden secret key '{full_key}'. The SignKit CLI strictly prohibits storing secret credentials in config files. Provide credentials via the SIGNKIT_API_KEY environment variable or --api-key-stdin."
                        )));
                    }
                }
                check_forbidden_keys_recursive(v, &full_key)?;
            }
        }
        toml::Value::Array(arr) => {
            for (idx, item) in arr.iter().enumerate() {
                let item_path = format!("{path}[{idx}]");
                check_forbidden_keys_recursive(item, &item_path)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Discovers and loads the non-secret configuration file, enforcing that secrets
/// are strictly forbidden anywhere in the document.
pub fn load_config_file(explicit_path: Option<&Path>) -> Result<SignKitConfigFile, CliError> {
    let path = match explicit_path {
        Some(p) => Some(p.to_path_buf()),
        None => match env::var_os("SIGNKIT_CONFIG") {
            Some(val) => Some(PathBuf::from(val)),
            None => default_config_path(),
        },
    };

    let Some(config_path) = path else {
        return Ok(SignKitConfigFile::default());
    };

    if !config_path.exists() {
        if explicit_path.is_some() || env::var_os("SIGNKIT_CONFIG").is_some() {
            return Err(CliError::Config(format!(
                "Config file not found at specified path: {}",
                config_path.display()
            )));
        }
        // Default location does not exist; silent proceed
        return Ok(SignKitConfigFile::default());
    }

    let contents = fs::read_to_string(&config_path).map_err(|e| {
        CliError::Config(format!(
            "Failed to read config file {}: {e}",
            config_path.display()
        ))
    })?;

    // Parse into generic toml::Value first to check recursively for forbidden secret keys
    let root_val: toml::Value = toml::from_str(&contents).map_err(|e| {
        CliError::Config(format!(
            "Invalid TOML syntax in {}: {e}",
            config_path.display()
        ))
    })?;

    check_forbidden_keys_recursive(&root_val, "")?;

    let config: SignKitConfigFile = toml::from_str(&contents).map_err(|e| {
        CliError::Config(format!(
            "Failed to deserialize config file {}: {e}",
            config_path.display()
        ))
    })?;

    Ok(config)
}

/// Finds the default XDG config file path: `$XDG_CONFIG_HOME/signkit/config.toml`
/// or `~/.config/signkit/config.toml`.
fn default_config_path() -> Option<PathBuf> {
    if let Some(xdg) = env::var_os("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(xdg).join("signkit").join("config.toml"));
    }
    if let Some(home) = env::var_os("HOME") {
        return Some(
            PathBuf::from(home)
                .join(".config")
                .join("signkit")
                .join("config.toml"),
        );
    }
    None
}

/// Reads the API key securely from standard input with a bounded maximum size (1024 bytes).
pub fn read_api_key_from_stdin() -> Result<String, CliError> {
    let mut buffer = String::new();
    io::stdin()
        .take(1024)
        .read_to_string(&mut buffer)
        .map_err(|e| CliError::Usage {
            detail: format!("Failed to read API key from stdin: {e}"),
            errors: None,
        })?;
    let trimmed = buffer.trim().to_string();
    if trimmed.is_empty() {
        return Err(CliError::usage(
            "API key provided via stdin was empty. An active SignKit API key is required.",
        ));
    }
    Ok(trimmed)
}

/// Resolves the full configuration by combining CLI flags, environment variables,
/// and non-secret config file according to strict precedence rules.
pub fn resolve_config(
    flag_base_url: Option<String>,
    flag_org: Option<String>,
    flag_api_key_stdin: bool,
    flag_config_path: Option<&Path>,
    flag_timeout_secs: Option<u64>,
) -> Result<ResolvedConfig, CliError> {
    let config_file = load_config_file(flag_config_path)?;

    // 1. Base URL resolution (no compiled fallback; mandatory)
    let raw_base_url = flag_base_url
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .or_else(|| {
            env::var("SIGNKIT_BASE_URL")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .or_else(|| {
            config_file
                .base_url
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.trim().to_string())
        });

    let base_url = match raw_base_url {
        Some(url) => normalize_base_url(&url)?,
        None => {
            return Err(CliError::usage(
                "Base URL is required. Specify it via --base-url flag, SIGNKIT_BASE_URL environment variable, or non-secret config file.",
            ));
        }
    };

    // 2. Organization ID resolution (handles empty string env aliases cleanly)
    let organization_id = flag_org
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .or_else(|| {
            env::var("SIGNKIT_ORG")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .or_else(|| {
            env::var("SIGNKIT_ORGANIZATION_ID")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .or_else(|| {
            config_file
                .organization_id
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.trim().to_string())
        })
        .or_else(|| {
            config_file
                .org
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.trim().to_string())
        });

    // 3. API Key resolution (stdin > env only, never flags, never config, no Bearer stripping)
    let api_key = if flag_api_key_stdin {
        Some(read_api_key_from_stdin()?)
    } else {
        env::var("SIGNKIT_API_KEY")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };

    let api_key = api_key.map(SecretApiKey::new);

    // 4. Timeout resolution (reject timeout == 0)
    let timeout_secs = if let Some(t) = flag_timeout_secs {
        t
    } else if let Some(env_t) = env::var("SIGNKIT_TIMEOUT_SECS")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        env_t.parse::<u64>().map_err(|_| {
            CliError::Config("SIGNKIT_TIMEOUT_SECS must be a valid positive integer".to_string())
        })?
    } else {
        config_file.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS)
    };

    if timeout_secs == 0 {
        return Err(CliError::usage(
            "Request timeout must be greater than 0 seconds (received 0).",
        ));
    }

    Ok(ResolvedConfig {
        base_url,
        organization_id,
        api_key,
        timeout_secs,
    })
}

/// Normalizes and rigorously validates the base URL:
/// - Must parse with `url::Url`
/// - Scheme must be HTTPS, except exact loopback hosts (localhost, 127.0.0.1, ::1) which permit HTTP
/// - Rejects userinfo (username or password)
/// - Rejects query parameters
/// - Rejects fragment identifiers
/// - Rejects non-root paths (must be empty or "/")
/// - Sets path to "/" so subsequent `Url::join` calls are safe and unambiguous
pub fn normalize_base_url(raw: &str) -> Result<url::Url, CliError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CliError::usage("Base URL cannot be empty"));
    }

    let mut parsed = url::Url::parse(trimmed)
        .map_err(|e| CliError::usage(format!("Invalid base URL '{raw}': {e}")))?;

    // Scheme & loopback verification
    match parsed.scheme() {
        "https" => {
            // HTTPS is always permitted
        }
        "http" => {
            let is_loopback = match parsed.host() {
                Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
                Some(url::Host::Ipv4(addr)) => {
                    addr == std::net::Ipv4Addr::new(127, 0, 0, 1) || addr.is_loopback()
                }
                Some(url::Host::Ipv6(addr)) => {
                    addr == std::net::Ipv6Addr::LOCALHOST || addr.is_loopback()
                }
                None => false,
            };
            if !is_loopback {
                return Err(CliError::usage(format!(
                    "Insecure HTTP scheme is only permitted for loopback hosts (localhost, 127.0.0.1, ::1). For all other hosts, HTTPS is required: '{raw}'"
                )));
            }
        }
        _ => {
            return Err(CliError::usage(format!(
                "Base URL scheme must be https (or http for loopback hosts): '{raw}'"
            )));
        }
    }

    // Reject userinfo
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(CliError::usage(format!(
            "Base URL must not contain user credentials: '{raw}'"
        )));
    }

    // Reject query parameters
    if parsed.query().is_some() {
        return Err(CliError::usage(format!(
            "Base URL must not contain query parameters: '{raw}'"
        )));
    }

    // Reject fragment
    if parsed.fragment().is_some() {
        return Err(CliError::usage(format!(
            "Base URL must not contain a fragment: '{raw}'"
        )));
    }

    // Reject non-root path
    let path = parsed.path();
    if !path.is_empty() && path != "/" {
        return Err(CliError::usage(format!(
            "Base URL must not contain a non-root path (got '{path}'). Specify only scheme, host, and port: '{raw}'"
        )));
    }

    // Normalize path to "/"
    parsed.set_path("/");

    Ok(parsed)
}
