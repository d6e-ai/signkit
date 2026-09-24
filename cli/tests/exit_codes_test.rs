mod common;

use assert_cmd::Command;
use predicates::prelude::*;
use std::time::Duration;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn test_process_exit_code_8_rate_limited_preserves_rfc9457_status() {
    let mock_server: MockServer = common::start_mock_server().await;
    let problem_json: &str = r#"{
        "type": "urn:signkit:problem:rate-limited",
        "title": "Too Many Requests",
        "status": 429,
        "detail": "Rate limit exceeded",
        "instance": "/api/v1/envelopes"
    }"#;

    Mock::given(method("GET"))
        .and(path("/api/v1/envelopes"))
        .respond_with(
            ResponseTemplate::new(429).set_body_raw(problem_json, "application/problem+json"),
        )
        .mount(&mock_server)
        .await;

    let mut cmd: Command = Command::cargo_bin("signkit").unwrap();
    let assert: assert_cmd::assert::Assert = cmd
        .args(["--base-url", &mock_server.uri(), "envelopes", "list"])
        .env("SIGNKIT_API_KEY", common::TEST_API_KEY)
        .assert()
        .code(8)
        .stdout(predicate::str::is_empty());

    let stderr_str: String = String::from_utf8(assert.get_output().stderr.clone()).unwrap();
    let problem: serde_json::Value =
        serde_json::from_str(&stderr_str).expect("stderr must be RFC 9457 JSON");
    assert_eq!(problem["status"], 429);
}

#[tokio::test]
async fn test_process_exit_code_9_server_unavailable_preserves_rfc9457_status() {
    let mock_server: MockServer = common::start_mock_server().await;
    let problem_json: &str = r#"{
        "type": "urn:signkit:problem:service-unavailable",
        "title": "Service Unavailable",
        "status": 503,
        "detail": "Capabilities temporarily unavailable",
        "instance": "/api/v1/system/capabilities"
    }"#;

    Mock::given(method("GET"))
        .and(path("/api/v1/system/capabilities"))
        .respond_with(
            ResponseTemplate::new(503).set_body_raw(problem_json, "application/problem+json"),
        )
        .mount(&mock_server)
        .await;

    let mut cmd: Command = Command::cargo_bin("signkit").unwrap();
    let assert: assert_cmd::assert::Assert = cmd
        .args(["--base-url", &mock_server.uri(), "capabilities"])
        .assert()
        .code(9)
        .stdout(predicate::str::is_empty());

    let stderr_str: String = String::from_utf8(assert.get_output().stderr.clone()).unwrap();
    let problem: serde_json::Value =
        serde_json::from_str(&stderr_str).expect("stderr must be RFC 9457 JSON");
    assert_eq!(problem["status"], 503);
}

#[tokio::test]
async fn test_process_exit_code_10_transport_failure() {
    // Bind then drop a listener to obtain a reliably closed local port.
    let listener: std::net::TcpListener =
        std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let addr: std::net::SocketAddr = listener.local_addr().expect("local addr");
    let port: u16 = addr.port();
    drop(listener);
    let base_url: String = format!("http://127.0.0.1:{port}");

    let mut cmd: Command = Command::cargo_bin("signkit").unwrap();
    let assert: assert_cmd::assert::Assert = cmd
        .args(["--base-url", &base_url, "envelopes", "list"])
        .env("SIGNKIT_API_KEY", common::TEST_API_KEY)
        .assert()
        .code(10)
        .stdout(predicate::str::is_empty());

    let stderr_str: String = String::from_utf8(assert.get_output().stderr.clone()).unwrap();
    let problem: serde_json::Value =
        serde_json::from_str(&stderr_str).expect("stderr must be RFC 9457 JSON");
    assert_eq!(problem["type"], "urn:signkit:cli:problem:network-error");
}

#[tokio::test]
async fn test_process_exit_code_11_timeout() {
    let mock_server: MockServer = common::start_mock_server().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/envelopes"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(1500))
                .set_body_raw(r#"{"items":[],"nextCursor":null}"#, "application/json"),
        )
        .mount(&mock_server)
        .await;

    let mut cmd: Command = Command::cargo_bin("signkit").unwrap();
    let assert: assert_cmd::assert::Assert = cmd
        .args([
            "--base-url",
            &mock_server.uri(),
            "--timeout",
            "1",
            "envelopes",
            "list",
        ])
        .env("SIGNKIT_API_KEY", common::TEST_API_KEY)
        .assert()
        .code(11)
        .stdout(predicate::str::is_empty());

    let stderr_str: String = String::from_utf8(assert.get_output().stderr.clone()).unwrap();
    let problem: serde_json::Value =
        serde_json::from_str(&stderr_str).expect("stderr must be RFC 9457 JSON");
    assert_eq!(problem["type"], "urn:signkit:cli:problem:request-timeout");
}

#[tokio::test]
async fn test_process_exit_code_12_redirect_refused_preserves_rfc9457_status() {
    let mock_server: MockServer = common::start_mock_server().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/envelopes"))
        .respond_with(
            ResponseTemplate::new(302)
                .insert_header("location", "https://untrusted.example.com/steal-auth"),
        )
        .mount(&mock_server)
        .await;

    let mut cmd: Command = Command::cargo_bin("signkit").unwrap();
    let assert: assert_cmd::assert::Assert = cmd
        .args(["--base-url", &mock_server.uri(), "envelopes", "list"])
        .env("SIGNKIT_API_KEY", common::TEST_API_KEY)
        .assert()
        .code(12)
        .stdout(predicate::str::is_empty());

    let stderr_str: String = String::from_utf8(assert.get_output().stderr.clone()).unwrap();
    let problem: serde_json::Value =
        serde_json::from_str(&stderr_str).expect("stderr must be RFC 9457 JSON");
    assert_eq!(problem["type"], "urn:signkit:cli:problem:redirect-refused");
    assert!(
        !stderr_str.contains(common::TEST_API_KEY),
        "API key secret must never leak in stderr"
    );
}
