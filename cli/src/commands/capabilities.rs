use crate::client::SignKitClient;
use crate::error::CliError;
use crate::output::print_success;
use crate::types::CapabilitiesResponse;

pub async fn execute(client: &SignKitClient, raw: bool, pretty: bool) -> Result<(), CliError> {
    let capabilities: CapabilitiesResponse = client
        .get("/api/v1/system/capabilities", &[], false)
        .await?;

    print_success(&capabilities, raw, pretty)?;
    Ok(())
}
