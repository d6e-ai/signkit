mod common;

use clap::Parser;
use signkit_cli::args::Cli;
use signkit_cli::error::ExitCode;
use signkit_cli::run_cli;
use wiremock::matchers::{body_json, header, method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn test_pdf_seal_request_success() {
    let mock_server = common::start_mock_server().await;
    let response_json = format!(
        r#"{{"pdfSeal":{{
            "envelopeId": "{}",
            "jobId": "0191b26f-4000-7000-8000-000000000099",
            "requestedProfile": "pades-b-b",
            "requestedAt": "2026-09-13T10:00:00Z"
        }}}}"#,
        common::TEST_ENVELOPE_ID
    );

    Mock::given(method("POST"))
        .and(path(format!(
            "/api/v1/envelopes/{}/pdf-seal",
            common::TEST_ENVELOPE_ID
        )))
        .and(header(
            "authorization",
            format!("Bearer {}", common::TEST_API_KEY).as_str(),
        ))
        .and(header("idempotency-key", "seal-1"))
        .and(body_json(
            serde_json::json!({"requestedProfile":"pades-b-b"}),
        ))
        .respond_with(ResponseTemplate::new(202).set_body_raw(response_json, "application/json"))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "pdf-seal-request",
        common::TEST_ENVELOPE_ID,
        "--profile",
        "pades-b-b",
        "--idempotency-key",
        "seal-1",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_pdf_seal_request_rejects_invalid_envelope_id() {
    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://127.0.0.1:9",
        "envelopes",
        "pdf-seal-request",
        "not-a-valid-uuid",
        "--profile",
        "pades-b-b",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
}

#[tokio::test]
async fn test_pdf_seal_request_disabled_conflict_uses_existing_exit_code() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("POST"))
        .and(path(format!(
            "/api/v1/envelopes/{}/pdf-seal",
            common::TEST_ENVELOPE_ID
        )))
        .respond_with(ResponseTemplate::new(409).set_body_raw(
            r#"{
                "type":"urn:signkit:problem:pdf-seal-disabled",
                "title":"PDF sealing disabled",
                "status":409,
                "detail":"PDF sealing is not enabled for this instance.",
                "instance":"/api/v1/envelopes/0191b26f-4000-7000-8000-000000000001/pdf-seal"
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
        "pdf-seal-request",
        common::TEST_ENVELOPE_ID,
        "--profile",
        "pades-b-t",
        "--idempotency-key",
        "seal-2",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::ConflictError);
}

#[tokio::test]
async fn test_pdf_seal_request_source_unavailable_not_found_uses_existing_exit_code() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("POST"))
        .and(path(format!(
            "/api/v1/envelopes/{}/pdf-seal",
            common::TEST_ENVELOPE_ID
        )))
        .respond_with(ResponseTemplate::new(404).set_body_raw(
            r#"{
                "type":"urn:signkit:problem:envelope-not-found",
                "title":"Envelope not found",
                "status":404,
                "detail":"No envelope was found.",
                "instance":"/api/v1/envelopes/0191b26f-4000-7000-8000-000000000001/pdf-seal"
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
        "pdf-seal-request",
        common::TEST_ENVELOPE_ID,
        "--profile",
        "pades-b-b",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::NotFoundError);
}

#[tokio::test]
async fn test_pdf_seal_status_pending() {
    let mock_server = common::start_mock_server().await;
    let response_json = format!(
        r#"{{"pdfSeal":{{
            "envelopeId": "{}",
            "status": "pending",
            "requestedProfile": "pades-b-b",
            "attempts": 0,
            "requestedAt": "2026-09-13T10:00:00Z"
        }}}}"#,
        common::TEST_ENVELOPE_ID
    );

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/pdf-seal",
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
        "pdf-seal-status",
        common::TEST_ENVELOPE_ID,
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_pdf_seal_status_published() {
    let mock_server = common::start_mock_server().await;
    let response_json = format!(
        r#"{{"pdfSeal":{{
            "envelopeId": "{}",
            "status": "published",
            "requestedProfile": "pades-b-b",
            "achievedProfile": "pades-b-b",
            "signerCertificateSha256": "{sha}",
            "sealedSha256": "{sha}",
            "sealedByteSize": 12345,
            "validationReportSha256": "{sha}",
            "validatedAt": "2026-09-13T10:05:00Z",
            "publishedAt": "2026-09-13T10:06:00Z"
        }}}}"#,
        common::TEST_ENVELOPE_ID,
        sha = "a".repeat(64)
    );

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/pdf-seal",
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
        "pdf-seal-status",
        common::TEST_ENVELOPE_ID,
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_pdf_seal_status_not_found_uses_existing_exit_code() {
    let mock_server = common::start_mock_server().await;

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/pdf-seal",
            common::TEST_ENVELOPE_ID
        )))
        .respond_with(ResponseTemplate::new(404).set_body_raw(
            r#"{
                "type":"urn:signkit:problem:envelope-not-found",
                "title":"Envelope not found",
                "status":404,
                "detail":"No envelope was found.",
                "instance":"/api/v1/envelopes/0191b26f-4000-7000-8000-000000000001/pdf-seal"
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
        "pdf-seal-status",
        common::TEST_ENVELOPE_ID,
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::NotFoundError);
}

#[tokio::test]
async fn test_pdf_seal_status_rejects_invalid_envelope_id() {
    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://127.0.0.1:9",
        "envelopes",
        "pdf-seal-status",
        "not-a-valid-uuid",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
}

#[tokio::test]
async fn test_pdf_seal_download_writes_bytes() {
    let mock_server = common::start_mock_server().await;
    let output = tempfile::NamedTempFile::new().unwrap();
    let output_path = output.path().to_path_buf();
    let pdf = b"%PDF-1.4 sealed fixture";

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/pdf-seal/pdf",
            common::TEST_ENVELOPE_ID
        )))
        .and(header(
            "authorization",
            format!("Bearer {}", common::TEST_API_KEY).as_str(),
        ))
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
        "envelopes",
        "pdf-seal-download",
        common::TEST_ENVELOPE_ID,
        "--output",
        output_path.to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::Success);
    assert_eq!(std::fs::read(&output_path).unwrap(), pdf);
}

#[tokio::test]
async fn test_pdf_seal_download_not_published_uses_existing_exit_code() {
    let mock_server = common::start_mock_server().await;
    let output = tempfile::NamedTempFile::new().unwrap();

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/pdf-seal/pdf",
            common::TEST_ENVELOPE_ID
        )))
        .respond_with(ResponseTemplate::new(404).set_body_raw(
            r#"{
                "type":"urn:signkit:problem:pdf-seal-not-published",
                "title":"PDF seal not published",
                "status":404,
                "detail":"A validated PDF seal has not been published for this envelope.",
                "instance":"/api/v1/envelopes/0191b26f-4000-7000-8000-000000000001/pdf-seal/pdf"
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
        "pdf-seal-download",
        common::TEST_ENVELOPE_ID,
        "--output",
        output.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::NotFoundError);
}

#[tokio::test]
async fn test_pdf_seal_download_requires_output_path() {
    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://127.0.0.1:9",
        "envelopes",
        "pdf-seal-download",
        common::TEST_ENVELOPE_ID,
        "--output",
        "",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
}

#[tokio::test]
async fn test_pdf_seal_download_refuses_stdout() {
    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://127.0.0.1:9",
        "envelopes",
        "pdf-seal-download",
        common::TEST_ENVELOPE_ID,
        "--output",
        "-",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
}

#[tokio::test]
async fn test_pdf_seal_download_refuses_redirect() {
    let mock_server = common::start_mock_server().await;
    let output = tempfile::NamedTempFile::new().unwrap();

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/pdf-seal/pdf",
            common::TEST_ENVELOPE_ID
        )))
        .respond_with(
            ResponseTemplate::new(302)
                .insert_header("location", "https://untrusted.example.com/steal-auth"),
        )
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "pdf-seal-download",
        common::TEST_ENVELOPE_ID,
        "--output",
        output.path().to_str().unwrap(),
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::RedirectRefusedError);
}
