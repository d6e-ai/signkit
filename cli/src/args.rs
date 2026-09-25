use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "signkit",
    author = "SignKit Authors",
    version,
    about = "Agent-first CLI for the SignKit e-signature platform",
    long_about = "Non-interactive, agent-first CLI for SignKit. Operates within the enabled API-key surface: envelopes:read, drafts:write, and envelopes:send. Key management and instance administration require interactive operator sessions and are not exposed here.",
    after_long_help = "Exit codes: 0 success; 1 internal or JSON error; 2 usage or local validation error; 3 authentication failure; 4 authorization failure; 5 not found; 6 conflict; 7 other client error; 8 rate limited; 9 server unavailable; 10 network failure; 11 timeout; 12 redirect refused."
)]
pub struct Cli {
    /// Base URL of the SignKit service.
    #[arg(long, global = true, value_name = "URL")]
    pub base_url: Option<String>,

    /// Read API key from standard input rather than the SIGNKIT_API_KEY environment variable.
    #[arg(long, global = true)]
    pub api_key_stdin: bool,

    /// Read the recipient capability token from standard input rather than the
    /// SIGNKIT_RECIPIENT_CAPABILITY environment variable. Used only by `recipient`
    /// commands; the sender SIGNKIT_API_KEY never authorizes them.
    #[arg(long, global = true)]
    pub recipient_capability_stdin: bool,

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

    /// Retrieve the OpenAPI 3.1 specification document (unauthenticated).
    Openapi,

    /// Envelope query, mutation, and evidence commands.
    Envelopes(EnvelopesArgs),

    /// Recipient capability commands: read context/documents, download a bounded
    /// PDF, and record viewed/sign/approve/decline. Authenticated solely by a
    /// recipient capability token, never by the sender API key.
    Recipient(RecipientArgs),
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

    /// List bounded draft revision history for an envelope.
    Revisions(EnvelopeRevisionsArgs),

    /// Read an exact draft revision by generation or commit SHA.
    Revision(EnvelopeRevisionArgs),

    /// Diff two draft revisions.
    RevisionDiff(EnvelopeRevisionDiffArgs),

    /// Download published completion evidence bytes (JSON or Markdown).
    Evidence(EnvelopeEvidenceArgs),

    /// Download the published executed agreement PDF.
    Pdf(EnvelopePdfArgs),

    /// Request a PAdES seal for the published executed agreement PDF (requires envelopes:send).
    PdfSealRequest(EnvelopePdfSealRequestArgs),

    /// Read PAdES seal job status for an envelope.
    PdfSealStatus(EnvelopeIdArg),

    /// Download the published, validated PAdES-sealed PDF.
    PdfSealDownload(EnvelopePdfSealDownloadArgs),
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
#[command(
    about = "Commit draft Markdown edits (requires drafts:write).",
    long_about = "Commit draft Markdown edits to the envelope draft workspace.\n\n\
        Supports local input validation via --validate-only (offline, non-mutating) \
        and schema discovery via --example.",
    after_help = "CANONICAL JSON EXAMPLE:\n  \
        {\n    \
          \"expectedGeneration\": 0,\n    \
          \"message\": \"Initial agreement draft\",\n    \
          \"edits\": [\n      \
            {\n        \
              \"path\": \"documents/agreement.md\",\n        \
              \"content\": \"# Mutual Non-Disclosure Agreement\\n\\nThis agreement...\"\n      \
            }\n    \
          ],\n    \
          \"provenance\": {\n      \
            \"automationRunId\": \"run-2026-09-24-001\",\n      \
            \"externalId\": \"workflow-step-1\"\n    \
          }\n  \
        }\n\n\
        EXAMPLES:\n  \
          signkit envelopes commit --example\n  \
          signkit envelopes commit --validate-only --file payload.json\n  \
          signkit envelopes commit 0191b26f-4000-7000-8000-000000000001 --file payload.json"
)]
pub struct EnvelopeCommitArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope. Optional when using --validate-only or --example.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: Option<String>,

    /// JSON file or `-` for stdin. Defaults to stdin.
    #[arg(long, value_name = "PATH", default_value = "-")]
    pub file: String,

    /// Overlay `expectedGeneration` onto the JSON body.
    #[arg(long, value_name = "N")]
    pub expected_generation: Option<u64>,

    /// Idempotency key. Generated as a UUIDv4 when omitted.
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,

    /// Safely validate payload locally without issuing a network request.
    #[arg(long)]
    pub validate_only: bool,

    /// Print a canonical JSON request example and exit.
    #[arg(long)]
    pub example: bool,
}

#[derive(Debug, Args)]
#[command(
    about = "Prepare a draft envelope for sending (requires drafts:write).",
    long_about = "Prepare a draft envelope for sending by declaring recipients and routing orders.\n\n\
        Supports local input validation via --validate-only (offline, non-mutating) \
        and schema discovery via --example.",
    after_help = "CANONICAL JSON EXAMPLE:\n  \
        {\n    \
          \"expectedGeneration\": 1,\n    \
          \"recipients\": [\n      \
            {\n        \
              \"email\": \"signer@example.com\",\n        \
              \"name\": \"Jane Doe\",\n        \
              \"role\": \"signer\",\n        \
              \"locale\": \"en\",\n        \
              \"routingOrder\": 1\n      \
            },\n      \
            {\n        \
              \"email\": \"approver@example.com\",\n        \
              \"name\": \"John Smith\",\n        \
              \"role\": \"approver\",\n        \
              \"locale\": \"en\",\n        \
              \"routingOrder\": 2\n      \
            }\n    \
          ]\n  \
        }\n\n\
        EXAMPLES:\n  \
          signkit envelopes ready --example\n  \
          signkit envelopes ready --validate-only --file payload.json\n  \
          signkit envelopes ready 0191b26f-4000-7000-8000-000000000001 --file payload.json"
)]
pub struct EnvelopeReadyArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope. Optional when using --validate-only or --example.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: Option<String>,

    /// JSON file or `-` for stdin. Defaults to stdin.
    #[arg(long, value_name = "PATH", default_value = "-")]
    pub file: String,

    /// Overlay `expectedGeneration` onto the JSON body.
    #[arg(long, value_name = "N")]
    pub expected_generation: Option<u64>,

    /// Idempotency key. Generated as a UUIDv4 when omitted.
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,

    /// Safely validate payload locally without issuing a network request.
    #[arg(long)]
    pub validate_only: bool,

    /// Print a canonical JSON request example and exit.
    #[arg(long)]
    pub example: bool,
}

#[derive(Debug, Args)]
#[command(
    about = "Place fields on a ready envelope (requires drafts:write).",
    long_about = "Place fields on a ready envelope.\n\n\
        Supports local input validation via --validate-only (offline, non-mutating) \
        and schema discovery via --example.",
    after_help = "CANONICAL JSON EXAMPLE:\n  \
        {\n    \
          \"expectedGeneration\": 1,\n    \
          \"expectedFieldGeneration\": 0,\n    \
          \"fields\": [\n      \
            {\n        \
              \"recipientId\": \"0191eb70-6523-74b2-b7b5-2fa75bb6d001\",\n        \
              \"documentId\": \"0191eb70-6523-74b2-b7b5-2fa75bb6d002\",\n        \
              \"fieldType\": \"signature\",\n        \
              \"label\": \"Signer Signature\",\n        \
              \"required\": true,\n        \
              \"position\": 0,\n        \
              \"geometry\": {\n          \
                \"page\": 1,\n          \
                \"x\": 0.1,\n          \
                \"y\": 0.7,\n          \
                \"width\": 0.25,\n          \
                \"height\": 0.05\n        \
              }\n      \
            }\n    \
          ]\n  \
        }\n\n\
        EXAMPLES:\n  \
          signkit envelopes fields --example\n  \
          signkit envelopes fields --validate-only --file payload.json\n  \
          signkit envelopes fields 0191b26f-4000-7000-8000-000000000001 --file payload.json"
)]
pub struct EnvelopeFieldsArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope. Optional when using --validate-only or --example.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: Option<String>,

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

    /// Safely validate payload locally without issuing a network request.
    #[arg(long)]
    pub validate_only: bool,

    /// Print a canonical JSON request example and exit.
    #[arg(long)]
    pub example: bool,
}

#[derive(Debug, Args)]
#[command(
    about = "Send a ready envelope (requires envelopes:send).",
    long_about = "Send a ready envelope to initiate recipient signing workflow.\n\n\
        Supports local input validation via --validate-only (offline, non-mutating) \
        and schema discovery via --example.",
    after_help = "CANONICAL JSON EXAMPLE:\n  \
        {\n    \
          \"expectedGeneration\": 1,\n    \
          \"expectedReadyAuditEventId\": \"0191eb70-6523-74b2-b7b5-2fa75bb6d003\"\n  \
        }\n\n\
        EXAMPLES:\n  \
          signkit envelopes send --example\n  \
          signkit envelopes send --validate-only --file payload.json\n  \
          signkit envelopes send 0191b26f-4000-7000-8000-000000000001 --file payload.json"
)]
pub struct EnvelopeSendArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope. Optional when using --validate-only or --example.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: Option<String>,

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

    /// Safely validate payload locally without issuing a network request.
    #[arg(long)]
    pub validate_only: bool,

    /// Print a canonical JSON request example and exit.
    #[arg(long)]
    pub example: bool,
}

#[derive(Debug, Args)]
#[command(
    about = "Void an envelope (requires envelopes:send).",
    long_about = "Void an envelope to terminate workflow.\n\n\
        Supports local input validation via --validate-only (offline, non-mutating) \
        and schema discovery via --example.",
    after_help = "CANONICAL JSON EXAMPLE:\n  \
        {\n    \
          \"expectedStatus\": \"sent\",\n    \
          \"expectedGeneration\": 1\n  \
        }\n\n\
        EXAMPLES:\n  \
          signkit envelopes void --example\n  \
          signkit envelopes void --validate-only --file payload.json\n  \
          signkit envelopes void 0191b26f-4000-7000-8000-000000000001 --file payload.json"
)]
pub struct EnvelopeVoidArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope. Optional when using --validate-only or --example.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: Option<String>,

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

    /// Safely validate payload locally without issuing a network request.
    #[arg(long)]
    pub validate_only: bool,

    /// Print a canonical JSON request example and exit.
    #[arg(long)]
    pub example: bool,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum PdfSealProfileArg {
    #[value(name = "pades-b-b")]
    PadesBB,
    #[value(name = "pades-b-t")]
    PadesBT,
}

impl PdfSealProfileArg {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PadesBB => "pades-b-b",
            Self::PadesBT => "pades-b-t",
        }
    }
}

#[derive(Debug, Args)]
pub struct EnvelopePdfSealRequestArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,

    /// Requested PAdES conformance profile. Must match the instance's configured profile.
    #[arg(long, value_enum)]
    pub profile: PdfSealProfileArg,

    /// Idempotency key. Generated as a UUIDv4 when omitted.
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Args)]
pub struct EnvelopePdfSealDownloadArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,

    /// Destination file. Sealed agreement bytes are never written to stdout.
    #[arg(long, value_name = "PATH")]
    pub output: String,
}

#[derive(Debug, Args)]
pub struct EnvelopeRevisionsArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,

    /// Pagination cursor generation from a previous page's nextCursor.
    #[arg(long, value_name = "GENERATION")]
    pub cursor: Option<u64>,

    /// Maximum number of revisions to return per page (1..=100, default: 50).
    #[arg(long, value_name = "LIMIT")]
    pub limit: Option<u32>,
}

#[derive(Debug, Args)]
pub struct EnvelopeRevisionArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,

    /// Revision reference: an integer generation or a 40-character hexadecimal commit SHA.
    #[arg(value_name = "REVISION_REF")]
    pub revision_ref: String,

    /// Specific document path to read (e.g. documents/agreement.md).
    #[arg(long, value_name = "PATH")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum RevisionDiffFormatArg {
    Json,
    Text,
    Unified,
}

impl RevisionDiffFormatArg {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Text => "text",
            Self::Unified => "unified",
        }
    }
}

#[derive(Debug, Args)]
pub struct EnvelopeRevisionDiffArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,

    /// Base revision reference (generation or commit SHA). Defaults to head - 1.
    #[arg(long, value_name = "REVISION_REF")]
    pub base: Option<String>,

    /// Head revision reference (generation or commit SHA). Defaults to the current revision.
    #[arg(long, value_name = "REVISION_REF")]
    pub head: Option<String>,

    /// Diff presentation format returned by the server (default: json).
    #[arg(long, value_enum, default_value = "json")]
    pub format: RevisionDiffFormatArg,

    /// Whether to compute unified diff text for modified text documents (default: true).
    #[arg(long, value_name = "BOOL")]
    pub include_unified: Option<bool>,
}

#[derive(Debug, Args)]
pub struct RecipientArgs {
    #[command(subcommand)]
    pub subcommand: RecipientSubcommand,
}

const RECIPIENT_CONSENT_HELP: &str = "Explicit confirmation that the recipient has reviewed and authorized this exact action. Supplying this flag is an attestation, by the caller, that the recipient genuinely took this action; an automated agent must never supply it without real, contemporaneous recipient authorization. Omit it (or use --validate-only / --example) to inspect or validate the command without submitting it.";

#[derive(Debug, Subcommand)]
pub enum RecipientSubcommand {
    /// Read the current recipient's signing context (authenticated by recipient capability).
    Context,

    /// Read the recipient's sent documents, source, placed fields, and field generation.
    Documents,

    /// Download the bounded PDF bytes for one sent document.
    Pdf(RecipientPdfArgs),

    /// Record that the recipient viewed the envelope (requires --consent).
    Viewed(RecipientActionArgs),

    /// Record the recipient's field values and signature (requires --consent).
    Sign(RecipientSignArgs),

    /// Record the recipient's approval (requires --consent).
    Approve(RecipientActionArgs),

    /// Record the recipient's decline (requires --consent).
    Decline(RecipientActionArgs),
}

#[derive(Debug, Args)]
#[command(
    about = "Download the bounded PDF bytes for one sent document.",
    long_about = "Download the bounded PDF bytes for one sent document belonging to the \
        envelope named by the recipient capability's own context.\n\n\
        Provide --document-id for envelopes with a pinned multi-document set. \
        Omit it only for legacy single-document envelopes, where the server \
        serves the one frozen agreement PDF directly.",
    after_help = "EXAMPLES:\n  \
        signkit recipient pdf 0191b26f-4000-7000-8000-000000000001 --document-id 0191eb70-6523-74b2-b7b5-2fa75bb6d002 --output agreement.pdf\n  \
        signkit recipient pdf 0191b26f-4000-7000-8000-000000000001 --output agreement.pdf"
)]
pub struct RecipientPdfArgs {
    /// Canonical RFC 9562 UUIDv7 identifier of the envelope.
    #[arg(value_name = "ENVELOPE_ID")]
    pub envelope_id: String,

    /// Canonical RFC 9562 UUIDv7 identifier of the document within the envelope. Omit only for legacy single-document envelopes.
    #[arg(long, value_name = "DOCUMENT_ID")]
    pub document_id: Option<String>,

    /// Destination file, or `-` for stdout.
    #[arg(long, value_name = "PATH")]
    pub output: String,
}

#[derive(Debug, Args)]
#[command(
    long_about = "Submit a recipient command (viewed, approve, or decline) identified by \
        envelopeId and recipientId.\n\n\
        Supports local input validation via --validate-only (offline, non-mutating) \
        and schema discovery via --example. Submitting the command for real requires \
        --consent, documented below.",
    after_help = "CANONICAL JSON EXAMPLE:\n  \
        {\n    \
          \"envelopeId\": \"0191b26f-4000-7000-8000-000000000001\",\n    \
          \"recipientId\": \"0191eb70-6523-74b2-b7b5-2fa75bb6d001\"\n  \
        }\n\n\
        CONSENT:\n  \
          Supplying --consent is an attestation that the recipient authorized this exact \
          action. An automated agent must never supply --consent without genuine, \
          contemporaneous recipient authorization for this specific command.\n\n\
        EXAMPLES:\n  \
          signkit recipient viewed --example\n  \
          signkit recipient viewed --validate-only --file payload.json\n  \
          signkit recipient viewed --file payload.json --consent"
)]
pub struct RecipientActionArgs {
    /// JSON file or `-` for stdin. Defaults to stdin.
    #[arg(long, value_name = "PATH", default_value = "-")]
    pub file: String,

    /// Overlay `envelopeId` onto the JSON body.
    #[arg(long, value_name = "ENVELOPE_ID")]
    pub envelope_id: Option<String>,

    /// Overlay `recipientId` onto the JSON body.
    #[arg(long, value_name = "RECIPIENT_ID")]
    pub recipient_id: Option<String>,

    /// Idempotency key. Generated as a UUIDv4 when omitted.
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,

    /// Safely validate payload locally without issuing a network request.
    #[arg(long)]
    pub validate_only: bool,

    /// Print a canonical JSON request example and exit.
    #[arg(long)]
    pub example: bool,

    #[arg(long, help = RECIPIENT_CONSENT_HELP)]
    pub consent: bool,
}

#[derive(Debug, Args)]
#[command(
    long_about = "Submit the recipient's field values and record their signature.\n\n\
        Supports local input validation via --validate-only (offline, non-mutating) \
        and schema discovery via --example. Submitting the command for real requires \
        --consent, documented below.",
    after_help = "CANONICAL JSON EXAMPLE:\n  \
        {\n    \
          \"envelopeId\": \"0191b26f-4000-7000-8000-000000000001\",\n    \
          \"recipientId\": \"0191eb70-6523-74b2-b7b5-2fa75bb6d001\",\n    \
          \"expectedFieldGeneration\": 0,\n    \
          \"values\": [\n      \
            {\n        \
              \"fieldId\": \"0191eb70-6523-74b2-b7b5-2fa75bb6d002\",\n        \
              \"value\": \"Jane Doe\"\n      \
            }\n    \
          ]\n  \
        }\n\n\
        CONSENT:\n  \
          Supplying --consent is an attestation that the recipient reviewed and \
          authorized signing with exactly these field values. An automated agent \
          must never supply --consent without genuine, contemporaneous recipient \
          authorization for this specific command.\n\n\
        EXAMPLES:\n  \
          signkit recipient sign --example\n  \
          signkit recipient sign --validate-only --file payload.json\n  \
          signkit recipient sign --file payload.json --consent"
)]
pub struct RecipientSignArgs {
    /// JSON file or `-` for stdin. Defaults to stdin.
    #[arg(long, value_name = "PATH", default_value = "-")]
    pub file: String,

    /// Overlay `envelopeId` onto the JSON body.
    #[arg(long, value_name = "ENVELOPE_ID")]
    pub envelope_id: Option<String>,

    /// Overlay `recipientId` onto the JSON body.
    #[arg(long, value_name = "RECIPIENT_ID")]
    pub recipient_id: Option<String>,

    /// Overlay `expectedFieldGeneration` onto the JSON body.
    #[arg(long, value_name = "N")]
    pub expected_field_generation: Option<u64>,

    /// Idempotency key. Generated as a UUIDv4 when omitted.
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,

    /// Safely validate payload locally without issuing a network request.
    #[arg(long)]
    pub validate_only: bool,

    /// Print a canonical JSON request example and exit.
    #[arg(long)]
    pub example: bool,

    #[arg(long, help = RECIPIENT_CONSENT_HELP)]
    pub consent: bool,
}
