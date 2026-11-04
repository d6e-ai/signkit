# Documents, localization, and the open-core boundary

Sent PDFs and executed PDFs are distinct artifacts: the former pin documents at send time; the
latter compose that immutable set, signed values, and an evidence appendix. Rendering and
verification belong to [sent agreement rendering](envelope-model.md#sent-agreement-rendering) and
[executed agreement PDF](executed-agreement-pdf.md).

Status: mixed — localization, bounded DOCX import/export, executed agreement PDF composition,
optional instance PAdES B-B/B-T sealing, authenticated download, operator UI, and CLI are
implemented; the open-core boundary is policy

## Documents and evidence

PDF and DOCX upload endpoints accept raw bodies, not multipart forms (415). Uploaded PDFs must be
passive: encrypted files, document-open actions, forms, additional actions, active annotations, and
actions other than internal `/GoTo` are rejected, including external `/URI` links. Parsing and
resource bounds are enforced before publication, including indirect and object-stream references;
see [`pdf-page-metadata.ts`](../../src/lib/adapters/pdf/pdf-page-metadata.ts).

DOCX import is a durable bounded conversion on `POST /api/v1/envelopes/{envelopeId}/draft/docx`:
hostile DOCX ZIP/XML → sanitized constrained representation → a Markdown-only `documents/*.md`
commit through the existing draft persistence boundary. The original DOCX never enters Git or the
object draft archive. It is held in generic object storage only while its SQL job can run, then
becomes eligible for the ordinary 24-hour orphan sweep. The upload and worker are capped by deploy
target (`CLOUDFLARE_DOCX_IMPORT_LIMITS` 2 MiB input / 4 MiB uncompressed on Workers; Node/Vercel
keep 20 MiB / 40 MiB) and require `drafts:write`, an `Idempotency-Key`, and the expected Git
generation.

DOCX export is `GET /api/v1/envelopes/{envelopeId}/docx` (`envelopes:read`). A durable job captures
the envelope's current trusted locator (`sentCommitSha` when present, otherwise `repositoryHead`),
renders that exact revision through `readImmutableDraftRevision`, retains the content-addressed
result outside Git, and returns WordprocessingML bytes plus `x-signkit-commit-sha`. Both directions
use leased SQL jobs, bounded retry, and append-only attempt outcomes described in
[docx-conversion-jobs.md](docx-conversion-jobs.md).

The executed agreement PDF is a deterministic composition of the immutable sent document set —
uploaded PDFs imported page-for-page, Markdown rendered by the same per-document renderer recipients
read — with each signed value drawn at its frozen geometry and the completion evidence summary
appended (see [completion-artifacts.md](completion-artifacts.md)). The product must distinguish that
visual executed agreement plus evidence trail from the separately requested instance PAdES seal. A
configured external provider and independent validator can publish PAdES B-B or B-T evidence, but
the product must not describe that instance approval signature as a PDF certification signature,
qualified electronic signature, or long-term B-LT/B-LTA artifact.

Audit events are normalized append-only rows scoped to their envelope within the instance database.
Their canonical hash fields are defined in [persistence](persistence.md#concurrency-and-evidence),
not by an external organization. Hash chaining improves evidence but is not an operator-independent
“tamper-proof” guarantee.

## Localization

Paraglide uses `en` and `ja`, in that order: URL, cookie, then base locale. Human pages have
explicit `/en` and `/ja` forms while `/` remains the English base. API, well-known, health, webhook,
and agent endpoints are excluded from locale routing. Signing links carry the recipient language
chosen by the sender. Language controls use language names, not country flags.

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

Google Workspace, Microsoft Entra ID, Okta, and other enterprise SSO/SAML handling belongs in
d6e-auth. SignKit must not grow a competing identity stack.
