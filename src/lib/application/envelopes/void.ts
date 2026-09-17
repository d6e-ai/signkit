import { hashAuditEventV3 } from '$lib/domain/audit';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import type { EnvelopeRequestActor } from './model';
import { envelopeActorType } from './model';
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
		private readonly now: () => Date = (): Date => new Date(),
		private readonly newId: UuidV7Generator = newUuidV7
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
		const actorType: 'user' | 'agent' = envelopeActorType(actor);
		const key: VoidCommandKey = {
			envelopeId,
			actorType,
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
			// An audit-head retry is a fresh unpublished attempt, so it mints a new
			// event identifier alongside its new timestamp and chain position.
			const auditEventId: string = this.newId();
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
			const auditEventHash: string = await hashAuditEventV3(
				{
					sequence: preparation.auditHead.sequence + 1,
					eventType: 'envelope.voided',
					actorType,
					actorId: actor.id,
					occurredAt: voidedAt,
					payload: JSON.parse(auditPayloadJson) as unknown,
					previousHash: preparation.auditHead.eventHash
				},
				{ envelopeId }
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
