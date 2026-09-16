mod common;

use assert_cmd::Command;
use clap::Parser;
use predicates::prelude::*;
use signkit_cli::args::Cli;
use signkit_cli::client::MAX_RESPONSE_BYTES;
use signkit_cli::error::ExitCode;
use signkit_cli::run_cli;
use std::time::Duration;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn test_api_key_missing_fails_fast() {
    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", None)]).await;

    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://127.0.0.1:5173",
        "envelopes",
        "list",
    ]);
    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::UsageError);
}

#[tokio::test]
async fn test_api_key_format_enforcement() {
    // 1. Key with Bearer prefix must NOT be stripped or accepted
    {
        let _env1 = common::EnvScope::new(&[(
            "SIGNKIT_API_KEY",
            Some("Bearer signkit_abcdef1234567890abcdef1234567890abcdef12345"),
        )])
        .await;
        let cli1 = Cli::parse_from([
            "signkit",
            "--base-url",
            "http://127.0.0.1:5173",
            "envelopes",
            "list",
        ]);
        assert_eq!(run_cli(cli1).await, ExitCode::UsageError);
    }

    // 2. Key too short
    {
        let _env2 = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some("signkit_too_short"))]).await;
        let cli2 = Cli::parse_from([
            "signkit",
            "--base-url",
            "http://127.0.0.1:5173",
            "envelopes",
            "list",
        ]);
        assert_eq!(run_cli(cli2).await, ExitCode::UsageError);
    }

    // 3. Key with invalid characters
    {
        let _env3 = common::EnvScope::new(&[(
            "SIGNKIT_API_KEY",
            Some("signkit_abcdef1234567890abcdef1234567890abcdef!@123"),
        )])
        .await;
        let cli3 = Cli::parse_from([
            "signkit",
            "--base-url",
            "http://127.0.0.1:5173",
            "envelopes",
            "list",
        ]);
        assert_eq!(run_cli(cli3).await, ExitCode::UsageError);
    }
}

#[tokio::test]
async fn test_no_api_key_command_line_flag_allowed() {
    let mut cmd = Command::cargo_bin("signkit").unwrap();
    cmd.args(["--api-key", "secret123", "envelopes", "list"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("unexpected argument '--api-key'"));
}

#[tokio::test]
async fn test_api_key_from_secure_stdin() {
    let mock_server = common::start_mock_server().await;

    let response_json = r#"{"items": [], "nextCursor": null}"#;
    let stdin_key = "signkit_from_stdin_secret_1234567890abcdef123456789";

    Mock::given(method("GET"))
        .and(path("/api/v1/envelopes"))
        .and(header(
            "authorization",
            format!("Bearer {stdin_key}").as_str(),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_raw(response_json, "application/json"))
        .mount(&mock_server)
        .await;

    let mut cmd = Command::cargo_bin("signkit").unwrap();
    cmd.args([
        "--base-url",
        &mock_server.uri(),
        "--api-key-stdin",
        "envelopes",
        "list",
    ])
    .write_stdin(format!("{stdin_key}\n"))
    .assert()
    .success();
}

#[tokio::test]
async fn test_rfc9457_error_401_authentication_required() {
    let mock_server = common::start_mock_server().await;

    let problem_json = r#"{
        "type": "urn:signkit:problem:api-key-authentication-required",
        "title": "API key authentication required",
        "status": 401,
        "detail": "A live SignKit API key is required for this request.",
        "instance": "/api/v1/envelopes"
    }"#;

    Mock::given(method("GET"))
        .and(path("/api/v1/envelopes"))
        .respond_with(
            ResponseTemplate::new(401)
                .insert_header("www-authenticate", "Bearer")
                .set_body_raw(problem_json, "application/problem+json"),
        )
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "list",
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::AuthenticationError);
}

#[tokio::test]
async fn test_rfc9457_error_403_insufficient_scope() {
    let mock_server = common::start_mock_server().await;

    let problem_json = r#"{
        "type": "urn:signkit:problem:api-key-insufficient-scope",
        "title": "Insufficient API key scope",
        "status": 403,
        "detail": "This request requires the envelopes:read scope.",
        "instance": "/api/v1/envelopes"
    }"#;

    Mock::given(method("GET"))
        .and(path("/api/v1/envelopes"))
        .respond_with(
            ResponseTemplate::new(403)
                .insert_header(
                    "www-authenticate",
                    r#"Bearer error="insufficient_scope", scope="envelopes:read""#,
                )
                .set_body_raw(problem_json, "application/problem+json"),
        )
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "list",
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::ForbiddenError);
}

#[tokio::test]
async fn test_remaining_4xx_map_to_exit_code_7() {
    // Status 422 Unprocessable Entity -> exit code 7
    let mock_server = common::start_mock_server().await;
    let problem_json = r#"{
        "type": "urn:signkit:problem:unprocessable-entity",
        "title": "Unprocessable Entity",
        "status": 422,
        "detail": "Invalid entity format",
        "instance": "/api/v1/envelopes"
    }"#;

    Mock::given(method("GET"))
        .and(path("/api/v1/envelopes"))
        .respond_with(
            ResponseTemplate::new(422).set_body_raw(problem_json, "application/problem+json"),
        )
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "list",
    ]);

    assert_eq!(run_cli(cli).await, ExitCode::ValidationError);

    // Status 429 Too Many Requests -> exit code 7
    let mock_server2 = common::start_mock_server().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/envelopes"))
        .respond_with(ResponseTemplate::new(429).set_body_raw(
            r#"{"status": 429, "title": "Too Many Requests", "detail": "Rate limit exceeded"}"#,
            "application/problem+json",
        ))
        .mount(&mock_server2)
        .await;

    let cli2 = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server2.uri(),
        "envelopes",
        "list",
    ]);

    assert_eq!(run_cli(cli2).await, ExitCode::ValidationError);
}

#[tokio::test]
async fn test_stdout_stderr_and_versioned_envelope() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/system/capabilities"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_raw(common::sample_capabilities_json(), "application/json"),
        )
        .mount(&mock_server)
        .await;

    // Success: stdout must contain versioned envelope, stderr empty
    let mut cmd = Command::cargo_bin("signkit").unwrap();
    let assert = cmd
        .args(["--base-url", &mock_server.uri(), "capabilities"])
        .assert()
        .success()
        .stderr(predicate::str::is_empty())
        .stdout(predicate::str::contains(r#""version":"1""#))
        .stdout(predicate::str::contains(r#""data":{"#));

    let output_str = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&output_str).unwrap();
    assert_eq!(parsed["version"], "1");
    assert!(parsed["data"]["name"].is_string());

    // Error: stderr must contain RFC 9457 problem JSON, stdout empty
    let mut fail_cmd = Command::cargo_bin("signkit").unwrap();
    fail_cmd
        .args([
            "--base-url",
            &mock_server.uri(),
            "envelopes",
            "get",
            "not-a-valid-uuid",
        ])
        .env_remove("SIGNKIT_API_KEY")
        .assert()
        .code(2)
        .stdout(predicate::str::is_empty())
        .stderr(predicate::str::contains("urn:signkit:cli:problem:"));
}

#[tokio::test]
async fn test_no_redirects_policy_refuses_redirect() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/envelopes"))
        .respond_with(
            ResponseTemplate::new(302)
                .insert_header("location", "https://untrusted.example.com/steal-auth"),
        )
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "list",
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::ForbiddenError);
}

#[tokio::test]
async fn test_request_timeout() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/envelopes"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(1500))
                .set_body_raw(r#"{"items":[],"nextCursor":null}"#, "application/json"),
        )
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "--timeout",
        "1",
        "envelopes",
        "list",
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::UnavailableError);
}

#[tokio::test]
async fn test_bounded_response_handling() {
    let mock_server = common::start_mock_server().await;

    // Send body larger than MAX_RESPONSE_BYTES
    Mock::given(method("GET"))
        .and(path("/api/v1/envelopes"))
        .respond_with(
            ResponseTemplate::new(200).set_body_bytes(vec![b'A'; MAX_RESPONSE_BYTES + 1024]),
        )
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "list",
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::ValidationError);
}

#[tokio::test]
async fn test_non_json_error_body_multibyte_truncation_no_panic_or_leak() {
    let mock_server = common::start_mock_server().await;

    // 499 ASCII bytes, followed by 4-byte '🦀' ([0xF0, 0x9F, 0xA6, 0x80]), then trailing bytes.
    // Index 500 lands inside the 4-byte crab emoji, which would panic with simple &detail_text[..500].
    let mut body = vec![b'X'; 499];
    body.extend_from_slice("🦀--trailing-upstream-proxy-error--".as_bytes());
    assert!(body.len() > 500);

    Mock::given(method("GET"))
        .and(path("/api/v1/envelopes"))
        .respond_with(
            ResponseTemplate::new(502)
                .insert_header("content-type", "text/plain; charset=utf-8")
                .set_body_bytes(body),
        )
        .mount(&mock_server)
        .await;

    // 1. Binary execution regression test: verify exit code 8, no panic, no secret leakage
    let mut cmd = Command::cargo_bin("signkit").unwrap();
    let assert = cmd
        .args(["--base-url", &mock_server.uri(), "envelopes", "list"])
        .env("SIGNKIT_API_KEY", common::TEST_API_KEY)
        .assert()
        .code(8)
        .stdout(predicate::str::is_empty());

    let stderr_str = String::from_utf8(assert.get_output().stderr.clone()).unwrap();
    assert!(
        !stderr_str.contains(common::TEST_API_KEY),
        "API key secret must never leak in stderr"
    );
    assert!(
        !stderr_str.contains("panicked"),
        "CLI must not panic when error detail crosses a multi-byte boundary"
    );

    // Verify valid RFC 9457 JSON problem document in stderr
    let problem: serde_json::Value = serde_json::from_str(&stderr_str)
        .expect("stderr must be valid RFC 9457 ProblemDetail JSON");
    assert_eq!(problem["status"], 502);
    assert_eq!(problem["type"], "urn:signkit:problem:http-502");
    assert_eq!(problem["title"], "Bad Gateway");
    let detail = problem["detail"].as_str().expect("detail must be a string");
    assert_eq!(detail, format!("{}...", "X".repeat(499)));

    // 2. In-process execution: verify run_cli returns ExitCode::UnavailableError
    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "list",
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::UnavailableError);
}
