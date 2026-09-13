use crate::args::{
    EnvelopeCommitArgs, EnvelopeCreateArgs, EnvelopeEvidenceArgs, EnvelopeExportDocxArgs,
    EnvelopeFieldsArgs, EnvelopeIdArg, EnvelopeImportDocxArgs, EnvelopeListArgs, EnvelopePdfArgs,
    EnvelopeReadyArgs, EnvelopeSendArgs, EnvelopeVoidArgs, EnvelopesSubcommand, EvidenceFormat,
};
use crate::client::{BinaryGetSpec, SignKitClient};
use crate::error::CliError;
use crate::io::{
    overlay_string, overlay_u64, read_docx_bytes, read_json_object, read_json_value,
    resolve_idempotency_key, write_output_bytes,
};
use crate::output::print_success;
use crate::types::{
    is_valid_uuid_v7, ArtifactDownloadReceipt, CompletionArtifactResponse, DeliveryStatusResponse,
    DocxExportReceipt, DraftCommitRequest, DraftCommitResponse, DraftWorkspaceSnapshot,
    EnvelopeCreateRequest, EnvelopeCreateResponse, EnvelopeGetResponse, EnvelopeListPage,
    PlaceFieldsRequest, PlaceFieldsResponse, ReadyEnvelopeRequest, ReadyEnvelopeResponse,
    SendEnvelopeRequest, SendEnvelopeResponse, VoidEnvelopeRequest, VoidEnvelopeResponse,
};

pub async fn execute(
    client: &SignKitClient,
    subcommand: EnvelopesSubcommand,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    match subcommand {
        EnvelopesSubcommand::List(args) => list_envelopes(client, args, raw, pretty).await,
        EnvelopesSubcommand::Get(args) => get_envelope(client, args, raw, pretty).await,
        EnvelopesSubcommand::Draft(args) => get_draft(client, args, raw, pretty).await,
        EnvelopesSubcommand::Deliveries(args) => get_deliveries(client, args, raw, pretty).await,
        EnvelopesSubcommand::Create(args) => create_envelope(client, args, raw, pretty).await,
        EnvelopesSubcommand::Commit(args) => commit_draft(client, args, raw, pretty).await,
        EnvelopesSubcommand::Ready(args) => ready_envelope(client, args, raw, pretty).await,
        EnvelopesSubcommand::Fields(args) => place_fields(client, args, raw, pretty).await,
        EnvelopesSubcommand::Send(args) => send_envelope(client, args, raw, pretty).await,
        EnvelopesSubcommand::Void(args) => void_envelope(client, args, raw, pretty).await,
        EnvelopesSubcommand::ImportDocx(args) => import_docx(client, args, raw, pretty).await,
        EnvelopesSubcommand::ExportDocx(args) => export_docx(client, args, raw, pretty).await,
        EnvelopesSubcommand::CompletionArtifact(args) | EnvelopesSubcommand::Audit(args) => {
            get_completion_artifact(client, args, raw, pretty).await
        }
        EnvelopesSubcommand::Evidence(args) => download_evidence(client, args, raw, pretty).await,
        EnvelopesSubcommand::Pdf(args) => download_pdf(client, args, raw, pretty).await,
    }
}

async fn list_envelopes(
    client: &SignKitClient,
    args: EnvelopeListArgs,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    let limit = args.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(CliError::usage(format!(
            "Limit must be between 1 and 100, received {limit}."
        )));
    }

    if let Some(ref cursor) = args.cursor {
        if !is_valid_uuid_v7(cursor) {
            return Err(CliError::usage(format!(
                "Invalid pagination cursor '{cursor}'. Cursors must be canonical lowercase RFC 9562 UUIDv7."
            )));
        }
    }

    let limit_str = limit.to_string();
    let mut query_params: Vec<(&str, &str)> = vec![("limit", &limit_str)];
    if let Some(ref cursor) = args.cursor {
        query_params.push(("cursor", cursor.as_str()));
    }

    let page: EnvelopeListPage = client.get("/api/v1/envelopes", &query_params, true).await?;

    print_success(&page, raw, pretty)?;
    Ok(())
}

async fn get_envelope(
    client: &SignKitClient,
    args: EnvelopeIdArg,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    validate_envelope_id(&args.envelope_id)?;
    let path = format!("/api/v1/envelopes/{}", args.envelope_id);
    let resp: EnvelopeGetResponse = client.get(&path, &[], true).await?;
    print_success(&resp, raw, pretty)?;
    Ok(())
}

async fn get_draft(
    client: &SignKitClient,
    args: EnvelopeIdArg,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    validate_envelope_id(&args.envelope_id)?;
    let path = format!("/api/v1/envelopes/{}/draft", args.envelope_id);
    let snapshot: DraftWorkspaceSnapshot = client.get(&path, &[], true).await?;
    print_success(&snapshot, raw, pretty)?;
    Ok(())
}

async fn get_deliveries(
    client: &SignKitClient,
    args: EnvelopeIdArg,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    validate_envelope_id(&args.envelope_id)?;
    let path = format!("/api/v1/envelopes/{}/deliveries", args.envelope_id);
    let resp: DeliveryStatusResponse = client.get(&path, &[], true).await?;
    print_success(&resp, raw, pretty)?;
    Ok(())
}

async fn get_completion_artifact(
    client: &SignKitClient,
    args: EnvelopeIdArg,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    validate_envelope_id(&args.envelope_id)?;
    let path = format!("/api/v1/envelopes/{}/completion-artifact", args.envelope_id);
    let resp: CompletionArtifactResponse = client.get(&path, &[], true).await?;
    print_success(&resp, raw, pretty)?;
    Ok(())
}

async fn create_envelope(
    client: &SignKitClient,
    args: EnvelopeCreateArgs,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    let request = match (args.title.as_deref(), args.file.as_deref()) {
        (Some(title), None) => {
            let trimmed = title.trim();
            if trimmed.is_empty() || trimmed.len() > 200 {
                return Err(CliError::usage(
                    "Envelope title must contain 1-200 characters.",
                ));
            }
            EnvelopeCreateRequest {
                title: trimmed.to_string(),
            }
        }
        (None, Some(path)) => {
            let value = read_json_value(path)?;
            serde_json::from_value(value).map_err(|err| {
                CliError::usage(format!("Create JSON did not match {{ title }}: {err}"))
            })?
        }
        (None, None) => {
            return Err(CliError::usage(
                "Provide --title or --file PATH (use '-' for stdin).",
            ));
        }
        (Some(_), Some(_)) => {
            return Err(CliError::usage("Use either --title or --file, not both."));
        }
    };
    let idempotency_key = resolve_idempotency_key(args.idempotency_key.as_deref())?;
    let resp: EnvelopeCreateResponse = client
        .post("/api/v1/envelopes", &request, &idempotency_key, true)
        .await?;
    print_success(&resp, raw, pretty)?;
    Ok(())
}

async fn commit_draft(
    client: &SignKitClient,
    args: EnvelopeCommitArgs,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    validate_envelope_id(&args.envelope_id)?;
    let mut object = read_json_object(&args.file)?;
    overlay_u64(&mut object, "expectedGeneration", args.expected_generation);
    let request: DraftCommitRequest = serde_json::from_value(serde_json::Value::Object(object))
        .map_err(|err| {
            CliError::usage(format!(
                "Commit JSON did not match the required schema: {err}"
            ))
        })?;
    let idempotency_key = resolve_idempotency_key(args.idempotency_key.as_deref())?;
    let path = format!("/api/v1/envelopes/{}/draft/commits", args.envelope_id);
    let resp: DraftCommitResponse = client.post(&path, &request, &idempotency_key, true).await?;
    print_success(&resp, raw, pretty)?;
    Ok(())
}

async fn ready_envelope(
    client: &SignKitClient,
    args: EnvelopeReadyArgs,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    validate_envelope_id(&args.envelope_id)?;
    let mut object = read_json_object(&args.file)?;
    overlay_u64(&mut object, "expectedGeneration", args.expected_generation);
    let request: ReadyEnvelopeRequest = serde_json::from_value(serde_json::Value::Object(object))
        .map_err(|err| {
        CliError::usage(format!(
            "Ready JSON did not match the required schema: {err}"
        ))
    })?;
    let idempotency_key = resolve_idempotency_key(args.idempotency_key.as_deref())?;
    let path = format!("/api/v1/envelopes/{}/ready", args.envelope_id);
    let resp: ReadyEnvelopeResponse = client.post(&path, &request, &idempotency_key, true).await?;
    print_success(&resp, raw, pretty)?;
    Ok(())
}

async fn place_fields(
    client: &SignKitClient,
    args: EnvelopeFieldsArgs,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    validate_envelope_id(&args.envelope_id)?;
    let mut object = read_json_object(&args.file)?;
    overlay_u64(&mut object, "expectedGeneration", args.expected_generation);
    overlay_u64(
        &mut object,
        "expectedFieldGeneration",
        args.expected_field_generation,
    );
    let request: PlaceFieldsRequest = serde_json::from_value(serde_json::Value::Object(object))
        .map_err(|err| {
            CliError::usage(format!(
                "Fields JSON did not match the required schema: {err}"
            ))
        })?;
    let idempotency_key = resolve_idempotency_key(args.idempotency_key.as_deref())?;
    let path = format!("/api/v1/envelopes/{}/fields", args.envelope_id);
    let resp: PlaceFieldsResponse = client.post(&path, &request, &idempotency_key, true).await?;
    print_success(&resp, raw, pretty)?;
    Ok(())
}

async fn send_envelope(
    client: &SignKitClient,
    args: EnvelopeSendArgs,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    validate_envelope_id(&args.envelope_id)?;
    let mut object = read_json_object(&args.file)?;
    overlay_u64(&mut object, "expectedGeneration", args.expected_generation);
    overlay_string(
        &mut object,
        "expectedReadyAuditEventId",
        args.expected_ready_audit_event_id.as_deref(),
    );
    let request: SendEnvelopeRequest = serde_json::from_value(serde_json::Value::Object(object))
        .map_err(|err| {
            CliError::usage(format!(
                "Send JSON did not match the required schema: {err}"
            ))
        })?;
    if !is_valid_uuid_v7(&request.expected_ready_audit_event_id) {
        return Err(CliError::usage(
            "expectedReadyAuditEventId must be a canonical lowercase RFC 9562 UUIDv7.",
        ));
    }
    let idempotency_key = resolve_idempotency_key(args.idempotency_key.as_deref())?;
    let path = format!("/api/v1/envelopes/{}/send", args.envelope_id);
    let resp: SendEnvelopeResponse = client.post(&path, &request, &idempotency_key, true).await?;
    print_success(&resp, raw, pretty)?;
    Ok(())
}

async fn void_envelope(
    client: &SignKitClient,
    args: EnvelopeVoidArgs,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    validate_envelope_id(&args.envelope_id)?;
    let mut object = read_json_object(&args.file)?;
    overlay_u64(&mut object, "expectedGeneration", args.expected_generation);
    overlay_string(
        &mut object,
        "expectedStatus",
        args.expected_status.as_deref(),
    );
    let request: VoidEnvelopeRequest = serde_json::from_value(serde_json::Value::Object(object))
        .map_err(|err| {
            CliError::usage(format!(
                "Void JSON did not match the required schema: {err}"
            ))
        })?;
    let idempotency_key = resolve_idempotency_key(args.idempotency_key.as_deref())?;
    let path = format!("/api/v1/envelopes/{}/void", args.envelope_id);
    let resp: VoidEnvelopeResponse = client.post(&path, &request, &idempotency_key, true).await?;
    print_success(&resp, raw, pretty)?;
    Ok(())
}

const DOCX_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_DRAFT_GENERATION: u64 = 2_147_483_647;

fn validate_markdown_path(path: &str) -> Result<(), CliError> {
    if path.contains("..")
        || path.len() > 240
        || !path.starts_with("documents/")
        || !path.ends_with(".md")
    {
        return Err(CliError::usage(
            "target-path must be a Markdown file directly under documents/ (for example documents/agreement.md).",
        ));
    }
    let rest = &path["documents/".len()..path.len() - ".md".len()];
    if rest.is_empty() {
        return Err(CliError::usage(
            "target-path must be a Markdown file directly under documents/ (for example documents/agreement.md).",
        ));
    }
    let bytes = rest.as_bytes();
    if !bytes[0].is_ascii_alphanumeric() {
        return Err(CliError::usage(
            "target-path must be a Markdown file directly under documents/ (for example documents/agreement.md).",
        ));
    }
    if !rest
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err(CliError::usage(
            "target-path must be a Markdown file directly under documents/ (for example documents/agreement.md).",
        ));
    }
    Ok(())
}

async fn import_docx(
    client: &SignKitClient,
    args: EnvelopeImportDocxArgs,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    validate_envelope_id(&args.envelope_id)?;
    validate_markdown_path(&args.target_path)?;
    if args.expected_generation >= MAX_DRAFT_GENERATION {
        return Err(CliError::usage(
            "expected-generation must be an integer between 0 and 2147483646.",
        ));
    }
    let docx_bytes = read_docx_bytes(&args.file)?;
    let idempotency_key = resolve_idempotency_key(args.idempotency_key.as_deref())?;
    let generation = args.expected_generation.to_string();
    let path = format!("/api/v1/envelopes/{}/draft/docx", args.envelope_id);
    let query = [
        ("targetPath", args.target_path.as_str()),
        ("expectedGeneration", generation.as_str()),
    ];
    let resp: DraftCommitResponse = client
        .post_bytes(
            &path,
            &query,
            docx_bytes,
            DOCX_CONTENT_TYPE,
            &idempotency_key,
        )
        .await?;
    print_success(&resp, raw, pretty)?;
    Ok(())
}

async fn export_docx(
    client: &SignKitClient,
    args: EnvelopeExportDocxArgs,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    validate_envelope_id(&args.envelope_id)?;
    if args.output.is_empty() {
        return Err(CliError::usage(
            "Provide --output PATH (use '-' to write DOCX bytes to stdout).",
        ));
    }
    let path = format!("/api/v1/envelopes/{}/docx", args.envelope_id);
    let resp = client
        .get_bytes(&path, &[], true, BinaryGetSpec::DOCX)
        .await?;
    write_output_bytes(&args.output, &resp.bytes)?;
    if args.output != "-" {
        let receipt = DocxExportReceipt {
            path: args.output,
            bytes: resp.bytes.len() as u64,
            commit_sha: resp.commit_sha,
        };
        print_success(&receipt, raw, pretty)?;
    }
    Ok(())
}

async fn download_evidence(
    client: &SignKitClient,
    args: EnvelopeEvidenceArgs,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    validate_envelope_id(&args.envelope_id)?;
    if args.output.is_empty() {
        return Err(CliError::usage(
            "Provide --output PATH (use '-' to write evidence bytes to stdout).",
        ));
    }
    let format: &'static str = args.format.as_str();
    let spec: BinaryGetSpec = match args.format {
        EvidenceFormat::Json => BinaryGetSpec::EVIDENCE_JSON,
        EvidenceFormat::Markdown => BinaryGetSpec::EVIDENCE_MARKDOWN,
    };
    let path = format!("/api/v1/envelopes/{}/evidence", args.envelope_id);
    let resp = client
        .get_bytes(&path, &[("format", format)], true, spec)
        .await?;
    write_output_bytes(&args.output, &resp.bytes)?;
    if args.output != "-" {
        let receipt = ArtifactDownloadReceipt {
            path: args.output,
            bytes: resp.bytes.len() as u64,
            format: format.to_string(),
            content_type: resp.content_type,
        };
        print_success(&receipt, raw, pretty)?;
    }
    Ok(())
}

async fn download_pdf(
    client: &SignKitClient,
    args: EnvelopePdfArgs,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    validate_envelope_id(&args.envelope_id)?;
    if args.output.is_empty() {
        return Err(CliError::usage(
            "Provide --output PATH (use '-' to write PDF bytes to stdout).",
        ));
    }
    let path = format!("/api/v1/envelopes/{}/pdf", args.envelope_id);
    let resp = client
        .get_bytes(&path, &[], true, BinaryGetSpec::PDF)
        .await?;
    write_output_bytes(&args.output, &resp.bytes)?;
    if args.output != "-" {
        let receipt = ArtifactDownloadReceipt {
            path: args.output,
            bytes: resp.bytes.len() as u64,
            format: "pdf".to_string(),
            content_type: resp.content_type,
        };
        print_success(&receipt, raw, pretty)?;
    }
    Ok(())
}

/// Validates that an envelope ID is a canonical lowercase RFC 9562 UUIDv7.
fn validate_envelope_id(id: &str) -> Result<(), CliError> {
    if !is_valid_uuid_v7(id) {
        return Err(CliError::usage(format!(
            "Invalid envelope ID '{id}'. Envelope IDs must be canonical lowercase RFC 9562 UUIDv7."
        )));
    }
    Ok(())
}
