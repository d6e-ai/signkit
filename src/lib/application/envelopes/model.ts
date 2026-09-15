import type {
	Envelope,
	FieldGeometry,
	FieldType,
	MarkdownPath,
	RecipientRole,
	RecipientStatus
} from '$lib/domain/envelope';
import type { EnvelopeStore } from '$lib/ports/envelope-store';

export interface EnvelopeActor {
	id: string;
	type: 'user' | 'agent';
}

export interface EnvelopeListQuery {
	cursor: string | null;
	limit: number;
}

export interface EnvelopeListPage {
	items: readonly Envelope[];
	nextCursor: string | null;
}

/**
 * Public create/list/get envelope JSON. Omits `repositoryArchiveKey` and any
 * other object-store locator. `repositoryHead` and `sentCommitSha` are Git
 * content identifiers used for pinning and concurrency; `repositoryArchiveSha256`
 * is a content digest, not a storage key.
 */
export interface PublicEnvelope {
	id: string;
	organizationId: string;
	title: string;
	status: Envelope['status'];
	repositoryGeneration: number;
	repositoryHead: string | null;
	repositoryArchiveSha256: string | null;
	sentCommitSha: string | null;
	fieldGeneration: number;
	createdAt: string;
	updatedAt: string;
}

export interface PublicEnvelopeListPage {
	items: readonly PublicEnvelope[];
	nextCursor: string | null;
}

export function toPublicEnvelope(envelope: Envelope): PublicEnvelope {
	return {
		id: envelope.id,
		organizationId: envelope.organizationId,
		title: envelope.title,
		status: envelope.status,
		repositoryGeneration: envelope.repositoryGeneration,
		repositoryHead: envelope.repositoryHead,
		repositoryArchiveSha256: envelope.repositoryArchiveSha256,
		sentCommitSha: envelope.sentCommitSha,
		fieldGeneration: envelope.fieldGeneration,
		createdAt: envelope.createdAt,
		updatedAt: envelope.updatedAt
	};
}

export function toPublicEnvelopeListPage(page: EnvelopeListPage): PublicEnvelopeListPage {
	return {
		items: page.items.map(toPublicEnvelope),
		nextCursor: page.nextCursor
	};
}

/**
 * `envelopeId` and `auditEventId` are freshly minted UUIDv7 candidates for a
 * first attempt. They are not derived from the idempotency key, so a store must
 * resolve a replay from its durable idempotency record and return the envelope
 * that record references rather than comparing the candidate ID.
 */
export interface CreateEnvelopeCommand {
	actor: EnvelopeActor;
	auditEventHash: string;
	auditEventId: string;
	createdAt: string;
	envelopeId: string;
	idempotencyKey: string;
	organizationId: string;
	organizationName: string;
	requestFingerprint: string;
	title: string;
}

export type CreateEnvelopeStoreResult =
	| { outcome: 'created'; envelope: Envelope }
	| { outcome: 'replayed'; envelope: Envelope }
	| { outcome: 'conflict' };

/**
 * Collection operations needed by the application layer in addition to the
 * existing per-envelope port. Implementations must scope every statement by
 * organizationId and make idempotent creation atomic.
 */
/**
 * Operator-safe recipient projection. Omits capability hashes, ciphertext,
 * expiry, revocation, and organization identifiers.
 */
export interface PublicEnvelopeRecipient {
	id: string;
	email: string;
	name: string;
	role: RecipientRole;
	locale: 'en' | 'ja';
	routingOrder: number;
	status: RecipientStatus;
}

/**
 * Operator-safe field projection. Labels can carry PII and are never echoed
 * on this read model, matching the field-placement receipt.
 */
export interface PublicEnvelopeDetailField {
	id: string;
	recipientId: string;
	documentId: string | null;
	documentPath: MarkdownPath | null;
	fieldType: FieldType;
	required: boolean;
	position: number;
	geometry: FieldGeometry | null;
}

/**
 * Tenant-authorized envelope read model used by GET /envelopes/{id}. Recipients,
 * the ready audit event id, and the current field set are durable server reads
 * so a reload or second tab can continue authoring/send without sessionStorage.
 */
export interface EnvelopeDetail {
	envelope: Envelope;
	recipients: readonly PublicEnvelopeRecipient[];
	readyAuditEventId: string | null;
	fields: readonly PublicEnvelopeDetailField[];
}

export interface EnvelopeApplicationStore extends EnvelopeStore {
	createIdempotently(command: CreateEnvelopeCommand): Promise<CreateEnvelopeStoreResult>;
	listForOrganization(organizationId: string, query: EnvelopeListQuery): Promise<EnvelopeListPage>;
	readDetail(organizationId: string, envelopeId: string): Promise<EnvelopeDetail | null>;
}

export interface EnvelopeRequestActor {
	id: string;
	organizationId: string;
	organizationName: string;
	/** Session operators are `user`; API keys are `agent`. Defaults to `user`. */
	actorType?: 'user' | 'agent';
}

export function envelopeActorType(actor: EnvelopeRequestActor): 'user' | 'agent' {
	return actor.actorType ?? 'user';
}

export interface CreateEnvelopeInput {
	idempotencyKey: string;
	title: string;
}

export type CreateEnvelopeResult =
	| { outcome: 'created'; envelope: Envelope }
	| { outcome: 'replayed'; envelope: Envelope }
	| { outcome: 'conflict' };

export interface EnvelopeApplicationPort {
	create(actor: EnvelopeRequestActor, input: CreateEnvelopeInput): Promise<CreateEnvelopeResult>;
	get(actor: EnvelopeRequestActor, envelopeId: string): Promise<Envelope | null>;
	getDetail(actor: EnvelopeRequestActor, envelopeId: string): Promise<EnvelopeDetail | null>;
	list(actor: EnvelopeRequestActor, query: EnvelopeListQuery): Promise<EnvelopeListPage>;
}
