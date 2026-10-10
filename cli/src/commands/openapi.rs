use crate::client::SignKitClient;
use crate::error::CliError;
use crate::output::print_success;
use crate::types::OpenApiDocument;

pub async fn execute(client: &SignKitClient, raw: bool, pretty: bool) -> Result<(), CliError> {
    let document: OpenApiDocument = client.get("/api/v1/openapi.json", &[], false).await?;
    print_success(&document, raw, pretty)?;
    Ok(())
}
