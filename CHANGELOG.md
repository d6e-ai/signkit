<!-- The [0.1.0] date below is a placeholder (YYYY-MM-DD) — fill in the actual date when the v0.1.0 tag is cut. -->

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - YYYY-MM-DD

First tagged release. Summary of major capabilities as implemented today:

### Added

- Envelope drafting and sending workflow: Markdown drafts tracked in a per-envelope Git repository, DOCX import/export, recipient graphs (signer/approver/viewer/cc/prefill) with routing order, signing-field placement with normalized page geometry, send/void/reissue commands, and one-shot recipient signing, approval, and decline.
- Two persistence adapters behind the same ports: Cloudflare D1 (Workers profile) and PostgreSQL 18 (Node/Docker and Vercel profiles), with dialect-specific migrations kept in parity by shared test suites.
- Object storage over R2 (Cloudflare binding) or any S3-compatible service (Node/Docker, Vercel).
- Webhook delivery: organization-scoped endpoints, HMAC-SHA256 signed payloads, subscribed audit-event catalog, delivery history, and a drain with fail-closed SSRF protections (public-address checks, DNS rebinding mitigation).
- Completion artifacts: a canonical completion manifest re-derived from Git and SQL evidence, published once per envelope, with JSON, Markdown, and rendered PDF access for operators, API keys, and a read-only public access-grant token.
- API key (Bearer) authentication for agents: instance-scoped keys with per-organization grants, explicit scopes (`envelopes:read`, `drafts:write`, `envelopes:send`), rate limiting, and exclusion from all instance/API-key/webhook management surfaces.
- Instance bootstrap and membership: first-user-wins owner claim (optionally restricted via `SIGNKIT_BOOTSTRAP_OWNER_EMAIL`), owner/admin/member roles, zero-PII instance invitations, and member role/status administration.
- First-party Rust CLI (`cli/`, binary `signkit`) for system capabilities, envelope inspection, completion evidence/PDF download, and API-key-authenticated authoring/send mutations.
- `create-signkit` npm package for deploying and upgrading the Cloudflare Workers profile from a GitHub Release.
- Background job endpoints (delivery drains, reseal sweeps, envelope expiry, webhook drain, object-store orphan sweep), driven by Cloudflare's own cron trigger or an external scheduler on Node/Docker and Vercel.

### Changed

- N/A (first release).

### Security

- Recipient capabilities, completion access grants, and API keys are distinct, purpose-separated authorities that never substitute for one another.
- Delivery and session material is sealed at rest with an active/previous encryption keyring supporting rotation.
- Webhook signing secrets are sealed at rest; drain resolves hostnames with fail-closed public-address checks.
- Known residual risks (first-user-wins bootstrap window, cross-tenant isolation, webhook SSRF edge cases, jurisdiction-dependent e-signature requirements) are tracked in [docs/architecture/deployment-and-risks.md](docs/architecture/deployment-and-risks.md).
