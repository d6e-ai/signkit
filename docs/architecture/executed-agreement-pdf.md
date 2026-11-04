# Executed agreement PDF

The PDF artifact published with the manifest is the executed agreement, not a description of one:
the immutable sent document set in document order, with every signed value drawn at the geometry
frozen when the envelope was sent, followed by the completion evidence summary as an appendix.

Base pages are the exact immutable PDF bytes published by the send transaction and served to
recipients. Completion never re-renders historical Markdown. Before any composition, every
sent-document pointer is reconciled with the pinned Git document set and the hash-chained
`envelope.sent` declaration (scope, sent commit, identity, order, kind, title, content-addressed
key, byte size, SHA-256, and page count), then bounded-read and re-hashed. The complete field
placement projection is likewise required to equal the latest pre-send `envelope.fields_placed`
payload at the pinned field generation; a changed coordinate, recipient, document, type, required
flag, missing row, or extra row fails closed. An untouched generation-zero empty field set is valid
without a placement event. A higher-generation empty set is valid only when a verified
`envelope.reopened` event proves the placements were cleared at the current field generation,
anchored to that reopen's own prior ready event, commit, and repository generation. A subsequent
ready pins the recipient roster independently; a nonempty field set still requires a matching
placement event. Composition, page import, and overlay drawing are in-house and Workers-compatible —
the uploaded-PDF metadata parser was extracted into a shared bounded object reader so uploads and
executed output are read by exactly one parser — and add no dependency beyond the `fflate` and
bundled subsetted font already shipped. Nothing that can act is carried across: `/Annots`, `/AA`,
and the source catalog are dropped, leaving static page content plus SignKit's own overlay stream,
on top of the reader's existing refusal of encrypted files and catalog-level `/OpenAction`,
JavaScript, or embedded files.

Field geometry is a unit square measured from the top-left of the page as a reader sees it, which is
what the signing UI captured; the composer converts it into page user space, undoing `/Rotate` and a
non-zero MediaBox origin, so a field placed over a rotated page lands where the signer placed it. A
drawn signature is fetched from its recipient-scoped content-addressed key, re-hashed against the
`sig:sha256:` reference held in the (already digest-verified) field value, decoded by a bounded PNG
decoder, and embedded as an image XObject with an `/SMask` so its transparent background does not
paint over the agreement text. The same bounded byte, decode-memory, and emitted-image checks run at
upload and again before a fresh signing command publishes a drawn signature or initials reference.
The pre-publication check also proves envelope/recipient scope and SHA-256; missing or malformed
assets refuse the command without mutation, while provider read failures remain retryable 503
responses. A durable signing receipt replays without another asset read. Orphan collection preserves
referenced drawn signatures and initials in their exact envelope/recipient scope. Typed signatures,
names, dates, and text are drawn in the bundled Unicode font, and checkboxes as a stroked path that
needs no glyph.

Geometry is integrity-critical for executed publication, with no null fallback: a signed value with
no placement row, with incomplete geometry, not scoped to a document in the sent set, out of range,
or past the document's pinned page count fails the publication closed, as does a missing or
digest-mismatched signature asset. Envelopes sent before per-document publication have path-scoped
fields that never had geometry, so they keep the evidence summary as their PDF artifact; the
published PDF manifest (`signkit-completion-pdf-manifest-v2`) records which it is in `artifactKind`
(`executed-agreement-v1` or `evidence-summary-v1`) along with the page count, the appendix's first
page, each document's page range, and each field's full frozen geometry. Composition is
deterministic — no timestamps, no document ID, fixed deflate level, fixed field draw order — so
identical evidence yields identical bytes and a replayed publication is a no-op. Every stage is
bounded (20 documents, 200 fields, 800 pages, 32 MiB in, 48 MiB copied, 32 MiB out, 50,000 objects,
4,000 overlay operations, 4096-pixel/4 M-pixel images) and a breach is the same non-retryable
`completion_artifact_evidence_too_large` outcome the manifest bounds use. This is a visual executed
agreement plus a hash-chained evidence appendix; it is not a certified or sealed (PAdES) PDF.

Publication and repair follow [completion artifacts](completion-artifacts.md). Attachments and
public access follow [completion delivery](completion-delivery.md).
