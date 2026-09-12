import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
	EnvelopeVoidStore,
	PublishVoidedEnvelopeCommand,
	PublishVoidedEnvelopeResult,
	VoidCommandKey,
	VoidPreparation
} from '$lib/ports/envelope-void-store';
import { EnvelopeVoidApplication, InvalidVoidCommandError, type VoidEnvelopeInput } from './void';

const actor = {
	id: 'user-1',
	organizationId: '01900000-0000-7000-8000-000000000002',
	organizationName: 'Workspace'
};
const envelopeId: string = '01900000-0000-7000-8000-000000000001';
const input: VoidEnvelopeInput = {
	idempotencyKey: 'void-1',
	expectedStatus: 'sent',
	expectedGeneration: 3
};
const ready: Extract<VoidPreparation, { outcome: 'ready' }> = {
	outcome: 'ready',
	previousStatus: 'sent',
	generation: 3,
	repositoryHead: '0123456789abcdef0123456789abcdef01234567',
	sentCommitSha: '0123456789abcdef0123456789abcdef01234567',
	auditHead: { sequence: 8, eventHash: 'hash-8' },
	revokedRecipientIds: ['recipient-z', 'recipient-a']
};

function store(preparations: readonly VoidPreparation[], publishOutcomes: readonly string[] = []) {
	const remainingPreparations: VoidPreparation[] = [...preparations];
	const remainingPublishOutcomes: string[] = [...publishOutcomes];
	const prepareVoid = vi.fn(async (_key: VoidCommandKey): Promise<VoidPreparation> => {
		void _key;
		const preparation: VoidPreparation | undefined = remainingPreparations.shift();
		if (preparation === undefined) throw new Error('Unexpected prepareVoid call');
		return preparation;
	});
	const publishVoid = vi.fn(
		async (command: PublishVoidedEnvelopeCommand): Promise<PublishVoidedEnvelopeResult> => {
			const outcome: string = remainingPublishOutcomes.shift() ?? 'published';
			if (outcome === 'audit_conflict') return { outcome: 'audit_conflict' as const };
			return {
				outcome: 'published' as const,
				result: {
					envelopeId: command.envelopeId,
					status: 'voided' as const,
					previousStatus: command.expectedStatus,
					generation: command.expectedGeneration,
					voidedAt: command.updatedAt,
					revokedCapabilityCount: command.revokedRecipientIds.length,
					auditEventId: command.auditEventId
				}
			};
		}
	);
	return { prepareVoid, publishVoid } satisfies EnvelopeVoidStore;
}

describe('EnvelopeVoidApplication', () => {
	it('publishes a deterministic, PII-free void audit event with sorted revocation evidence', async () => {
		const applicationStore = store([ready]);
		const application = new EnvelopeVoidApplication(
			applicationStore,
			(): Date => new Date('2026-09-12T01:02:03.000Z')
		);

		const result = await application.voidEnvelope(actor, envelopeId, input);

		expect(result).toMatchObject({
			outcome: 'published',
			result: { envelopeId, status: 'voided', generation: 3 }
		});
		const key = applicationStore.prepareVoid.mock.calls[0][0];
		expect(key).toEqual({
			organizationId: actor.organizationId,
			envelopeId,
			actorType: 'user',
			actorId: actor.id,
			idempotencyKey: input.idempotencyKey,
			expectedStatus: 'sent',
			expectedGeneration: 3,
			requestFingerprint: sha256(JSON.stringify({ expectedStatus: 'sent', expectedGeneration: 3 }))
		});
		const command = applicationStore.publishVoid.mock.calls[0][0];
		expect(command.revokedRecipientIds).toEqual(['recipient-a', 'recipient-z']);
		expect(command.repositoryHead).toBe(ready.repositoryHead);
		expect(command.sentCommitSha).toBe(ready.sentCommitSha);
		expect(command.auditEventId).toBe(
			deterministicUuid(
				[
					'signkit-envelope-voided-event-v1',
					actor.organizationId,
					envelopeId,
					actor.id,
					input.idempotencyKey
				].join('\u0000')
			)
		);
		expect(JSON.parse(command.auditPayloadJson)).toEqual({
			previousStatus: 'sent',
			generation: 3,
			repositoryHead: ready.repositoryHead,
			sentCommitSha: ready.sentCommitSha,
			voidedAt: '2026-09-12T01:02:03.000Z',
			revokedCapabilities: {
				reason: 'envelope_voided',
				recipientIds: ['recipient-a', 'recipient-z']
			}
		});
		expect(command.auditEventHash).toBe(
			sha256(
				JSON.stringify({
					actorId: actor.id,
					envelopeId,
					eventType: 'envelope.voided',
					occurredAt: command.updatedAt,
					organizationId: actor.organizationId,
					payload: JSON.parse(command.auditPayloadJson),
					previousHash: ready.auditHead.eventHash
				})
			)
		);
	});

	it.each([
		'idempotency_conflict',
		'not_found',
		'not_voidable',
		'status_conflict',
		'generation_conflict',
		'delivery_in_flight',
		'integrity_error'
	] as const)('returns %s preparations without publishing', async (outcome) => {
		const applicationStore = store([{ outcome }]);
		const result = await new EnvelopeVoidApplication(applicationStore).voidEnvelope(
			actor,
			envelopeId,
			input
		);
		expect(result).toEqual({ outcome });
		expect(applicationStore.publishVoid).not.toHaveBeenCalled();
	});

	it('retries an audit-head race with a fresh timestamp and the same deterministic event ID', async () => {
		const secondReady: Extract<VoidPreparation, { outcome: 'ready' }> = {
			...ready,
			auditHead: { sequence: 9, eventHash: 'hash-9' }
		};
		const applicationStore = store([ready, secondReady], ['audit_conflict', 'published']);
		const times: Date[] = [
			new Date('2026-09-12T01:02:03.000Z'),
			new Date('2026-09-12T01:02:04.000Z')
		];
		const application = new EnvelopeVoidApplication(
			applicationStore,
			(): Date => times.shift() as Date
		);

		const result = await application.voidEnvelope(actor, envelopeId, input);

		expect(result.outcome).toBe('published');
		expect(applicationStore.prepareVoid).toHaveBeenCalledTimes(2);
		expect(applicationStore.publishVoid).toHaveBeenCalledTimes(2);
		const [first, second] = applicationStore.publishVoid.mock.calls.map((call) => call[0]);
		expect(second.auditEventId).toBe(first.auditEventId);
		expect(second.updatedAt).not.toBe(first.updatedAt);
		expect(second.previousAuditHash).toBe('hash-9');
	});

	it('fails closed when a ready preparation contradicts the requested CAS', async () => {
		const applicationStore = store([{ ...ready, generation: 4 }]);
		await expect(
			new EnvelopeVoidApplication(applicationStore).voidEnvelope(actor, envelopeId, input)
		).resolves.toEqual({ outcome: 'integrity_error' });
		expect(applicationStore.publishVoid).not.toHaveBeenCalled();
	});

	it.each([-1, 2_147_483_648, 1.5, Number.NaN])(
		'rejects an invalid expected generation (%s)',
		async (expectedGeneration) => {
			const applicationStore = store([ready]);
			await expect(
				new EnvelopeVoidApplication(applicationStore).voidEnvelope(actor, envelopeId, {
					...input,
					expectedGeneration
				})
			).rejects.toBeInstanceOf(InvalidVoidCommandError);
			expect(applicationStore.prepareVoid).not.toHaveBeenCalled();
		}
	);
});

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function deterministicUuid(value: string): string {
	const digest: string = sha256(value);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(
		17,
		20
	)}-${digest.slice(20, 32)}`;
}
