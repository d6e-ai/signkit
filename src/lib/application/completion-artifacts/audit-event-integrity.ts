import {
	COMPLETION_AUDIT_ANCHOR_EVENT_TYPE,
	CURRENT_AUDIT_HASH_VERSION,
	DRAFT_REVISION_EVENT_TYPE,
	auditEventHashPreimage as domainAuditEventHashPreimage,
	isAllowedActorType,
	isAuditEventType,
	parseAuditHashVersion,
	sha256TextHex,
	type AuditEventHashContext,
	type AuditHashVersion
} from '$lib/domain/audit';
import {
	CompletionArtifactBoundExceededError,
	CompletionArtifactIntegrityError,
	ISO_MILLISECOND_TIMESTAMP_PATTERN,
	type CompletionEvidenceAuditEvent
} from '$lib/ports/completion-artifact-store';

export {
	COMPLETION_AUDIT_ANCHOR_EVENT_TYPE,
	CURRENT_AUDIT_HASH_VERSION,
	DRAFT_REVISION_EVENT_TYPE
};

/** Sum of every `payloadJson` byte length in a chain; bounds work before any hashing happens. */
export const MAX_AUDIT_CHAIN_PAYLOAD_BYTES: number = 4 * 1024 * 1024;

export type CompletionAuditChainContext = AuditEventHashContext;

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
 * Reproduces the exact JSON.stringify preimage each writer hashed: the single
 * hash version, which includes `hashVersion`, `actorType`, and `actorId` for
 * every event.
 */
export function auditEventHashPreimage(
	event: CompletionEvidenceAuditEvent,
	payload: unknown,
	context: CompletionAuditChainContext
): string {
	return domainAuditEventHashPreimage(
		{
			hashVersion: hashVersionOf(event),
			sequence: event.sequence,
			eventType: event.eventType,
			actorType: event.actorType,
			actorId: event.actorId,
			occurredAt: event.occurredAt,
			payload,
			previousHash: event.previousHash
		},
		context
	);
}

/**
 * Verifies one event in isolation: canonical timestamp and payload, an actor
 * type consistent with the event type and hash version, and a recomputed hash
 * that matches the recorded one. Returns the parsed payload so callers never
 * need to re-parse already-validated JSON.
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

	assertExpectedActorType(event);

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

function hashVersionOf(event: CompletionEvidenceAuditEvent): AuditHashVersion {
	try {
		return parseAuditHashVersion(event.hashVersion);
	} catch {
		throw new CompletionArtifactIntegrityError(
			'Completion audit event has an unsupported hash version'
		);
	}
}

function assertExpectedActorType(event: CompletionEvidenceAuditEvent): void {
	hashVersionOf(event);
	if (!isAuditEventType(event.eventType)) {
		throw new CompletionArtifactIntegrityError(
			`Completion audit event has an unknown event type: ${event.eventType}`
		);
	}

	if (!isAllowedActorType(event.eventType, event.actorType)) {
		throw new CompletionArtifactIntegrityError(
			'Completion audit event has an unexpected actor type'
		);
	}
}

function byteLengthUtf8(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}
