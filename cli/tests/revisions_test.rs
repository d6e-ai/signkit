mod common;

use assert_cmd::Command;
use clap::Parser;
use signkit_cli::args::Cli;
use signkit_cli::error::ExitCode;
use signkit_cli::run_cli;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn test_revisions_list_default_page() {
    let mock_server = common::start_mock_server().await;

    let response_json = r#"{
        "revisions": [
            {
                "generation": 2,
                "commitSha": "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
                "timestamp": "2026-09-13T10:05:00Z",
                "message": "Update exhibit A",
                "actorType": "api-key"
            },
            {
                "generation": 1,
                "commitSha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
                "timestamp": "2026-09-13T10:00:00Z",
                "message": "Initial commit",
                "actorType": "api-key"
            }
        ],
        "truncated": false,
        "nextCursor": null
    }"#;

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/revisions",
            common::TEST_ENVELOPE_ID
        )))
        .and(query_param("limit", "50"))
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
        "revisions",
        common::TEST_ENVELOPE_ID,
    ]);

    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_revisions_list_with_cursor_and_limit() {
    let mock_server = common::start_mock_server().await;

    let response_json = r#"{
        "revisions": [
            {
                "generation": 1,
                "commitSha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
                "timestamp": "2026-09-13T10:00:00Z",
                "message": "Initial commit",
                "actorType": "api-key"
            }
        ],
        "truncated": false,
        "nextCursor": null
    }"#;

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/revisions",
            common::TEST_ENVELOPE_ID
        )))
        .and(query_param("limit", "10"))
        .and(query_param("cursor", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(response_json, "application/json"))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "revisions",
        common::TEST_ENVELOPE_ID,
        "--limit",
        "10",
        "--cursor",
        "2",
    ]);

    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_revisions_list_rejects_out_of_range_limit() {
    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;

    // 0 is below the 1..=100 bound.
    let cli_zero = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://localhost:5173",
        "envelopes",
        "revisions",
        common::TEST_ENVELOPE_ID,
        "--limit",
        "0",
    ]);
    assert_eq!(run_cli(cli_zero).await, ExitCode::UsageError);

    // 101 is above the 1..=100 bound.
    let cli_over = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://localhost:5173",
        "envelopes",
        "revisions",
        common::TEST_ENVELOPE_ID,
        "--limit",
        "101",
    ]);
    assert_eq!(run_cli(cli_over).await, ExitCode::UsageError);
}

#[tokio::test]
async fn test_revisions_list_rejects_invalid_envelope_id() {
    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://localhost:5173",
        "envelopes",
        "revisions",
        "not-a-valid-uuid",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
}

#[tokio::test]
async fn test_revision_get_by_generation_success() {
    let mock_server = common::start_mock_server().await;

    let response_json = r##"{
        "generation": 2,
        "commitSha": "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
        "archiveSha256": "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        "timestamp": "2026-09-13T10:05:00Z",
        "message": "Update exhibit A",
        "actorType": "api-key",
        "documents": [
            {
                "path": "documents/agreement.md",
                "content": "# Mutual Non-Disclosure Agreement"
            }
        ]
    }"##;

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/revisions/2",
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
        "revision",
        common::TEST_ENVELOPE_ID,
        "2",
    ]);

    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_revision_get_by_commit_sha_with_path_filter() {
    let mock_server = common::start_mock_server().await;
    let commit_sha = "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3";

    let response_json = r##"{
        "generation": 2,
        "commitSha": "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
        "archiveSha256": "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        "timestamp": "2026-09-13T10:05:00Z",
        "message": "Update exhibit A",
        "actorType": "api-key",
        "document": {
            "path": "documents/exhibit_a.md",
            "content": "# Exhibit A"
        },
        "documents": [
            {
                "path": "documents/exhibit_a.md",
                "content": "# Exhibit A"
            }
        ]
    }"##;

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/revisions/{}",
            common::TEST_ENVELOPE_ID,
            commit_sha
        )))
        .and(query_param("path", "documents/exhibit_a.md"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(response_json, "application/json"))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "revision",
        common::TEST_ENVELOPE_ID,
        commit_sha,
        "--path",
        "documents/exhibit_a.md",
    ]);

    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_revision_get_rejects_invalid_revision_ref() {
    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;

    // Neither an all-digit generation nor a 40-character hex commit SHA.
    let cli_bad_ref = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://localhost:5173",
        "envelopes",
        "revision",
        common::TEST_ENVELOPE_ID,
        "not-a-ref",
    ]);
    assert_eq!(run_cli(cli_bad_ref).await, ExitCode::UsageError);

    // 39 hex characters: one short of a valid commit SHA.
    let cli_short_sha = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://localhost:5173",
        "envelopes",
        "revision",
        common::TEST_ENVELOPE_ID,
        "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c",
    ]);
    assert_eq!(run_cli(cli_short_sha).await, ExitCode::UsageError);

    let cli_out_of_range_generation = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://localhost:5173",
        "envelopes",
        "revision",
        common::TEST_ENVELOPE_ID,
        "2147483648",
    ]);
    assert_eq!(
        run_cli(cli_out_of_range_generation).await,
        ExitCode::UsageError
    );
}

#[tokio::test]
async fn test_revision_get_rejects_empty_path() {
    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://localhost:5173",
        "envelopes",
        "revision",
        common::TEST_ENVELOPE_ID,
        "1",
        "--path",
        "   ",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
}

#[tokio::test]
async fn test_revision_diff_json_default_format() {
    let mock_server = common::start_mock_server().await;

    let response_json = r#"{
        "schema": "signkit-revision-diff-v1",
        "base": { "generation": 1, "commitSha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" },
        "head": { "generation": 2, "commitSha": "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3", "message": "Update exhibit A" },
        "summary": {
            "documentsAdded": 0,
            "documentsRemoved": 0,
            "documentsModified": 1,
            "documentsReordered": 0,
            "titlesChanged": 0,
            "totalChanges": 1
        },
        "changes": [],
        "unifiedText": "",
        "truncated": false
    }"#;

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/revisions/diff",
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
        "revision-diff",
        common::TEST_ENVELOPE_ID,
    ]);

    assert_eq!(run_cli(cli).await, ExitCode::Success);
    let requests = mock_server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let query: Vec<(String, String)> = requests[0]
        .url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    assert!(query.contains(&("format".to_string(), "json".to_string())));
    assert!(query.contains(&("includeUnified".to_string(), "true".to_string())));
}

#[tokio::test]
async fn test_revision_diff_json_with_explicit_base_and_head() {
    let mock_server = common::start_mock_server().await;

    let response_json = r#"{
        "schema": "signkit-revision-diff-v1",
        "base": { "generation": 1, "commitSha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" },
        "head": { "generation": 3, "commitSha": "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", "message": "Reorder documents" },
        "summary": {
            "documentsAdded": 0,
            "documentsRemoved": 0,
            "documentsModified": 0,
            "documentsReordered": 1,
            "titlesChanged": 0,
            "totalChanges": 1
        },
        "changes": [],
        "unifiedText": "",
        "truncated": false
    }"#;

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/revisions/diff",
            common::TEST_ENVELOPE_ID
        )))
        .and(query_param("base", "1"))
        .and(query_param("head", "3"))
        .and(query_param("includeUnified", "false"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(response_json, "application/json"))
        .mount(&mock_server)
        .await;

    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        &mock_server.uri(),
        "envelopes",
        "revision-diff",
        common::TEST_ENVELOPE_ID,
        "--base",
        "1",
        "--head",
        "3",
        "--include-unified",
        "false",
    ]);

    assert_eq!(run_cli(cli).await, ExitCode::Success);
}

#[tokio::test]
async fn test_revision_diff_text_format_prints_raw_body() {
    let mock_server = common::start_mock_server().await;
    let diff_text =
        "--- a/documents/agreement.md\n+++ b/documents/agreement.md\n@@ -1 +1 @@\n-old\n+new\n";

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/revisions/diff",
            common::TEST_ENVELOPE_ID
        )))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/plain")
                .set_body_raw(diff_text.as_bytes(), "text/plain"),
        )
        .mount(&mock_server)
        .await;

    let mut cmd = Command::cargo_bin("signkit").unwrap();
    let assert = cmd
        .args([
            "--base-url",
            &mock_server.uri(),
            "envelopes",
            "revision-diff",
            common::TEST_ENVELOPE_ID,
            "--format",
            "text",
        ])
        .env("SIGNKIT_API_KEY", common::TEST_API_KEY)
        .assert()
        .success();

    let stdout_str = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    assert_eq!(stdout_str, diff_text);
    let requests = mock_server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let query: Vec<(String, String)> = requests[0]
        .url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    assert!(query.contains(&("format".to_string(), "text".to_string())));
}

#[tokio::test]
async fn test_revision_diff_unified_format_prints_raw_body() {
    let mock_server = common::start_mock_server().await;
    let diff_text = "diff --git a/documents/agreement.md b/documents/agreement.md\n";

    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/envelopes/{}/revisions/diff",
            common::TEST_ENVELOPE_ID
        )))
        .and(query_param("format", "unified"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/plain")
                .set_body_raw(diff_text.as_bytes(), "text/plain"),
        )
        .mount(&mock_server)
        .await;

    let mut cmd = Command::cargo_bin("signkit").unwrap();
    let assert = cmd
        .args([
            "--base-url",
            &mock_server.uri(),
            "envelopes",
            "revision-diff",
            common::TEST_ENVELOPE_ID,
            "--format",
            "unified",
        ])
        .env("SIGNKIT_API_KEY", common::TEST_API_KEY)
        .assert()
        .success();

    let stdout_str = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    assert_eq!(stdout_str, diff_text);
}

#[tokio::test]
async fn test_revision_diff_rejects_invalid_base_and_head_refs() {
    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;

    let cli_bad_base = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://localhost:5173",
        "envelopes",
        "revision-diff",
        common::TEST_ENVELOPE_ID,
        "--base",
        "not-a-ref",
    ]);
    assert_eq!(run_cli(cli_bad_base).await, ExitCode::UsageError);

    let cli_bad_head = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://localhost:5173",
        "envelopes",
        "revision-diff",
        common::TEST_ENVELOPE_ID,
        "--head",
        "not-a-ref",
    ]);
    assert_eq!(run_cli(cli_bad_head).await, ExitCode::UsageError);
}

#[tokio::test]
async fn test_revision_diff_rejects_invalid_envelope_id() {
    let _env = common::EnvScope::new(&[("SIGNKIT_API_KEY", Some(common::TEST_API_KEY))]).await;
    let cli = Cli::parse_from([
        "signkit",
        "--base-url",
        "http://localhost:5173",
        "envelopes",
        "revision-diff",
        "not-a-valid-uuid",
    ]);
    assert_eq!(run_cli(cli).await, ExitCode::UsageError);
}
