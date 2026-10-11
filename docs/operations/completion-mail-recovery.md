# Recover a failed completion email

Refreshing an envelope or repairing its completion PDF does **not** resend historical failed mail.
It also does not restore a revoked or expired link. An authorized operator must explicitly issue a
new link after resolving the delivery problem.

## Before you confirm

1. Open the completed envelope's **Documents** tab and check that the completed documents and
   evidence are available. The server verifies their immutable bytes again before issuing access.
2. Check **Completion delivery** for the intended recipient. The recorded failure cause is separate
   from the retry-limit classification. Older deliveries may show an unknown cause; do not assume
   that a PDF delay caused them to fail.
3. Resolve the underlying problem (for example, mail-provider configuration). Reissuing does not
   edit recipient identity, repair an invalid address, or fix the provider.
4. Confirm that this recipient should receive renewed access. This is a new 30-day grant, not an
   extension of the old link. The old grant and delivery history remain unchanged and revoked.

## Issue a new link

Use **Grant new access** beside the intended recipient and read the confirmation dialog. The action
is available only for the latest terminal failed delivery: no remaining automatic retries, no active
lease, a revoked grant, and a scrubbed old token. Permanent rejection and expired-grant cleanup can
also qualify; reaching a particular attempt count is not a prerequisite.

Confirm once. Success means the new email is **queued**, not that it was delivered. The normal
maintenance drain sends it through the instance's selected SMTP or Cloudflare Email provider.
Refresh the delivery status to observe sending, delivery, or a new failure. A status refresh itself
never issues access or sends mail.

If the connection fails ambiguously, retry the same open confirmation rather than creating another
request. The UI preserves the captured delivery generation and idempotency key across a retry or
cancel-and-reopen. A changed generation returns a conflict: refresh, review the new status, and only
then decide whether a fresh request is appropriate. A successful reissue followed by a status-read
failure is shown as a separate refresh warning; it does not mean issuance failed.

## Automation and troubleshooting

An API client first reads `GET /api/v1/envelopes/{envelopeId}/completion-deliveries` with
`envelopes:read`. It then calls
`POST /api/v1/envelopes/{envelopeId}/recipients/{recipientId}/completion-access/reissue` with
`envelopes:send`, `grantAccess: true`, a unique opaque `Idempotency-Key`, and the exact observed
`expectedDeliveryId`, `expectedAttempts`, `expectedFailedAt`, and `expectedErrorCode`. Preserve the
key and body on an ambiguous retry; do not regenerate the timestamp or truncate its precision.
The response contains a receipt, never the recipient's bearer token.

Missing/corrupt completion artifacts, inactive membership, insufficient scope, changed delivery
generation, and ineligible recipients fail closed. Do not reset a failed outbox row, copy an old token,
or remove revocation directly in SQL. Investigate the artifact or provider problem, refresh the
status, and use the explicit action when it becomes eligible. Check the normal maintenance/drain
monitoring if an accepted successor remains queued.

This feature requires the forward migrations and matching application version on both D1 and
PostgreSQL. For a deployment that also includes the signature-retention changes, follow the
coordinated-rollout guidance in [signature asset retention](../architecture/signature-asset-retention.md);
do not leave the old collector running during the upgrade. No automatic historical resend or grant
renewal occurs as part of migration, deployment, PDF repair, or maintenance.

See [the API and persistence design](../architecture/completion-access-reissue.md) and
[maintenance monitoring](maintenance-monitoring.md) for the detailed contracts.
