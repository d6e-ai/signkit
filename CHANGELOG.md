# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.12] - 2026-09-26

### Changed

- Make `create-signkit` post-deploy, upgrade, and plan bootstrap guidance explicitly conditional on a fresh or uninitialized instance, clarifying that initialized instances retain their existing owner and do not bootstrap again ([#191](https://github.com/d6e-ai/signkit/issues/191)). Only bootstrapper operator guidance is changed; instance initialization, authorization, and fail-closed safety remain unchanged.

### Fixed

- Make shared recipient access, invalid/unavailable status, generic document review, and non-signer decline and approval failure wording role-neutral across English and Japanese locales, keeping signing-specific copy strictly on genuine signer controls ([#193](https://github.com/d6e-ai/signkit/issues/193)).
- Prevent application header overflow on mobile viewports by making appearance and language controls non-shrinking and breadcrumbs flexible with accessible truncation, preserving the shared 64px header height and control usability at 390px and 320px ([#195](https://github.com/d6e-ai/signkit/issues/195)).

### Security

- Known residual risks remain documented in [docs/architecture/deployment-and-risks.md](docs/architecture/deployment-and-risks.md), including jurisdiction-dependent e-signature requirements. The optional PAdES B-B/B-T instance seal is not a recipient certificate signature or a claim of advanced or qualified status; Vercel remains CI-only.

## [0.1.11] - 2026-09-26

### Fixed

- The Documents tab for a completed envelope now prioritizes the final PDF when available, clearly labels original documents, and offers same-origin downloads.
- Make sender tabs lifecycle-aware: keep post-send field placements read-only and show delivery progress separately from each recipient signing status.
- Restore a signed/approved confirmation as a bounded, evidence-checked, read-only receipt available for 30 days; no mutation or document/artifact access authority is restored.
- Fix completion-evidence line wrapping and pagination so long identifiers and digests remain fully visible without truncation, while published artifacts remain immutable.
- Correct the D1 approval-command SQL bindings so approvals persist and route and complete envelopes correctly ([#185](https://github.com/d6e-ai/signkit/issues/185)).
- Correctly encode supported accented Latin-1 text in evidence PDFs so glyphs stay within wrapped bounds ([#188](https://github.com/d6e-ai/signkit/issues/188)).

### Security

- Known residual risks remain documented in [docs/architecture/deployment-and-risks.md](docs/architecture/deployment-and-risks.md), including jurisdiction-dependent e-signature requirements. The optional PAdES B-B/B-T instance seal is not a recipient certificate signature or a claim of advanced or qualified status; Vercel remains CI-only.

## [0.1.10] - 2026-09-25

### Added

- Browserless recipient review, signing, approval, and decline in the Rust CLI using a recipient's own invitation capability. A separate bearer-only API serves recipient context, pinned documents/PDF, and decisions without requiring a browser session ([#177](https://github.com/d6e-ai/signkit/issues/177)).
- A real-backend CLI end-to-end test covers sender preparation, signer and approver decisions, completion evidence/PDF, and credential-leak checks against PostgreSQL and S3-compatible storage.

### Security

- Recipient capabilities remain separate from sender API keys; CLI decisions require explicit consent, and server-side role, routing, revocation, expiry, field, and idempotency checks remain in force. An automation agent must not sign on a person's behalf without that person's contemporaneous authorization for the specific document and field values.
- Known residual risks remain documented in [docs/architecture/deployment-and-risks.md](docs/architecture/deployment-and-risks.md), including jurisdiction-dependent e-signature requirements. The optional PAdES B-B/B-T instance seal is not a recipient certificate signature or a claim of advanced or qualified status; Vercel remains CI-only.

## [0.1.9] - 2026-09-24

### Fixed

- Restore recipient viewing and signing on Cloudflare D1 by correcting the viewed-command, signed-command, and field-value writes. Migration-backed tests now cover publication, completion, routing, audit chaining, and safe replay ([#170](https://github.com/d6e-ai/signkit/issues/170)).
- Display the pinned PDF documents of sent and completed envelopes in the Documents tab, including PDF-only and mixed document sets, with localized loading failures ([#171](https://github.com/d6e-ai/signkit/issues/171)).
- Render PDF page content on first load and after navigation or resize, including Japanese CID/CMap text, with a document-open fallback when rendering fails ([#172](https://github.com/d6e-ai/signkit/issues/172)).

### Security

- Sent-document previews continue to use sender authorization, immutable revision verification, and no-store responses. Known residual risks remain documented in [docs/architecture/deployment-and-risks.md](docs/architecture/deployment-and-risks.md), including jurisdiction-dependent e-signature requirements and the absence of PAdES/TSA certification; Vercel remains CI-only.

## [0.1.8] - 2026-09-24

### Fixed

- Advertise all three read-only revision history and diff endpoints in system capabilities, including the API-key `envelopes:read` endpoint list, so agents can discover the v0.1.7 contract-review API.

### Security

- Existing read-scope authorization and Git archive verification remain unchanged. Known residual risks are documented in [docs/architecture/deployment-and-risks.md](docs/architecture/deployment-and-risks.md), including jurisdiction-dependent e-signature requirements and the absence of PAdES/TSA certification; Vercel remains CI-only.

## [0.1.7] - 2026-09-24

### Added

- Rust CLI mutation commands validate envelope, field, and recipient payloads offline against schemas shared with the server before sending them, and expose those schemas plus a generated OpenAPI document for agent tooling ([#161](https://github.com/d6e-ai/signkit/issues/161)).
- Verified contract revision history and diff: agents can list an envelope's Git-tracked draft revisions and fetch a Git-verified diff between any two revisions through both the HTTP API and the Rust CLI, supporting a non-mutating review-and-propose workflow ([#162](https://github.com/d6e-ai/signkit/issues/162)).

### Fixed

- Resolved a D1 envelope readiness `INSERT` arity bug in `D1EnvelopeReadyStore` where an extraneous value placeholder and `NULL` literal made the `VALUES` clause disagree with the destination columns and bound parameters, breaking the draft-to-ready transition on Cloudflare; added integration coverage against the real D1 migration chain ([#160](https://github.com/d6e-ai/signkit/issues/160)).
- Aligned the Rust CLI process exit codes with the documented `0`–`12` automation contract ([#163](https://github.com/d6e-ai/signkit/issues/163)): HTTP 429 now exits `8` (rate limited), HTTP 5xx exits `9` (server unavailable), transport failures exit `10`, timeouts exit `11`, and refused redirects exit `12`. RFC 9457 JSON on stderr still carries the original HTTP `status`. Scripts written against v0.1.x must refresh any handling of the former compact `8` code.

### Security

- Revision diffs re-verify each revision against Git history before returning content and classify tampered or unreconstructable revisions as integrity errors rather than serving unverified data.
- Known residual risks remain documented in [docs/architecture/deployment-and-risks.md](docs/architecture/deployment-and-risks.md), including jurisdiction-dependent e-signature requirements and the absence of PAdES/TSA certification; Vercel remains CI-only and is not supported for production deployment.

## [0.1.6] - 2026-09-23

### Changed

- Cloudflare upgrades and non-initial deploys now activate the verified Worker version and then reconcile routes, custom domains, and Cron Triggers from the same release configuration before smoke verification.
- The first Worker upload—including an adopted Worker with zero published versions—continues to use complete `wrangler deploy`, as required by Cloudflare, while later deployments use the explicit version-and-trigger sequence.
- Custom-domain configuration now explicitly disables `workers.dev`, records one `custom_domain` route, and limits production smoke checks to the intended custom-domain origin instead of falling back to `workers.dev`.

### Fixed

- Follow-up to [#125](https://github.com/d6e-ai/signkit/issues/125): `create-signkit` no longer activates new Worker code without applying the release's changed routes and Cron Triggers.
- Trigger-reconciliation and first-upload failures now preserve honest non-secret partial state, including the observed or active Worker version, previous version when known, release metadata, applied migrations, D1 backup, and a retry marker; retained recovery material remains available for a safe retry.
- Smoke failure after a completed Worker-and-trigger transition keeps that coherent state instead of attempting a Worker-only rollback that could leave routes or Cron Triggers mismatched.

### Security

- Cloudflare deployment failures fail the CLI command, record observed partial state, and require explicit reconciliation when code, route, or trigger state cannot be proven complete. Known residual risks remain documented in [docs/architecture/deployment-and-risks.md](docs/architecture/deployment-and-risks.md), including jurisdiction-dependent e-signature requirements and the absence of PAdES/TSA certification.
- A provider failure after the first `wrangler deploy` may leave remote activation or trigger state indeterminate: `create-signkit` re-inspects versions and records a retry marker when it observes a new version, but operators must still inspect and retry because Cloudflare does not expose an atomic result across all affected surfaces.

## [0.1.5] - 2026-09-22

### Added

- Verified completion-artifact downloads for senders and localized recipient receipt pages for completed PDF and evidence exports.
- Precise keyboard-only signing-field placement with bounded percentage controls, fine and coarse movement or resizing, live announcements, and exact persisted-coordinate review.

### Changed

- Recipient name and email validation now blocks readiness before network mutation and focuses the first invalid field for keyboard submissions.
- Envelope navigation keeps stable breadcrumbs during client transitions, and the product favicon is served consistently.
- Published signing fields fail closed as read-only in the sender editor until a complete field set can be reconstructed safely for whole-set replacement.

### Fixed

- Cloudflare orphan sweeps now use D1-safe bounded queries, actionable single-boundary failure logging, covered empty, retained, deletion, and provider-failure paths, and an isolated five-minute cron separate from the one-minute maintenance trigger.
- Completion download responses verify object keys, size bounds, and SHA-256 digests before returning bytes.

### Security

- Completion artifacts no longer trust object-store bytes or metadata without re-deriving the expected key and verifying the stored digest.
- Known residual risks remain documented in [docs/architecture/deployment-and-risks.md](docs/architecture/deployment-and-risks.md), including jurisdiction-dependent e-signature requirements and the absence of PAdES/TSA certification.

## [0.1.4] - 2026-09-17

### Added

- Durable, locale-aware instance invitation email delivery with encrypted D1 and PostgreSQL outboxes, bounded retries, crash-safe leases, and automatic Cloudflare scheduled draining.
- Explicit `cloudflare` or `smtp` mail-provider selection in `create-signkit`, including secret-safe SMTP credential provisioning.

### Changed

- Cloudflare Workers, Node/Docker, and Vercel can each use either Cloudflare Email or SMTP instead of coupling mail transport to the deployment runtime.
- Instance administration stores only stable d6e-auth subject identifiers; live name and email resolution remains the identity provider's responsibility.

### Security

- Invitation bearer tokens are no longer exposed to the administrator UI and are scrubbed from terminal delivery records.
- SMTP passwords are accepted only through bounded secret input and are never stored in deployment state or command-line arguments.

## [0.1.3] - 2026-09-17

### Added

- Durable DOCX import and export jobs with bounded retries, idempotent result publication, audit events, and equivalent D1 and PostgreSQL implementations.
- Verified GitHub build provenance for `create-signkit` release selection before any Cloudflare resource or local recovery-state mutation.
- A personal recipient contact book with private per-user ownership, conflict-safe updates, locale-aware search, pagination, and authoring-form integration.
- Rust CLI commands for uploading bounded PDF documents and atomically replacing an envelope's retained document order.

### Changed

- Completed the agent-facing API-key surface around the three live scopes: `envelopes:read`, `drafts:write`, and `envelopes:send`.
- Centralized application page width in the shared layout and removed page-local maximum-width constraints.
- Upgraded the Node container profile to Node.js 26 and added an actual Docker image build to CI.
- Refreshed pinned GitHub Actions, npm tooling, Rust randomness support, and Node.js types.

### Security

- Cloudflare release installation now fails closed when GitHub provenance is missing, invalid, ambiguous, unavailable, malformed, or does not match the downloaded bundle digest.
- API keys remain owner-bound and become unusable when their local SignKit instance owner is suspended or removed.

## [0.1.0] - 2026-09-16

First tagged release. Summary of major capabilities as implemented today:

### Added

- Envelope drafting and sending workflow: Markdown drafts tracked in a per-envelope Git repository, DOCX import/export, recipient graphs (signer/approver/viewer/cc/prefill) with routing order, signing-field placement with normalized page geometry, send/void/reissue commands, and one-shot recipient signing, approval, and decline.
- Two persistence adapters behind the same ports: Cloudflare D1 (Workers profile) and PostgreSQL 18 (Node/Docker and Vercel profiles), with dialect-specific migrations kept in parity by shared test suites.
- Object storage over R2 (Cloudflare binding) or any S3-compatible service (Node/Docker, Vercel).
- Webhook delivery: instance-owner/admin-managed endpoints, HMAC-SHA256 signed payloads, subscribed audit-event catalog, delivery history, and a drain with fail-closed SSRF protections (public-address checks, DNS rebinding mitigation).
- Completion artifacts: a canonical completion manifest re-derived from Git and SQL evidence, published once per envelope, with JSON, Markdown, and rendered PDF access for operators, API keys, and a read-only public access-grant token.
- API key (Bearer) authentication for agents: keys bound to an active local owner, explicit scopes (`envelopes:read`, `drafts:write`, `envelopes:send`), rate limiting, and exclusion from all instance/API-key/webhook management surfaces.
- Instance bootstrap and membership: fail-closed owner claim requiring `SIGNKIT_BOOTSTRAP_OWNER_EMAIL` (or the local-development-only unsafe opt-in), owner/admin/member roles, zero-PII instance invitations, and member role/status administration.
- First-party Rust CLI (`cli/`, binary `signkit`) for system capabilities, envelope inspection, completion evidence/PDF download, and API-key-authenticated authoring/send mutations.
- Independently versioned `create-signkit` npm package for deploying and upgrading the Cloudflare Workers profile from a GitHub Release, including schema-epoch refusal for incompatible populated D1 databases.
- Background job endpoints (delivery drains, reseal sweeps, envelope expiry, webhook drain, object-store orphan sweep), driven by Cloudflare's own cron trigger or an external scheduler on Node/Docker and Vercel.

### Changed

- One deployment and database now form one SignKit instance. d6e-auth supplies identity only; local active membership supplies operator authority. This intentionally replaces the unreleased organization-scoped schema.

### Security

- Recipient capabilities, completion access grants, and API keys are distinct, purpose-separated authorities that never substitute for one another.
- Delivery and session material is sealed at rest with an active/previous encryption keyring supporting rotation.
- Webhook signing secrets are sealed at rest; drain resolves hostnames with fail-closed public-address checks; destination allowlist wildcards require at least three labels.
- Uploaded PDFs reject external `/URI` actions recursively (internal `/GoTo` only).
- Known residual risks (deployment isolation, webhook SSRF edge cases, jurisdiction-dependent e-signature requirements) are tracked in [docs/architecture/deployment-and-risks.md](docs/architecture/deployment-and-risks.md).
