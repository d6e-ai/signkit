# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
