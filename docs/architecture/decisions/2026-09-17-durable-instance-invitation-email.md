# Durable instance invitation email — 2026-09-17

## Context

Instance invitation creation previously returned the one-time `ski1_` bearer token to the administrator. The administrator had to copy it out-of-band, despite SignKit already having an explicit SMTP/Cloudflare mail-provider boundary and durable delivery patterns. Returning the bearer token also made a lost HTTP response awkward: an exact idempotent replay could prove the invitation, but could not recover the one-time plaintext token.

## Decision

Invitation creation now writes three records atomically: the pending invitation, its idempotency receipt, and exactly one dedicated instance-invitation delivery row. The normalized invited mailbox and one-time token are sealed together with the existing `DELIVERY_ENCRYPTION_KEY`. A purpose-specific AEAD context binds the ciphertext to both invitation and delivery identifiers, so recipient-envelope ciphertext cannot be substituted and a row cannot be moved without authentication failing.

The public create response never returns the token. Fresh and replayed success report only that email delivery is scheduled; exact replay verifies the original delivery row and does not enqueue a duplicate. The idempotent-replay window is the same fixed seven days as the invitation lifetime. Reusing the key after the invitation expires is a conflict rather than an indefinite historical replay.

The request fingerprint is an HKDF-separated HMAC over normalized email, role, and locale. During that seven-day window, the active and previous delivery keys are accepted so a single key rotation does not break retries. A second rotation is prohibited until no unexpired invitation or delivery remains under the previous key. This bounded replay contract avoids both a plaintext-email digest and permanent retention of old encryption keys.

The dedicated protected drain follows the existing production delivery rules: bounded claims, five-minute abandoned-lease recovery, capped exponential backoff, ten attempts, stable error codes, and ciphertext scrubbing on delivery, terminal failure, acceptance, revocation, or expiry discovery. It re-verifies the token hash and token-bound email digest after decrypting. Mail contains rich HTML and text, never invents a recipient name, and includes the token in the message body rather than in the URL. The CTA opens the locale-specific settings page.

Cloudflare Workers use the native Email Sending binding. Node/Docker and Vercel use the selected SMTP or Cloudflare provider through the same `MailSender` port. Provider acceptance is outside the SQL transaction, so this remains an at-least-once boundary with rare duplicate delivery after an ambiguous crash.

## Consequences

- SQL does not contain plaintext invitation mailboxes or bearer tokens, but database backup and restore must preserve the encrypted delivery row until it becomes terminal.
- `DELIVERY_ENCRYPTION_KEY_PREVIOUS` must remain configured until invitations sealed under it have delivered or reached their seven-day terminal window. A second rotation inside that overlap is unsupported. A separate reseal sweep for this short-lived outbox is deferred.
- Operators no longer act as a manual secret transport. If delivery fails retryably, the scheduled drain retries without minting another invitation or token.
