import { hashAuditEventV3 } from '$lib/domain/audit';
import { fingerprintReopenRequest, reopenAuditPayloadJson } from '$lib/domain/commands/reopen';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import type { Envelope } from '$lib/domain/envelope';
import type {
	EnvelopeReopenStore,
	PublishReopenedEnvelopeCommand,
	PublishReopenedEnvelopeResult,
	PublishedReopenedEnvelope,
	ReopenPreparation
} from '$lib/ports/envelope-reopen-store';
import type { EnvelopeRequestActor } from './model';
import { envelopeActorType } from './model';

export interface ReopenEnvelopeInput {
	idempotencyKey: string;
	expectedGeneration: number;
	expectedFieldGeneration: number;
	expectedReadyAuditEventId: string;
}

export type ReopenEnvelopeResult =
	| { outcome: 'published' | 'replayed'; result: PublishedReopenedEnvelope }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'not_ready' }
	| { outcome: 'generation_conflict' }
	| { outcome: 'field_generation_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'integrity_error' };

export interface EnvelopeReopenApplicationPort {
	reopen(
		actor: EnvelopeRequestActor,
		envelopeId: string,
		input: ReopenEnvelopeInput
	): Promise<ReopenEnvelopeResult>;
}

export class InvalidReopenCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidReopenCommandError';
	}
}

export class EnvelopeReopenApplication implements EnvelopeReopenApplicationPort {
	readonly #store: EnvelopeReopenStore;
	readonly #newId: UuidV7Generator;

	constructor(store: EnvelopeReopenStore, newId: UuidV7Generator = newUuidV7) {
		this.#store = store;
		this.#newId = newId;
	}

	async reopen(
		actor: EnvelopeRequestActor,
		envelopeId: string,
		input: ReopenEnvelopeInput
	): Promise<ReopenEnvelopeResult> {
		assertReopenInput(input);
		const requestFingerprint: string = await fingerprintReopenRequest({
			expectedGeneration: input.expectedGeneration,
			expectedFieldGeneration: input.expectedFieldGeneration,
			expectedReadyAuditEventId: input.expectedReadyAuditEventId
		});
		const actorType: 'user' | 'agent' = envelopeActorType(actor);
		const key = {
			envelopeId,
			actorType,
			actorId: actor.id,
			idempotencyKey: input.idempotencyKey,
			requestFingerprint
		};
		const preparation: ReopenPreparation = await this.#store.prepareReopen(
			key,
			input.expectedGeneration,
			input.expectedFieldGeneration,
			input.expectedReadyAuditEventId
		);
		if (preparation.outcome !== 'ready') return preparation;

		const updatedAt: string = new Date().toISOString();
		const auditEventId: string = this.#newId();
		const fieldGeneration: number = input.expectedFieldGeneration + 1;
		const auditPayloadJson: string = reopenAuditPayloadJson({
			commitSha: requiredHead(preparation.envelope),
			generation: preparation.envelope.repositoryGeneration,
			fieldGeneration,
			readyAuditEventId: input.expectedReadyAuditEventId
		});
		const auditEventHash: string = await hashAuditEventV3(
			{
				sequence: preparation.auditHead.sequence + 1,
				eventType: 'envelope.reopened',
				actorType,
				actorId: actor.id,
				occurredAt: updatedAt,
				payload: JSON.parse(auditPayloadJson) as unknown,
				previousHash: preparation.auditHead.eventHash
			},
			{ envelopeId }
		);
		const command: PublishReopenedEnvelopeCommand = {
			...key,
			expectedGeneration: input.expectedGeneration,
			expectedFieldGeneration: input.expectedFieldGeneration,
			expectedReadyAuditEventId: input.expectedReadyAuditEventId,
			expectedCommitSha: requiredHead(preparation.envelope),
			updatedAt,
			expectedAuditSequence: preparation.auditHead.sequence,
			previousAuditHash: preparation.auditHead.eventHash,
			auditEventId,
			auditEventHash,
			auditPayloadJson
		};
		const published: PublishReopenedEnvelopeResult = await this.#store.publishReopen(command);
		return published;
	}
}

function assertReopenInput(input: ReopenEnvelopeInput): void {
	if (
		!Number.isSafeInteger(input.expectedGeneration) ||
		input.expectedGeneration < 1 ||
		input.expectedGeneration > 2_147_483_647
	) {
		throw new InvalidReopenCommandError('Expected generation is outside the supported range');
	}
	if (
		!Number.isSafeInteger(input.expectedFieldGeneration) ||
		input.expectedFieldGeneration < 0 ||
		input.expectedFieldGeneration > 2_147_483_646
	) {
		throw new InvalidReopenCommandError('Expected field generation is outside the supported range');
	}
	if (input.expectedReadyAuditEventId.length === 0) {
		throw new InvalidReopenCommandError('Expected ready audit event id is required');
	}
}

function requiredHead(envelope: Envelope): string {
	if (envelope.repositoryHead === null) {
		throw new Error('Reopen preparation returned an empty revision');
	}
	return envelope.repositoryHead;
}
