import { describe, expect, it } from 'vitest';
import type { Envelope } from '$lib/domain/envelope';
import type {
	EnvelopeReopenStore,
	PublishReopenedEnvelopeCommand,
	ReopenCommandKey,
	ReopenPreparation
} from '$lib/ports/envelope-reopen-store';
import { isUuidV7 } from '$lib/ids/uuid-v7';
import { EnvelopeReopenApplication, InvalidReopenCommandError } from './reopen';

const envelope: Envelope = {
	id: '01900000-0000-7000-8000-000000000001',
	createdByUserId: 'user-1',
	title: 'Agreement',
	status: 'ready',
	repositoryGeneration: 2,
	repositoryHead: '0123456789abcdef0123456789abcdef01234567',
	repositoryArchiveKey: 'internal',
	repositoryArchiveSha256: 'a'.repeat(64),
	sentCommitSha: null,
	fieldGeneration: 1,
	createdAt: '2026-09-11T00:00:00.000Z',
	updatedAt: '2026-09-11T00:01:00.000Z'
};

const actor = {
	id: 'user-1',
	createdByUserId: 'user-1'
} as const;

const readyAuditEventId: string = '01900000-0000-7000-8000-000000000099';

class CapturingStore implements EnvelopeReopenStore {
	readonly commands: PublishReopenedEnvelopeCommand[] = [];
	readonly keys: ReopenCommandKey[] = [];

	async prepareReopen(key: ReopenCommandKey): Promise<ReopenPreparation> {
		this.keys.push(key);
		return { outcome: 'ready', envelope, auditHead: { sequence: 4, eventHash: 'b'.repeat(64) } };
	}

	async publishReopen(command: PublishReopenedEnvelopeCommand) {
		this.commands.push(command);
		return {
			outcome: 'published' as const,
			result: {
				envelopeId: command.envelopeId,
				status: 'draft' as const,
				generation: command.expectedGeneration,
				fieldGeneration: command.expectedFieldGeneration + 1,
				updatedAt: command.updatedAt,
				auditEventId: command.auditEventId
			}
		};
	}
}

describe('EnvelopeReopenApplication', () => {
	it('fingerprints generation, field generation, and the latest ready anchor before publishing', async () => {
		const store: CapturingStore = new CapturingStore();
		const application: EnvelopeReopenApplication = new EnvelopeReopenApplication(store);
		const result = await application.reopen(actor, envelope.id, {
			idempotencyKey: 'reopen-1',
			expectedGeneration: 2,
			expectedFieldGeneration: 1,
			expectedReadyAuditEventId: readyAuditEventId
		});

		expect(result.outcome).toBe('published');
		expect(store.keys[0]).toMatchObject({
			envelopeId: envelope.id,
			actorType: 'user',
			actorId: actor.id,
			idempotencyKey: 'reopen-1'
		});
		expect(store.keys[0].requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(store.commands[0]).toMatchObject({
			expectedCommitSha: envelope.repositoryHead,
			expectedAuditSequence: 4,
			previousAuditHash: 'b'.repeat(64),
			expectedReadyAuditEventId: readyAuditEventId
		});
		expect(isUuidV7(store.commands[0].auditEventId)).toBe(true);
		expect(JSON.parse(store.commands[0].auditPayloadJson)).toEqual({
			commitSha: envelope.repositoryHead,
			generation: 2,
			fieldGeneration: 2,
			readyAuditEventId
		});
		expect(store.commands[0].auditPayloadJson).not.toContain('@example.com');
		if (result.outcome === 'published') {
			expect(result.result.fieldGeneration).toBe(2);
			expect(result.result.status).toBe('draft');
		}
	});

	it('rejects an expected generation outside the supported range', async () => {
		const application: EnvelopeReopenApplication = new EnvelopeReopenApplication(
			new CapturingStore()
		);
		await expect(
			application.reopen(actor, envelope.id, {
				idempotencyKey: 'reopen-bad',
				expectedGeneration: 0,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: readyAuditEventId
			})
		).rejects.toBeInstanceOf(InvalidReopenCommandError);
		await expect(
			application.reopen(actor, envelope.id, {
				idempotencyKey: 'reopen-bad-field',
				expectedGeneration: 1,
				expectedFieldGeneration: -1,
				expectedReadyAuditEventId: readyAuditEventId
			})
		).rejects.toBeInstanceOf(InvalidReopenCommandError);
		await expect(
			application.reopen(actor, envelope.id, {
				idempotencyKey: 'reopen-bad-field-max',
				expectedGeneration: 1,
				expectedFieldGeneration: 2_147_483_647,
				expectedReadyAuditEventId: readyAuditEventId
			})
		).rejects.toBeInstanceOf(InvalidReopenCommandError);
	});
});
