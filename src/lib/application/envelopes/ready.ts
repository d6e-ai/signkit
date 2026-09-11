import type { Envelope, Recipient, RecipientRole } from '$lib/domain/envelope';
import type {
	EnvelopeReadyStore,
	PublishReadyEnvelopeCommand,
	PublishReadyEnvelopeResult,
	PublishedReadyEnvelope,
	ReadyPreparation
} from '$lib/ports/envelope-ready-store';
import type { EnvelopeRequestActor } from './model';

export interface ReadyRecipientInput {
	email: string;
	name: string;
	role: RecipientRole;
	locale: 'en' | 'ja';
	routingOrder: number;
}

export interface ReadyEnvelopeInput {
	idempotencyKey: string;
	expectedGeneration: number;
	recipients: readonly ReadyRecipientInput[];
}

export type ReadyEnvelopeResult =
	| { outcome: 'published' | 'replayed'; result: PublishedReadyEnvelope }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'immutable' }
	| { outcome: 'generation_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'empty_draft' }
	| { outcome: 'integrity_error' };

export interface EnvelopeReadyApplicationPort {
	ready(
		actor: EnvelopeRequestActor,
		envelopeId: string,
		input: ReadyEnvelopeInput
	): Promise<ReadyEnvelopeResult>;
}

export class EnvelopeReadyApplication implements EnvelopeReadyApplicationPort {
	readonly #store: EnvelopeReadyStore;

	constructor(store: EnvelopeReadyStore) {
		this.#store = store;
	}

	async ready(
		actor: EnvelopeRequestActor,
		envelopeId: string,
		input: ReadyEnvelopeInput
	): Promise<ReadyEnvelopeResult> {
		const canonicalRecipients: readonly ReadyRecipientInput[] = canonicalizeRecipients(
			input.recipients
		);
		const canonicalRequest: string = JSON.stringify({
			expectedGeneration: input.expectedGeneration,
			recipients: canonicalRecipients
		});
		const requestFingerprint: string = await sha256(canonicalRequest);
		const key = {
			organizationId: actor.organizationId,
			envelopeId,
			actorId: actor.id,
			idempotencyKey: input.idempotencyKey,
			requestFingerprint
		};
		const preparation: ReadyPreparation = await this.#store.prepareReady(
			key,
			input.expectedGeneration
		);
		if (preparation.outcome !== 'ready') return preparation;

		const updatedAt: string = new Date().toISOString();
		const recipients: readonly Recipient[] = await Promise.all(
			canonicalRecipients.map(async (recipient: ReadyRecipientInput): Promise<Recipient> => ({
				id: await deterministicUuid(
					['signkit-recipient-v1', envelopeId, recipient.email].join('\u0000')
				),
				organizationId: actor.organizationId,
				envelopeId,
				email: recipient.email,
				name: recipient.name,
				role: recipient.role,
				locale: recipient.locale,
				routingOrder: recipient.routingOrder,
				status: 'pending'
			}))
		);
		const recipientsJson: string = JSON.stringify(recipients);
		const auditEventId: string = await deterministicUuid(
			['signkit-ready-event-v1', actor.organizationId, actor.id, input.idempotencyKey].join(
				'\u0000'
			)
		);
		const auditPayloadJson: string = JSON.stringify({
			commitSha: preparation.envelope.repositoryHead,
			generation: preparation.envelope.repositoryGeneration,
			recipients: recipients.map((recipient: Recipient) => ({
				id: recipient.id,
				role: recipient.role,
				routingOrder: recipient.routingOrder
			}))
		});
		const auditEventHash: string = await sha256(
			JSON.stringify({
				actorId: actor.id,
				envelopeId,
				eventType: 'envelope.ready',
				occurredAt: updatedAt,
				organizationId: actor.organizationId,
				payload: JSON.parse(auditPayloadJson) as unknown,
				previousHash: preparation.auditHead.eventHash
			})
		);
		const command: PublishReadyEnvelopeCommand = {
			...key,
			expectedGeneration: input.expectedGeneration,
			expectedCommitSha: requiredHead(preparation.envelope),
			recipients,
			recipientsJson,
			updatedAt,
			expectedAuditSequence: preparation.auditHead.sequence,
			previousAuditHash: preparation.auditHead.eventHash,
			auditEventId,
			auditEventHash,
			auditPayloadJson
		};
		const published: PublishReadyEnvelopeResult = await this.#store.publishReady(command);
		return published;
	}
}

function canonicalizeRecipients(
	recipients: readonly ReadyRecipientInput[]
): readonly ReadyRecipientInput[] {
	return recipients
		.map((recipient: ReadyRecipientInput): ReadyRecipientInput => ({
			email: recipient.email.trim().toLowerCase(),
			name: recipient.name.trim(),
			role: recipient.role,
			locale: recipient.locale,
			routingOrder: recipient.routingOrder
		}))
		.sort(
			(left: ReadyRecipientInput, right: ReadyRecipientInput): number =>
				left.routingOrder - right.routingOrder ||
				left.email.localeCompare(right.email) ||
				left.role.localeCompare(right.role)
		);
}

function requiredHead(envelope: Envelope): string {
	if (envelope.repositoryHead === null)
		throw new Error('Ready preparation returned an empty draft');
	return envelope.repositoryHead;
}

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
