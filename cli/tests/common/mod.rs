#![allow(dead_code)]

use tokio::sync::Mutex;
use wiremock::MockServer;

pub const TEST_ORG: &str = "org_test_12345678";
pub const TEST_API_KEY: &str = "signkit_abcdef1234567890abcdef1234567890abcdef12345";
pub const TEST_ENVELOPE_ID: &str = "0191b26f-4000-7000-8000-000000000001";
pub const TEST_ENVELOPE_ID_2: &str = "0191b26f-4000-7000-8000-000000000002";

static TEST_MUTEX: Mutex<()> = Mutex::const_new(());

/// Async scope guard that serializes environment variable mutations across tests
/// and cleanly restores prior environment state on drop.
pub struct EnvScope {
    entries: Vec<(&'static str, Option<String>)>,
    _guard: tokio::sync::MutexGuard<'static, ()>,
}

impl EnvScope {
    pub async fn new(vars: &[(&'static str, Option<&str>)]) -> Self {
        let guard = TEST_MUTEX.lock().await;
        let mut entries = Vec::new();
        for &(key, val) in vars {
            let prev = std::env::var(key).ok();
            if let Some(v) = val {
                std::env::set_var(key, v);
            } else {
                std::env::remove_var(key);
            }
            entries.push((key, prev));
        }
        Self {
            entries,
            _guard: guard,
        }
    }
}

impl Drop for EnvScope {
    fn drop(&mut self) {
        for (key, prev) in self.entries.drain(..) {
            if let Some(val) = prev {
                std::env::set_var(key, val);
            } else {
                std::env::remove_var(key);
            }
        }
    }
}

pub async fn start_mock_server() -> MockServer {
    MockServer::start().await
}

pub fn sample_capabilities_json() -> &'static str {
    r#"{
      "name": "SignKit",
      "apiVersion": "v1",
      "runtime": "node",
      "supportedProfiles": {
        "node": { "database": "postgresql", "objects": "s3-compatible", "status": "scaffolded" },
        "cloudflare": { "database": "d1", "objects": "r2", "status": "scaffolded" },
        "vercel": { "database": "postgresql", "objects": "s3-compatible", "status": "planned" }
      },
      "draftHistory": {
        "format": "git",
        "archive": "gzip",
        "trackedFiles": ["documents/*.md"],
        "commitEndpoint": "/api/v1/envelopes/{envelopeId}/draft/commits",
        "concurrency": "expected-generation",
        "idempotency": "required"
      },
      "readiness": {
        "endpoint": "/api/v1/envelopes/{envelopeId}/ready",
        "recipients": "complete-graph",
        "actionableRoles": ["signer", "approver"],
        "observerRoles": ["viewer"],
        "preSendOnlyRoles": ["prefill"],
        "concurrency": "expected-generation",
        "idempotency": "required"
      },
      "sending": {
        "endpoint": "/api/v1/envelopes/{envelopeId}/send",
        "concurrency": "expected-generation-and-ready-audit-event",
        "delivery": "durable-outbox",
        "idempotency": "required"
      },
      "voiding": {
        "endpoint": "/api/v1/envelopes/{envelopeId}/void",
        "authentication": "organization-session",
        "concurrency": "expected-status-and-generation",
        "terminalCleanup": "atomic",
        "idempotency": "required"
      },
      "delivery": {
        "statusEndpoint": "/api/v1/envelopes/{envelopeId}/deliveries",
        "workerEndpoint": "/api/v1/system/deliveries/drain",
        "workerAuthentication": "bearer-secret",
        "semantics": "at-least-once",
        "transports": { "cloudflare": "email-binding", "node": "cloudflare-email-rest" }
      },
      "recipientAccess": {
        "endpoint": "/api/v1/signing/context",
        "documentsEndpoint": "/api/v1/signing/documents",
        "viewedEndpoint": "/api/v1/signing/viewed",
        "declineEndpoint": "/api/v1/signing/decline",
        "approveEndpoint": "/api/v1/signing/approve",
        "signEndpoint": "/api/v1/signing/sign",
        "linkExchange": "/s/{capability}",
        "webSurface": "/{locale}/sign",
        "authentication": "bearer-capability",
        "browserSession": "encrypted-http-only-cookie",
        "terminalDeclineReceipt": {
          "browserSession": "purpose-separated-encrypted-http-only-cookie",
          "revalidation": "command-audit-and-terminal-projection",
          "retentionDays": 30,
          "documentAccess": false,
          "mutations": false
        },
        "mutations": "same-origin-cookie-context",
        "roles": ["signer", "approver", "viewer"],
        "states": ["sent", "in_progress"],
        "cache": "no-store"
      },
      "completionArtifact": {
        "statusEndpoint": "/api/v1/envelopes/{envelopeId}/completion-artifact",
        "workerEndpoint": "/api/v1/system/completion-artifacts/drain",
        "workerAuthentication": "bearer-secret",
        "authentication": "organization-session",
        "discovery": "reconciliation-job",
        "manifestSchema": "signkit-completion-manifest-v1",
        "artifacts": ["json", "markdown", "pdf"],
        "auditVerification": "bounded-per-event-hash-rederivation",
        "ccDelivery": "supported",
        "publicArtifactGrants": "supported"
      },
      "completionDelivery": {
        "workerEndpoint": "/api/v1/system/completion-deliveries/drain",
        "workerAuthentication": "bearer-secret",
        "semantics": "at-least-once",
        "transports": { "cloudflare": "email-binding", "node": "cloudflare-email-rest" },
        "roles": ["signer", "approver", "viewer", "cc"],
        "prerequisite": "published-completion-artifact",
        "tokenFormat": "skca1",
        "grantRetentionDays": 30
      },
      "publicCompletionArtifact": {
        "apiEndpoint": "/api/v1/completion-artifacts",
        "linkEndpoint": "/c/{token}",
        "authentication": "bearer-token-or-path-token",
        "formats": ["json", "markdown", "pdf"],
        "tokenPrefix": "skca1",
        "cookies": false
      },
      "apiKeyAuthentication": {
        "scheme": "bearer",
        "tokenPrefix": "signkit",
        "organizationSelector": "SignKit-Organization-Id",
        "organizationSelectorRequired": true,
        "grantModel": "explicit-per-organization",
        "multipleOrganizationsPerKey": true,
        "effectiveAuthority": "key-scopes-intersected-with-requested-live-grant",
        "enabledScopes": ["envelopes:read", "drafts:write", "envelopes:send"],
        "mintedButUnusableScopes": ["audit:read"],
        "readEndpoints": [
          "/api/v1/envelopes",
          "/api/v1/envelopes/{envelopeId}",
          "/api/v1/envelopes/{envelopeId}/draft",
          "/api/v1/envelopes/{envelopeId}/docx",
          "/api/v1/envelopes/{envelopeId}/deliveries",
          "/api/v1/envelopes/{envelopeId}/completion-artifact",
          "/api/v1/envelopes/{envelopeId}/evidence",
          "/api/v1/envelopes/{envelopeId}/completion-artifact/evidence",
          "/api/v1/envelopes/{envelopeId}/pdf",
          "/api/v1/envelopes/{envelopeId}/completion-artifact/pdf"
        ],
        "writeEndpoints": {
          "drafts:write": [
            "/api/v1/envelopes",
            "/api/v1/envelopes/{envelopeId}/draft/commits",
            "/api/v1/envelopes/{envelopeId}/draft/docx",
            "/api/v1/envelopes/{envelopeId}/ready",
            "/api/v1/envelopes/{envelopeId}/fields"
          ],
          "envelopes:send": [
            "/api/v1/envelopes/{envelopeId}/send",
            "/api/v1/envelopes/{envelopeId}/void"
          ]
        },
        "mutations": true,
        "cookieComposition": false,
        "caching": "none",
        "lastUsedTracking": true,
        "rateLimits": { "durable": true, "windowSeconds": 60, "maxRequests": 120 },
        "actor": { "type": "agent", "id": "api-key-uuidv7" },
        "grantManagement": {
          "create": "/api/v1/api-keys/{apiKeyId}/organization-grants",
          "list": "/api/v1/api-keys/{apiKeyId}/organization-grants",
          "revoke": "/api/v1/api-keys/{apiKeyId}/organization-grants/{grantId}/revoke"
        },
        "grantAuthority": "key-owner-and-d6e-organization-owner-or-admin",
        "grantRevokeAuthority": ["key_owner", "organization_admin"]
      },
      "automation": { "idempotencyKeys": true, "actorProvenance": true, "webhooks": "supported" }
    }"#
}
