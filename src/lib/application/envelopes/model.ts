import type { Envelope } from '$lib/domain/envelope';
import type { EnvelopeStore } from '$lib/ports/envelope-store';

export interface EnvelopeActor {
	id: string;
	type: 'user';
}

export interface EnvelopeListQuery {
	cursor: string | null;
	limit: number;
}

export interface EnvelopeListPage {
	items: readonly Envelope[];
	nextCursor: string | null;
}

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
export interface EnvelopeApplicationStore extends EnvelopeStore {
	createIdempotently(command: CreateEnvelopeCommand): Promise<CreateEnvelopeStoreResult>;
	listForOrganization(organizationId: string, query: EnvelopeListQuery): Promise<EnvelopeListPage>;
}

export interface EnvelopeRequestActor {
	id: string;
	organizationId: string;
	organizationName: string;
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
	list(actor: EnvelopeRequestActor, query: EnvelopeListQuery): Promise<EnvelopeListPage>;
}
