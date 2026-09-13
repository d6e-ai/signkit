use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "signkit",
    author = "SignKit Authors",
    version = "0.1.0",
    about = "Agent-first CLI for the SignKit e-signature platform",
    long_about = "Non-interactive, agent-first CLI for SignKit. Operates strictly within the enabled 'envelopes:read' API-key surface. All mutations and key management require interactive operator sessions and are not exposed here."
)]
pub struct Cli {
    /// Base URL of the SignKit service.
    #[arg(long, global = true, value_name = "URL")]
    pub base_url: Option<String>,

    /// Target organization identifier (mandatory for all envelope endpoints).
    #[arg(long, global = true, value_name = "ORG_ID")]
    pub org: Option<String>,

    /// Read API key from standard input rather than the SIGNKIT_API_KEY environment variable.
    #[arg(long, global = true)]
    pub api_key_stdin: bool,

    /// Path to non-secret configuration file.
    #[arg(long, global = true, value_name = "PATH")]
    pub config: Option<PathBuf>,

    /// Request timeout in seconds.
    #[arg(long, global = true, value_name = "SECONDS")]
    pub timeout: Option<u64>,

    /// Output raw API JSON response without the versioned CLI envelope wrapper.
    #[arg(long, global = true)]
    pub raw: bool,

    /// Pretty-print JSON output with indentation.
    #[arg(long, global = true)]
    pub pretty: bool,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Read system capabilities and supported runtime profiles (unauthenticated).
    Capabilities,

    /// Envelope query and inspection commands (requires envelopes:read scope).
    Envelopes(EnvelopesArgs),
}

#[derive(Debug, Args)]
pub struct EnvelopesArgs {
    #[command(subcommand)]
    pub subcommand: EnvelopesSubcommand,
}

#[derive(Debug, Subcommand)]
pub enum EnvelopesSubcommand {
    /// List envelopes in the authorized organization.
    List(EnvelopeListArgs),

    /// Read details of a specific envelope.
    Get(EnvelopeIdArg),

    /// Read the current draft workspace and tracked documents of an envelope.
    Draft(EnvelopeIdArg),

    /// Read the delivery status of invitations for an envelope.
    Deliveries(EnvelopeIdArg),

    /// Read completion artifact publication status for an envelope.
    CompletionArtifact(EnvelopeIdArg),
}

#[derive(Debug, Args)]
pub struct EnvelopeListArgs {
    /// Pagination cursor from a previous page's nextCursor.
    #[arg(long, value_name = "CURSOR")]
    pub cursor: Option<String>,

    /// Maximum number of envelopes to return per page (1..=100, default: 50).
    #[arg(long, value_name = "LIMIT")]
    pub limit: Option<u32>,
}

#[derive(Debug, Args)]
pub struct EnvelopeIdArg {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,
}
