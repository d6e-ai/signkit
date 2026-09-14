# Sent agreement PDF: the recipient-facing artifact — 2026-09-14

Until now a recipient was shown Markdown, re-rendered in their browser from the Git revision an envelope was sent at. That was fine for reading and wrong for signing. Two problems followed from it directly:

- **There was no document to point at.** A signing field needs a place: page 3, this box, this size. Markdown has no pages. Field geometry existed in the schema but nothing could validate it, so placement stayed ordinal-only in practice.
- **Recipients were handed SignKit's source representation.** The Markdown a sender authored is an internal artifact. A counterparty is entitled to the agreement, not to how we store it — and a browser-side Markdown renderer means "what was agreed to" depends on which renderer ran.

## Decision

At send time, the envelope's exact immutable revision is rendered into a **bounded, deterministic PDF**, written to object storage under a content-addressed key, and pinned by the same durable command that flips the envelope to `sent`.

- **Pinned three ways.** The pointer carries object key, SHA-256, and byte size. The key is derivable from the digest plus the organization and envelope, so a rewritten key is detectable without trusting the row. The digest is written into the `envelope.sent` audit payload; the key is not, because a storage path is infrastructure, not evidence.
- **Commit-scoped.** The pointer's primary key is `(organization, envelope, commit)`, and the read joins back to `envelope.sent_commit_sha`. A pointer published for one revision can never satisfy a read pinned to another.
- **Atomic with the publication.** On D1 the row is inserted inside `envelope_send_publish_guard`, alongside the status flip and the audit event, and the trigger refuses outright if the command carries no pointer. On PostgreSQL the same three writes share one transaction. A stale generation, a lost CAS, an audit conflict, or an idempotency conflict rolls all of them back together.
- **Object first, pointer second.** The PDF is written before anything references it, exactly as draft archives are. A failed publication leaves an unreferenced, content-addressed object for the orphan sweep — which now treats `envelope_sent_pdf.object_key` as a live reference — never a durable pointer to bytes that were never written.

Git remains the source of truth for history. The PDF is the source of truth for _what the recipient was shown_.

## Rendering: why a hand-written renderer, and why this font

The existing completion-evidence writer draws with the non-embedded base-14 Courier face and substitutes `?` for every character outside WinAnsi. For an internal evidence dump that is a documented tradeoff. For the document a Japanese signer is being asked to agree to it is unusable, so that writer is not reused here.

The replacement (`src/lib/adapters/pdf/`) is a Workers/Node-portable renderer with no native dependencies:

- **One embedded typeface.** Zen Kaku Gothic New Regular (SIL OFL 1.1) covers JIS X 0208 kanji, kana, and Latin. It ships gzipped and base64-encoded inside the bundle — about 1.4 MB compressed — because Workers has no font service and fetching a typeface while a recipient reads their agreement would both leak the reading and add a third party to the critical path.
- **Runtime subsetting.** Only the glyphs a given agreement uses are embedded, so a typical artifact is tens of kilobytes rather than 2.3 MB. This is also why a TrueType subsetter exists at all (`truetype-font.ts`): without it, "embed the font" and "bounded artifact" are incompatible.
- **One weight.** Bold is synthesized as fill-plus-stroke and italic as a text-matrix skew. A second face would roughly double an already large bundled artifact for a typographic nicety.
- **Deterministic output.** No timestamps, no document ID, no wall-clock metadata. Identical input produces identical bytes, which is what allows the artifact to be content-addressed — and what lets the sender's placement editor render the same pages the signer will see before the envelope is sent at all.
- **Sanitized input only.** The renderer consumes the same node tree the browser would have: images are already placeholders, HTML is already inert text, links are restricted to https/mailto, and invisible Unicode controls are surfaced as `⟦U+XXXX⟧` markers. Nothing in the pipeline fetches anything.

Layout is bounded on every axis that could run away: page count, block count, tree depth, per-document and total Markdown bytes, and final artifact size.

## Serving it

`GET /sign/agreement.pdf` is same-origin and authenticated **only** by the sealed, http-only recipient session cookie. No token appears in the URL, in page data, or anywhere JavaScript can read it, so the address is not a bearer credential and cannot leak through history, referrers, logs, or a shared link.

The capability and the pinned commit are revalidated _after_ the object read as well as before it, because object storage is slow enough for a revocation to land in between. Failures are deliberately uninformative: an inactive, expired, revoked, or absent session is an empty 404, indistinguishable from a path that was never valid; every storage or integrity problem is the same fixed, empty 503. Neither carries an identifier, a name, an object key, or a provider message.

## Consequences

- Sending now requires object storage. A deployment without it cannot pin a rendering, and a send that cannot pin its own rendering must not proceed.
- Envelopes sent before this change have no pointer. They resolve as unavailable rather than silently falling back to Markdown; the product is unreleased, so no migration path is provided.
- `GET /api/v1/signing/documents` no longer returns Markdown. It returns the page geometry of the rendering, which is what a recipient-facing client actually needs.
- Field geometry is now required for every placement, and a field's page must fall inside its own document's page range in that rendering. Ordinal-only placement is gone.
