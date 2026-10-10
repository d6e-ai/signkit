# Browserless recipient capability for the Rust CLI

Date: 2026-09-25
Status: Accepted

## Context

The Rust CLI can author and send an envelope, but completing it previously required the browser signing page. The existing recipient application commands already take a recipient invitation capability and validate its live scope, expiry, revocation, role, routing order, field generation, field ownership, idempotency, and audit head. Browser HTTP handlers obtain that capability from an envelope-scoped encrypted cookie and require a same-origin `Origin` header. An instance-member API key is never recipient authority.

An agent working on behalf of a recipient needs to review the exact sent documents and submit that recipient's authorized decision without pretending to be a browser or borrowing the sender's key.

## Decision

- Add a distinct `/api/v1/recipient/**` HTTP surface for non-browser clients. It accepts only `Authorization: Bearer skr1_…` from the recipient's own invitation. It rejects requests carrying `Cookie` or `Origin`; it never falls back to an ambient session. The browser's `/api/v1/signing/**` mutations and `/sign/**` document routes retain their cookie and same-origin behavior.
- Reuse the same application commands and stores for both transports. No new recipient authority, audit actor, or mutable state is introduced. The capability remains envelope- and recipient-bound, expires or is revoked normally, and cannot be used on operator endpoints.
- Expose only the recipient's pinned document metadata, their own placed fields and current field generation. Download one pinned PDF through a capability-authorized, integrity-checked, `no-store` endpoint. Neither Markdown source nor object keys are disclosed.
- Require an `Idempotency-Key` for every mutation and the current `expectedFieldGeneration` for signing. The CLI requires an explicit consent flag for viewed, sign, approve, and decline; supplying a capability alone is not consent. The responsible recipient must authorize the particular action and values. Automation must not silently sign an agreement for someone else.
- The CLI ingests recipient capabilities only from a dedicated environment variable or bounded stdin. It does not place them in argv, config, URLs, output, logs, or audit payloads. It never sends a sender API key with a recipient request and refuses redirects. Document downloads require an output file.
- Browser-only cookie lifecycle remains browser-only. A bearer sign or approval cannot delete a browser cookie. A bearer decline returns a durable JSON receipt without attempting the browser's declined-receipt cookie exchange.

## Consequences

Recipient events continue to use `actorType: recipient` and the durable recipient ID, distinct from sender/agent actions. The audit payload and hash format do not change. Invalid, revoked, expired, blocked, wrong-envelope, or wrong-role capabilities fail through the existing application outcomes; a malformed or foreign bearer cannot inherit browser authority.

The invitation capability is a powerful bearer secret. A recipient must deliberately provide it to a trusted CLI/agent session and protect that session's environment and output files. This design enables browserless signing; it does not give agents independent legal authority to consent.

## Alternatives considered

- **Use the sender API key for recipient actions:** rejected because it permits impersonation and destroys the consent boundary.
- **Fabricate `Origin` and exchange `/s/{capability}` for a cookie:** rejected because it disguises a non-browser client as a browser and risks leaking the capability through a URL.
- **Duplicate signing business logic for CLI:** rejected because a second authority and audit implementation would drift from the established recipient checks.
