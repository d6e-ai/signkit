import {
	AUDIT_HASH_VERSION_V1,
	AUDIT_HASH_VERSION_V2,
	CURRENT_AUDIT_HASH_VERSION,
	DRAFT_REVISION_EVENT_TYPE,
	type AuditHashVersion
} from './catalog';

export interface AuditEventHashContext {
	organizationId: string;
	envelopeId: string;
}

export interface AuditEventHashFields {
	hashVersion: AuditHashVersion;
	sequence: number;
	eventType: string;
	actorType: string;
	actorId: string | null;
	occurredAt: string;
	payload: unknown;
	previousHash: string | null;
}

/**
 * Reproduces the exact JSON.stringify preimage each writer hashed.
 *
 * v1 had two shapes:
 * 1. `draft.revision_created`:
 *    `{ organizationId, envelopeId, sequence, eventType, actorType, actorId, occurredAt, payload, previousHash }`
 * 2. Every other event:
 *    `{ actorId, envelopeId, eventType, occurredAt, organizationId, payload, previousHash }`
 *
 * v2 is one shape for every event and always includes `hashVersion`, `actorType`,
 * and `actorId`. Property order is part of the hashed bytes.
 */
export function auditEventHashPreimage(
	event: AuditEventHashFields,
	context: AuditEventHashContext
): string {
	if (event.hashVersion === AUDIT_HASH_VERSION_V2) {
		return JSON.stringify({
			hashVersion: AUDIT_HASH_VERSION_V2,
			organizationId: context.organizationId,
			envelopeId: context.envelopeId,
			sequence: event.sequence,
			eventType: event.eventType,
			actorType: event.actorType,
			actorId: event.actorId,
			occurredAt: event.occurredAt,
			payload: event.payload,
			previousHash: event.previousHash
		});
	}

	if (event.eventType === DRAFT_REVISION_EVENT_TYPE) {
		return JSON.stringify({
			organizationId: context.organizationId,
			envelopeId: context.envelopeId,
			sequence: event.sequence,
			eventType: event.eventType,
			actorType: event.actorType,
			actorId: event.actorId,
			occurredAt: event.occurredAt,
			payload: event.payload,
			previousHash: event.previousHash
		});
	}

	return JSON.stringify({
		actorId: event.actorId,
		envelopeId: context.envelopeId,
		eventType: event.eventType,
		occurredAt: event.occurredAt,
		organizationId: context.organizationId,
		payload: event.payload,
		previousHash: event.previousHash
	});
}

export async function hashAuditEvent(
	event: AuditEventHashFields,
	context: AuditEventHashContext
): Promise<string> {
	return sha256TextHex(auditEventHashPreimage(event, context));
}

export async function hashAuditEventV2(
	event: Omit<AuditEventHashFields, 'hashVersion'>,
	context: AuditEventHashContext
): Promise<string> {
	return hashAuditEvent({ ...event, hashVersion: CURRENT_AUDIT_HASH_VERSION }, context);
}

/**
 * Recomputes a stored event's hash from the version recorded with it.
 * Missing/null `hashVersion` is v1 so legacy rows and test fixtures that
 * predate the column still verify. New writers stamp 2 explicitly.
 */
export async function hashStoredAuditEvent(
	event: Omit<AuditEventHashFields, 'hashVersion'> & {
		hashVersion?: number | string | null;
	},
	context: AuditEventHashContext
): Promise<string> {
	return hashAuditEvent(
		{
			...event,
			hashVersion: parseAuditHashVersion(event.hashVersion)
		},
		context
	);
}

export function parseAuditHashVersion(value: number | string | null | undefined): AuditHashVersion {
	const numeric: number =
		typeof value === 'string' ? Number(value) : (value ?? AUDIT_HASH_VERSION_V1);
	if (numeric === AUDIT_HASH_VERSION_V2) return AUDIT_HASH_VERSION_V2;
	if (numeric === AUDIT_HASH_VERSION_V1) return AUDIT_HASH_VERSION_V1;
	throw new Error(`Unsupported audit hash version: ${String(value)}`);
}

export async function sha256TextHex(value: string): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value)
	);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
