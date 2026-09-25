use serde::{de::DeserializeOwned, Serialize};

use crate::args::{RecipientActionArgs, RecipientPdfArgs, RecipientSignArgs, RecipientSubcommand};
use crate::client::{BinaryGetSpec, SignKitClient};
use crate::error::CliError;
use crate::io::{
    overlay_string, overlay_u64, read_json_object, resolve_idempotency_key, write_output_bytes,
};
use crate::output::print_success;
use crate::types::{
    is_valid_uuid_v7, ArtifactDownloadReceipt, RecipientApproveResponse, RecipientContextResponse,
    RecipientDeclineResponse, RecipientDocumentsResponse, RecipientSignRequest,
    RecipientSignResponse, RecipientSimpleActionRequest, RecipientViewedResponse,
};

pub fn is_offline(subcommand: &RecipientSubcommand) -> bool {
    match subcommand {
        RecipientSubcommand::Viewed(args) => args.example || args.validate_only,
        RecipientSubcommand::Approve(args) => args.example || args.validate_only,
        RecipientSubcommand::Decline(args) => args.example || args.validate_only,
        RecipientSubcommand::Sign(args) => args.example || args.validate_only,
        _ => false,
    }
}

pub fn execute_offline(
    subcommand: &RecipientSubcommand,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    match subcommand {
        RecipientSubcommand::Viewed(args) => {
            offline_simple_action(
                args,
                "viewed",
                crate::validation::EXAMPLE_RECIPIENT_VIEWED_JSON,
                raw,
                pretty,
            )?;
        }
        RecipientSubcommand::Approve(args) => {
            offline_simple_action(
                args,
                "approve",
                crate::validation::EXAMPLE_RECIPIENT_APPROVE_JSON,
                raw,
                pretty,
            )?;
        }
        RecipientSubcommand::Decline(args) => {
            offline_simple_action(
                args,
                "decline",
                crate::validation::EXAMPLE_RECIPIENT_DECLINE_JSON,
                raw,
                pretty,
            )?;
        }
        RecipientSubcommand::Sign(args) => {
            if args.example {
                crate::validation::print_example(
                    crate::validation::EXAMPLE_RECIPIENT_SIGN_JSON,
                    raw,
                    pretty,
                )?;
                return Ok(());
            }
            if args.validate_only {
                let mut object = read_json_object(&args.file)?;
                overlay_string(&mut object, "envelopeId", args.envelope_id.as_deref());
                overlay_string(&mut object, "recipientId", args.recipient_id.as_deref());
                overlay_u64(
                    &mut object,
                    "expectedFieldGeneration",
                    args.expected_field_generation,
                );
                let receipt = crate::validation::validate_recipient_sign_payload(&object)?;
                print_success(&receipt, raw, pretty)?;
                return Ok(());
            }
        }
        _ => {}
    }
    Ok(())
}

fn offline_simple_action(
    args: &RecipientActionArgs,
    command: &str,
    example: &str,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    if args.example {
        crate::validation::print_example(example, raw, pretty)?;
        return Ok(());
    }
    if args.validate_only {
        let mut object = read_json_object(&args.file)?;
        overlay_string(&mut object, "envelopeId", args.envelope_id.as_deref());
        overlay_string(&mut object, "recipientId", args.recipient_id.as_deref());
        let receipt = crate::validation::validate_recipient_action_payload(&object, command)?;
        print_success(&receipt, raw, pretty)?;
    }
    Ok(())
}

pub async fn execute(
    client: &SignKitClient,
    subcommand: RecipientSubcommand,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    if is_offline(&subcommand) {
        return execute_offline(&subcommand, raw, pretty);
    }
    match subcommand {
        RecipientSubcommand::Context => get_context(client, raw, pretty).await,
        RecipientSubcommand::Documents => get_documents(client, raw, pretty).await,
        RecipientSubcommand::Pdf(args) => download_pdf(client, args, raw, pretty).await,
        RecipientSubcommand::Viewed(args) => {
            simple_action::<RecipientViewedResponse>(
                client,
                args,
                "viewed",
                "/api/v1/recipient/viewed",
                raw,
                pretty,
            )
            .await
        }
        RecipientSubcommand::Approve(args) => {
            simple_action::<RecipientApproveResponse>(
                client,
                args,
                "approve",
                "/api/v1/recipient/approve",
                raw,
                pretty,
            )
            .await
        }
        RecipientSubcommand::Decline(args) => {
            simple_action::<RecipientDeclineResponse>(
                client,
                args,
                "decline",
                "/api/v1/recipient/decline",
                raw,
                pretty,
            )
            .await
        }
        RecipientSubcommand::Sign(args) => sign(client, args, raw, pretty).await,
    }
}

async fn get_context(client: &SignKitClient, raw: bool, pretty: bool) -> Result<(), CliError> {
    let resp: RecipientContextResponse = client
        .get_recipient("/api/v1/recipient/context", &[])
        .await?;
    print_success(&resp, raw, pretty)?;
    Ok(())
}

async fn get_documents(client: &SignKitClient, raw: bool, pretty: bool) -> Result<(), CliError> {
    let resp: RecipientDocumentsResponse = client
        .get_recipient("/api/v1/recipient/documents", &[])
        .await?;
    print_success(&resp, raw, pretty)?;
    Ok(())
}

async fn download_pdf(
    client: &SignKitClient,
    args: RecipientPdfArgs,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    validate_envelope_id(&args.envelope_id)?;
    if args.output.is_empty() || args.output == "-" {
        return Err(CliError::usage(
            "Provide --output PATH naming a regular file; recipient document bytes are never written to stdout.",
        ));
    }
    if let Some(ref document_id) = args.document_id {
        if !is_valid_uuid_v7(document_id) {
            return Err(CliError::usage(
                "Document IDs must be canonical lowercase RFC 9562 UUIDv7.",
            ));
        }
    }
    let path = format!("/api/v1/recipient/documents/{}.pdf", args.envelope_id);
    let query: Vec<(&str, &str)> = match args.document_id.as_deref() {
        Some(document_id) => vec![("documentId", document_id)],
        None => Vec::new(),
    };
    let resp = client
        .get_bytes_recipient(&path, &query, BinaryGetSpec::RECIPIENT_PDF)
        .await?;
    write_output_bytes(&args.output, &resp.bytes)?;
    let receipt = ArtifactDownloadReceipt {
        path: args.output,
        bytes: resp.bytes.len() as u64,
        format: "pdf".to_string(),
        content_type: resp.content_type,
    };
    print_success(&receipt, raw, pretty)?;
    Ok(())
}

fn require_consent(consent: bool) -> Result<(), CliError> {
    if !consent {
        return Err(CliError::usage(
            "This command requires --consent: an explicit attestation that the recipient reviewed and authorized this exact action. An automated agent must never supply --consent without genuine, contemporaneous recipient authorization. Use --validate-only or --example to inspect the command without submitting it.",
        ));
    }
    Ok(())
}

async fn simple_action<T: DeserializeOwned + Serialize>(
    client: &SignKitClient,
    args: RecipientActionArgs,
    command: &'static str,
    path: &'static str,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    require_consent(args.consent)?;
    let mut object = read_json_object(&args.file)?;
    overlay_string(&mut object, "envelopeId", args.envelope_id.as_deref());
    overlay_string(&mut object, "recipientId", args.recipient_id.as_deref());
    let _receipt = crate::validation::validate_recipient_action_payload(&object, command)?;
    let request: RecipientSimpleActionRequest =
        serde_json::from_value(serde_json::Value::Object(object)).map_err(|err| {
            CliError::usage(format!(
                "{command} JSON did not match the required schema: {err}"
            ))
        })?;
    let idempotency_key = resolve_idempotency_key(args.idempotency_key.as_deref())?;
    let resp: T = client
        .post_recipient(path, &request, &idempotency_key)
        .await?;
    print_success(&resp, raw, pretty)?;
    Ok(())
}

async fn sign(
    client: &SignKitClient,
    args: RecipientSignArgs,
    raw: bool,
    pretty: bool,
) -> Result<(), CliError> {
    require_consent(args.consent)?;
    let mut object = read_json_object(&args.file)?;
    overlay_string(&mut object, "envelopeId", args.envelope_id.as_deref());
    overlay_string(&mut object, "recipientId", args.recipient_id.as_deref());
    overlay_u64(
        &mut object,
        "expectedFieldGeneration",
        args.expected_field_generation,
    );
    let _receipt = crate::validation::validate_recipient_sign_payload(&object)?;
    let request: RecipientSignRequest = serde_json::from_value(serde_json::Value::Object(object))
        .map_err(|err| {
        CliError::usage(format!(
            "sign JSON did not match the required schema: {err}"
        ))
    })?;
    let idempotency_key = resolve_idempotency_key(args.idempotency_key.as_deref())?;
    let resp: RecipientSignResponse = client
        .post_recipient("/api/v1/recipient/sign", &request, &idempotency_key)
        .await?;
    print_success(&resp, raw, pretty)?;
    Ok(())
}

/// Validates that an envelope ID is a canonical lowercase RFC 9562 UUIDv7.
fn validate_envelope_id(id: &str) -> Result<(), CliError> {
    if !is_valid_uuid_v7(id) {
        return Err(CliError::usage(
            "Envelope IDs must be canonical lowercase RFC 9562 UUIDv7.",
        ));
    }
    Ok(())
}
