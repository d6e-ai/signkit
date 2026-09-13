export const AUDIT_HASH_VERSION_V1 = 1 as const;
export const AUDIT_HASH_VERSION_V2 = 2 as const;
export const CURRENT_AUDIT_HASH_VERSION = AUDIT_HASH_VERSION_V2;

export type AuditHashVersion = 1 | 2;
export type AuditActorType = 'user' | 'agent' | 'system' | 'recipient';

export const DRAFT_REVISION_EVENT_TYPE: string = 'draft.revision_created';
export const COMPLETION_AUDIT_ANCHOR_EVENT_TYPE: string = 'envelope.completed';
export const COMPLETION_ARTIFACT_PUBLISHED_EVENT_TYPE: string =
	'envelope.completion_artifact_published';

/**
 * Registry of durable envelope audit events and the actor types a truthful
 * writer may stamp. v2 hashes include `actorType` and `actorId`, so widening
 * operator events to `user | agent` does not make actor-field tampering
 * invisible. v1 rows keep the historical exact-actor checks in the verifier
 * because those preimages omitted `actorType`.
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
	'envelope.completion_artifact_published': { actorTypes: ['system'] }
};

/**
 * v1 exact actor expectations for events whose preimage did not include
 * `actorType`. Draft revision is excluded: its v1 preimage already hashed
 * actor fields, and it already allowed user/agent/system.
 */
export const LEGACY_V1_FIXED_ACTOR_TYPES: Readonly<Record<string, AuditActorType>> = {
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
