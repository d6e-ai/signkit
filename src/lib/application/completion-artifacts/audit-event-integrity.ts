import {
	CompletionArtifactBoundExceededError,
	CompletionArtifactIntegrityError,
	ISO_MILLISECOND_TIMESTAMP_PATTERN,
	type CompletionEvidenceAuditEvent
} from '$lib/ports/completion-artifact-store';

/**
 * The only audit event types a completion artifact worker currently knows how
 * to verify, mapped to the actor type every writer stamps for that event.
 * `actorType` is not part of the hash preimage for these events (see
 * {@link auditEventHashPreimage}), so it is checked here explicitly — an
 * attacker who flips `actor_type` in place would otherwise leave the
 * recomputed hash unchanged. A type not on this list fails closed: either it
 * was never a real writer event (tampering) or it is a genuinely new event
 * type this verifier has not been taught about yet, and in both cases
 * publishing a manifest that silently ignores it would be wrong.
 */
export const COMPLETION_AUDIT_EVENT_ACTOR_TYPES: Readonly<Record<string, string>> = {
	'envelope.created': 'user',
	'envelope.ready': 'user',
	'envelope.fields_placed': 'user',
	'envelope.sent': 'user',
	'envelope.voided': 'user',
	'recipient.viewed': 'recipient',
	'recipient.signed': 'recipient',
	'recipient.approved': 'recipient',
	'recipient.declined': 'recipient',
	'envelope.completed': 'recipient',
	'envelope.completion_artifact_published': 'system'
};

/**
 * The one writer event whose `actorType`/`actorId` are hashed rather than
 * checked against a single fixed expectation — a draft revision can
 * legitimately be authored by a human, an agent, or a system process.
 */
export const DRAFT_REVISION_EVENT_TYPE: string = 'draft.revision_created';
export const DRAFT_REVISION_ACTOR_TYPES: ReadonlySet<string> = new Set(['user', 'agent', 'system']);

export const COMPLETION_AUDIT_ANCHOR_EVENT_TYPE: string = 'envelope.completed';

/** Sum of every `payloadJson` byte length in a chain; bounds work before any hashing happens. */
export const MAX_AUDIT_CHAIN_PAYLOAD_BYTES: number = 4 * 1024 * 1024;

export interface CompletionAuditChainContext {
	organizationId: string;
	envelopeId: string;
}

export interface CompletionAuditChainVerification {
	anchorEventType: typeof COMPLETION_AUDIT_ANCHOR_EVENT_TYPE;
	anchorEventId: string;
	headSequence: number;
	verifiedEventCount: number;
	/**
	 * Every stored `event_hash` in the chain was independently recomputed from
	 * its own recorded fields and matched, and the `previous_hash` pointers
	 * were verified to link the chain from its root through the
	 * `envelope.completed` anchor. This is NOT a tamper-proof guarantee: an
	 * adversary with direct database write access who rewrites every event in
	 * the chain and recomputes every hash consistently would pass this check.
	 * Detecting that class of whole-chain rewrite requires an external
	 * signed/published anchor (for example, a hash checkpoint written to a
	 * separate, append-only system) and is out of scope here.
	 */
	hashChainVerified: true;
}

/**
 * Reproduces the exact JSON.stringify preimage each writer hashed. There are
 * exactly two shapes in the current codebase:
 *
 * 1. `draft.revision_created` (src/lib/application/drafts/draft-persistence.ts):
 *    `{ organizationId, envelopeId, sequence, eventType, actorType, actorId, occurredAt, payload, previousHash }`
 * 2. Every other writer event (envelope create/ready/fields/sent/voided,
 *    recipient viewed/signed/approved/declined, envelope.completed,
 *    envelope.completion_artifact_published):
 *    `{ actorId, envelopeId, eventType, occurredAt, organizationId, payload, previousHash }`
 *
 * Property order matters: it is part of the hashed bytes, not just the value.
 */
export function auditEventHashPreimage(
	event: CompletionEvidenceAuditEvent,
	payload: unknown,
	context: CompletionAuditChainContext
): string {
	if (event.eventType === DRAFT_REVISION_EVENT_TYPE) {
		return JSON.stringify({
			organizationId: context.organizationId,
			envelopeId: context.envelopeId,
			sequence: event.sequence,
			eventType: event.eventType,
			actorType: event.actorType,
			actorId: event.actorId,
			occurredAt: event.occurredAt,
			payload,
			previousHash: event.previousHash
		});
	}
	return JSON.stringify({
		actorId: event.actorId,
		envelopeId: context.envelopeId,
		eventType: event.eventType,
		occurredAt: event.occurredAt,
		organizationId: context.organizationId,
		payload,
		previousHash: event.previousHash
	});
}

/**
 * Verifies one event in isolation: canonical timestamp and payload, an
 * actor type consistent with the event type, and a recomputed hash that
 * matches the recorded one. Returns the parsed payload so callers (chain
 * walking, field/decision cross-checks) never need to re-parse
 * already-validated JSON.
 */
export async function verifyAuditEventRecord(
	event: CompletionEvidenceAuditEvent,
	context: CompletionAuditChainContext
): Promise<unknown> {
	if (!ISO_MILLISECOND_TIMESTAMP_PATTERN.test(event.occurredAt)) {
		throw new CompletionArtifactIntegrityError(
			'Completion audit event has a non-canonical timestamp'
		);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(event.payloadJson) as unknown;
	} catch {
		throw new CompletionArtifactIntegrityError('Completion audit event payload is not valid JSON');
	}
	if (JSON.stringify(payload) !== event.payloadJson) {
		throw new CompletionArtifactIntegrityError(
			'Completion audit event payload is not canonical JSON'
		);
	}

	if (event.eventType === DRAFT_REVISION_EVENT_TYPE) {
		if (!DRAFT_REVISION_ACTOR_TYPES.has(event.actorType)) {
			throw new CompletionArtifactIntegrityError(
				'Draft revision audit event has an unexpected actor type'
			);
		}
	} else {
		const expectedActorType: string | undefined =
			COMPLETION_AUDIT_EVENT_ACTOR_TYPES[event.eventType];
		if (expectedActorType === undefined) {
			throw new CompletionArtifactIntegrityError(
				`Completion audit event has an unknown event type: ${event.eventType}`
			);
		}
		if (event.actorType !== expectedActorType) {
			throw new CompletionArtifactIntegrityError(
				'Completion audit event has an unexpected actor type'
			);
		}
	}

	const preimage: string = auditEventHashPreimage(event, payload, context);
	const recomputed: string = await sha256TextHex(preimage);
	if (recomputed !== event.eventHash) {
		throw new CompletionArtifactIntegrityError(
			'Completion audit event hash does not match its recorded fields'
		);
	}
	return payload;
}

/**
 * Walks a completion evidence audit chain end to end: sequence contiguity,
 * hash-chain linkage, a bounded aggregate payload budget, and a per-event
 * recompute (see {@link verifyAuditEventRecord}) — then requires the chain to
 * terminate at `envelope.completed`. Returns the recomputed proof plus every
 * event's parsed payload, keyed by event id, for callers that need to
 * cross-check evidence against specific events (signed fields, recipient
 * decisions) without re-parsing.
 */
export async function verifyCompletionAuditChain(
	events: readonly CompletionEvidenceAuditEvent[],
	context: CompletionAuditChainContext,
	maxEvents: number
): Promise<{
	proof: CompletionAuditChainVerification;
	payloadsByEventId: ReadonlyMap<string, unknown>;
}> {
	if (events.length === 0) {
		throw new CompletionArtifactIntegrityError('Completion audit chain is empty');
	}
	if (events.length > maxEvents) {
		throw new CompletionArtifactBoundExceededError(
			`Completion audit chain exceeds the ${maxEvents}-event verification bound`
		);
	}

	const payloadsByEventId = new Map<string, unknown>();
	let aggregatePayloadBytes: number = 0;
	for (let index: number = 0; index < events.length; index += 1) {
		const event: CompletionEvidenceAuditEvent = events[index];
		if (event.sequence !== index + 1) {
			throw new CompletionArtifactIntegrityError('Completion audit chain has a sequence gap');
		}
		if (index === 0) {
			if (event.previousHash !== null) {
				throw new CompletionArtifactIntegrityError('Completion audit chain has an invalid root');
			}
		} else if (event.previousHash !== events[index - 1].eventHash) {
			throw new CompletionArtifactIntegrityError('Completion audit chain has a broken hash link');
		}

		aggregatePayloadBytes += byteLengthUtf8(event.payloadJson);
		if (aggregatePayloadBytes > MAX_AUDIT_CHAIN_PAYLOAD_BYTES) {
			throw new CompletionArtifactBoundExceededError(
				'Completion audit chain exceeds the aggregate payload byte budget'
			);
		}

		const payload: unknown = await verifyAuditEventRecord(event, context);
		payloadsByEventId.set(event.id, payload);
	}

	const head: CompletionEvidenceAuditEvent = events[events.length - 1];
	if (head.eventType !== COMPLETION_AUDIT_ANCHOR_EVENT_TYPE) {
		throw new CompletionArtifactIntegrityError(
			'Completion audit chain does not end at envelope.completed'
		);
	}

	return {
		proof: {
			anchorEventType: COMPLETION_AUDIT_ANCHOR_EVENT_TYPE,
			anchorEventId: head.id,
			headSequence: head.sequence,
			verifiedEventCount: events.length,
			hashChainVerified: true
		},
		payloadsByEventId
	};
}

function byteLengthUtf8(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

async function sha256TextHex(value: string): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value)
	);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
