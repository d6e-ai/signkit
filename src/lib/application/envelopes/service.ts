import { hashAuditEventV2 } from '$lib/domain/audit';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import type { Envelope } from '$lib/domain/envelope';
import type {
	CreateEnvelopeInput,
	CreateEnvelopeResult,
	EnvelopeApplicationPort,
	EnvelopeApplicationStore,
	EnvelopeListPage,
	EnvelopeListQuery,
	EnvelopeRequestActor
} from './model';
import { envelopeActorType } from './model';

async function sha256(value: string): Promise<string> {
	const bytes: Uint8Array<ArrayBuffer> = new TextEncoder().encode(value);
	const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

export class EnvelopeApplication implements EnvelopeApplicationPort {
	readonly #store: EnvelopeApplicationStore;
	readonly #newId: UuidV7Generator;

	constructor(store: EnvelopeApplicationStore, newId: UuidV7Generator = newUuidV7) {
		this.#store = store;
		this.#newId = newId;
	}

	async create(
		actor: EnvelopeRequestActor,
		input: CreateEnvelopeInput
	): Promise<CreateEnvelopeResult> {
		const canonicalRequest: string = JSON.stringify({ title: input.title });
		const requestFingerprint: string = await sha256(canonicalRequest);
		// Candidate identifiers for a first attempt. The durable idempotency
		// record, not a derivation of the caller's key, is what a replay reads
		// back, so these are simply discarded when this request is a replay.
		const envelopeId: string = this.#newId();
		const auditEventId: string = this.#newId();
		const createdAt: string = new Date().toISOString();
		const actorType: 'user' | 'agent' = envelopeActorType(actor);
		const auditEventHash: string = await hashAuditEventV2(
			{
				sequence: 1,
				eventType: 'envelope.created',
				actorType,
				actorId: actor.id,
				occurredAt: createdAt,
				payload: { title: input.title },
				previousHash: null
			},
			{ organizationId: actor.organizationId, envelopeId }
		);
		return this.#store.createIdempotently({
			actor: { id: actor.id, type: actorType },
			auditEventHash,
			auditEventId,
			createdAt,
			envelopeId,
			idempotencyKey: input.idempotencyKey,
			organizationId: actor.organizationId,
			organizationName: actor.organizationName,
			requestFingerprint,
			title: input.title
		});
	}

	async get(actor: EnvelopeRequestActor, envelopeId: string): Promise<Envelope | null> {
		return this.#store.findForOrganization(actor.organizationId, envelopeId);
	}

	async list(actor: EnvelopeRequestActor, query: EnvelopeListQuery): Promise<EnvelopeListPage> {
		return this.#store.listForOrganization(actor.organizationId, query);
	}
}
