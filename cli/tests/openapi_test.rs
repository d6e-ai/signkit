mod common;

use clap::Parser;
use signkit_cli::args::Cli;
use signkit_cli::error::ExitCode;
use signkit_cli::run_cli;
use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

fn sample_openapi_json() -> &'static str {
    r#"{
      "openapi": "3.1.0",
      "info": {
        "title": "SignKit API",
        "version": "1.0.0",
        "description": "SignKit OpenAPI Specification"
      },
      "servers": [
        { "url": "http://localhost:3000", "description": "Local test server" }
      ],
      "tags": [
        { "name": "Envelopes", "description": "Envelope lifecycle" }
      ],
      "paths": {
        "/api/v1/openapi.json": {
          "get": {
            "summary": "Retrieve OpenAPI specification",
            "responses": {
              "200": { "description": "OpenAPI 3.1 document" }
            }
          }
        }
      },
      "components": {
        "schemas": {
          "DraftWorkspaceSnapshot": {
            "type": "object",
            "required": ["generation", "documents"]
          }
        },
        "securitySchemes": {}
      }
    }"#
}

#[tokio::test]
async fn test_openapi_success() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/openapi.json"))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw(sample_openapi_json(), "application/json"),
        )
        .mount(&mock_server)
        .await;

    let cli = Cli::parse_from(["signkit", "--base-url", &mock_server.uri(), "openapi"]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::Success);
}

#[tokio::test]
async fn test_openapi_raw_output() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/openapi.json"))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw(sample_openapi_json(), "application/json"),
        )
        .mount(&mock_server)
        .await;

    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "--raw",
        "openapi",
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::Success);
}

#[tokio::test]
async fn test_openapi_sends_no_auth_header_even_when_configured() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/openapi.json"))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw(sample_openapi_json(), "application/json"),
        )
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;

    let cli = Cli::parse_from(["signkit", "--base-url", &mock_server.uri(), "openapi"]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::Success);

    let requests = mock_server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let req = &requests[0];

    // OpenAPI retrieval MUST NOT send authorization headers.
    assert!(
        !req.headers
            .contains_key(wiremock::http::HeaderName::from_static("authorization")),
        "OpenAPI request must NOT include Authorization header"
    );
    let ua = req
        .headers
        .get(wiremock::http::HeaderName::from_static("user-agent"))
        .unwrap()
        .to_str()
        .unwrap();
    assert!(ua.starts_with("signkit-cli/"));
}

#[tokio::test]
async fn test_openapi_service_unavailable() {
    let mock_server = common::start_mock_server().await;

    let problem_json = r#"{
        "type": "urn:signkit:problem:service-unavailable",
        "title": "Service Unavailable",
        "status": 503,
        "detail": "OpenAPI spec endpoint temporarily unavailable",
        "instance": "/api/v1/openapi.json"
    }"#;

    Mock::given(method("GET"))
        .and(path("/api/v1/openapi.json"))
        .respond_with(
            ResponseTemplate::new(503).set_body_raw(problem_json, "application/problem+json"),
        )
        .mount(&mock_server)
        .await;

    let cli = Cli::parse_from(["signkit", "--base-url", &mock_server.uri(), "openapi"]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::ServerUnavailableError);
}
