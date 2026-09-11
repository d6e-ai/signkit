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

async function sha256(value: string): Promise<string> {
	const bytes: Uint8Array<ArrayBuffer> = new TextEncoder().encode(value);
	const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

async function deterministicUuid(value: string): Promise<string> {
	const digest: string = await sha256(value);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(
		17,
		20
	)}-${digest.slice(20, 32)}`;
}

export class EnvelopeApplication implements EnvelopeApplicationPort {
	readonly #store: EnvelopeApplicationStore;

	constructor(store: EnvelopeApplicationStore) {
		this.#store = store;
	}

	async create(
		actor: EnvelopeRequestActor,
		input: CreateEnvelopeInput
	): Promise<CreateEnvelopeResult> {
		const canonicalRequest: string = JSON.stringify({ title: input.title });
		const requestFingerprint: string = await sha256(canonicalRequest);
		const envelopeId: string = await deterministicUuid(
			['signkit-envelope-v1', actor.organizationId, actor.id, input.idempotencyKey].join('\u0000')
		);
		const createdAt: string = new Date().toISOString();
		const auditEventId: string = await deterministicUuid(`${envelopeId}\u0000envelope.created`);
		const auditEventHash: string = await sha256(
			JSON.stringify({
				actorId: actor.id,
				envelopeId,
				eventType: 'envelope.created',
				occurredAt: createdAt,
				organizationId: actor.organizationId,
				payload: { title: input.title },
				previousHash: null
			})
		);
		return this.#store.createIdempotently({
			actor: { id: actor.id, type: 'user' },
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
