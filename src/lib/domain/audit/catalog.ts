export const AUDIT_HASH_VERSION_V3 = 3 as const;
export const CURRENT_AUDIT_HASH_VERSION = AUDIT_HASH_VERSION_V3;

export type AuditHashVersion = 3;
export type AuditActorType = 'user' | 'agent' | 'system' | 'recipient';

export const DRAFT_REVISION_EVENT_TYPE: string = 'draft.revision_created';
export const COMPLETION_AUDIT_ANCHOR_EVENT_TYPE: string = 'envelope.completed';
export const COMPLETION_ARTIFACT_PUBLISHED_EVENT_TYPE: string =
	'envelope.completion_artifact_published';
export const PDF_SEAL_PUBLISHED_EVENT_TYPE: string = 'envelope.pdf_seal_published';

/**
 * Registry of durable envelope audit events and the actor types a truthful
 * writer may stamp. Hashes include `actorType` and `actorId`, so widening
 * operator events to `user | agent` does not make actor-field tampering
 * invisible.
 */
export const AUDIT_EVENT_CATALOG: Readonly<
	Record<string, { readonly actorTypes: readonly AuditActorType[] }>
> = {
	'envelope.created': { actorTypes: ['user', 'agent'] },
	'draft.revision_created': { actorTypes: ['user', 'agent', 'system'] },
	'envelope.ready': { actorTypes: ['user', 'agent'] },
	'envelope.fields_placed': { actorTypes: ['user', 'agent'] },
	'envelope.sent': { actorTypes: ['user', 'agent'] },
	'envelope.voided': { actorTypes: ['user', 'agent'] },
	'recipient.viewed': { actorTypes: ['recipient'] },
	'recipient.signed': { actorTypes: ['recipient'] },
	'recipient.approved': { actorTypes: ['recipient'] },
	'recipient.declined': { actorTypes: ['recipient'] },
	'envelope.completed': { actorTypes: ['recipient'] },
	'envelope.completion_artifact_published': { actorTypes: ['system'] },
	// D1 0051 / Postgres 0047. Atomic PDF seal publication; system actor only.
	'envelope.pdf_seal_published': { actorTypes: ['system'] },
	// D1 0036 / Postgres 0034. HTTP reissue is session-only (user); agent is
	// catalogued for hashes so a later agent writer cannot mint an invisible actor.
	'recipient.capability_reissued': { actorTypes: ['user', 'agent'] },
	// D1 0034. System expiry drain; webhook-subscribable like other catalog events.
	'envelope.expired': { actorTypes: ['system'] }
};

export const WEBHOOK_AUDIT_EVENT_TYPES: readonly string[] = Object.freeze(
	Object.keys(AUDIT_EVENT_CATALOG)
);

export function isAuditEventType(value: string): boolean {
	return Object.prototype.hasOwnProperty.call(AUDIT_EVENT_CATALOG, value);
}

export function allowedActorTypes(eventType: string): readonly AuditActorType[] | undefined {
	return AUDIT_EVENT_CATALOG[eventType]?.actorTypes;
}

export function isAllowedActorType(eventType: string, actorType: string): boolean {
	const allowed: readonly AuditActorType[] | undefined = allowedActorTypes(eventType);
	if (allowed === undefined) return false;
	return (allowed as readonly string[]).includes(actorType);
}
