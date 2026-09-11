import { describe, expect, it, vi } from 'vitest';
import type { Envelope, Recipient } from '$lib/domain/envelope';
import type {
	EnvelopeSendStore,
	PublishSentEnvelopeCommand,
	SendCommandKey,
	SendPreparation
} from '$lib/ports/envelope-send-store';
import type {
	CapabilitySealContext,
	RecipientCapabilitySealer
} from '$lib/security/delivery-capability';
import { EnvelopeSendApplication } from './send';

const envelope: Envelope = {
	id: '01900000-0000-7000-8000-000000000001',
	organizationId: '01900000-0000-7000-8000-000000000002',
	title: 'Agreement',
	status: 'ready',
	repositoryGeneration: 2,
	repositoryHead: '0123456789abcdef0123456789abcdef01234567',
	repositoryArchiveKey: 'internal',
	repositoryArchiveSha256: 'a'.repeat(64),
	sentCommitSha: null,
	createdAt: '2026-09-11T00:00:00.000Z',
	updatedAt: '2026-09-11T00:01:00.000Z'
};
const recipients: readonly Recipient[] = [
	{
		id: 'r1',
		organizationId: envelope.organizationId,
		envelopeId: envelope.id,
		email: 'a@example.com',
		name: 'A',
		role: 'signer',
		locale: 'en',
		routingOrder: 1,
		status: 'pending'
	},
	{
		id: 'r2',
		organizationId: envelope.organizationId,
		envelopeId: envelope.id,
		email: 'b@example.com',
		name: 'B',
		role: 'approver',
		locale: 'ja',
		routingOrder: 2,
		status: 'pending'
	},
	{
		id: 'r3',
		organizationId: envelope.organizationId,
		envelopeId: envelope.id,
		email: 'cc@example.com',
		name: 'CC',
		role: 'cc',
		locale: 'en',
		routingOrder: 3,
		status: 'pending'
	}
];
const actor = {
	id: 'user-1',
	organizationId: envelope.organizationId,
	organizationName: 'Workspace'
} as const;
const readyEventId: string = '01900000-0000-7000-8000-000000000099';

class CapturingStore implements EnvelopeSendStore {
	readonly keys: SendCommandKey[] = [];
	readonly commands: PublishSentEnvelopeCommand[] = [];
	async prepareSend(key: SendCommandKey): Promise<SendPreparation> {
		this.keys.push(key);
		return {
			outcome: 'ready',
			envelope,
			recipients,
			auditHead: {
				eventId: readyEventId,
				eventType: 'envelope.ready',
				sequence: 4,
				eventHash: 'b'.repeat(64)
			}
		};
	}
	async publishSend(command: PublishSentEnvelopeCommand) {
		this.commands.push(command);
		return {
			outcome: 'published' as const,
			result: {
				envelopeId: command.envelopeId,
				status: 'sent' as const,
				generation: command.expectedGeneration,
				commitSha: command.commitSha,
				readyAuditEventId: command.expectedReadyAuditEventId,
				queuedDeliveryCount: command.deliveries.filter(
					(delivery): boolean => delivery.status === 'pending'
				).length,
				reservedCapabilityCount: command.deliveries.length,
				initialCapabilityExpiresAt: command.initialCapabilityExpiresAt,
				updatedAt: command.updatedAt,
				auditEventId: command.auditEventId
			}
		};
	}
}

const sealer: RecipientCapabilitySealer = {
	seal: vi.fn(async (token: string, context: CapabilitySealContext) => ({
		sealedCapability: `sealed:${context.recipientId}:${token.slice(0, 8)}`,
		sealingKeyId: 'key-1',
		sealedCapabilitySha256: 'c'.repeat(64)
	}))
};

describe('EnvelopeSendApplication', () => {
	it('reserves non-CC capabilities but queues only the first routing group', async () => {
		const store: CapturingStore = new CapturingStore();
		const result = await new EnvelopeSendApplication(store, sealer).send(actor, envelope.id, {
			idempotencyKey: 'send-1',
			expectedGeneration: 2,
			expectedReadyAuditEventId: readyEventId
		});
		expect(result.outcome).toBe('published');
		expect(store.commands[0].deliveries).toHaveLength(2);
		expect(
			store.commands[0].deliveries.map((delivery) => ({
				recipientId: delivery.recipientId,
				status: delivery.status,
				expires: delivery.capabilityExpiresAt !== null,
				available: delivery.availableAt !== null
			}))
		).toEqual([
			{ recipientId: 'r1', status: 'pending', expires: true, available: true },
			{ recipientId: 'r2', status: 'blocked', expires: false, available: false }
		]);
		expect(store.commands[0].expectedReadyAuditEventId).toBe(readyEventId);
		expect(JSON.parse(store.commands[0].auditPayloadJson)).toMatchObject({
			readyAuditEventId: readyEventId,
			initialRoutingOrder: 1,
			queuedDeliveryCount: 1,
			reservedCapabilityCount: 2
		});
		expect(store.commands[0].auditPayloadJson).not.toContain('@example.com');
		expect(store.commands[0].auditPayloadJson).not.toContain('skr1_');
	});

	it('returns preparation failures without creating secrets', async () => {
		const blocked: EnvelopeSendStore = {
			prepareSend: vi.fn(async (): Promise<SendPreparation> => ({ outcome: 'audit_conflict' })),
			publishSend: vi.fn()
		};
		const localSealer: RecipientCapabilitySealer = { seal: vi.fn() };
		const result = await new EnvelopeSendApplication(blocked, localSealer).send(
			actor,
			envelope.id,
			{
				idempotencyKey: 'send-1',
				expectedGeneration: 2,
				expectedReadyAuditEventId: readyEventId
			}
		);
		expect(result).toEqual({ outcome: 'audit_conflict' });
		expect(localSealer.seal).not.toHaveBeenCalled();
		expect(blocked.publishSend).not.toHaveBeenCalled();
	});
});
