import { CURRENT_AUDIT_HASH_VERSION, type AuditHashVersion } from './catalog';

export interface AuditEventHashContext {
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
 * The single hash version covers every event and always includes
 * `hashVersion`, `actorType`, and `actorId`. Property order is part of the
 * hashed bytes. One deployment database is the sole SignKit instance
 * boundary, so the preimage carries no tenant field.
 */
export function auditEventHashPreimage(
	event: AuditEventHashFields,
	context: AuditEventHashContext
): string {
	return JSON.stringify({
		hashVersion: event.hashVersion,
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

export async function hashAuditEvent(
	event: AuditEventHashFields,
	context: AuditEventHashContext
): Promise<string> {
	return sha256TextHex(auditEventHashPreimage(event, context));
}

export async function hashAuditEventV3(
	event: Omit<AuditEventHashFields, 'hashVersion'>,
	context: AuditEventHashContext
): Promise<string> {
	return hashAuditEvent({ ...event, hashVersion: CURRENT_AUDIT_HASH_VERSION }, context);
}

/**
 * Recomputes a stored event's hash from the version recorded with it.
 * Only the current version verifies: old databases must be reset, so no
 * historical preimage is retained.
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
		typeof value === 'string' ? Number(value) : (value ?? CURRENT_AUDIT_HASH_VERSION);
	if (numeric === CURRENT_AUDIT_HASH_VERSION) return CURRENT_AUDIT_HASH_VERSION;
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
