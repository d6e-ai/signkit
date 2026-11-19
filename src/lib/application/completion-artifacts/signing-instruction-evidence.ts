import { readSigningInstruction } from '$lib/domain/signing-instruction';
import { sentSigningInstructionVersion } from '$lib/domain/commands/sent-signing-instruction';
import {
	CompletionArtifactIntegrityError,
	type CompletionEvidenceAuditEvent,
	type CompletionEvidenceField,
	type CompletionEvidenceRecipient
} from '$lib/ports/completion-artifact-store';

const SENT_EVENT_TYPE: string = 'envelope.sent';
const READY_EVENT_TYPE: string = 'envelope.ready';
const SIGNED_EVENT_TYPE: string = 'recipient.signed';
const SHA256_PATTERN: RegExp = /^[a-f0-9]{64}$/;

export interface SigningInstructionEvidenceField {
	id: string;
	fieldType: string;
	valueSha256: string;
}

/** One signer's verified instruction, portable without the audit chain's raw payloads. */
export interface SigningInstructionEvidenceParty {
	recipientId: string;
	role: 'signer';
	routingOrder: number;
	decisionEventId: string;
	decisionEventHash: string;
	signedAt: string;
	signingInstruction: {
		version: 1;
		locale: 'en' | 'ja';
		sentEventHash: string;
		textSha256: string;
		fieldGeneration: number;
	};
	fields: readonly SigningInstructionEvidenceField[];
}

/**
 * Present only on manifests for sends whose canonical `envelope.sent` payload
 * carries `signingInstructionVersion`. It records what was verified from the
 * hash-chained audit events; it makes no claim about provider authorization
 * or legal effect.
 */
export interface CompletionSigningInstructionEvidence {
	version: 1;
	sentEventId: string;
	sentEventHash: string;
	sentCommitSha: string;
	/** SHA-256 of each sent PDF, in the attested `envelope.sent` document order. */
	sentPdfSha256: readonly string[];
	parties: readonly SigningInstructionEvidenceParty[];
}

export interface VerifySigningInstructionEvidenceInput {
	auditEvents: readonly CompletionEvidenceAuditEvent[];
	/** Parsed payloads of an already hash-verified chain. */
	payloadsByEventId: ReadonlyMap<string, unknown>;
	fieldGeneration: number;
	fields: readonly CompletionEvidenceField[];
	/** When supplied, each signer's SQL decision pointer must equal the verified event. */
	recipients?: readonly CompletionEvidenceRecipient[];
}

function fail(message: string): never {
	throw new CompletionArtifactIntegrityError(message);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function byId(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Shared by manifest building and executed-PDF assembly so neither can accept
 * a marked send without per-signer proof. Returns `null` for a legacy send
 * (no marker), which must also carry no instruction on any signature.
 * Approvers and other non-signers need no instruction.
 */
export async function verifySigningInstructionEvidence(
	input: VerifySigningInstructionEvidenceInput
): Promise<CompletionSigningInstructionEvidence | null> {
	const sentEvents = input.auditEvents.filter((event) => event.eventType === SENT_EVENT_TYPE);
	// Pre-send-event manifests are legacy; assembly separately demands exactly one send.
	if (sentEvents.length === 0) return null;
	if (sentEvents.length > 1) fail('Completion evidence has more than one envelope.sent event');
	const sentEvent: CompletionEvidenceAuditEvent = sentEvents[0];
	const sentPayload = asRecord(input.payloadsByEventId.get(sentEvent.id));
	if (sentPayload === undefined) fail('Verified envelope.sent payload is missing');
	const version = sentSigningInstructionVersion(sentPayload);
	if (version === null) fail('Verified envelope.sent signing instruction marker is invalid');

	const signedEvents = input.auditEvents.filter((event) => event.eventType === SIGNED_EVENT_TYPE);
	if (version === undefined) {
		for (const event of signedEvents) {
			const payload = asRecord(input.payloadsByEventId.get(event.id));
			if (payload !== undefined && 'signingInstruction' in payload) {
				fail('Signed event carries a signing instruction the send did not mark');
			}
		}
		return null;
	}

	const sentCommitSha: unknown = sentPayload.commitSha;
	if (typeof sentCommitSha !== 'string') fail('Verified envelope.sent commit is missing');
	if (!Array.isArray(sentPayload.documents) || sentPayload.documents.length === 0) {
		fail('Verified envelope.sent documents are missing');
	}
	const sentPdfSha256: string[] = (sentPayload.documents as unknown[]).map((entry) => {
		const sha = asRecord(entry)?.sha256;
		if (typeof sha !== 'string' || !SHA256_PATTERN.test(sha)) {
			fail('Verified envelope.sent document digest is invalid');
		}
		return sha;
	});

	const signerIds = readySigners(input, sentEvent);
	const signedBySigner = new Map<string, CompletionEvidenceAuditEvent>();
	for (const event of signedEvents) {
		if (event.actorId === null || !signerIds.has(event.actorId)) {
			fail('Signed event actor is not a named signer of the marked send');
		}
		if (signedBySigner.has(event.actorId)) {
			fail('A named signer has more than one signed event');
		}
		signedBySigner.set(event.actorId, event);
	}

	const fieldsById = new Map(input.fields.map((field) => [field.id, field] as const));
	const parties: SigningInstructionEvidenceParty[] = [];
	for (const [recipientId, routingOrder] of signerIds) {
		const event = signedBySigner.get(recipientId);
		if (event === undefined) fail('A named signer has no signed event for the marked send');
		const payload = asRecord(input.payloadsByEventId.get(event.id));
		if (
			payload === undefined ||
			event.sequence <= sentEvent.sequence ||
			payload.recipientId !== recipientId ||
			payload.role !== 'signer' ||
			payload.routingOrder !== routingOrder ||
			payload.sentCommitSha !== sentCommitSha ||
			payload.signedAt !== event.occurredAt
		) {
			fail('Signed event does not match its named signer and send');
		}
		const instruction = await readSigningInstruction(payload);
		if (
			instruction === undefined ||
			instruction === null ||
			instruction.version !== version ||
			(instruction.locale !== 'en' && instruction.locale !== 'ja') ||
			instruction.sentEventHash !== sentEvent.eventHash ||
			!SHA256_PATTERN.test(instruction.textSha256) ||
			instruction.fieldGeneration !== input.fieldGeneration
		) {
			fail('Signed event signing instruction does not match the exact envelope.sent event');
		}
		const declared: SigningInstructionEvidenceField[] = [];
		for (const candidate of Array.isArray(payload.fields) ? (payload.fields as unknown[]) : []) {
			const field = asRecord(candidate);
			const stored = typeof field?.id === 'string' ? fieldsById.get(field.id) : undefined;
			if (
				field === undefined ||
				stored === undefined ||
				field.fieldType !== stored.fieldType ||
				field.valueSha256 !== stored.valueSha256
			) {
				fail('Signed event field digests do not match the verified field evidence');
			}
			declared.push({
				id: stored.id,
				fieldType: stored.fieldType,
				valueSha256: stored.valueSha256
			});
		}
		if (input.recipients !== undefined) {
			const recipient = input.recipients.find((candidate) => candidate.id === recipientId);
			if (
				recipient === undefined ||
				recipient.role !== 'signer' ||
				recipient.decisionEventId !== event.id ||
				recipient.decisionOccurredAt !== event.occurredAt
			) {
				fail('Signer decision does not match the verified signing instruction event');
			}
		}
		parties.push({
			recipientId,
			role: 'signer',
			routingOrder,
			decisionEventId: event.id,
			decisionEventHash: event.eventHash,
			signedAt: event.occurredAt,
			signingInstruction: {
				version: 1,
				locale: instruction.locale,
				sentEventHash: instruction.sentEventHash,
				textSha256: instruction.textSha256,
				fieldGeneration: instruction.fieldGeneration
			},
			fields: declared.sort((l, r) => byId(l.id, r.id))
		});
	}
	parties.sort((l, r) => byId(l.recipientId, r.recipientId));
	return {
		version: 1,
		sentEventId: sentEvent.id,
		sentEventHash: sentEvent.eventHash,
		sentCommitSha,
		sentPdfSha256,
		parties
	};
}

/** Signers named by the latest `envelope.ready` before send. */
function readySigners(
	input: VerifySigningInstructionEvidenceInput,
	sentEvent: CompletionEvidenceAuditEvent
): Map<string, number> {
	const ready = input.auditEvents
		.filter((event) => event.eventType === READY_EVENT_TYPE && event.sequence < sentEvent.sequence)
		.reduce<CompletionEvidenceAuditEvent | undefined>(
			(latest, event) => (latest === undefined || event.sequence > latest.sequence ? event : latest),
			undefined
		);
	const payload = ready === undefined ? undefined : asRecord(input.payloadsByEventId.get(ready.id));
	if (payload === undefined || !Array.isArray(payload.recipients)) {
		fail('envelope.ready recipient declarations are missing for the marked send');
	}
	const signers = new Map<string, number>();
	for (const candidate of payload.recipients as unknown[]) {
		const entry = asRecord(candidate);
		if (typeof entry?.id !== 'string' || typeof entry.routingOrder !== 'number') {
			fail('envelope.ready recipient declaration is malformed');
		}
		if (entry.role === 'signer') signers.set(entry.id, entry.routingOrder);
	}
	return signers;
}
