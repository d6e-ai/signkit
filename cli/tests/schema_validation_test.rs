mod common;

use clap::Parser;
use signkit_cli::args::Cli;
use signkit_cli::error::ExitCode;
use signkit_cli::run_cli;
use signkit_cli::validation::{
    validate_commit_payload, validate_fields_payload, validate_ready_payload,
};
use std::io::Write;
use tempfile::NamedTempFile;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn test_example_flags_work_offline_without_credentials() {
    // Neither SIGNKIT_BASE_URL nor SIGNKIT_API_KEY is configured.
    let _env =
        common::EnvScope::new(&[("SIGNKIT_BASE_URL", None), ("SIGNKIT_API_KEY", None)]).await;

    let mutation_commands = ["commit", "ready", "fields", "send", "void"];
    for cmd in mutation_commands {
        let cli = Cli::parse_from(["signkit", "envelopes", cmd, "--example"]);
        let exit_code = run_cli(cli).await;
        assert_eq!(
            exit_code,
            ExitCode::Success,
            "Failed running signkit envelopes {cmd} --example"
        );
    }
}

#[tokio::test]
async fn test_validate_only_works_offline_without_credentials() {
    let _env =
        common::EnvScope::new(&[("SIGNKIT_BASE_URL", None), ("SIGNKIT_API_KEY", None)]).await;

    // 1. Commit validate-only
    let mut commit_file = NamedTempFile::new().unwrap();
    commit_file
        .write_all(
            r##"{
            "expectedGeneration": 0,
            "message": "Valid commit message",
            "edits": [
                {"path": "documents/agreement.md", "content": "# Agreement Content"}
            ],
            "provenance": {
                "automationRunId": "run-123",
                "externalId": "step-1"
            }
        }"##
            .as_bytes(),
        )
        .unwrap();

    let cli = Cli::parse_from([
        "signkit",
        "envelopes",
        "commit",
        "--validate-only",
        "--file",
        commit_file.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);

    // 2. Ready validate-only
    let mut ready_file = NamedTempFile::new().unwrap();
    ready_file
        .write_all(
            r#"{
            "expectedGeneration": 1,
            "recipients": [
                {
                    "email": "signer@example.com",
                    "name": "Signer Person",
                    "role": "signer",
                    "locale": "en",
                    "routingOrder": 1
                }
            ]
        }"#
            .as_bytes(),
        )
        .unwrap();

    let cli = Cli::parse_from([
        "signkit",
        "envelopes",
        "ready",
        "--validate-only",
        "--file",
        ready_file.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);

    // 3. Fields validate-only
    let mut fields_file = NamedTempFile::new().unwrap();
    fields_file
        .write_all(
            r#"{
            "expectedGeneration": 1,
            "expectedFieldGeneration": 0,
            "fields": [
                {
                    "recipientId": "0191b26f-4000-7000-8000-000000000001",
                    "documentId": "0191b26f-4000-7000-8000-000000000002",
                    "fieldType": "signature",
                    "label": "Primary Signature",
                    "required": true,
                    "position": 0,
                    "geometry": {
                        "page": 1,
                        "x": 0.2,
                        "y": 0.8,
                        "width": 0.3,
                        "height": 0.05
                    }
                }
            ]
        }"#
            .as_bytes(),
        )
        .unwrap();

    let cli = Cli::parse_from([
        "signkit",
        "envelopes",
        "fields",
        "--validate-only",
        "--file",
        fields_file.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);

    // 4. Send validate-only
    let mut send_file = NamedTempFile::new().unwrap();
    send_file
        .write_all(
            r#"{
            "expectedGeneration": 1,
            "expectedReadyAuditEventId": "0191b26f-4000-7000-8000-000000000003"
        }"#
            .as_bytes(),
        )
        .unwrap();

    let cli = Cli::parse_from([
        "signkit",
        "envelopes",
        "send",
        "--validate-only",
        "--file",
        send_file.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);

    // 5. Void validate-only
    let mut void_file = NamedTempFile::new().unwrap();
    void_file
        .write_all(
            r#"{
            "expectedStatus": "sent",
            "expectedGeneration": 2
        }"#
            .as_bytes(),
        )
        .unwrap();

    let cli = Cli::parse_from([
        "signkit",
        "envelopes",
        "void",
        "--validate-only",
        "--file",
        void_file.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_validate_only_cannot_issue_network_mutations() {
    let mock_server = common::start_mock_server().await;

    // Deliberately DO NOT mount any mocks on mock_server.
    // If a request was attempted, mock_server would record it.
    let mut file = NamedTempFile::new().unwrap();
    file.write_all(
        r##"{
            "expectedGeneration": 0,
            "message": "Commit to validate",
            "edits": [
                {"path": "documents/agreement.md", "content": "Agreement text"}
            ]
        }"##
        .as_bytes(),
    )
    .unwrap();

    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "commit",
        common::TEST_ENVELOPE_ID,
        "--validate-only",
        "--file",
        file.path().to_str().unwrap(),
    ]);

    let exit_code = run_cli(cli).await;
    assert_eq!(exit_code, ExitCode::Success);

    // Physically verify 0 network requests occurred
    let requests = mock_server.received_requests().await.unwrap();
    assert_eq!(
        requests.len(),
        0,
        "No network requests should be issued during --validate-only"
    );
}

#[tokio::test]
async fn test_validate_only_rejects_invalid_payloads_with_exit_code_2() {
    let _env =
        common::EnvScope::new(&[("SIGNKIT_BASE_URL", None), ("SIGNKIT_API_KEY", None)]).await;

    // 1. Missing message in commit payload
    let mut bad_commit = NamedTempFile::new().unwrap();
    bad_commit
        .write_all(
            r#"{
            "expectedGeneration": 0,
            "edits": [{"path": "documents/agreement.md", "content": "test"}]
        }"#
            .as_bytes(),
        )
        .unwrap();
    let cli = Cli::parse_from([
        "signkit",
        "envelopes",
        "commit",
        "--validate-only",
        "--file",
        bad_commit.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);

    // 2. Trailing/invalid path in edit (path traversal)
    let mut bad_path = NamedTempFile::new().unwrap();
    bad_path
        .write_all(
            r#"{
            "expectedGeneration": 0,
            "message": "test",
            "edits": [{"path": "documents/../secret.txt", "content": "test"}]
        }"#
            .as_bytes(),
        )
        .unwrap();
    let cli = Cli::parse_from([
        "signkit",
        "envelopes",
        "commit",
        "--validate-only",
        "--file",
        bad_path.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);

    // 3. Duplicate recipient emails in ready payload
    let mut dup_ready = NamedTempFile::new().unwrap();
    dup_ready.write_all(
        r#"{
            "expectedGeneration": 1,
            "recipients": [
                {"email": "signer@example.com", "name": "Signer 1", "role": "signer", "locale": "en", "routingOrder": 1},
                {"email": "signer@example.com", "name": "Signer 2", "role": "signer", "locale": "en", "routingOrder": 2}
            ]
        }"#.as_bytes()
    ).unwrap();
    let cli = Cli::parse_from([
        "signkit",
        "envelopes",
        "ready",
        "--validate-only",
        "--file",
        dup_ready.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);

    // 4. Viewer alone in routing order without actionable recipient
    let mut viewer_only = NamedTempFile::new().unwrap();
    viewer_only.write_all(
        r#"{
            "expectedGeneration": 1,
            "recipients": [
                {"email": "signer@example.com", "name": "Signer", "role": "signer", "locale": "en", "routingOrder": 1},
                {"email": "viewer@example.com", "name": "Viewer", "role": "viewer", "locale": "en", "routingOrder": 2}
            ]
        }"#.as_bytes()
    ).unwrap();
    let cli = Cli::parse_from([
        "signkit",
        "envelopes",
        "ready",
        "--validate-only",
        "--file",
        viewer_only.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);

    // 5. Fields out of bounds geometry (x > 1.0)
    let mut bad_geom = NamedTempFile::new().unwrap();
    bad_geom
        .write_all(
            r#"{
            "expectedGeneration": 1,
            "expectedFieldGeneration": 0,
            "fields": [
                {
                    "recipientId": "0191b26f-4000-7000-8000-000000000001",
                    "documentId": "0191b26f-4000-7000-8000-000000000002",
                    "fieldType": "signature",
                    "label": "Sig",
                    "required": true,
                    "position": 0,
                    "geometry": {
                        "page": 1,
                        "x": 1.5,
                        "y": 0.5,
                        "width": 0.2,
                        "height": 0.1
                    }
                }
            ]
        }"#
            .as_bytes(),
        )
        .unwrap();
    let cli = Cli::parse_from([
        "signkit",
        "envelopes",
        "fields",
        "--validate-only",
        "--file",
        bad_geom.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);

    // 6. Duplicate field placement locators
    let mut dup_field = NamedTempFile::new().unwrap();
    dup_field
        .write_all(
            r#"{
            "expectedGeneration": 1,
            "expectedFieldGeneration": 0,
            "fields": [
                {
                    "recipientId": "0191b26f-4000-7000-8000-000000000001",
                    "documentId": "0191b26f-4000-7000-8000-000000000002",
                    "fieldType": "signature",
                    "label": "Sig 1",
                    "required": true,
                    "position": 0,
                    "geometry": {"page": 1, "x": 0.1, "y": 0.1, "width": 0.2, "height": 0.1}
                },
                {
                    "recipientId": "0191b26f-4000-7000-8000-000000000001",
                    "documentId": "0191b26f-4000-7000-8000-000000000002",
                    "fieldType": "text",
                    "label": "Text 1",
                    "required": false,
                    "position": 0,
                    "geometry": {"page": 1, "x": 0.1, "y": 0.3, "width": 0.2, "height": 0.1}
                }
            ]
        }"#
            .as_bytes(),
        )
        .unwrap();
    let cli = Cli::parse_from([
        "signkit",
        "envelopes",
        "fields",
        "--validate-only",
        "--file",
        dup_field.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);

    // 7. Invalid envelope_id format with validate-only
    let mut valid_file = NamedTempFile::new().unwrap();
    valid_file
        .write_all(
            r#"{
            "expectedStatus": "sent",
            "expectedGeneration": 1
        }"#
            .as_bytes(),
        )
        .unwrap();
    let cli = Cli::parse_from([
        "signkit",
        "envelopes",
        "void",
        "not-a-valid-uuid",
        "--validate-only",
        "--file",
        valid_file.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
}

#[tokio::test]
async fn test_local_validation_runs_before_network_in_normal_mutation() {
    let mock_server = common::start_mock_server().await;

    // Do NOT mount any mock on server.
    let mut bad_file = NamedTempFile::new().unwrap();
    bad_file
        .write_all(
            r#"{
            "expectedStatus": "nonexistent_status",
            "expectedGeneration": 1
        }"#
            .as_bytes(),
        )
        .unwrap();

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "void",
        common::TEST_ENVELOPE_ID,
        "--file",
        bad_file.path().to_str().unwrap(),
    ]);

    let exit_code = run_cli(cli).await;
    // Local validation must fail before sending any request to the network
    assert_eq!(exit_code, ExitCode::UsageError);

    let requests = mock_server.received_requests().await.unwrap();
    assert_eq!(
        requests.len(),
        0,
        "Server must NOT receive any request for a locally invalid payload"
    );
}

#[tokio::test]
async fn test_agent_multi_step_workflow() {
    let mock_server = common::start_mock_server().await;

    // Step 1: Agent inspects canonical example for ready payload
    let cli_example = Cli::parse_from(["signkit", "envelopes", "ready", "--example"]);
    assert_eq!(run_cli(cli_example).await, ExitCode::Success);

    // Step 2: Agent drafts payload and validates it offline with --validate-only
    let mut ready_file = NamedTempFile::new().unwrap();
    ready_file
        .write_all(
            r#"{
            "expectedGeneration": 1,
            "recipients": [
                {
                    "email": "primary_signer@example.com",
                    "name": "Alex Mercer",
                    "role": "signer",
                    "locale": "en",
                    "routingOrder": 1
                }
            ]
        }"#
            .as_bytes(),
        )
        .unwrap();

    let cli_val = Cli::parse_from([
        "signkit",
        "envelopes",
        "ready",
        common::TEST_ENVELOPE_ID,
        "--validate-only",
        "--file",
        ready_file.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli_val).await, ExitCode::Success);

    // Step 3: Agent executes mutation against live endpoint with valid idempotency key
    Mock::given(method("POST"))
        .and(path(format!(
            "/api/v1/envelopes/{}/ready",
            common::TEST_ENVELOPE_ID
        )))
        .and(header("idempotency-key", "ready-step-3"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            r#"{
                "ready": {
                    "envelopeId": "0191b26f-4000-7000-8000-000000000001",
                    "status": "ready",
                    "generation": 1,
                    "commitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "updatedAt": "2026-09-24T10:05:00Z",
                    "auditEventId": "0191b26f-4000-7000-8000-000000000003"
                }
            }"#,
            "application/json",
        ))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli_exec = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "ready",
        common::TEST_ENVELOPE_ID,
        "--file",
        ready_file.path().to_str().unwrap(),
        "--idempotency-key",
        "ready-step-3",
    ]);

    assert_eq!(run_cli(cli_exec).await, ExitCode::Success);
    let requests = mock_server.received_requests().await.unwrap();
    assert_eq!(
        requests.len(),
        1,
        "Exactly one network mutation should be dispatched"
    );
}

#[test]
fn test_local_validation_matches_unicode_and_normalized_markdown_limits() {
    let message: String = "契約書".repeat(60);
    let content: String = format!("{}\r\n", "a".repeat(512 * 1024 - 1));
    let payload: serde_json::Value = serde_json::json!({
        "expectedGeneration": 0,
        "message": message,
        "edits": [{"path": "documents/agreement.md", "content": content}]
    });
    let object: &serde_json::Map<String, serde_json::Value> = payload.as_object().unwrap();
    assert!(validate_commit_payload(object, None).is_ok());

    let ready: serde_json::Value = serde_json::json!({
        "expectedGeneration": 1,
        "recipients": [{
            "email": "signer@example.com",
            "name": "木村".repeat(90),
            "role": "signer",
            "locale": "ja",
            "routingOrder": 1
        }]
    });
    assert!(validate_ready_payload(ready.as_object().unwrap(), None).is_ok());
}

#[test]
fn test_local_field_type_matches_server_enum() {
    let payload: serde_json::Value = serde_json::json!({
        "expectedGeneration": 1,
        "expectedFieldGeneration": 0,
        "fields": [{
            "recipientId": "0191eb70-6523-74b2-b7b5-2fa75bb6d001",
            "documentId": "0191eb70-6523-74b2-b7b5-2fa75bb6d002",
            "fieldType": "date_signed",
            "label": "Date",
            "required": true,
            "position": 0,
            "geometry": {"page": 1, "x": 0.1, "y": 0.7, "width": 0.25, "height": 0.05}
        }]
    });
    assert!(validate_fields_payload(payload.as_object().unwrap(), None).is_err());
}
