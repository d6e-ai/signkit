# Envelope reopen and dedicated authoring field reads

Date: 2026-10-11
Status: Accepted

## Context

`ready` was a pre-send pin that still allowed documents and recipients to be wrong. Correcting them required either sending anyway or abandoning the envelope. Field labels can contain PII, so public envelope detail, placement receipts, and completion evidence omit them. The field command is a whole-set replace guarded by `expectedFieldGeneration`. Without a dedicated authoring read, a client that reloaded from the public projection could not reconstruct labels and would risk deleting unseen fields.

Send preparation treated the caller-supplied `envelope.ready` audit event as a matching receipt for the current Git generation. Completion evidence assumed exactly one `envelope.ready` event. Reopen plus a later ready produces more than one ready event, so a stale send anchor had to fail closed in both adapters and in completion verification.

## Decision

- Add `POST /api/v1/envelopes/{envelopeId}/reopen` (`drafts:write`, required `Idempotency-Key`). The body is a strict `{expectedGeneration, expectedFieldGeneration, expectedReadyAuditEventId}` tuple. Publication is atomic `ready → draft` only while `sent_commit_sha IS NULL`. Recipients, repository head, and Git generation stay. Every field row is deleted. `field_generation` increments and never resets. One `envelope.reopened` audit event is appended at hash version 3. D1 uses an `AFTER INSERT` command trigger; PostgreSQL uses `FOR UPDATE` in one transaction. Both recheck the latest-ready anchor and audit head inside that boundary. Matching replay returns 200 with the durable receipt and the replay header.
- Add `GET /api/v1/envelopes/{envelopeId}/fields` as a dedicated `drafts:write` authoring read. It returns the complete stored field definitions, including labels and nullable document/geometry columns, from a coherent SQL snapshot. It does not decode Git or draft archives. Public envelope detail, placement receipts, and completion evidence stay label-free.
- Harden send in application preparation and in the D1/PostgreSQL publish guards: the named ready event must still be the latest `envelope.ready` for that envelope, generation, and commit, with no later `envelope.ready` or `envelope.reopened`. Forward migrations only (`migrations/d1/0056_envelope_reopen.sql`, `migrations/postgres/0052_envelope_reopen.sql`); D1 recreates the send trigger because SQLite cannot `ALTER` one.
- Completion manifests match the recipient roster to that same latest ready event and refuse a send that still names a superseded ready.

## Consequences

Senders can correct documents and recipients before send without minting a new envelope or remapping signature geometry. Existing recipient rows remain for prefill after reopen; the next ready command still declares a complete graph. Signature placements must be created again against the new revision.

Authoring clients can reload a complete field set and republish without guessing labels. `envelopes:read` and recipient surfaces still cannot see labels.

Audit and webhook catalogs gain `envelope.reopened`. Evidence consumers that assumed a single ready event must use latest-ready selection. Historical envelopes with one ready event remain valid.

## Alternatives considered

- **Silent remap of field geometry or recipients after a document or graph change:** rejected. Geometry is page-relative, and email identity is ambiguous.
- **Reset `field_generation` on reopen:** rejected. The counter is a compare-and-set generation, not a live field count; resetting it would make stale placement receipts look current.
- **Put labels on public envelope detail:** rejected. Labels can contain PII and would leak on every `envelopes:read` surface.
- **Keep exactly-one-ready completion verification:** rejected. Reopen and re-ready are now first-class, so evidence must accept the latest ready that the send actually anchored.
