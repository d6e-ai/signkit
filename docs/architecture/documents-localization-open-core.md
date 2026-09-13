# Documents, localization, and the open-core boundary

Status: mixed — localization and bounded DOCX import/export are implemented; PDF sealing is backlog; the open-core boundary is policy

## Documents and evidence

DOCX import is a bounded conversion on `POST /api/v1/envelopes/{envelopeId}/draft/docx`: hostile DOCX ZIP/XML → sanitized constrained representation → a Markdown-only `documents/*.md` commit through the existing draft persistence boundary. The original DOCX never enters Git or the object draft archive. The upload is capped (`MAX_DOCX_INPUT_BYTES`, 20 MiB) and requires `drafts:write`, an `Idempotency-Key`, and the expected Git generation.

DOCX export is `GET /api/v1/envelopes/{envelopeId}/docx` (`envelopes:read`). It renders the envelope's current trusted locator (`sentCommitSha` when present, otherwise `repositoryHead`) through `readImmutableDraftRevision` and returns WordprocessingML bytes plus `x-signkit-commit-sha`. Those bytes are derived for the response; they are not stored in Git.

PDF output is also derived from a pinned Git commit. The product must distinguish a visual electronic signature plus evidence trail from cryptographic PDF certification/PAdES. It must not claim the latter until certificate, timestamping, and long-term validation are implemented and verified.

Audit events are normalized append-only rows with tenant, envelope, sequence, actor, event type, canonical payload, time, previous hash, and event hash. Hash chaining improves evidence but does not make the operator-independent claim “tamper-proof.”

## Localization

Paraglide uses `en` and `ja`, in that order: URL, cookie, then base locale. Human pages have explicit `/en` and `/ja` forms while `/` remains the English base. API, well-known, health, webhook, and agent endpoints are excluded from locale routing. Signing links carry the recipient language chosen by the sender. Language controls use language names, not country flags.

## Open-core enterprise boundary

Always open source:

- audit event capture and evidence hashes;
- authorization and tenancy checks;
- backup, restore, and ordinary audit viewing;
- interoperable API and webhook formats.

Commercial modules:

- audit export to NDJSON/CSV, SIEM streaming, signed export bundles, and retention controls;
- advanced policy, reporting, compliance packs, and support;
- offline-capable commercial entitlement validation;
- SAML/SCIM enterprise identity features implemented in d6e-auth and consumed here.

Google Workspace, Microsoft Entra ID, Okta, and other enterprise SSO/SAML handling belongs in d6e-auth. SignKit must not grow a competing identity stack.
