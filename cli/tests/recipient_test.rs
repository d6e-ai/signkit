mod common;

use clap::Parser;
use signkit_cli::args::Cli;
use signkit_cli::error::ExitCode;
use signkit_cli::run_cli;
use std::io::Write;
use wiremock::matchers::{header, header_exists, method, path, query_param};
use wiremock::{Mock, ResponseTemplate};

fn context_json() -> String {
    format!(
        r#"{{
            "access": {{
                "envelopeId": "{envelope}",
                "recipientId": "{recipient}",
                "recipientName": "Jane Doe",
                "role": "signer",
                "locale": "en",
                "recipientStatus": "pending",
                "envelopeTitle": "Agreement",
                "envelopeStatus": "sent",
                "expiresAt": "2026-10-01T00:00:00Z"
            }}
        }}"#,
        envelope = common::TEST_ENVELOPE_ID,
        recipient = common::TEST_RECIPIENT_ID,
    )
}

fn documents_json() -> String {
    format!(
        r#"{{
            "access": {{
                "envelopeId": "{envelope}",
                "recipientId": "{recipient}",
                "recipientName": "Jane Doe",
                "role": "signer",
                "locale": "en",
                "recipientStatus": "pending",
                "envelopeTitle": "Agreement",
                "envelopeStatus": "sent",
                "expiresAt": "2026-10-01T00:00:00Z"
            }},
            "documents": [
                {{
                    "documentId": "{document}",
                    "position": 0,
                    "title": "Agreement",
                    "kind": "pdf",
                    "pageCount": 3,
                    "pageWidth": 612.0,
                    "pageHeight": 792.0
                }}
            ],
            "source": "document-set",
            "fields": [
                {{
                    "id": "{field}",
                    "documentId": "{document}",
                    "fieldType": "signature",
                    "label": "Signature",
                    "required": true,
                    "geometry": {{ "page": 1, "x": 0.1, "y": 0.7, "width": 0.25, "height": 0.05 }}
                }}
            ],
            "fieldGeneration": 0
        }}"#,
        envelope = common::TEST_ENVELOPE_ID,
        recipient = common::TEST_RECIPIENT_ID,
        document = common::TEST_DOCUMENT_ID,
        field = common::TEST_FIELD_ID,
    )
}

fn sign_payload_file() -> tempfile::NamedTempFile {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    write!(
        file,
        r#"{{
            "envelopeId": "{envelope}",
            "recipientId": "{recipient}",
            "expectedFieldGeneration": 0,
            "values": [{{ "fieldId": "{field}", "value": "Jane Doe" }}]
        }}"#,
        envelope = common::TEST_ENVELOPE_ID,
        recipient = common::TEST_RECIPIENT_ID,
        field = common::TEST_FIELD_ID,
    )
    .unwrap();
    file
}

fn action_payload_file() -> tempfile::NamedTempFile {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    write!(
        file,
        r#"{{ "envelopeId": "{envelope}", "recipientId": "{recipient}" }}"#,
        envelope = common::TEST_ENVELOPE_ID,
        recipient = common::TEST_RECIPIENT_ID,
    )
    .unwrap();
    file
}

// --- Credential source isolation -------------------------------------------------

#[tokio::test]
async fn test_recipient_command_requires_recipient_capability_not_api_key() {
    // Even with a valid sender API key present, a recipient command must fail
    // fast (no network call) without a recipient capability. Point at a closed
    // port so any accidental network attempt fails loudly rather than hanging.
    let _env = common::EnvScope::new(&[
        ("SIGNKIT_API_KEY", Some(common::TEST_API_KEY)),
        ("SIGNKIT_RECIPIENT_CAPABILITY", None),
    ])
    .await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://127.0.0.1:9",
        "recipient",
        "context",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
}

#[tokio::test]
async fn test_recipient_command_rejects_malformed_capability_without_network_call() {
    let _env = common::EnvScope::new(&[(
        "SIGNKIT_RECIPIENT_CAPABILITY",
        Some("signkit_not_a_recipient_token_abcdefghijklmnopqrstuvwx"),
    )])
    .await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://127.0.0.1:9",
        "recipient",
        "context",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
}

#[tokio::test]
async fn test_no_recipient_capability_command_line_flag_allowed() {
    let mut cmd = assert_cmd::Command::cargo_bin("signkit").unwrap();
    cmd.args([
        "--recipient-capability",
        common::TEST_RECIPIENT_CAPABILITY,
        "recipient",
        "context",
    ])
    .assert()
    .failure()
    .stderr(predicates::str::contains(
        "unexpected argument '--recipient-capability'",
    ));
}

#[tokio::test]
async fn test_recipient_capability_from_secure_stdin() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/recipient/context"))
        .and(header(
            "authorization",
            format!("Bearer {}", common::TEST_RECIPIENT_CAPABILITY).as_str(),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_raw(context_json(), "application/json"))
        .mount(&mock_server)
        .await;

    let mut cmd = assert_cmd::Command::cargo_bin("signkit").unwrap();
    cmd.args([
        "--base-url",
        &mock_server.uri(),
        "--recipient-capability-stdin",
        "recipient",
        "context",
    ])
    .write_stdin(format!("{}\n", common::TEST_RECIPIENT_CAPABILITY))
    .assert()
    .success();
}

// --- Context / documents / pdf ---------------------------------------------------

#[tokio::test]
async fn test_recipient_context_success() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/recipient/context"))
        .and(header(
            "authorization",
            format!("Bearer {}", common::TEST_RECIPIENT_CAPABILITY).as_str(),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_raw(context_json(), "application/json"))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[(
        "SIGNKIT_RECIPIENT_CAPABILITY",
        Some(common::TEST_RECIPIENT_CAPABILITY),
    )])
    .await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "recipient",
        "context",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_recipient_documents_success() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/recipient/documents"))
        .and(header(
            "authorization",
            format!("Bearer {}", common::TEST_RECIPIENT_CAPABILITY).as_str(),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_raw(documents_json(), "application/json"))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[(
        "SIGNKIT_RECIPIENT_CAPABILITY",
        Some(common::TEST_RECIPIENT_CAPABILITY),
    )])
    .await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "recipient",
        "documents",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_recipient_pdf_download_with_document_id() {
    let mock_server = common::start_mock_server().await;
    let temp_dir = tempfile::tempdir().unwrap();
    let output_path = temp_dir.path().join("agreement.pdf");

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/recipient/documents/{}.pdf",
            common::TEST_ENVELOPE_ID
        )))
        .and(query_param("documentId", common::TEST_DOCUMENT_ID))
        .and(header(
            "authorization",
            format!("Bearer {}", common::TEST_RECIPIENT_CAPABILITY).as_str(),
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/pdf")
                .set_body_bytes(b"%PDF-1.4 fake".to_vec()),
        )
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[(
        "SIGNKIT_RECIPIENT_CAPABILITY",
        Some(common::TEST_RECIPIENT_CAPABILITY),
    )])
    .await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "recipient",
        "pdf",
        common::TEST_ENVELOPE_ID,
        "--document-id",
        common::TEST_DOCUMENT_ID,
        "--output",
        output_path.to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
    assert!(output_path.exists());
}

#[tokio::test]
async fn test_recipient_pdf_omits_document_id_query_for_legacy() {
    let mock_server = common::start_mock_server().await;
    let temp_dir = tempfile::tempdir().unwrap();
    let output_path = temp_dir.path().join("agreement.pdf");

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/recipient/documents/{}.pdf",
            common::TEST_ENVELOPE_ID
        )))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/pdf")
                .set_body_bytes(b"%PDF-1.4 fake".to_vec()),
        )
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[(
        "SIGNKIT_RECIPIENT_CAPABILITY",
        Some(common::TEST_RECIPIENT_CAPABILITY),
    )])
    .await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "recipient",
        "pdf",
        common::TEST_ENVELOPE_ID,
        "--output",
        output_path.to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_recipient_pdf_rejects_invalid_document_id_without_network_call() {
    let _env = common::EnvScope::new(&[(
        "SIGNKIT_RECIPIENT_CAPABILITY",
        Some(common::TEST_RECIPIENT_CAPABILITY),
    )])
    .await;
    let temp_dir = tempfile::tempdir().unwrap();
    let output_path = temp_dir.path().join("agreement.pdf");
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://127.0.0.1:9",
        "recipient",
        "pdf",
        common::TEST_ENVELOPE_ID,
        "--document-id",
        "not-a-uuid",
        "--output",
        output_path.to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
    assert!(!output_path.exists());
}

#[tokio::test]
async fn test_recipient_pdf_never_writes_agreement_bytes_to_stdout() {
    let _env = common::EnvScope::new(&[(
        "SIGNKIT_RECIPIENT_CAPABILITY",
        Some(common::TEST_RECIPIENT_CAPABILITY),
    )])
    .await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://127.0.0.1:9",
        "recipient",
        "pdf",
        common::TEST_ENVELOPE_ID,
        "--output",
        "-",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
}

#[tokio::test]
async fn test_recipient_capability_stdin_requires_json_payload_file() {
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://127.0.0.1:9",
        "--recipient-capability-stdin",
        "recipient",
        "sign",
        "--consent",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
}

// --- Consent gating ----------------------------------------------------------------

#[tokio::test]
async fn test_recipient_viewed_requires_consent_without_network_call() {
    let _env = common::EnvScope::new(&[(
        "SIGNKIT_RECIPIENT_CAPABILITY",
        Some(common::TEST_RECIPIENT_CAPABILITY),
    )])
    .await;
    let file = action_payload_file();
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://127.0.0.1:9",
        "recipient",
        "viewed",
        "--file",
        file.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
}

#[tokio::test]
async fn test_recipient_sign_requires_consent_without_network_call() {
    let _env = common::EnvScope::new(&[(
        "SIGNKIT_RECIPIENT_CAPABILITY",
        Some(common::TEST_RECIPIENT_CAPABILITY),
    )])
    .await;
    let file = sign_payload_file();
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://127.0.0.1:9",
        "recipient",
        "sign",
        "--file",
        file.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
}

// --- Offline validate-only / example -------------------------------------------

#[tokio::test]
async fn test_recipient_viewed_example_prints_canonical_json_without_credential() {
    let mut cmd = assert_cmd::Command::cargo_bin("signkit").unwrap();
    cmd.args(["recipient", "viewed", "--example"])
        .env_remove("SIGNKIT_RECIPIENT_CAPABILITY")
        .env_remove("SIGNKIT_API_KEY")
        .assert()
        .success()
        .stdout(predicates::str::contains("envelopeId"))
        .stdout(predicates::str::contains("recipientId"));
}

#[tokio::test]
async fn test_recipient_sign_validate_only_succeeds_without_network_or_consent() {
    let _env = common::EnvScope::new(&[("SIGNKIT_RECIPIENT_CAPABILITY", None)]).await;
    let file = sign_payload_file();
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://127.0.0.1:9",
        "recipient",
        "sign",
        "--file",
        file.path().to_str().unwrap(),
        "--validate-only",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_recipient_sign_validate_only_rejects_bad_field_generation() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    write!(
        file,
        r#"{{
            "envelopeId": "{envelope}",
            "recipientId": "{recipient}",
            "expectedFieldGeneration": -1,
            "values": []
        }}"#,
        envelope = common::TEST_ENVELOPE_ID,
        recipient = common::TEST_RECIPIENT_ID,
    )
    .unwrap();
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://127.0.0.1:9",
        "recipient",
        "sign",
        "--file",
        file.path().to_str().unwrap(),
        "--validate-only",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
}

// --- Live mutation paths: success, replay, conflict, not found --------------------

#[tokio::test]
async fn test_recipient_viewed_success_with_consent() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("POST"))
        .and(path("/api/v1/recipient/viewed"))
        .and(header(
            "authorization",
            format!("Bearer {}", common::TEST_RECIPIENT_CAPABILITY).as_str(),
        ))
        .and(header_exists("idempotency-key"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            format!(
                r#"{{"viewed":{{"envelopeId":"{envelope}","recipientId":"{recipient}","recipientStatus":"viewed","envelopeStatus":"sent","viewedAt":"2026-09-25T00:00:00Z"}}}}"#,
                envelope = common::TEST_ENVELOPE_ID,
                recipient = common::TEST_RECIPIENT_ID,
            ),
            "application/json",
        ))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[(
        "SIGNKIT_RECIPIENT_CAPABILITY",
        Some(common::TEST_RECIPIENT_CAPABILITY),
    )])
    .await;
    let file = action_payload_file();
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "recipient",
        "viewed",
        "--file",
        file.path().to_str().unwrap(),
        "--consent",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_recipient_sign_replay_reports_success() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("POST"))
        .and(path("/api/v1/recipient/sign"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("idempotency-replayed", "true")
                .set_body_raw(
                    format!(
                        r#"{{"signed":{{"envelopeId":"{envelope}","recipientId":"{recipient}","recipientStatus":"completed","envelopeStatus":"completed","signedAt":"2026-09-25T00:00:00Z"}}}}"#,
                        envelope = common::TEST_ENVELOPE_ID,
                        recipient = common::TEST_RECIPIENT_ID,
                    ),
                    "application/json",
                ),
        )
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[(
        "SIGNKIT_RECIPIENT_CAPABILITY",
        Some(common::TEST_RECIPIENT_CAPABILITY),
    )])
    .await;
    let file = sign_payload_file();
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "recipient",
        "sign",
        "--file",
        file.path().to_str().unwrap(),
        "--consent",
        "--idempotency-key",
        "sign-replay-1",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_recipient_sign_field_generation_conflict_exit_code() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("POST"))
        .and(path("/api/v1/recipient/sign"))
        .respond_with(ResponseTemplate::new(409).set_body_raw(
            r#"{
                "type": "urn:signkit:problem:recipient-signed-field-generation-conflict",
                "title": "Field generation conflict",
                "status": 409,
                "detail": "The signing fields changed after this page was loaded.",
                "instance": "/api/v1/recipient/sign"
            }"#,
            "application/problem+json",
        ))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[(
        "SIGNKIT_RECIPIENT_CAPABILITY",
        Some(common::TEST_RECIPIENT_CAPABILITY),
    )])
    .await;
    let file = sign_payload_file();
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "recipient",
        "sign",
        "--file",
        file.path().to_str().unwrap(),
        "--consent",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::ConflictError);
}

#[tokio::test]
async fn test_recipient_approve_role_not_actionable_maps_to_not_found() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("POST"))
        .and(path("/api/v1/recipient/approve"))
        .respond_with(ResponseTemplate::new(404).set_body_raw(
            r#"{
                "type": "urn:signkit:problem:recipient-access-not-found",
                "title": "Recipient access not found",
                "status": 404,
                "detail": "No active recipient access was found.",
                "instance": "/api/v1/recipient/approve"
            }"#,
            "application/problem+json",
        ))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[(
        "SIGNKIT_RECIPIENT_CAPABILITY",
        Some(common::TEST_RECIPIENT_CAPABILITY),
    )])
    .await;
    let file = action_payload_file();
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "recipient",
        "approve",
        "--file",
        file.path().to_str().unwrap(),
        "--consent",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::NotFoundError);
}

#[tokio::test]
async fn test_recipient_decline_success_with_consent() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("POST"))
        .and(path("/api/v1/recipient/decline"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            format!(
                r#"{{"declined":{{"envelopeId":"{envelope}","recipientId":"{recipient}","recipientStatus":"declined","envelopeStatus":"declined","declinedAt":"2026-09-25T00:00:00Z"}}}}"#,
                envelope = common::TEST_ENVELOPE_ID,
                recipient = common::TEST_RECIPIENT_ID,
            ),
            "application/json",
        ))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[(
        "SIGNKIT_RECIPIENT_CAPABILITY",
        Some(common::TEST_RECIPIENT_CAPABILITY),
    )])
    .await;
    let file = action_payload_file();
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "recipient",
        "decline",
        "--file",
        file.path().to_str().unwrap(),
        "--consent",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

// --- Redirects, bounded bodies, and secret hygiene --------------------------------

#[tokio::test]
async fn test_recipient_context_refuses_redirect() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/recipient/context"))
        .respond_with(
            ResponseTemplate::new(302)
                .insert_header("location", "https://untrusted.example.com/steal-capability"),
        )
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[(
        "SIGNKIT_RECIPIENT_CAPABILITY",
        Some(common::TEST_RECIPIENT_CAPABILITY),
    )])
    .await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "recipient",
        "context",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::RedirectRefusedError);
}

#[tokio::test]
async fn test_recipient_error_detail_echoing_token_is_redacted() {
    let mock_server = common::start_mock_server().await;

    // A misbehaving/compromised server reflects the Authorization value back
    // in a problem detail. The CLI must never let that reach stderr verbatim.
    let leaking_detail = format!(
        "Rejected token Bearer {}",
        common::TEST_RECIPIENT_CAPABILITY
    );
    Mock::given(method("GET"))
        .and(path("/api/v1/recipient/context"))
        .respond_with(
            ResponseTemplate::new(400).set_body_raw(
                serde_json::json!({
                    "type": "urn:signkit:problem:example",
                    "title": "Bad request",
                    "status": 400,
                    "detail": leaking_detail,
                    "instance": "/api/v1/recipient/context"
                })
                .to_string(),
                "application/problem+json",
            ),
        )
        .mount(&mock_server)
        .await;

    let mut cmd = assert_cmd::Command::cargo_bin("signkit").unwrap();
    let assert = cmd
        .args(["--base-url", &mock_server.uri(), "recipient", "context"])
        .env(
            "SIGNKIT_RECIPIENT_CAPABILITY",
            common::TEST_RECIPIENT_CAPABILITY,
        )
        .env_remove("SIGNKIT_API_KEY")
        .assert()
        .code(7)
        .stdout(predicates::str::is_empty());

    let stderr_str = String::from_utf8(assert.get_output().stderr.clone()).unwrap();
    assert!(
        !stderr_str.contains(common::TEST_RECIPIENT_CAPABILITY),
        "recipient capability token must never leak in stderr, got: {stderr_str}"
    );
    assert!(stderr_str.contains("[REDACTED]"));
}

#[tokio::test]
async fn test_recipient_success_echoing_token_is_not_printed() {
    let mock_server = common::start_mock_server().await;
    let leaking_context = context_json().replace(
        "Jane Doe",
        &format!("Jane {}", common::TEST_RECIPIENT_CAPABILITY),
    );
    Mock::given(method("GET"))
        .and(path("/api/v1/recipient/context"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(leaking_context, "application/json"))
        .mount(&mock_server)
        .await;

    let mut cmd = assert_cmd::Command::cargo_bin("signkit").unwrap();
    let assert = cmd
        .args(["--base-url", &mock_server.uri(), "recipient", "context"])
        .env(
            "SIGNKIT_RECIPIENT_CAPABILITY",
            common::TEST_RECIPIENT_CAPABILITY,
        )
        .assert()
        .code(10)
        .stdout(predicates::str::is_empty());
    let stderr_str = String::from_utf8(assert.get_output().stderr.clone()).unwrap();
    assert!(!stderr_str.contains(common::TEST_RECIPIENT_CAPABILITY));
}

#[tokio::test]
async fn test_recipient_documents_bounded_response_handling() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("GET"))
        .and(path("/api/v1/recipient/documents"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![
            b'A';
            signkit_cli::client::MAX_RESPONSE_BYTES
                + 1024
        ]))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[(
        "SIGNKIT_RECIPIENT_CAPABILITY",
        Some(common::TEST_RECIPIENT_CAPABILITY),
    )])
    .await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "recipient",
        "documents",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::ValidationError);
}
