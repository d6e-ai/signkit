import { hashAuditEventV3 } from '$lib/domain/audit';
import { sentSigningInstructionVersion } from '$lib/domain/commands/sent-signing-instruction';
import type { SentDocumentSetPointer } from '$lib/ports/envelope-sent-document-store';

export interface SentSigningInstructionEvidenceRow {
	commandPayloadJson?: string | null;
	payloadJson?: string | null;
	commandEventId?: string | null;
	eventId?: string | null;
	eventHash?: string | null;
	previousHash?: string | null;
	sequence?: number | string | null;
	actorType?: string | null;
	actorId?: string | null;
	occurredAt?: Date | string | null;
	hashVersion?: number | string | null;
}

function readPayload(json: string | null | undefined): Record<string, unknown> {
	if (json == null) return {};
	const value: unknown = JSON.parse(json);
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw integrityError();
	return value as Record<string, unknown>;
}

export async function attestSentSigningInstruction(
	envelopeId: string,
	commitSha: string,
	row: SentSigningInstructionEvidenceRow,
	set: SentDocumentSetPointer | null
): Promise<string | undefined> {
	const payload = readPayload(row.payloadJson);
	const version = sentSigningInstructionVersion(payload);
	const commandVersion = sentSigningInstructionVersion(readPayload(row.commandPayloadJson));
	if (version === undefined && commandVersion === undefined) return undefined;
	if (
		version !== 1 ||
		commandVersion !== version ||
		!row.eventId ||
		row.commandEventId !== row.eventId ||
		row.payloadJson !== row.commandPayloadJson ||
		JSON.stringify(payload) !== row.payloadJson ||
		set === null ||
		payload.commitSha !== commitSha ||
		payload.documentSetHash !== set.documentSetHash ||
		payload.documentCount !== set.documentCount ||
		JSON.stringify(payload.documents) !==
			JSON.stringify(
				set.documents.map((document) => ({
					id: document.documentId,
					sha256: document.sha256,
					byteSize: document.byteSize,
					pageCount: document.pageCount
				}))
			) ||
		Number(row.hashVersion) !== 3 ||
		!row.eventHash ||
		!row.previousHash ||
		!row.occurredAt ||
		!row.actorId ||
		(row.actorType !== 'user' && row.actorType !== 'agent' && row.actorType !== 'system') ||
		!Number.isSafeInteger(Number(row.sequence)) ||
		Number(row.sequence) < 1
	)
		throw integrityError();
	const occurredAt = row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt;
	const hash = await hashAuditEventV3(
		{
			sequence: Number(row.sequence),
			eventType: 'envelope.sent',
			actorType: row.actorType,
			actorId: row.actorId,
			occurredAt,
			payload,
			previousHash: row.previousHash
		},
		{ envelopeId }
	);
	if (hash !== row.eventHash) throw integrityError();
	return hash;
}

function integrityError(): Error {
	return new Error('The signing instruction must reference the attested sent document set');
}
