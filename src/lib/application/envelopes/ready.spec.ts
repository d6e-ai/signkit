import { describe, expect, it, vi } from 'vitest';
import type { Envelope } from '$lib/domain/envelope';
import type {
	EnvelopeReadyStore,
	PublishReadyEnvelopeCommand,
	ReadyCommandKey,
	ReadyPreparation
} from '$lib/ports/envelope-ready-store';
import { EnvelopeReadyApplication } from './ready';

const envelope: Envelope = {
	id: '01900000-0000-7000-8000-000000000001',
	organizationId: '01900000-0000-7000-8000-000000000002',
	title: 'Agreement',
	status: 'draft',
	repositoryGeneration: 2,
	repositoryHead: '0123456789abcdef0123456789abcdef01234567',
	repositoryArchiveKey: 'internal',
	repositoryArchiveSha256: 'a'.repeat(64),
	sentCommitSha: null,
	createdAt: '2026-09-11T00:00:00.000Z',
	updatedAt: '2026-09-11T00:01:00.000Z'
};

const actor = {
	id: 'user-1',
	organizationId: envelope.organizationId,
	organizationName: 'Workspace'
} as const;

class CapturingStore implements EnvelopeReadyStore {
	readonly commands: PublishReadyEnvelopeCommand[] = [];
	readonly keys: ReadyCommandKey[] = [];

	async prepareReady(key: ReadyCommandKey): Promise<ReadyPreparation> {
		this.keys.push(key);
		return { outcome: 'ready', envelope, auditHead: { sequence: 3, eventHash: 'b'.repeat(64) } };
	}

	async publishReady(command: PublishReadyEnvelopeCommand) {
		this.commands.push(command);
		return {
			outcome: 'published' as const,
			result: {
				envelopeId: command.envelopeId,
				status: 'ready' as const,
				generation: command.expectedGeneration,
				commitSha: command.expectedCommitSha,
				recipients: command.recipients,
				updatedAt: command.updatedAt,
				auditEventId: command.auditEventId
			}
		};
	}
}

describe('EnvelopeReadyApplication', () => {
	it('canonicalizes the complete recipient graph before fingerprinting and publishing', async () => {
		const store: CapturingStore = new CapturingStore();
		const application: EnvelopeReadyApplication = new EnvelopeReadyApplication(store);
		const result = await application.ready(actor, envelope.id, {
			idempotencyKey: 'ready-1',
			expectedGeneration: 2,
			recipients: [
				{ email: ' B@example.com ', name: ' Bob ', role: 'viewer', locale: 'en', routingOrder: 2 },
				{ email: 'A@Example.com', name: ' Alice ', role: 'signer', locale: 'ja', routingOrder: 1 }
			]
		});

		expect(result.outcome).toBe('published');
		expect(store.keys[0]).toMatchObject({
			organizationId: envelope.organizationId,
			envelopeId: envelope.id,
			actorId: actor.id,
			idempotencyKey: 'ready-1',
			requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/)
		});
		expect(store.commands[0].recipients).toMatchObject([
			{ email: 'a@example.com', name: 'Alice', role: 'signer', routingOrder: 1 },
			{ email: 'b@example.com', name: 'Bob', role: 'viewer', routingOrder: 2 }
		]);
		expect(store.commands[0]).toMatchObject({
			expectedCommitSha: envelope.repositoryHead,
			expectedAuditSequence: 3,
			previousAuditHash: 'b'.repeat(64),
			auditEventHash: expect.stringMatching(/^[0-9a-f]{64}$/),
			auditEventId: expect.stringMatching(/^[0-9a-f-]{36}$/)
		});
		expect(JSON.parse(store.commands[0].auditPayloadJson)).toEqual({
			commitSha: envelope.repositoryHead,
			generation: 2,
			recipients: store.commands[0].recipients.map((recipient) => ({
				id: recipient.id,
				role: recipient.role,
				routingOrder: recipient.routingOrder
			}))
		});
		expect(store.commands[0].auditPayloadJson).not.toContain('@example.com');
	});

	it('makes semantically identical recipient ordering share a request fingerprint', async () => {
		const first: CapturingStore = new CapturingStore();
		const second: CapturingStore = new CapturingStore();
		const recipients = [
			{
				email: 'a@example.com',
				name: 'Alice',
				role: 'signer' as const,
				locale: 'en' as const,
				routingOrder: 1
			},
			{
				email: 'b@example.com',
				name: 'Bob',
				role: 'cc' as const,
				locale: 'ja' as const,
				routingOrder: 2
			}
		];
		await new EnvelopeReadyApplication(first).ready(actor, envelope.id, {
			idempotencyKey: 'same-key',
			expectedGeneration: 2,
			recipients
		});
		await new EnvelopeReadyApplication(second).ready(actor, envelope.id, {
			idempotencyKey: 'same-key',
			expectedGeneration: 2,
			recipients: [...recipients].reverse()
		});

		expect(first.keys[0].requestFingerprint).toBe(second.keys[0].requestFingerprint);
		expect(first.commands[0].recipients.map((recipient) => recipient.id)).toEqual(
			second.commands[0].recipients.map((recipient) => recipient.id)
		);
	});

	it('returns preparation conflicts without attempting publication', async () => {
		const store: EnvelopeReadyStore = {
			prepareReady: vi.fn(async (): Promise<ReadyPreparation> => ({
				outcome: 'generation_conflict'
			})),
			publishReady: vi.fn()
		};
		const result = await new EnvelopeReadyApplication(store).ready(actor, envelope.id, {
			idempotencyKey: 'ready-1',
			expectedGeneration: 1,
			recipients: [
				{ email: 'a@example.com', name: 'Alice', role: 'signer', locale: 'en', routingOrder: 1 }
			]
		});

		expect(result).toEqual({ outcome: 'generation_conflict' });
		expect(store.publishReady).not.toHaveBeenCalled();
	});
});
