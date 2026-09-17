mod common;

use clap::Parser;
use signkit_cli::args::Cli;
use signkit_cli::error::ExitCode;
use signkit_cli::run_cli;
use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn test_capabilities_success() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/system/capabilities"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_raw(common::sample_capabilities_json(), "application/json"),
        )
        .mount(&mock_server)
        .await;

    let cli = Cli::parse_from(["signkit", "--base-url", &mock_server.uri(), "capabilities"]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::Success);
}

#[tokio::test]
async fn test_capabilities_raw_output() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/system/capabilities"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_raw(common::sample_capabilities_json(), "application/json"),
        )
        .mount(&mock_server)
        .await;

    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "--raw",
        "capabilities",
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::Success);
}

#[tokio::test]
async fn test_capabilities_sends_no_auth_header_even_when_configured() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/system/capabilities"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_raw(common::sample_capabilities_json(), "application/json"),
        )
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;

    let cli = Cli::parse_from(["signkit", "--base-url", &mock_server.uri(), "capabilities"]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::Success);

    let requests = mock_server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let req = &requests[0];

    // Capabilities MUST NOT send authorization headers.
    assert!(
        !req.headers
            .contains_key(wiremock::http::HeaderName::from_static("authorization")),
        "Capabilities request must NOT include Authorization header"
    );
    // User-Agent must be present and match signkit-cli
    let ua = req
        .headers
        .get(wiremock::http::HeaderName::from_static("user-agent"))
        .unwrap()
        .to_str()
        .unwrap();
    assert!(ua.starts_with("signkit-cli/"));
}

#[tokio::test]
async fn test_capabilities_service_unavailable() {
    let mock_server = common::start_mock_server().await;

    let problem_json = r#"{
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

    let cli = Cli::parse_from(["signkit", "--base-url", &mock_server.uri(), "capabilities"]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::UnavailableError);
}
