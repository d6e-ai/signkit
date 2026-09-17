mod common;

use clap::Parser;
use signkit_cli::args::Cli;
use signkit_cli::error::ExitCode;
use signkit_cli::run_cli;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn test_envelope_deliveries_success() {
    let mock_server = common::start_mock_server().await;

    let response_json = format!(
        r#"{{
            "delivery": {{
                "envelopeId": "{id}",
                "envelopeStatus": "sent",
                "deliveries": [
                    {{
                        "recipientId": "0191b26f-5000-7000-8000-000000000001",
                        "recipientRole": "signer",
                        "routingOrder": 1,
                        "status": "delivered",
                        "attempts": 1,
                        "availableAt": null,
                        "deliveredAt": "2026-09-13T10:15:00Z",
                        "updatedAt": "2026-09-13T10:15:00Z",
                        "errorCode": null
                    }},
                    {{
                        "recipientId": "0191b26f-5000-7000-8000-000000000002",
                        "recipientRole": "approver",
                        "routingOrder": 2,
                        "status": "blocked",
                        "attempts": 0,
                        "availableAt": null,
                        "deliveredAt": null,
                        "updatedAt": "2026-09-13T10:05:00Z",
                        "errorCode": null
                    }}
                ]
            }}
        }}"#,
        id = common::TEST_ENVELOPE_ID
    );

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/deliveries",
            common::TEST_ENVELOPE_ID
        )))
        .and(header(
            "authorization",
            format!("Bearer {}", common::TEST_API_KEY).as_str(),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_raw(response_json, "application/json"))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "deliveries",
        common::TEST_ENVELOPE_ID,
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::Success);
}

#[tokio::test]
async fn test_envelope_deliveries_not_found() {
    let mock_server = common::start_mock_server().await;

    let problem_json = r#"{
        "type": "urn:signkit:problem:envelope-not-found",
        "title": "Envelope not found",
        "status": 404,
        "detail": "No envelope was found in the authorized organization.",
        "instance": "/api/v1/envelopes/0191b26f-4000-7000-8000-000000000001/deliveries"
    }"#;

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/deliveries",
            common::TEST_ENVELOPE_ID
        )))
        .respond_with(
            ResponseTemplate::new(404).set_body_raw(problem_json, "application/problem+json"),
        )
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "deliveries",
        common::TEST_ENVELOPE_ID,
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::NotFoundError);
}
