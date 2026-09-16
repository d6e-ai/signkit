mod common;

use clap::Parser;
use signkit_cli::args::Cli;
use signkit_cli::error::ExitCode;
use signkit_cli::run_cli;
use std::io::Write;
use wiremock::matchers::{body_json, header, method, path};
use wiremock::{Mock, ResponseTemplate};

fn envelope_json() -> String {
    format!(
        r#"{{
            "id": "{}",
            "title": "Agreement",
            "status": "draft",
            "repositoryGeneration": 0,
            "repositoryHead": null,
            "repositoryArchiveSha256": null,
            "sentCommitSha": null,
            "fieldGeneration": 0,
            "createdAt": "2026-09-13T10:00:00Z",
            "updatedAt": "2026-09-13T10:05:00Z"
        }}"#,
        common::TEST_ENVELOPE_ID
    )
}

#[tokio::test]
async fn test_envelopes_create_with_title() {
    let mock_server = common::start_mock_server().await;
    let response_json = format!(r#"{{"envelope":{}}}"#, envelope_json());

    Mock::given(method("POST"))
        .and(path("/api/v1/envelopes"))
        .and(header(
            "authorization",
            format!("Bearer {}", common::TEST_API_KEY).as_str(),
        ))
        .and(header("idempotency-key", "create-1"))
        .and(body_json(serde_json::json!({"title":"Agreement"})))
        .respond_with(ResponseTemplate::new(201).set_body_raw(response_json, "application/json"))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "create",
        "--title",
        "Agreement",
        "--idempotency-key",
        "create-1",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_envelopes_commit_from_file() {
    let mock_server = common::start_mock_server().await;
    let mut file = tempfile::NamedTempFile::new().unwrap();
    write!(
        file,
        r##"{{
            "expectedGeneration": 0,
            "message": "Initial draft",
            "edits": [{{"path":"documents/agreement.md","content":"Agreement"}}]
        }}"##
    )
    .unwrap();

    Mock::given(method("POST"))
        .and(path(format!(
            "/api/v1/envelopes/{}/draft/commits",
            common::TEST_ENVELOPE_ID
        )))
        .and(header("idempotency-key", "commit-1"))
        .respond_with(ResponseTemplate::new(201).set_body_raw(
            r#"{"revision":{"generation":1,"commitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","archiveSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}"#,
            "application/json",
        ))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "commit",
        common::TEST_ENVELOPE_ID,
        "--file",
        file.path().to_str().unwrap(),
        "--idempotency-key",
        "commit-1",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_envelopes_void_conflict_uses_existing_exit_code() {
    let mock_server = common::start_mock_server().await;
    let mut file = tempfile::NamedTempFile::new().unwrap();
    write!(
        file,
        r#"{{"expectedStatus":"sent","expectedGeneration":3}}"#
    )
    .unwrap();

    Mock::given(method("POST"))
        .and(path(format!(
            "/api/v1/envelopes/{}/void",
            common::TEST_ENVELOPE_ID
        )))
        .respond_with(ResponseTemplate::new(409).set_body_raw(
            r#"{
                "type":"urn:signkit:problem:envelope-void-status-conflict",
                "title":"Envelope state conflict",
                "status":409,
                "detail":"The envelope status changed after the caller read it.",
                "instance":"/api/v1/envelopes/0191b26f-4000-7000-8000-000000000001/void"
            }"#,
            "application/problem+json",
        ))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "void",
        common::TEST_ENVELOPE_ID,
        "--file",
        file.path().to_str().unwrap(),
        "--idempotency-key",
        "void-1",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::ConflictError);
}

#[tokio::test]
async fn test_envelopes_audit_reads_completion_artifact_status() {
    let mock_server = common::start_mock_server().await;
    let body = format!(
        r#"{{"completionArtifact":{{"status":"not_completed","envelopeId":"{}"}}}}"#,
        common::TEST_ENVELOPE_ID
    );

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/completion-artifact",
            common::TEST_ENVELOPE_ID
        )))
        .respond_with(ResponseTemplate::new(200).set_body_raw(body, "application/json"))
        .expect(1)
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "audit",
        common::TEST_ENVELOPE_ID,
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_envelopes_create_requires_title_or_file() {
    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://127.0.0.1:9",
        "envelopes",
        "create",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
}
