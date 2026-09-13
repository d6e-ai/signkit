use crate::args::{EnvelopeIdArg, EnvelopeListArgs, EnvelopesSubcommand};
use crate::client::SignKitClient;
use crate::error::CliError;
use crate::output::print_success;
use crate::types::{
    is_valid_uuid_v7, CompletionArtifactResponse, DeliveryStatusResponse, DraftWorkspaceSnapshot,
    EnvelopeGetResponse, EnvelopeListPage,
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
        EnvelopesSubcommand::CompletionArtifact(args) => {
            get_completion_artifact(client, args, raw, pretty).await
        }
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

/// Validates that an envelope ID is a canonical lowercase RFC 9562 UUIDv7.
fn validate_envelope_id(id: &str) -> Result<(), CliError> {
    if !is_valid_uuid_v7(id) {
        return Err(CliError::usage(format!(
            "Invalid envelope ID '{id}'. Envelope IDs must be canonical lowercase RFC 9562 UUIDv7."
        )));
    }
    Ok(())
}
