import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import {
	isActionableRecipientRole,
	recipientRoles,
	type Envelope,
	type Recipient,
	type RecipientRole
} from '$lib/domain/envelope';
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

export class InvalidRecipientGraphError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidRecipientGraphError';
	}
}

export class EnvelopeReadyApplication implements EnvelopeReadyApplicationPort {
	readonly #store: EnvelopeReadyStore;
	readonly #newId: UuidV7Generator;

	constructor(store: EnvelopeReadyStore, newId: UuidV7Generator = newUuidV7) {
		this.#store = store;
		this.#newId = newId;
	}

	async ready(
		actor: EnvelopeRequestActor,
		envelopeId: string,
		input: ReadyEnvelopeInput
	): Promise<ReadyEnvelopeResult> {
		const canonicalRecipients: readonly ReadyRecipientInput[] = canonicalizeRecipients(
			input.recipients
		);
		assertReadyInput(input.expectedGeneration, canonicalRecipients);
		const canonicalRequest: string = JSON.stringify({
			expectedGeneration: input.expectedGeneration,
			recipients: canonicalRecipients
		});
		const requestFingerprint: string = await sha256(canonicalRequest);
		const key = {
			organizationId: actor.organizationId,
			envelopeId,
			actorType: 'user' as const,
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
		// Recipient identifiers are minted, never derived from the email address.
		// A derivation would let anyone holding a published recipient ID confirm a
		// guessed address for that envelope. A lost publication race replays the
		// durable receipt, whose recipient IDs are authoritative over these.
		const recipients: readonly Recipient[] = canonicalRecipients.map(
			(recipient: ReadyRecipientInput): Recipient => ({
				id: this.#newId(),
				organizationId: actor.organizationId,
				envelopeId,
				email: recipient.email,
				name: recipient.name,
				role: recipient.role,
				locale: recipient.locale,
				routingOrder: recipient.routingOrder,
				status: 'pending'
			})
		);
		const auditEventId: string = this.#newId();
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

function assertReadyInput(
	expectedGeneration: number,
	recipients: readonly ReadyRecipientInput[]
): void {
	if (
		!Number.isSafeInteger(expectedGeneration) ||
		expectedGeneration < 1 ||
		expectedGeneration > 2_147_483_647
	) {
		throw new InvalidRecipientGraphError('Expected generation is outside the supported range');
	}
	if (recipients.length < 1 || recipients.length > 50) {
		throw new InvalidRecipientGraphError(
			'Recipient graphs must contain between 1 and 50 recipients'
		);
	}
	const emails: Set<string> = new Set<string>();
	for (const recipient of recipients) {
		if (!isEmail(recipient.email) || recipient.email.length > 320) {
			throw new InvalidRecipientGraphError('Recipient email is invalid');
		}
		if (recipient.name.length < 1 || recipient.name.length > 200) {
			throw new InvalidRecipientGraphError('Recipient name is invalid');
		}
		if (!recipientRoles.includes(recipient.role)) {
			throw new InvalidRecipientGraphError('Recipient role is invalid');
		}
		if (recipient.role === 'prefill') {
			throw new InvalidRecipientGraphError(
				'Prefill recipients are not supported in ready recipient graphs'
			);
		}
		if (recipient.locale !== 'en' && recipient.locale !== 'ja') {
			throw new InvalidRecipientGraphError('Recipient locale is invalid');
		}
		if (
			!Number.isSafeInteger(recipient.routingOrder) ||
			recipient.routingOrder < 1 ||
			recipient.routingOrder > 1000
		) {
			throw new InvalidRecipientGraphError('Recipient routing order is invalid');
		}
		if (emails.has(recipient.email)) {
			throw new InvalidRecipientGraphError('Recipient email addresses must be unique');
		}
		emails.add(recipient.email);
	}
	const actionableRoutingOrders: Set<number> = new Set<number>(
		recipients
			.filter((recipient: ReadyRecipientInput): boolean =>
				isActionableRecipientRole(recipient.role)
			)
			.map((recipient: ReadyRecipientInput): number => recipient.routingOrder)
	);
	if (actionableRoutingOrders.size === 0) {
		throw new InvalidRecipientGraphError('At least one signer or approver is required');
	}
	if (
		recipients.some(
			(recipient: ReadyRecipientInput): boolean =>
				recipient.role === 'viewer' && !actionableRoutingOrders.has(recipient.routingOrder)
		)
	) {
		throw new InvalidRecipientGraphError(
			'Every viewer routing order must include a signer or approver'
		);
	}
}

function isEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
