# Architecture decisions

Dated notes recording the rationale behind choices made in [../](../README.md) at the time they were made. They are historical context, not normative: the current normative contract always lives in the architecture spec files, and a decision note never overrides them.

- [2026-09-15-ordered-multi-document-pdf-upload.md](./2026-09-15-ordered-multi-document-pdf-upload.md) — envelopes are ordered mixed Markdown/PDF document sets with a Merkle `documentSetHash`.
- [2026-09-15-executed-agreement-pdf.md](./2026-09-15-executed-agreement-pdf.md) — the completion PDF is the executed agreement with signed values drawn at frozen geometry, not an evidence summary.
- [2026-09-15-security-fixes.md](./2026-09-15-security-fixes.md) — fail-closed hardening for redirects, uploads, session sealing, d6e-auth origin, CLI I/O, and webhook delivery.
- [2026-09-15-bootstrap-fail-closed.md](./2026-09-15-bootstrap-fail-closed.md) — uninitialized instances fail closed without a bootstrap owner email; local-only unsafe opt-in, GoTo-only PDF actions, and three-label webhook wildcards.
- [2026-09-15-release-publishing-integrity.md](./2026-09-15-release-publishing-integrity.md) — exact lockfile-pinned npm publishing, immutable draft-release reruns, and GitHub provenance generation with an explicit deploy-time verification boundary.
- [2026-09-16-create-signkit-secret-bootstrap.md](./2026-09-16-create-signkit-secret-bootstrap.md) — pristine initial deploys read OAuth JSON once from stdin and bootstrap Worker secrets through a retained recovery file uploaded via `--secrets-file`; no secret-only stub flow.
- [2026-09-17-recipient-contact-book.md](./2026-09-17-recipient-contact-book.md) — contacts are explicit, private per-member projections with body-based search and no recipient-history inference.
- [2026-09-17-durable-instance-invitation-email.md](./2026-09-17-durable-instance-invitation-email.md) — invitation creation atomically schedules encrypted, retryable provider-neutral email and never returns the bearer token to the administrator.
