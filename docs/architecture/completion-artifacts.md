# Completion artifacts

Completion evidence is reconstructed from the pinned revision and SQL evidence. Read only the
relevant lifecycle boundary:

- Publication, repair, and requeue: this file.
- [Executed agreement PDF](executed-agreement-pdf.md): composition and rendering bounds.
- [Completion delivery](completion-delivery.md): grants, downloads, and attachments.
- [Recipient capability reissue](recipient-capability-reissue.md): replacement of signing
  invitations.
- [Completion access reissue](completion-access-reissue.md): explicit recovery of terminal mail.
- [PDF sealing](pdf-sealing.md): an optional, separate instance seal.

## Publication

Completion evidence is published by a durable reconciliation job, never by extending the hot
`recipient.signed`/`recipient.approved` completion transactions. A periodic worker discovers
envelopes with `status = 'completed'` and no published artifact — including envelopes that completed
before this feature shipped — and leases exactly one dedicated `completion_artifact_job` row per
envelope, mirroring the invitation outbox's bounded-claim, five-minute-reclaim, capped-backoff, and
stable-safe-error-code pattern rather than reusing the invitation `delivery_outbox` table.

Completed envelopes retain immutable draft, document, field, and decision evidence. Later
operational audit events do not redefine the completion anchor. The worker rebuilds the canonical
`signkit-completion-manifest-v1` manifest deterministically from the pinned Git revision (read the
same way as `readImmutableDraftRevision`, whose `DraftIntegrityError` — a missing object, a SHA-256
mismatch, an envelope-scope mismatch, a size violation, or a Git verification failure — is
classified as a non-retryable integrity failure here exactly like the worker's own evidence checks,
since R2/S3 are strongly consistent for these immutable pointers; a raw provider read error that is
not itself a `DraftIntegrityError` is not assumed to be tampering and remains retryable). The
document-set manifest is parsed from those already-verified archive bytes — never from a second,
unverified object-store read. SQL evidence supplies the envelope ID and title, `sent_commit_sha`,
the draft archive SHA-256, the field generation, `completedAt`, sorted documents (Markdown
path/content digest, plus `id`/`kind`/`position`/`title` and `documentSetHash` for envelopes sent
after per-document publication; PDF leaves carry the PDF digest/size/pages, which the executed
agreement PDF re-verifies the uploaded bytes against before importing their pages), sorted recipient
ID/role/routing-order/status plus each actionable recipient's decision audit event ID and timestamp,
sorted field ID/type/value-SHA-256 triples, and an audit proof. When a `documentSetHash` is present,
publication binds it to the hash attested in the verified `envelope.sent` audit payload and fails
closed on mismatch (including a send event that attests a hash the pinned revision does not bind, or
a pinned hash with no attested send hash). Manifest content deliberately excludes names, email
addresses, labels, raw field values, token or capability material, object storage keys, key IDs, and
provider identifiers or secrets.

The audit proof reads at most 5,000 audit events for the envelope, under a bounded aggregate payload
byte budget, and fully re-derives the chain rather than trusting stored hashes: for each event it
requires a known event type from an explicit allowlist (an unknown type fails closed), canonical
`payload_json` (`JSON.stringify(JSON.parse(payload_json))` must equal the stored string
byte-for-byte), an actor type allowed for that event, the current audit hash version 3 (including
`hashVersion`, `actorType`, and `actorId`, with no organization field; older hash versions are
rejected), and a recomputed SHA-256 over the exact preimage the writer hashed. It also verifies
sequence contiguity, the `previous_hash`/`event_hash` chain link between consecutive rows, and that
the chain's terminal row is the envelope's own `envelope.completed` event; a gap, a broken link, an
unknown type, a wrong actor type, a non-canonical payload, or a wrong terminal event fails the
publication closed as a genuine integrity error. Exceeding the event-count bound or the aggregate
payload byte budget instead fails closed as the distinct, non-retryable
`completion_artifact_evidence_too_large` outcome — an oversized envelope is an operational scaling
signal, not evidence of tampering, and is never conflated with
`completion_artifact_evidence_invalid`; the same too-large/invalid split applies to the manifest's
document, recipient, and field counts and to its own source and gzip byte limits. PostgreSQL reads
`occurred_at` at full microsecond precision and requires the sub-millisecond remainder to be exactly
zero before use, so a sub-millisecond alteration below the driver's own millisecond-only rounding
cannot silently pass; D1 requires the stored value to already be a canonical ISO-8601 millisecond
string. The recipient roster is cross-checked for exact set equality — no row inserted, missing, or
drifted in role or routing order — against the `{id, role, routingOrder}` triples declared by the
latest `envelope.ready` event before the anchored send. The `envelope.sent` payload must name that
latest ready event, and no ready or reopen may intervene before send. A historical payload without
`readyAuditEventId` is accepted only when there is exactly one ready event and no reopen; a missing
anchor never permits an ambiguous history. The complete `field_value` set is cross-checked against
the union of `payload.fields` declared across every verified `recipient.signed` event — an inserted,
deleted, or substituted row fails closed. Every actionable (signer/approver) recipient must carry
`status = 'completed'` and a decision of the role-specific type — a signer's `decisionEventId` must
resolve to a verified `recipient.signed` event and an approver's to a verified `recipient.approved`
event, one can never stand in for the other — with a matching actor and timestamp, rather than
trusting an unverified subselect; a non-actionable (viewer/prefill/cc) recipient must carry no
signed or approved decision at all. None of this is a tamper-proof guarantee: an adversary with
direct database write access who rewrites every event in the chain and recomputes every hash
consistently would still pass. Detecting that class of whole-chain rewrite needs an external
signed/published anchor (for example, a hash checkpoint written to a separate, append-only system)
and remains out of scope.

The manifest is serialized as deterministic fixed-key JSON and rendered into a deterministic
Markdown summary of the same fields, gzip-compressed with the existing fflate `level: 9, mtime: 0`
convention used by the draft Git archive, and bounded in both source and compressed size the same
way draft archives are — exceeding either bound is the same non-retryable
`completion_artifact_evidence_too_large` outcome as the manifest's own count bounds, never
`completion_artifact_evidence_invalid`. Both artifacts are written through the existing
`ObjectStore.putImmutable` under content-addressed keys derived from their own gzip SHA-256. A
failed write is resolved into exactly one of three outcomes by reading the object back and
independently verifying its byte length and SHA-256, exactly like immutable draft archive
persistence: bytes that verify mean the write already landed and are safely reused; an object that
is missing, or that cannot be read back at all, is treated as a transient condition and the original
error is rethrown for the caller to retry; an object that exists at that exact content-addressed key
but holds different bytes is a real conflict — content-addressing makes that cryptographically
impossible for honest data — and fails closed immediately as a non-retryable integrity error rather
than retrying until attempts exhaust. Because the manifest is rebuilt deterministically from
otherwise-immutable evidence, a retry after an object write succeeds but the SQL publish fails
reproduces byte-identical artifacts and the same content-addressed keys.

Publication itself is one immutable pointer per envelope, enforced by the envelope id primary key.
Immutable JSON, Markdown, and optional PDF objects are written first. PostgreSQL then locks the
envelope row and the job row, rechecks `status = 'completed'`, `sent_commit_sha = repository_head`
and equal to the pinned value, the expected field generation, and that the audit chain is still
anchored with `envelope.completed` as the immediate predecessor of the new event and nothing newer,
before inserting the pointer, marking the job published, appending a chained
`envelope.completion_artifact_published` audit event, and inserting optional PDF metadata in one
transaction. D1 performs the equivalent all-or-none recheck inside a rollback-on-failed-predicate
command trigger. Receipt replay compares PDF metadata too. A provider transient during that insert
is rethrown, never classified as integrity or `artifact_not_found` by parsing error strings. If the
same evidence is republished under an already-used lease, the durable receipt is compared
field-for-field against the freshly recomputed command; identical evidence replays safely, while any
difference is a fail-closed integrity error rather than a silent overwrite. When D1's trigger rolls
an insert back, an absent durable receipt does not by itself prove which predicate failed — it could
equally be an unrelated transient D1 error — so the store directly re-evaluates the same
envelope-state, anchor, and lease predicates the trigger checks, classifying the outcome as stale or
integrity only when one of them actually fails; it never inspects the error's message. When every
predicate still holds, the original error is rethrown for the service to schedule a retry instead of
recording a permanent integrity verdict.

Already-published envelopes whose PDF pointer never landed (published before atomic PDF publication
existed, or by a deployment without a PDF store) are recovered by a dedicated
`completion_artifact_pdf_repair` job. The same completion drain discovers at most 25 such envelopes
per run and claims at most one repair after the primary batch, only when the PDF repair store is
wired; a repair-queue outage never discards the primary batch's outcomes. Repair rebuilds from the
original `anchor_audit_event_id` / `audit_head_sequence - 1` evidence prefix, verifies the original
publication event with the version-aware audit recompute, and must reproduce the stored manifest,
JSON, and Markdown digests. Later audit events (PDF seal, user actions) cannot change those bytes.
Repair only reads back and verifies the published JSON/Markdown objects: it never rewrites them, the
manifest pointer, the publication receipt or audit event, or the primary job. The PDF pointer is
inserted with compare-and-swap under the repair lease and the matching manifest digest: an identical
existing pointer is a safe replay, a different pointer fails closed. A retryable repair failure
reads as PDF `pending` with its next attempt time; a permanent evidence or budget failure, or
exhausted attempts, reads as PDF `failed` rather than pending forever.

Until a PDF pointer lands, orphan collection treats every object under
`completion-artifacts/v1/envelopes/<envelopeId>/` as live whenever that envelope's primary job is
unpublished or its manifest is published without a PDF pointer, so partial objects survive before
repair discovery or claim.

Completion mail can be enrolled after manifest publication, but both database adapters require a
published PDF pointer before claiming it. Waiting for PDF publication or repair therefore does not
consume mail attempts or revoke an otherwise eligible completion grant. Expiration and revocation
cleanup remain independent of this dependency gate. Historical deliveries that already exhausted and
scrubbed their sealed token are not reactivated automatically; recovery requires the
[explicit completion-access reissue](completion-access-reissue.md).

A lease reclaimed after ten recorded attempts is failed before any evidence, object, or PDF work,
for both primary publication and PDF repair. An interrupted claim does not prove a transient
provider failure: the distinct `completion_artifact_interrupted_attempts_exhausted` and
`completion_artifact_pdf_repair_interrupted_attempts_exhausted` codes are terminal and excluded from
transient-only operator requeue. This bounds crash loops without inventing a cause for an unobserved
interruption or starving healthy jobs.

Operators refresh status with `GET /api/v1/envelopes/{envelopeId}/completion-artifact` (UI: "Refresh
status") and requeue with `POST /api/v1/envelopes/{envelopeId}/completion-artifact/retry` (UI:
"Reprocess completion"; `envelopes:send` scope for API keys, an active local instance membership for
sessions, and an `Idempotency-Key`). Only the exact codes `completion_artifact_attempts_exhausted`
(primary job) and `completion_artifact_pdf_repair_attempts_exhausted` (PDF repair) are eligible. The
body echoes `expectedAttempts` and `expectedFailedAt` from the status read. Attempts alone repeat
after a requeue (10, then 0, then 10 again), so the exhausting failure's `updated_at` is the
generation the database CAS compares, inside the PostgreSQL row-locked transaction and the D1
command trigger. A stale page, a concurrent duplicate under another key, an integrity or budget
failure, or a live lease is refused; the same key replays from its durable receipt. Requeue does not
re-sign, overwrite a published artifact, or append audit past the fixed completion anchor. It also
does not reissue completion mail whose own delivery already exhausted; that remains a separate
delivery concern.

Operators read publication state through `GET /api/v1/envelopes/{envelopeId}/completion-artifact`,
an active-instance-member, explicit-allowlist read that returns only the publication status, the
manifest/JSON/Markdown content digests (comparable to the existing draft `archiveSha256` exposure),
a coarse `published`/`pending`/`failed`/`unavailable` PDF status, and the retry eligibility and
failure generation described above — never object storage keys, audit event hashes, recipient
email/name, raw field values, capability material, or internal claim tokens. The completed-envelope
UI keeps the immutable sent documents distinct from the completed rendering and offers the verified
PDF and JSON/Markdown evidence only after publication. Every operator download re-derives the
content-addressed key from the recorded digest, applies the artifact byte bound, and hashes the
retrieved bytes before returning a private, non-cacheable attachment.
`POST /api/v1/system/completion-artifacts/drain` reuses the existing `DELIVERY_WORKER_SECRET`
constant-time bearer convention rather than a new credential. Cloudflare's existing one-minute
scheduled trigger invokes it in-process through the Worker's own `fetch` handler alongside the
invitation drain, with no Cloudflare REST API call from the Worker; Node/Docker drains it from the
same host scheduler used for invitation delivery.

CC recipient delivery, public artifact grants, and completion notification mailing are implemented
in Slice B (below). Operator commit-pinned DOCX export is a separate derived read
(`GET /api/v1/envelopes/{envelopeId}/docx`) and is not part of the completion artifact. Operators
and agents with `envelopes:read` download published JSON or Markdown evidence from
`GET /api/v1/envelopes/{envelopeId}/evidence` (aliased at `.../completion-artifact/evidence`;
`?format=markdown` selects Markdown, otherwise JSON) and the executed agreement PDF from
`GET /api/v1/envelopes/{envelopeId}/pdf` (aliased at `.../completion-artifact/pdf`). A configured
instance may explicitly request a separately stored and independently validated PAdES B-B or B-T
seal over those exact PDF bytes; automatic historical sealing is forbidden. Authenticated operators
and `envelopes:read` agents download only the fully reverified published result from
`GET /api/v1/envelopes/{envelopeId}/pdf-seal/pdf`.
