import type { EnvelopeRequestActor } from './model';
import type {
	EnvelopeVoidStore,
	PublishVoidedEnvelopeCommand,
	PublishVoidedEnvelopeResult,
	PublishedVoidedEnvelope,
	VoidCommandKey,
	VoidPreparation,
	VoidableEnvelopeStatus
} from '$lib/ports/envelope-void-store';

const MAX_AUDIT_ATTEMPTS: number = 3;

export interface VoidEnvelopeInput {
	idempotencyKey: string;
	expectedStatus: VoidableEnvelopeStatus;
	expectedGeneration: number;
}

export type VoidEnvelopeResult =
	| { outcome: 'published' | 'replayed'; result: PublishedVoidedEnvelope }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'not_voidable' }
	| { outcome: 'status_conflict' }
	| { outcome: 'generation_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'delivery_in_flight' }
	| { outcome: 'integrity_error' };

export interface EnvelopeVoidApplicationPort {
	voidEnvelope(
		actor: EnvelopeRequestActor,
		envelopeId: string,
		input: VoidEnvelopeInput
	): Promise<VoidEnvelopeResult>;
}

export class EnvelopeVoidApplication implements EnvelopeVoidApplicationPort {
	constructor(
		private readonly store: EnvelopeVoidStore,
		private readonly now: () => Date = (): Date => new Date()
	) {}

	async voidEnvelope(
		actor: EnvelopeRequestActor,
		envelopeId: string,
		input: VoidEnvelopeInput
	): Promise<VoidEnvelopeResult> {
		assertExpectedGeneration(input.expectedGeneration);
		const requestFingerprint: string = await sha256(
			JSON.stringify({
				expectedStatus: input.expectedStatus,
				expectedGeneration: input.expectedGeneration
			})
		);
		const key: VoidCommandKey = {
			organizationId: actor.organizationId,
			envelopeId,
			actorType: 'user',
			actorId: actor.id,
			idempotencyKey: input.idempotencyKey,
			requestFingerprint,
			expectedStatus: input.expectedStatus,
			expectedGeneration: input.expectedGeneration
		};

		for (let attempt: number = 0; attempt < MAX_AUDIT_ATTEMPTS; attempt += 1) {
			const preparation: VoidPreparation = await this.store.prepareVoid(key);
			if (preparation.outcome !== 'ready') return preparation;
			if (
				preparation.previousStatus !== input.expectedStatus ||
				preparation.generation !== input.expectedGeneration
			) {
				return { outcome: 'integrity_error' };
			}

			const voidedAt: string = this.now().toISOString();
			const revokedRecipientIds: readonly string[] = sortedRecipientIds(
				preparation.revokedRecipientIds
			);
			const auditEventId: string = await deterministicUuid(
				[
					'signkit-envelope-voided-event-v1',
					actor.organizationId,
					envelopeId,
					actor.id,
					input.idempotencyKey
				].join('\u0000')
			);
			const auditPayloadJson: string = JSON.stringify({
				previousStatus: preparation.previousStatus,
				generation: preparation.generation,
				repositoryHead: preparation.repositoryHead,
				sentCommitSha: preparation.sentCommitSha,
				voidedAt,
				revokedCapabilities: {
					reason: 'envelope_voided',
					recipientIds: revokedRecipientIds
				}
			});
			const auditEventHash: string = await sha256(
				JSON.stringify({
					actorId: actor.id,
					envelopeId,
					eventType: 'envelope.voided',
					occurredAt: voidedAt,
					organizationId: actor.organizationId,
					payload: JSON.parse(auditPayloadJson) as unknown,
					previousHash: preparation.auditHead.eventHash
				})
			);
			const command: PublishVoidedEnvelopeCommand = {
				...key,
				updatedAt: voidedAt,
				expectedAuditSequence: preparation.auditHead.sequence,
				previousAuditHash: preparation.auditHead.eventHash,
				repositoryHead: preparation.repositoryHead,
				sentCommitSha: preparation.sentCommitSha,
				revokedRecipientIds,
				auditEventId,
				auditEventHash,
				auditPayloadJson
			};
			const published: PublishVoidedEnvelopeResult = await this.store.publishVoid(command);
			if (published.outcome === 'audit_conflict' && attempt + 1 < MAX_AUDIT_ATTEMPTS) continue;
			return published;
		}

		throw new Error('Envelope void retry loop exhausted without a terminal result');
	}
}

export class InvalidVoidCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidVoidCommandError';
	}
}

function assertExpectedGeneration(expectedGeneration: number): void {
	if (
		!Number.isSafeInteger(expectedGeneration) ||
		expectedGeneration < 0 ||
		expectedGeneration > 2_147_483_647
	) {
		throw new InvalidVoidCommandError('Expected generation is outside the supported range');
	}
}

function sortedRecipientIds(values: readonly string[]): readonly string[] {
	return [...values].sort((left: string, right: string): number => left.localeCompare(right));
}

async function sha256(value: string): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value)
	);
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
