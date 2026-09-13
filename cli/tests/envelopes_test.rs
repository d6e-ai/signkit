mod common;

use clap::Parser;
use signkit_cli::args::Cli;
use signkit_cli::error::ExitCode;
use signkit_cli::run_cli;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, ResponseTemplate};

fn envelope_json(id: &str) -> String {
    format!(
        r#"{{
            "id": "{id}",
            "organizationId": "{}",
            "title": "Mutual Non-Disclosure Agreement",
            "status": "draft",
            "repositoryGeneration": 1,
            "repositoryHead": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
            "repositoryArchiveKey": null,
            "repositoryArchiveSha256": null,
            "sentCommitSha": null,
            "fieldGeneration": 0,
            "createdAt": "2026-09-13T10:00:00Z",
            "updatedAt": "2026-09-13T10:05:00Z"
        }}"#,
        common::TEST_ORG
    )
}

#[tokio::test]
async fn test_envelopes_list_single_page() {
    let mock_server = common::start_mock_server().await;

    let response_json = format!(
        r#"{{
            "items": [{}],
            "nextCursor": null
        }}"#,
        envelope_json(common::TEST_ENVELOPE_ID)
    );

    Mock::given(method("GET"))
        .and(path("/api/v1/envelopes"))
        .and(query_param("limit", "50"))
        .and(header("signkit-organization-id", common::TEST_ORG))
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
        "--org",
        common::TEST_ORG,
        "envelopes",
        "list",
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::Success);
}

#[tokio::test]
async fn test_envelopes_list_with_cursor_and_limit() {
    let mock_server = common::start_mock_server().await;

    let response_json = format!(
        r#"{{
            "items": [{}],
            "nextCursor": null
        }}"#,
        envelope_json(common::TEST_ENVELOPE_ID_2)
    );

    Mock::given(method("GET"))
        .and(path("/api/v1/envelopes"))
        .and(query_param("limit", "25"))
        .and(query_param("cursor", common::TEST_ENVELOPE_ID))
        .and(header("signkit-organization-id", common::TEST_ORG))
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
        "--org",
        common::TEST_ORG,
        "envelopes",
        "list",
        "--limit",
        "25",
        "--cursor",
        common::TEST_ENVELOPE_ID,
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::Success);
}

#[tokio::test]
async fn test_envelopes_list_rejects_invalid_cursor_uuidv7() {
    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://localhost:5173",
        "--org",
        common::TEST_ORG,
        "envelopes",
        "list",
        "--cursor",
        "not-a-valid-cursor",
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::UsageError);

    // Uppercase cursor rejected (must be canonical lowercase)
    let cli2 = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://localhost:5173",
        "--org",
        common::TEST_ORG,
        "envelopes",
        "list",
        "--cursor",
        "0191B26F-4000-7000-8000-000000000001",
    ]);
    let exit_code2 = run_cli(cli2).await;
    assert_eq!(exit_code2, ExitCode::UsageError);
}

#[tokio::test]
async fn test_envelope_get_success() {
    let mock_server = common::start_mock_server().await;

    let response_json = format!(
        r#"{{
            "envelope": {}
        }}"#,
        envelope_json(common::TEST_ENVELOPE_ID)
    );

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}",
            common::TEST_ENVELOPE_ID
        )))
        .and(header("signkit-organization-id", common::TEST_ORG))
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
        "--org",
        common::TEST_ORG,
        "envelopes",
        "get",
        common::TEST_ENVELOPE_ID,
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::Success);
}

#[tokio::test]
async fn test_envelope_get_not_found() {
    let mock_server = common::start_mock_server().await;

    let problem_json = r#"{
        "type": "urn:signkit:problem:envelope-not-found",
        "title": "Envelope not found",
        "status": 404,
        "detail": "No envelope was found in the authorized organization.",
        "instance": "/api/v1/envelopes/0191b26f-4000-7000-8000-000000000001"
    }"#;

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}",
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
        "--org",
        common::TEST_ORG,
        "envelopes",
        "get",
        common::TEST_ENVELOPE_ID,
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::NotFoundError);
}

#[tokio::test]
async fn test_envelope_get_invalid_uuid() {
    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://localhost:5173",
        "--org",
        common::TEST_ORG,
        "envelopes",
        "get",
        "not-a-valid-uuid",
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::UsageError);

    // Uppercase rejected
    let cli_upper = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://localhost:5173",
        "--org",
        common::TEST_ORG,
        "envelopes",
        "get",
        "0191B26F-4000-7000-8000-000000000001",
    ]);
    let exit_code_upper = run_cli(cli_upper).await;
    assert_eq!(exit_code_upper, ExitCode::UsageError);

    // UUIDv4 rejected (version digit is 4, not 7)
    let cli_v4 = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://localhost:5173",
        "--org",
        common::TEST_ORG,
        "envelopes",
        "get",
        "0191b26f-4000-4000-8000-000000000001",
    ]);
    let exit_code_v4 = run_cli(cli_v4).await;
    assert_eq!(exit_code_v4, ExitCode::UsageError);
}
