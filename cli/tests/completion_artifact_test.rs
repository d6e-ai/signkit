mod common;

use clap::Parser;
use signkit_cli::args::Cli;
use signkit_cli::error::ExitCode;
use signkit_cli::run_cli;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn test_completion_artifact_published() {
    let mock_server = common::start_mock_server().await;

    let response_json = format!(
        r#"{{
            "completionArtifact": {{
                "envelopeId": "{id}",
                "status": "published",
                "publishedAt": "2026-09-13T11:00:00Z",
                "manifestSha256": "111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000",
                "jsonSha256": "22223333444455556666777788889999aaaabbbbccccddddeeeeffff00001111",
                "markdownSha256": "3333444455556666777788889999aaaabbbbccccddddeeeeffff000011112222"
            }}
        }}"#,
        id = common::TEST_ENVELOPE_ID
    );

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/completion-artifact",
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
        "completion-artifact",
        common::TEST_ENVELOPE_ID,
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::Success);
}

#[tokio::test]
async fn test_completion_artifact_pending() {
    let mock_server = common::start_mock_server().await;

    let response_json = format!(
        r#"{{
            "completionArtifact": {{
                "envelopeId": "{id}",
                "status": "pending",
                "attempts": 1
            }}
        }}"#,
        id = common::TEST_ENVELOPE_ID
    );

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/completion-artifact",
            common::TEST_ENVELOPE_ID
        )))
        .respond_with(ResponseTemplate::new(200).set_body_raw(response_json, "application/json"))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "completion-artifact",
        common::TEST_ENVELOPE_ID,
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::Success);
}

#[tokio::test]
async fn test_completion_artifact_failed() {
    let mock_server = common::start_mock_server().await;

    let response_json = format!(
        r#"{{
            "completionArtifact": {{
                "envelopeId": "{id}",
                "status": "failed",
                "attempts": 3,
                "errorCode": "evidence_digest_mismatch",
                "availableAt": "2026-09-13T12:00:00Z"
            }}
        }}"#,
        id = common::TEST_ENVELOPE_ID
    );

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/completion-artifact",
            common::TEST_ENVELOPE_ID
        )))
        .respond_with(ResponseTemplate::new(200).set_body_raw(response_json, "application/json"))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "completion-artifact",
        common::TEST_ENVELOPE_ID,
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::Success);
}
