# Ordered multi-document PDF upload — 2026-09-15

The first upload architecture constrained an envelope to either N Markdown documents or exactly one uploaded PDF, and made uploaded bytes the whole sent artifact. That constraint was rejected: an envelope is an ordered bundle in which Markdown and multiple uploaded PDFs coexist.

## Decision

An envelope is an ordered list of at most 20 documents, each with a stable UUIDv7 id and a `kind` of `markdown` or `pdf`.

- Git holds `document-set.json` (canonical, service-constructed) plus `documents/*.md`. Uploaded PDF bytes never enter Git; they live content-addressed in ObjectStore.
- `documentSetHash` is a domain-separated RFC 6962 Merkle root over ordered leaves (`DOMAIN = "signkit:document-set:v1"`). It is bound into `draft.revision_created`, `envelope.sent`, and the completion manifest. Completion publication compares the hash recomputed from the verified Git archive with the hash attested in the verified `envelope.sent` payload and fails closed on mismatch.
- At send, each document becomes its own immutable PDF: uploaded PDFs are byte-identical copies; Markdown is rendered deterministically per document. There is no concatenation and no single-PDF fallback.
- Fields are `documentId` + page + unit-square geometry. Recipient and authoring UIs switch documents; they never silently fall back to one PDF.
- `envelope_sent_pdf` is kept as frozen evidence for envelopes already sent.

## Consequences

- Ready-but-unsent envelopes without a materialized document set must return to draft (or re-ready after a commit) and re-place fields.
- Storage multiplies with document count, bounded by the 20-document and 20 MiB caps.
- The hostile-PDF parser remains the upload input surface; damaged-xref files are refused with a re-save message.
