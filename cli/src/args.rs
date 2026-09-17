use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "signkit",
    author = "SignKit Authors",
    version,
    about = "Agent-first CLI for the SignKit e-signature platform",
    long_about = "Non-interactive, agent-first CLI for SignKit. Operates within the enabled API-key surface: envelopes:read, drafts:write, and envelopes:send. Key management and instance administration require interactive operator sessions and are not exposed here."
)]
pub struct Cli {
    /// Base URL of the SignKit service.
    #[arg(long, global = true, value_name = "URL")]
    pub base_url: Option<String>,

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

    /// Envelope query, mutation, and evidence commands.
    Envelopes(EnvelopesArgs),
}

#[derive(Debug, Args)]
pub struct EnvelopesArgs {
    #[command(subcommand)]
    pub subcommand: EnvelopesSubcommand,
}

#[derive(Debug, Subcommand)]
pub enum EnvelopesSubcommand {
    /// List envelopes in the instance.
    List(EnvelopeListArgs),

    /// Read details of a specific envelope.
    Get(EnvelopeIdArg),

    /// Read the current draft workspace and tracked documents of an envelope.
    Draft(EnvelopeIdArg),

    /// Read the delivery status of invitations for an envelope.
    Deliveries(EnvelopeIdArg),

    /// Create a draft envelope (requires drafts:write).
    Create(EnvelopeCreateArgs),

    /// Commit draft Markdown edits (requires drafts:write).
    Commit(EnvelopeCommitArgs),

    /// Prepare a draft envelope for sending (requires drafts:write).
    Ready(EnvelopeReadyArgs),

    /// Place fields on a ready envelope (requires drafts:write).
    Fields(EnvelopeFieldsArgs),

    /// Send a ready envelope (requires envelopes:send).
    Send(EnvelopeSendArgs),

    /// Void an envelope (requires envelopes:send).
    Void(EnvelopeVoidArgs),

    /// Import a bounded DOCX file as a Markdown draft commit (requires drafts:write).
    ImportDocx(EnvelopeImportDocxArgs),

    /// Upload a bounded PDF as a draft document (requires drafts:write).
    UploadPdf(EnvelopeUploadPdfArgs),

    /// Reorder the draft document set, omitting IDs to remove documents (requires drafts:write).
    DocumentOrder(EnvelopeDocumentOrderArgs),

    /// Export the pinned revision as DOCX (requires envelopes:read).
    ExportDocx(EnvelopeExportDocxArgs),

    /// Read completion artifact publication status for an envelope.
    CompletionArtifact(EnvelopeIdArg),

    /// Download published completion evidence bytes (JSON or Markdown).
    Evidence(EnvelopeEvidenceArgs),

    /// Download the published executed agreement PDF.
    Pdf(EnvelopePdfArgs),
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

#[derive(Debug, Args)]
pub struct EnvelopeCreateArgs {
    /// Envelope title. Mutually exclusive with --file.
    #[arg(long)]
    pub title: Option<String>,

    /// JSON file or `-` for stdin containing `{ "title": "..." }`.
    #[arg(long, value_name = "PATH")]
    pub file: Option<String>,

    /// Idempotency key. Generated as a UUIDv4 when omitted.
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Args)]
pub struct EnvelopeCommitArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,

    /// JSON file or `-` for stdin. Defaults to stdin.
    #[arg(long, value_name = "PATH", default_value = "-")]
    pub file: String,

    /// Overlay `expectedGeneration` onto the JSON body.
    #[arg(long, value_name = "N")]
    pub expected_generation: Option<u64>,

    /// Idempotency key. Generated as a UUIDv4 when omitted.
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Args)]
pub struct EnvelopeReadyArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,

    /// JSON file or `-` for stdin. Defaults to stdin.
    #[arg(long, value_name = "PATH", default_value = "-")]
    pub file: String,

    /// Overlay `expectedGeneration` onto the JSON body.
    #[arg(long, value_name = "N")]
    pub expected_generation: Option<u64>,

    /// Idempotency key. Generated as a UUIDv4 when omitted.
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Args)]
pub struct EnvelopeFieldsArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,

    /// JSON file or `-` for stdin. Defaults to stdin.
    #[arg(long, value_name = "PATH", default_value = "-")]
    pub file: String,

    /// Overlay `expectedGeneration` onto the JSON body.
    #[arg(long, value_name = "N")]
    pub expected_generation: Option<u64>,

    /// Overlay `expectedFieldGeneration` onto the JSON body.
    #[arg(long, value_name = "N")]
    pub expected_field_generation: Option<u64>,

    /// Idempotency key. Generated as a UUIDv4 when omitted.
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Args)]
pub struct EnvelopeSendArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,

    /// JSON file or `-` for stdin. Defaults to stdin.
    #[arg(long, value_name = "PATH", default_value = "-")]
    pub file: String,

    /// Overlay `expectedGeneration` onto the JSON body.
    #[arg(long, value_name = "N")]
    pub expected_generation: Option<u64>,

    /// Overlay `expectedReadyAuditEventId` onto the JSON body.
    #[arg(long, value_name = "ID")]
    pub expected_ready_audit_event_id: Option<String>,

    /// Idempotency key. Generated as a UUIDv4 when omitted.
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Args)]
pub struct EnvelopeVoidArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,

    /// JSON file or `-` for stdin. Defaults to stdin.
    #[arg(long, value_name = "PATH", default_value = "-")]
    pub file: String,

    /// Overlay `expectedStatus` onto the JSON body.
    #[arg(long, value_name = "STATUS")]
    pub expected_status: Option<String>,

    /// Overlay `expectedGeneration` onto the JSON body.
    #[arg(long, value_name = "N")]
    pub expected_generation: Option<u64>,

    /// Idempotency key. Generated as a UUIDv4 when omitted.
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Args)]
pub struct EnvelopeImportDocxArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,

    /// DOCX file or `-` for stdin. Defaults to stdin.
    #[arg(long, value_name = "PATH", default_value = "-")]
    pub file: String,

    /// Target Markdown path under documents/.
    #[arg(long, value_name = "PATH")]
    pub target_path: String,

    /// Expected Git generation for the draft commit.
    #[arg(long, value_name = "N")]
    pub expected_generation: u64,

    /// Idempotency key. Generated as a UUIDv4 when omitted.
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Args)]
pub struct EnvelopeUploadPdfArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,

    /// PDF file or `-` for stdin. Defaults to stdin.
    #[arg(long, value_name = "PATH", default_value = "-")]
    pub file: String,

    /// Expected Git generation for the draft commit.
    #[arg(long, value_name = "N")]
    pub expected_generation: u64,

    /// Optional display title for the uploaded document.
    #[arg(long, value_name = "TITLE")]
    pub title: Option<String>,

    /// Optional zero-based insertion position (0..=19).
    #[arg(long, value_name = "N")]
    pub position: Option<u32>,

    /// Idempotency key. Generated as a UUIDv4 when omitted.
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Args)]
pub struct EnvelopeDocumentOrderArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,

    /// JSON file or `-` for stdin. Defaults to stdin.
    #[arg(long, value_name = "PATH", default_value = "-")]
    pub file: String,

    /// Overlay `expectedGeneration` onto the JSON body.
    #[arg(long, value_name = "N")]
    pub expected_generation: Option<u64>,

    /// Idempotency key. Generated as a UUIDv4 when omitted.
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Args)]
pub struct EnvelopeExportDocxArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,

    /// Destination file, or `-` for stdout.
    #[arg(long, value_name = "PATH")]
    pub output: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum EvidenceFormat {
    Json,
    Markdown,
}

impl EvidenceFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Markdown => "markdown",
        }
    }
}

#[derive(Debug, Args)]
pub struct EnvelopeEvidenceArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,

    /// Evidence representation to download.
    #[arg(long, value_enum, default_value = "json")]
    pub format: EvidenceFormat,

    /// Destination file, or `-` for stdout.
    #[arg(long, value_name = "PATH")]
    pub output: String,
}

#[derive(Debug, Args)]
pub struct EnvelopePdfArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,

    /// Destination file, or `-` for stdout.
    #[arg(long, value_name = "PATH")]
    pub output: String,
}
