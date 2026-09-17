use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

/// Current version of the CLI output envelope.
pub const CURRENT_SCHEMA_VERSION: &str = "1";

/// Validates that a string is a canonical lowercase RFC 9562 UUIDv7.
///
/// Must match `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`.
pub fn is_valid_uuid_v7(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    if bytes[8] != b'-' || bytes[13] != b'-' || bytes[18] != b'-' || bytes[23] != b'-' {
        return false;
    }
    // Version 7: character at index 14 must be '7'
    if bytes[14] != b'7' {
        return false;
    }
    // Variant 1: character at index 19 must be '8', '9', 'a', or 'b'
    if !matches!(bytes[19], b'8' | b'9' | b'a' | b'b') {
        return false;
    }

    for (i, &b) in bytes.iter().enumerate() {
        if i == 8 || i == 13 || i == 18 || i == 23 {
            continue;
        }
        if !b.is_ascii_digit() && !(b'a'..=b'f').contains(&b) {
            return false;
        }
    }
    true
}

/// Versioned CLI output envelope wrapping successful command responses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliEnvelope<T> {
    pub version: String,
    pub data: T,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl<T> CliEnvelope<T> {
    pub fn new(data: T) -> Self {
        Self {
            version: CURRENT_SCHEMA_VERSION.to_string(),
            data,
            extra: BTreeMap::new(),
        }
    }
}

/// Default problem type per RFC 9457 Section 3.1:
/// "When this member is not present, its value is assumed to be 'about:blank'".
fn default_problem_type() -> String {
    "about:blank".to_string()
}

/// RFC 9457 Problem Details for HTTP APIs.
/// Preserves partial problem documents and unknown extension fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProblemDetail {
    #[serde(default = "default_problem_type")]
    pub r#type: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: u16,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub instance: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<ProblemValidationError>>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProblemValidationError {
    pub path: String,
    pub message: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Profile details in system capabilities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileDetails {
    pub database: String,
    pub objects: String,
    pub status: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Supported deployment profiles in system capabilities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SupportedProfiles {
    pub node: ProfileDetails,
    pub cloudflare: ProfileDetails,
    pub vercel: ProfileDetails,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftHistoryCapability {
    pub format: String,
    pub archive: String,
    #[serde(rename = "trackedFiles")]
    pub tracked_files: Vec<String>,
    #[serde(rename = "commitEndpoint")]
    pub commit_endpoint: String,
    pub concurrency: String,
    pub idempotency: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadinessCapability {
    pub endpoint: String,
    pub recipients: String,
    #[serde(rename = "actionableRoles")]
    pub actionable_roles: Vec<String>,
    #[serde(rename = "observerRoles")]
    pub observer_roles: Vec<String>,
    #[serde(rename = "preSendOnlyRoles")]
    pub pre_send_only_roles: Vec<String>,
    pub concurrency: String,
    pub idempotency: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendingCapability {
    pub endpoint: String,
    pub concurrency: String,
    pub delivery: String,
    pub idempotency: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoidingCapability {
    pub endpoint: String,
    pub authentication: String,
    pub concurrency: String,
    #[serde(rename = "terminalCleanup")]
    pub terminal_cleanup: String,
    pub idempotency: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeliveryTransports {
    pub cloudflare: String,
    pub node: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeliveryCapability {
    #[serde(rename = "statusEndpoint")]
    pub status_endpoint: String,
    #[serde(rename = "workerEndpoint")]
    pub worker_endpoint: String,
    #[serde(rename = "workerAuthentication")]
    pub worker_authentication: String,
    pub semantics: String,
    pub transports: DeliveryTransports,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalDeclineReceiptCapability {
    #[serde(rename = "browserSession")]
    pub browser_session: String,
    pub revalidation: String,
    #[serde(rename = "retentionDays")]
    pub retention_days: u32,
    #[serde(rename = "documentAccess")]
    pub document_access: bool,
    pub mutations: bool,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipientAccessCapability {
    pub endpoint: String,
    #[serde(rename = "documentsEndpoint")]
    pub documents_endpoint: String,
    #[serde(rename = "viewedEndpoint")]
    pub viewed_endpoint: String,
    #[serde(rename = "declineEndpoint")]
    pub decline_endpoint: String,
    #[serde(rename = "approveEndpoint")]
    pub approve_endpoint: String,
    #[serde(rename = "signEndpoint")]
    pub sign_endpoint: String,
    #[serde(rename = "linkExchange")]
    pub link_exchange: String,
    #[serde(rename = "webSurface")]
    pub web_surface: String,
    pub authentication: String,
    #[serde(rename = "browserSession")]
    pub browser_session: String,
    #[serde(rename = "terminalDeclineReceipt")]
    pub terminal_decline_receipt: TerminalDeclineReceiptCapability,
    pub mutations: String,
    pub roles: Vec<String>,
    pub states: Vec<String>,
    pub cache: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompletionArtifactCapability {
    #[serde(rename = "statusEndpoint")]
    pub status_endpoint: String,
    #[serde(rename = "workerEndpoint")]
    pub worker_endpoint: String,
    #[serde(rename = "workerAuthentication")]
    pub worker_authentication: String,
    pub authentication: String,
    pub discovery: String,
    #[serde(rename = "manifestSchema")]
    pub manifest_schema: String,
    pub artifacts: Vec<String>,
    #[serde(rename = "auditVerification")]
    pub audit_verification: String,
    #[serde(rename = "ccDelivery")]
    pub cc_delivery: String,
    #[serde(rename = "publicArtifactGrants")]
    pub public_artifact_grants: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompletionDeliveryCapability {
    #[serde(rename = "workerEndpoint")]
    pub worker_endpoint: String,
    #[serde(rename = "workerAuthentication")]
    pub worker_authentication: String,
    pub semantics: String,
    pub transports: DeliveryTransports,
    pub roles: Vec<String>,
    pub prerequisite: String,
    #[serde(rename = "tokenFormat")]
    pub token_format: String,
    #[serde(rename = "grantRetentionDays")]
    pub grant_retention_days: u32,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicCompletionArtifactCapability {
    #[serde(rename = "apiEndpoint")]
    pub api_endpoint: String,
    #[serde(rename = "linkEndpoint")]
    pub link_endpoint: String,
    pub authentication: String,
    pub formats: Vec<String>,
    #[serde(rename = "tokenPrefix")]
    pub token_prefix: String,
    pub cookies: bool,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiKeyRateLimits {
    pub durable: bool,
    #[serde(rename = "windowSeconds")]
    pub window_seconds: u32,
    #[serde(rename = "maxRequests")]
    pub max_requests: u32,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiKeyActor {
    #[serde(rename = "type")]
    pub actor_type: String,
    pub id: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiKeyAuthenticationCapability {
    pub scheme: String,
    #[serde(rename = "tokenPrefix")]
    pub token_prefix: String,
    pub authority: String,
    #[serde(rename = "effectiveAuthority")]
    pub effective_authority: String,
    #[serde(rename = "enabledScopes")]
    pub enabled_scopes: Vec<String>,
    #[serde(rename = "readEndpoints")]
    pub read_endpoints: Vec<String>,
    #[serde(rename = "writeEndpoints")]
    pub write_endpoints: BTreeMap<String, Vec<String>>,
    pub mutations: bool,
    #[serde(rename = "cookieComposition")]
    pub cookie_composition: bool,
    pub caching: String,
    #[serde(rename = "lastUsedTracking")]
    pub last_used_tracking: bool,
    #[serde(rename = "rateLimits")]
    pub rate_limits: ApiKeyRateLimits,
    pub actor: ApiKeyActor,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationCapability {
    #[serde(rename = "idempotencyKeys")]
    pub idempotency_keys: bool,
    #[serde(rename = "actorProvenance")]
    pub actor_provenance: bool,
    pub webhooks: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Response payload for `GET /api/v1/system/capabilities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilitiesResponse {
    pub name: String,
    #[serde(rename = "apiVersion")]
    pub api_version: String,
    pub runtime: String,
    #[serde(rename = "supportedProfiles")]
    pub supported_profiles: SupportedProfiles,
    #[serde(rename = "draftHistory")]
    pub draft_history: DraftHistoryCapability,
    pub readiness: ReadinessCapability,
    pub sending: SendingCapability,
    pub voiding: VoidingCapability,
    pub delivery: DeliveryCapability,
    #[serde(rename = "recipientAccess")]
    pub recipient_access: RecipientAccessCapability,
    #[serde(rename = "completionArtifact")]
    pub completion_artifact: CompletionArtifactCapability,
    #[serde(rename = "completionDelivery")]
    pub completion_delivery: CompletionDeliveryCapability,
    #[serde(rename = "publicCompletionArtifact")]
    pub public_completion_artifact: PublicCompletionArtifactCapability,
    #[serde(rename = "apiKeyAuthentication")]
    pub api_key_authentication: ApiKeyAuthenticationCapability,
    pub automation: AutomationCapability,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Status of an envelope. Extensible to support future enum variants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvelopeStatus {
    Draft,
    Ready,
    Sent,
    InProgress,
    Completed,
    Declined,
    Expired,
    Voided,
    Other(String),
}

impl EnvelopeStatus {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Draft => "draft",
            Self::Ready => "ready",
            Self::Sent => "sent",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Declined => "declined",
            Self::Expired => "expired",
            Self::Voided => "voided",
            Self::Other(s) => s.as_str(),
        }
    }
}

impl Serialize for EnvelopeStatus {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for EnvelopeStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(match s.as_str() {
            "draft" => Self::Draft,
            "ready" => Self::Ready,
            "sent" => Self::Sent,
            "in_progress" => Self::InProgress,
            "completed" => Self::Completed,
            "declined" => Self::Declined,
            "expired" => Self::Expired,
            "voided" => Self::Voided,
            _ => Self::Other(s),
        })
    }
}

/// Envelope entity returned by the API. Preserves unknown extension fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    pub id: String,
    #[serde(default, rename = "createdByUserId")]
    pub created_by_user_id: Option<String>,
    pub title: String,
    pub status: EnvelopeStatus,
    #[serde(rename = "repositoryGeneration")]
    pub repository_generation: u64,
    #[serde(rename = "repositoryHead")]
    pub repository_head: Option<String>,
    #[serde(rename = "repositoryArchiveSha256")]
    pub repository_archive_sha256: Option<String>,
    #[serde(rename = "sentCommitSha")]
    pub sent_commit_sha: Option<String>,
    #[serde(rename = "fieldGeneration")]
    pub field_generation: u64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Envelope list page from `GET /api/v1/envelopes`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvelopeListPage {
    pub items: Vec<Envelope>,
    #[serde(rename = "nextCursor")]
    pub next_cursor: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Response payload from `GET /api/v1/envelopes/{envelopeId}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvelopeGetResponse {
    pub envelope: Envelope,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// A document tracked within the draft workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftDocument {
    pub path: String,
    pub content: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Draft workspace snapshot from `GET /api/v1/envelopes/{envelopeId}/draft`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftWorkspaceSnapshot {
    pub generation: u64,
    #[serde(rename = "commitSha")]
    pub commit_sha: Option<String>,
    #[serde(rename = "archiveSha256")]
    pub archive_sha256: Option<String>,
    pub documents: Vec<DraftDocument>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Individual recipient delivery status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicDeliveryStatus {
    #[serde(rename = "recipientId")]
    pub recipient_id: String,
    #[serde(rename = "recipientRole")]
    pub recipient_role: String,
    #[serde(rename = "routingOrder")]
    pub routing_order: u32,
    pub status: String,
    pub attempts: u32,
    #[serde(rename = "availableAt")]
    pub available_at: Option<String>,
    #[serde(rename = "deliveredAt")]
    pub delivered_at: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "errorCode")]
    pub error_code: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Overall delivery status for an envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicEnvelopeDeliveryStatus {
    #[serde(rename = "envelopeId")]
    pub envelope_id: String,
    #[serde(rename = "envelopeStatus")]
    pub envelope_status: EnvelopeStatus,
    pub deliveries: Vec<PublicDeliveryStatus>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Response payload from `GET /api/v1/envelopes/{envelopeId}/deliveries`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeliveryStatusResponse {
    pub delivery: PublicEnvelopeDeliveryStatus,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Completion artifact status. Extensible for unknown variants and unknown fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PublicCompletionArtifactStatus {
    NotCompleted {
        envelope_id: String,
        extra: BTreeMap<String, serde_json::Value>,
    },
    Pending {
        envelope_id: String,
        attempts: u32,
        extra: BTreeMap<String, serde_json::Value>,
    },
    Processing {
        envelope_id: String,
        attempts: u32,
        extra: BTreeMap<String, serde_json::Value>,
    },
    Failed {
        envelope_id: String,
        attempts: u32,
        error_code: Option<String>,
        available_at: Option<String>,
        extra: BTreeMap<String, serde_json::Value>,
    },
    Published {
        envelope_id: String,
        published_at: String,
        manifest_sha256: String,
        json_sha256: String,
        markdown_sha256: String,
        extra: BTreeMap<String, serde_json::Value>,
    },
    Other {
        status: String,
        extra: BTreeMap<String, serde_json::Value>,
    },
}

impl Serialize for PublicCompletionArtifactStatus {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::NotCompleted { envelope_id, extra } => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("status", "not_completed")?;
                map.serialize_entry("envelopeId", envelope_id)?;
                for (k, v) in extra {
                    if k != "status" && k != "envelopeId" {
                        map.serialize_entry(k, v)?;
                    }
                }
                map.end()
            }
            Self::Pending {
                envelope_id,
                attempts,
                extra,
            } => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("status", "pending")?;
                map.serialize_entry("envelopeId", envelope_id)?;
                map.serialize_entry("attempts", attempts)?;
                for (k, v) in extra {
                    if k != "status" && k != "envelopeId" && k != "attempts" {
                        map.serialize_entry(k, v)?;
                    }
                }
                map.end()
            }
            Self::Processing {
                envelope_id,
                attempts,
                extra,
            } => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("status", "processing")?;
                map.serialize_entry("envelopeId", envelope_id)?;
                map.serialize_entry("attempts", attempts)?;
                for (k, v) in extra {
                    if k != "status" && k != "envelopeId" && k != "attempts" {
                        map.serialize_entry(k, v)?;
                    }
                }
                map.end()
            }
            Self::Failed {
                envelope_id,
                attempts,
                error_code,
                available_at,
                extra,
            } => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("status", "failed")?;
                map.serialize_entry("envelopeId", envelope_id)?;
                map.serialize_entry("attempts", attempts)?;
                if let Some(ec) = error_code {
                    map.serialize_entry("errorCode", ec)?;
                }
                if let Some(aa) = available_at {
                    map.serialize_entry("availableAt", aa)?;
                }
                for (k, v) in extra {
                    if k != "status"
                        && k != "envelopeId"
                        && k != "attempts"
                        && k != "errorCode"
                        && k != "availableAt"
                    {
                        map.serialize_entry(k, v)?;
                    }
                }
                map.end()
            }
            Self::Published {
                envelope_id,
                published_at,
                manifest_sha256,
                json_sha256,
                markdown_sha256,
                extra,
            } => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("status", "published")?;
                map.serialize_entry("envelopeId", envelope_id)?;
                map.serialize_entry("publishedAt", published_at)?;
                map.serialize_entry("manifestSha256", manifest_sha256)?;
                map.serialize_entry("jsonSha256", json_sha256)?;
                map.serialize_entry("markdownSha256", markdown_sha256)?;
                for (k, v) in extra {
                    if k != "status"
                        && k != "envelopeId"
                        && k != "publishedAt"
                        && k != "manifestSha256"
                        && k != "jsonSha256"
                        && k != "markdownSha256"
                    {
                        map.serialize_entry(k, v)?;
                    }
                }
                map.end()
            }
            Self::Other { status, extra } => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("status", status)?;
                for (k, v) in extra {
                    if k != "status" {
                        map.serialize_entry(k, v)?;
                    }
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for PublicCompletionArtifactStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct ArtifactVisitor;

        impl<'de> Visitor<'de> for ArtifactVisitor {
            type Value = PublicCompletionArtifactStatus;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a completion artifact status object with status field")
            }

            fn visit_map<M>(self, mut access: M) -> Result<Self::Value, M::Error>
            where
                M: MapAccess<'de>,
            {
                let mut raw_map = BTreeMap::<String, serde_json::Value>::new();
                while let Some((k, v)) = access.next_entry::<String, serde_json::Value>()? {
                    raw_map.insert(k, v);
                }

                let status_val = raw_map
                    .remove("status")
                    .ok_or_else(|| de::Error::missing_field("status"))?;
                let status_str = status_val
                    .as_str()
                    .ok_or_else(|| de::Error::custom("status must be a string"))?;

                match status_str {
                    "not_completed" => {
                        let envelope_id = raw_map
                            .remove("envelopeId")
                            .and_then(|v| v.as_str().map(String::from))
                            .ok_or_else(|| de::Error::missing_field("envelopeId"))?;
                        Ok(PublicCompletionArtifactStatus::NotCompleted {
                            envelope_id,
                            extra: raw_map,
                        })
                    }
                    "pending" => {
                        let envelope_id = raw_map
                            .remove("envelopeId")
                            .and_then(|v| v.as_str().map(String::from))
                            .ok_or_else(|| de::Error::missing_field("envelopeId"))?;
                        let attempts = raw_map
                            .remove("attempts")
                            .and_then(|v| v.as_u64())
                            .map(|u| u as u32)
                            .unwrap_or(0);
                        Ok(PublicCompletionArtifactStatus::Pending {
                            envelope_id,
                            attempts,
                            extra: raw_map,
                        })
                    }
                    "processing" => {
                        let envelope_id = raw_map
                            .remove("envelopeId")
                            .and_then(|v| v.as_str().map(String::from))
                            .ok_or_else(|| de::Error::missing_field("envelopeId"))?;
                        let attempts = raw_map
                            .remove("attempts")
                            .and_then(|v| v.as_u64())
                            .map(|u| u as u32)
                            .unwrap_or(0);
                        Ok(PublicCompletionArtifactStatus::Processing {
                            envelope_id,
                            attempts,
                            extra: raw_map,
                        })
                    }
                    "failed" => {
                        let envelope_id = raw_map
                            .remove("envelopeId")
                            .and_then(|v| v.as_str().map(String::from))
                            .ok_or_else(|| de::Error::missing_field("envelopeId"))?;
                        let attempts = raw_map
                            .remove("attempts")
                            .and_then(|v| v.as_u64())
                            .map(|u| u as u32)
                            .unwrap_or(0);
                        let error_code = raw_map
                            .remove("errorCode")
                            .and_then(|v| v.as_str().map(String::from));
                        let available_at = raw_map
                            .remove("availableAt")
                            .and_then(|v| v.as_str().map(String::from));
                        Ok(PublicCompletionArtifactStatus::Failed {
                            envelope_id,
                            attempts,
                            error_code,
                            available_at,
                            extra: raw_map,
                        })
                    }
                    "published" => {
                        let envelope_id = raw_map
                            .remove("envelopeId")
                            .and_then(|v| v.as_str().map(String::from))
                            .ok_or_else(|| de::Error::missing_field("envelopeId"))?;
                        let published_at = raw_map
                            .remove("publishedAt")
                            .and_then(|v| v.as_str().map(String::from))
                            .ok_or_else(|| de::Error::missing_field("publishedAt"))?;
                        let manifest_sha256 = raw_map
                            .remove("manifestSha256")
                            .and_then(|v| v.as_str().map(String::from))
                            .ok_or_else(|| de::Error::missing_field("manifestSha256"))?;
                        let json_sha256 = raw_map
                            .remove("jsonSha256")
                            .and_then(|v| v.as_str().map(String::from))
                            .ok_or_else(|| de::Error::missing_field("jsonSha256"))?;
                        let markdown_sha256 = raw_map
                            .remove("markdownSha256")
                            .and_then(|v| v.as_str().map(String::from))
                            .ok_or_else(|| de::Error::missing_field("markdownSha256"))?;
                        Ok(PublicCompletionArtifactStatus::Published {
                            envelope_id,
                            published_at,
                            manifest_sha256,
                            json_sha256,
                            markdown_sha256,
                            extra: raw_map,
                        })
                    }
                    other => Ok(PublicCompletionArtifactStatus::Other {
                        status: other.to_string(),
                        extra: raw_map,
                    }),
                }
            }
        }

        deserializer.deserialize_map(ArtifactVisitor)
    }
}

/// Response payload from `GET /api/v1/envelopes/{envelopeId}/completion-artifact`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompletionArtifactResponse {
    #[serde(rename = "completionArtifact")]
    pub completion_artifact: PublicCompletionArtifactStatus,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvelopeCreateRequest {
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvelopeCreateResponse {
    pub envelope: Envelope,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftEdit {
    pub path: String,
    pub content: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftCommitProvenance {
    #[serde(rename = "automationRunId", skip_serializing_if = "Option::is_none")]
    pub automation_run_id: Option<String>,
    #[serde(rename = "externalId", skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftCommitRequest {
    #[serde(rename = "expectedGeneration")]
    pub expected_generation: u64,
    pub message: String,
    pub edits: Vec<DraftEdit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<DraftCommitProvenance>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftRevision {
    pub generation: u64,
    #[serde(rename = "commitSha")]
    pub commit_sha: String,
    #[serde(rename = "archiveSha256")]
    pub archive_sha256: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftCommitResponse {
    pub revision: DraftRevision,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentOrderRequest {
    #[serde(rename = "expectedGeneration")]
    pub expected_generation: u64,
    #[serde(rename = "documentIds")]
    pub document_ids: Vec<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Receipt written to stdout when DOCX export lands on a regular file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocxExportReceipt {
    pub path: String,
    pub bytes: u64,
    #[serde(rename = "commitSha")]
    pub commit_sha: Option<String>,
}

/// Receipt written to stdout when evidence or PDF download lands on a regular file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactDownloadReceipt {
    pub path: String,
    pub bytes: u64,
    pub format: String,
    #[serde(rename = "contentType")]
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadyRecipient {
    pub email: String,
    pub name: String,
    pub role: String,
    pub locale: String,
    #[serde(rename = "routingOrder")]
    pub routing_order: u32,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadyEnvelopeRequest {
    #[serde(rename = "expectedGeneration")]
    pub expected_generation: u64,
    pub recipients: Vec<ReadyRecipient>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishedReadyEnvelope {
    #[serde(rename = "envelopeId")]
    pub envelope_id: String,
    pub status: EnvelopeStatus,
    pub generation: u64,
    #[serde(rename = "commitSha")]
    pub commit_sha: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "auditEventId")]
    pub audit_event_id: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadyEnvelopeResponse {
    pub ready: PublishedReadyEnvelope,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldPlacement {
    #[serde(rename = "recipientId")]
    pub recipient_id: String,
    #[serde(rename = "documentPath")]
    pub document_path: String,
    #[serde(rename = "fieldType")]
    pub field_type: String,
    pub label: String,
    pub required: bool,
    pub position: u32,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaceFieldsRequest {
    #[serde(rename = "expectedGeneration")]
    pub expected_generation: u64,
    #[serde(rename = "expectedFieldGeneration")]
    pub expected_field_generation: u64,
    pub fields: Vec<FieldPlacement>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishedFieldPlacement {
    #[serde(rename = "envelopeId")]
    pub envelope_id: String,
    pub generation: u64,
    #[serde(rename = "fieldGeneration")]
    pub field_generation: u64,
    #[serde(rename = "commitSha")]
    pub commit_sha: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "auditEventId")]
    pub audit_event_id: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaceFieldsResponse {
    pub fields: PublishedFieldPlacement,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendEnvelopeRequest {
    #[serde(rename = "expectedGeneration")]
    pub expected_generation: u64,
    #[serde(rename = "expectedReadyAuditEventId")]
    pub expected_ready_audit_event_id: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishedSentEnvelope {
    #[serde(rename = "envelopeId")]
    pub envelope_id: String,
    pub status: EnvelopeStatus,
    pub generation: u64,
    #[serde(rename = "commitSha")]
    pub commit_sha: String,
    #[serde(rename = "readyAuditEventId")]
    pub ready_audit_event_id: String,
    #[serde(rename = "queuedDeliveryCount")]
    pub queued_delivery_count: u32,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "auditEventId")]
    pub audit_event_id: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendEnvelopeResponse {
    pub sent: PublishedSentEnvelope,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoidEnvelopeRequest {
    #[serde(rename = "expectedStatus")]
    pub expected_status: EnvelopeStatus,
    #[serde(rename = "expectedGeneration")]
    pub expected_generation: u64,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishedVoidedEnvelope {
    #[serde(rename = "envelopeId")]
    pub envelope_id: String,
    pub status: EnvelopeStatus,
    #[serde(rename = "previousStatus")]
    pub previous_status: EnvelopeStatus,
    pub generation: u64,
    #[serde(rename = "voidedAt")]
    pub voided_at: String,
    #[serde(rename = "revokedCapabilityCount")]
    pub revoked_capability_count: u32,
    #[serde(rename = "auditEventId")]
    pub audit_event_id: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoidEnvelopeResponse {
    pub voided: PublishedVoidedEnvelope,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_uuid_v7_validation() {
        assert!(is_valid_uuid_v7("0191b26f-4000-7000-8000-000000000001"));
        assert!(is_valid_uuid_v7("0191b26f-4000-7abc-9fff-000000000002"));
        assert!(is_valid_uuid_v7("0191b26f-4000-7123-afff-000000000003"));
        assert!(is_valid_uuid_v7("0191b26f-4000-7456-bfff-000000000004"));

        // Uppercase rejected (must be canonical lowercase)
        assert!(!is_valid_uuid_v7("0191B26F-4000-7000-8000-000000000001"));
        // Version 4 rejected (must be version 7)
        assert!(!is_valid_uuid_v7("0191b26f-4000-4000-8000-000000000001"));
        // Invalid variant bits (must be 8, 9, a, b)
        assert!(!is_valid_uuid_v7("0191b26f-4000-7000-c000-000000000001"));
        // Invalid lengths or characters
        assert!(!is_valid_uuid_v7("0191b26f"));
        assert!(!is_valid_uuid_v7("0191b26f-4000-7000-8000-00000000000z"));
    }

    #[test]
    fn test_envelope_status_future_variant_round_trip() {
        // Known variant
        let status: EnvelopeStatus = serde_json::from_str("\"in_progress\"").unwrap();
        assert_eq!(status, EnvelopeStatus::InProgress);
        assert_eq!(serde_json::to_string(&status).unwrap(), "\"in_progress\"");

        // Future/unknown variant
        let future_status: EnvelopeStatus = serde_json::from_str("\"reconciling\"").unwrap();
        assert_eq!(
            future_status,
            EnvelopeStatus::Other("reconciling".to_string())
        );
        assert_eq!(
            serde_json::to_string(&future_status).unwrap(),
            "\"reconciling\""
        );
    }

    #[test]
    fn test_public_envelope_does_not_require_object_keys() {
        let raw = r#"{
            "id": "0191b26f-4000-7000-8000-000000000001",
            "createdByUserId": "user_test",
            "title": "Test Envelope",
            "status": "draft",
            "repositoryGeneration": 1,
            "repositoryHead": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "repositoryArchiveSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "sentCommitSha": null,
            "fieldGeneration": 0,
            "createdAt": "2026-09-13T10:00:00Z",
            "updatedAt": "2026-09-13T10:05:00Z"
        }"#;
        let envelope: Envelope = serde_json::from_str(raw).unwrap();
        assert!(envelope.repository_head.is_some());
        assert!(envelope.repository_archive_sha256.is_some());
        assert!(!envelope.extra.contains_key("repositoryArchiveKey"));
        let serialized = serde_json::to_string(&envelope).unwrap();
        assert!(!serialized.contains("repositoryArchiveKey"));
    }

    #[test]
    fn test_envelope_preserves_unknown_fields_round_trip() {
        let raw = r#"{
            "id": "0191b26f-4000-7000-8000-000000000001",
            "createdByUserId": "user_test",
            "title": "Test Envelope",
            "status": "draft",
            "repositoryGeneration": 1,
            "repositoryHead": null,
            "repositoryArchiveSha256": null,
            "sentCommitSha": null,
            "fieldGeneration": 0,
            "createdAt": "2026-09-13T10:00:00Z",
            "updatedAt": "2026-09-13T10:05:00Z",
            "unknownFutureField": "future_value",
            "nestedObject": { "key": 42 }
        }"#;

        let envelope: Envelope = serde_json::from_str(raw).unwrap();
        assert_eq!(envelope.id, "0191b26f-4000-7000-8000-000000000001");
        assert_eq!(
            envelope.extra.get("unknownFutureField"),
            Some(&serde_json::json!("future_value"))
        );

        let serialized = serde_json::to_string(&envelope).unwrap();
        let re_deserialized: Envelope = serde_json::from_str(&serialized).unwrap();
        assert_eq!(envelope, re_deserialized);
    }

    #[test]
    fn test_completion_artifact_preserves_unknown_status_and_fields() {
        // 1. Not completed variant
        let not_completed_json = r#"{
            "envelopeId": "0191b26f-4000-7000-8000-000000000001",
            "status": "not_completed",
            "extraMeta": "preserved"
        }"#;
        let nc: PublicCompletionArtifactStatus = serde_json::from_str(not_completed_json).unwrap();
        match &nc {
            PublicCompletionArtifactStatus::NotCompleted { envelope_id, extra } => {
                assert_eq!(envelope_id, "0191b26f-4000-7000-8000-000000000001");
                assert_eq!(
                    extra.get("extraMeta"),
                    Some(&serde_json::json!("preserved"))
                );
            }
            _ => panic!("Expected NotCompleted"),
        }
        let nc_re = serde_json::to_string(&nc).unwrap();
        let nc_back: PublicCompletionArtifactStatus = serde_json::from_str(&nc_re).unwrap();
        assert_eq!(nc, nc_back);

        // 2. Future unknown status variant
        let future_json = r#"{
            "status": "reconciling",
            "envelopeId": "0191b26f-4000-7000-8000-000000000001",
            "stage": 2
        }"#;
        let future: PublicCompletionArtifactStatus = serde_json::from_str(future_json).unwrap();
        match &future {
            PublicCompletionArtifactStatus::Other { status, extra } => {
                assert_eq!(status, "reconciling");
                assert_eq!(extra.get("stage"), Some(&serde_json::json!(2)));
            }
            _ => panic!("Expected Other"),
        }
        let future_re = serde_json::to_string(&future).unwrap();
        let future_back: PublicCompletionArtifactStatus = serde_json::from_str(&future_re).unwrap();
        assert_eq!(future, future_back);
    }

    #[test]
    fn test_partial_rfc9457_problem_json_preserves_type_and_fields() {
        // Partial problem with custom type and status, missing title/detail/instance
        let partial_json = r#"{
            "type": "urn:signkit:problem:custom-reason",
            "status": 422,
            "customExtension": "custom_data"
        }"#;

        let problem: ProblemDetail = serde_json::from_str(partial_json).unwrap();
        assert_eq!(problem.r#type, "urn:signkit:problem:custom-reason");
        assert_eq!(problem.status, 422);
        assert_eq!(
            problem.extra.get("customExtension"),
            Some(&serde_json::json!("custom_data"))
        );

        let round_trip = serde_json::to_string(&problem).unwrap();
        let re_parsed: ProblemDetail = serde_json::from_str(&round_trip).unwrap();
        assert_eq!(problem, re_parsed);

        // Partial problem without type defaults to about:blank
        let no_type_json = r#"{
            "status": 404,
            "detail": "Envelope not found"
        }"#;
        let problem_no_type: ProblemDetail = serde_json::from_str(no_type_json).unwrap();
        assert_eq!(problem_no_type.r#type, "about:blank");
        assert_eq!(problem_no_type.detail, "Envelope not found");
    }
}
