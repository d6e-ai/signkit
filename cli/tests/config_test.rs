mod common;

use clap::Parser;
use signkit_cli::args::Cli;
use signkit_cli::config::{normalize_base_url, resolve_config};
use signkit_cli::error::ExitCode;
use signkit_cli::run_cli;
use std::io::Write;
use tempfile::NamedTempFile;

#[tokio::test]
async fn test_config_precedence_flag_over_env_over_file() {
    let mut temp_file = NamedTempFile::new().unwrap();
    writeln!(
        temp_file,
        r#"
        base_url = "https://config.example.com"
        timeout_secs = 45
        "#
    )
    .unwrap();

    // 1. File only (ensure env vars are cleared)
    {
        let _env =
            common::EnvScope::new(&[("SIGNKIT_BASE_URL", None), ("SIGNKIT_TIMEOUT_SECS", None)])
                .await;
        let resolved = resolve_config(None, false, Some(temp_file.path()), None).unwrap();
        assert_eq!(resolved.base_url.as_str(), "https://config.example.com/");
        assert_eq!(resolved.timeout_secs, 45);
    }

    // 2. Env overrides file
    {
        let _env = common::EnvScope::new(&[
            ("SIGNKIT_BASE_URL", Some("https://env.example.com")),
            ("SIGNKIT_TIMEOUT_SECS", Some("50")),
        ])
        .await;
        let resolved2 = resolve_config(None, false, Some(temp_file.path()), None).unwrap();
        assert_eq!(resolved2.base_url.as_str(), "https://env.example.com/");
        assert_eq!(resolved2.timeout_secs, 50);
    }

    // 3. Flag overrides env and file
    {
        let _env = common::EnvScope::new(&[
            ("SIGNKIT_BASE_URL", Some("https://env.example.com")),
            ("SIGNKIT_TIMEOUT_SECS", Some("50")),
        ])
        .await;
        let resolved3 = resolve_config(
            Some("https://flag.example.com".to_string()),
            false,
            Some(temp_file.path()),
            Some(60),
        )
        .unwrap();
        assert_eq!(resolved3.base_url.as_str(), "https://flag.example.com/");
        assert_eq!(resolved3.timeout_secs, 60);
    }
}

#[tokio::test]
async fn test_config_file_rejects_api_key() {
    let mut temp_file = NamedTempFile::new().unwrap();
    writeln!(
        temp_file,
        r#"
        base_url = "https://example.com"
        api_key = "signkit_illegal_stored_secret"
        "#
    )
    .unwrap();

    let cli = Cli::parse_from([
        "signkit",
        "--config",
        temp_file.path().to_str().unwrap(),
        "capabilities",
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::UsageError);
}

#[tokio::test]
async fn test_config_file_rejects_token_or_secret_keys() {
    let mut temp_file = NamedTempFile::new().unwrap();
    writeln!(
        temp_file,
        r#"
        base_url = "https://example.com"
        secret = "super_secret"
        "#
    )
    .unwrap();

    let cli = Cli::parse_from([
        "signkit",
        "--config",
        temp_file.path().to_str().unwrap(),
        "capabilities",
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::UsageError);
}

#[tokio::test]
async fn test_config_file_recursively_rejects_nested_secrets() {
    // Nested table
    let mut temp_file = NamedTempFile::new().unwrap();
    writeln!(
        temp_file,
        r#"
        base_url = "https://example.com"
        [credentials]
        secret = "nested_secret"
        "#
    )
    .unwrap();

    let cli = Cli::parse_from([
        "signkit",
        "--config",
        temp_file.path().to_str().unwrap(),
        "capabilities",
    ]);
    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::UsageError);

    // Array of tables
    let mut temp_file2 = NamedTempFile::new().unwrap();
    writeln!(
        temp_file2,
        r#"
        base_url = "https://example.com"
        [[users]]
        token = "token_in_array"
        "#
    )
    .unwrap();

    let cli2 = Cli::parse_from([
        "signkit",
        "--config",
        temp_file2.path().to_str().unwrap(),
        "capabilities",
    ]);
    let exit_code2 = run_cli(cli2).await;
    assert_eq!(exit_code2, ExitCode::UsageError);
}

#[test]
fn test_base_url_validation_rules() {
    // Valid HTTPS
    assert!(normalize_base_url("https://api.signkit.com").is_ok());
    assert!(normalize_base_url("https://api.signkit.com/").is_ok());

    // Valid HTTP loopback
    assert!(normalize_base_url("http://localhost:5173").is_ok());
    assert!(normalize_base_url("http://127.0.0.1:8080").is_ok());
    assert!(normalize_base_url("http://[::1]:8080").is_ok());

    // Insecure HTTP non-loopback rejected
    assert!(normalize_base_url("http://api.signkit.com").is_err());
    assert!(normalize_base_url("http://192.168.1.1:8080").is_err());

    // User credentials rejected
    assert!(normalize_base_url("https://user:pass@api.signkit.com").is_err());

    // Query parameters rejected
    assert!(normalize_base_url("https://api.signkit.com?param=val").is_err());

    // Fragment rejected
    assert!(normalize_base_url("https://api.signkit.com#section").is_err());

    // Non-root path rejected
    assert!(normalize_base_url("https://api.signkit.com/v1").is_err());
    assert!(normalize_base_url("https://api.signkit.com/api/").is_err());
}

#[tokio::test]
async fn test_timeout_zero_rejected() {
    let result = resolve_config(
        Some("https://example.com".to_string()),
        false,
        None,
        Some(0),
    );
    assert!(result.is_err());
}

#[tokio::test]
async fn test_credential_redacted_in_debug() {
    let _env = common::EnvScope::new(&[
        ("SIGNKIT_BASE_URL", Some("https://example.com")),
        ("SIGNKIT_API_KEY", Some(common::TEST_API_KEY)),
    ])
    .await;

    let resolved = resolve_config(None, false, None, None).unwrap();
    let debug_output = format!("{resolved:?}");
    assert!(debug_output.contains("[REDACTED]"));
    assert!(!debug_output.contains(common::TEST_API_KEY));
}
