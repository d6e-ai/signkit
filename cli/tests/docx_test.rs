mod common;

use clap::Parser;
use signkit_cli::args::Cli;
use signkit_cli::error::ExitCode;
use signkit_cli::run_cli;
use std::io::Write;
use wiremock::matchers::{body_string, header, method, path, query_param};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn test_envelopes_import_docx_from_file() {
    let mock_server = common::start_mock_server().await;
    let mut file = tempfile::NamedTempFile::new().unwrap();
    file.write_all(b"PK\x03\x04docx-fixture").unwrap();

    Mock::given(method("POST"))
        .and(path(format!(
            "/api/v1/envelopes/{}/draft/docx",
            common::TEST_ENVELOPE_ID
        )))
        .and(query_param("targetPath", "documents/agreement.md"))
        .and(query_param("expectedGeneration", "0"))
        .and(header("idempotency-key", "docx-import-1"))
        .and(header(
            "content-type",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ))
        .and(body_string("PK\x03\x04docx-fixture"))
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
        "import-docx",
        common::TEST_ENVELOPE_ID,
        "--file",
        file.path().to_str().unwrap(),
        "--target-path",
        "documents/agreement.md",
        "--expected-generation",
        "0",
        "--idempotency-key",
        "docx-import-1",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_envelopes_import_docx_rejects_invalid_target_path() {
    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://127.0.0.1:9",
        "envelopes",
        "import-docx",
        common::TEST_ENVELOPE_ID,
        "--file",
        "-",
        "--target-path",
        "documents/../secret.md",
        "--expected-generation",
        "0",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
}

#[tokio::test]
async fn test_envelopes_export_docx_to_file() {
    let mock_server = common::start_mock_server().await;
    let output = tempfile::NamedTempFile::new().unwrap();
    let output_path = output.path().to_path_buf();

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/docx",
            common::TEST_ENVELOPE_ID
        )))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header(
                    "content-type",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                )
                .insert_header(
                    "x-signkit-commit-sha",
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                )
                .set_body_raw(
                    b"PK\x03\x04exported".as_slice(),
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                ),
        )
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "export-docx",
        common::TEST_ENVELOPE_ID,
        "--output",
        output_path.to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
    assert_eq!(std::fs::read(&output_path).unwrap(), b"PK\x03\x04exported");
}

#[tokio::test]
async fn test_envelopes_export_docx_conflict_uses_existing_exit_code() {
    let mock_server = common::start_mock_server().await;
    let output = tempfile::NamedTempFile::new().unwrap();

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/docx",
            common::TEST_ENVELOPE_ID
        )))
        .respond_with(ResponseTemplate::new(409).set_body_raw(
            r#"{
                "type":"urn:signkit:problem:docx-export-empty",
                "title":"No pinned revision to export",
                "status":409,
                "detail":"The envelope has no pinned Markdown revision to export as DOCX.",
                "instance":"/api/v1/envelopes/0191b26f-4000-7000-8000-000000000001/docx"
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
        "export-docx",
        common::TEST_ENVELOPE_ID,
        "--output",
        output.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::ConflictError);
}
