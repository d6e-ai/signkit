mod common;

use clap::Parser;
use signkit_cli::args::Cli;
use signkit_cli::error::ExitCode;
use signkit_cli::io::MAX_PDF_BYTES;
use signkit_cli::run_cli;
use std::io::Write;
use wiremock::matchers::{body_json, body_string, header, method, path, query_param};
use wiremock::{Mock, ResponseTemplate};

const REVISION: &str = r#"{"revision":{"generation":2,"commitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","archiveSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}"#;

#[tokio::test]
async fn test_envelopes_upload_pdf_sends_raw_bounded_pdf_request() {
    let mock_server = common::start_mock_server().await;
    let mut file = tempfile::NamedTempFile::new().unwrap();
    file.write_all(b"%PDF-1.7\nfixture").unwrap();

    Mock::given(method("POST"))
        .and(path(format!(
            "/api/v1/envelopes/{}/documents/pdf",
            common::TEST_ENVELOPE_ID
        )))
        .and(query_param("expectedGeneration", "1"))
        .and(query_param("title", "Exhibit A"))
        .and(query_param("position", "2"))
        .and(header("idempotency-key", "pdf-upload-1"))
        .and(header("content-type", "application/pdf"))
        .and(body_string("%PDF-1.7\nfixture"))
        .and(header(
            "authorization",
            format!("Bearer {}", common::TEST_API_KEY).as_str(),
        ))
        .respond_with(ResponseTemplate::new(201).set_body_raw(REVISION, "application/json"))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "upload-pdf",
        common::TEST_ENVELOPE_ID,
        "--file",
        file.path().to_str().unwrap(),
        "--expected-generation",
        "1",
        "--title",
        "Exhibit A",
        "--position",
        "2",
        "--idempotency-key",
        "pdf-upload-1",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_envelopes_upload_pdf_rejects_out_of_range_position_before_network() {
    let mock_server = common::start_mock_server().await;
    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "upload-pdf",
        common::TEST_ENVELOPE_ID,
        "--file",
        "missing.pdf",
        "--expected-generation",
        "0",
        "--position",
        "20",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
    assert!(mock_server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn test_envelopes_upload_pdf_rejects_files_over_20_mib_before_network() {
    let mock_server = common::start_mock_server().await;
    let file = tempfile::NamedTempFile::new().unwrap();
    file.as_file().set_len((MAX_PDF_BYTES + 1) as u64).unwrap();

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "upload-pdf",
        common::TEST_ENVELOPE_ID,
        "--file",
        file.path().to_str().unwrap(),
        "--expected-generation",
        "0",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
    assert!(mock_server.received_requests().await.unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn test_envelopes_upload_pdf_refuses_symlink_before_network() {
    use std::os::unix::fs::symlink;

    let mock_server = common::start_mock_server().await;
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("target.pdf");
    std::fs::write(&target, b"%PDF-1.7\nfixture").unwrap();
    let link = directory.path().join("link.pdf");
    symlink(&target, &link).unwrap();

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "upload-pdf",
        common::TEST_ENVELOPE_ID,
        "--file",
        link.to_str().unwrap(),
        "--expected-generation",
        "0",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
    assert!(mock_server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn test_envelopes_document_order_can_remove_by_omitting_ids() {
    let mock_server = common::start_mock_server().await;
    let mut file = tempfile::NamedTempFile::new().unwrap();
    write!(
        file,
        r#"{{"expectedGeneration":1,"documentIds":["{}"]}}"#,
        common::TEST_ENVELOPE_ID
    )
    .unwrap();

    Mock::given(method("POST"))
        .and(path(format!(
            "/api/v1/envelopes/{}/documents/order",
            common::TEST_ENVELOPE_ID
        )))
        .and(header("idempotency-key", "document-order-1"))
        .and(header(
            "authorization",
            format!("Bearer {}", common::TEST_API_KEY).as_str(),
        ))
        .and(body_json(serde_json::json!({
            "expectedGeneration": 1,
            "documentIds": [common::TEST_ENVELOPE_ID]
        })))
        .respond_with(ResponseTemplate::new(201).set_body_raw(REVISION, "application/json"))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "document-order",
        common::TEST_ENVELOPE_ID,
        "--file",
        file.path().to_str().unwrap(),
        "--idempotency-key",
        "document-order-1",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_envelopes_document_order_rejects_duplicate_ids_before_network() {
    let mock_server = common::start_mock_server().await;
    let mut file = tempfile::NamedTempFile::new().unwrap();
    write!(
        file,
        r#"{{"expectedGeneration":1,"documentIds":["{0}","{0}"]}}"#,
        common::TEST_ENVELOPE_ID
    )
    .unwrap();

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "document-order",
        common::TEST_ENVELOPE_ID,
        "--file",
        file.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
    assert!(mock_server.received_requests().await.unwrap().is_empty());
}
