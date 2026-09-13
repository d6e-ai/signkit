mod common;

use clap::Parser;
use signkit_cli::args::Cli;
use signkit_cli::error::ExitCode;
use signkit_cli::run_cli;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn test_envelopes_evidence_downloads_json_bytes() {
    let mock_server = common::start_mock_server().await;
    let output = tempfile::NamedTempFile::new().unwrap();
    let output_path = output.path().to_path_buf();
    let evidence = br#"{"schema":"signkit-completion-manifest-v1"}"#;

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/evidence",
            common::TEST_ENVELOPE_ID
        )))
        .and(query_param("format", "json"))
        .and(header("signkit-organization-id", common::TEST_ORG))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_raw(evidence.as_slice(), "application/json"),
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
        "evidence",
        common::TEST_ENVELOPE_ID,
        "--output",
        output_path.to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
    assert_eq!(std::fs::read(&output_path).unwrap(), evidence);
}

#[tokio::test]
async fn test_envelopes_evidence_downloads_markdown_bytes() {
    let mock_server = common::start_mock_server().await;
    let output = tempfile::NamedTempFile::new().unwrap();
    let output_path = output.path().to_path_buf();
    let evidence = b"# Completion evidence";

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/evidence",
            common::TEST_ENVELOPE_ID
        )))
        .and(query_param("format", "markdown"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/markdown")
                .set_body_raw(evidence.as_slice(), "text/markdown"),
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
        "evidence",
        common::TEST_ENVELOPE_ID,
        "--format",
        "markdown",
        "--output",
        output_path.to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
    assert_eq!(std::fs::read(&output_path).unwrap(), evidence);
}

#[tokio::test]
async fn test_envelopes_pdf_downloads_bytes() {
    let mock_server = common::start_mock_server().await;
    let output = tempfile::NamedTempFile::new().unwrap();
    let output_path = output.path().to_path_buf();
    let pdf = b"%PDF-1.4 fixture";

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/pdf",
            common::TEST_ENVELOPE_ID
        )))
        .and(header("signkit-organization-id", common::TEST_ORG))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/pdf")
                .set_body_raw(pdf.as_slice(), "application/pdf"),
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
        "pdf",
        common::TEST_ENVELOPE_ID,
        "--output",
        output_path.to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
    assert_eq!(std::fs::read(&output_path).unwrap(), pdf);
}

#[tokio::test]
async fn test_envelopes_evidence_not_found_uses_existing_exit_code() {
    let mock_server = common::start_mock_server().await;
    let output = tempfile::NamedTempFile::new().unwrap();

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/evidence",
            common::TEST_ENVELOPE_ID
        )))
        .respond_with(ResponseTemplate::new(404).set_body_raw(
            r#"{
                "type":"urn:signkit:problem:completion-evidence-not-found",
                "title":"Completion evidence not published",
                "status":404,
                "detail":"Completion evidence has not been published for this envelope.",
                "instance":"/api/v1/envelopes/0191b26f-4000-7000-8000-000000000001/evidence"
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
        "--org",
        common::TEST_ORG,
        "envelopes",
        "evidence",
        common::TEST_ENVELOPE_ID,
        "--output",
        output.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::NotFoundError);
}
