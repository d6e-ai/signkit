mod common;

use clap::Parser;
use signkit_cli::args::Cli;
use signkit_cli::error::ExitCode;
use signkit_cli::run_cli;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn test_envelope_draft_success() {
    let mock_server = common::start_mock_server().await;

    let response_json = r##"{
        "generation": 2,
        "commitSha": "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
        "archiveSha256": "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        "documents": [
            {
                "path": "documents/agreement.md",
                "content": "# Mutual Non-Disclosure Agreement\n\nThis agreement..."
            },
            {
                "path": "documents/exhibit_a.md",
                "content": "# Exhibit A\n\nScope of confidential information..."
            }
        ]
    }"##;

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/draft",
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
        "draft",
        common::TEST_ENVELOPE_ID,
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::Success);
}

#[tokio::test]
async fn test_envelope_draft_not_found() {
    let mock_server = common::start_mock_server().await;

    let problem_json = r#"{
        "type": "urn:signkit:problem:envelope-not-found",
        "title": "Envelope not found",
        "status": 404,
        "detail": "No envelope was found in the authorized organization.",
        "instance": "/api/v1/envelopes/0191b26f-4000-7000-8000-000000000001/draft"
    }"#;

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/draft",
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
        "draft",
        common::TEST_ENVELOPE_ID,
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::NotFoundError);
}
