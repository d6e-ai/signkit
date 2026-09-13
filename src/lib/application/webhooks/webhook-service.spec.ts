import { describe, expect, it, vi } from 'vitest';
import { WebhookApplication } from './webhook-service';
import type {
	CreateWebhookEndpointCommand,
	WebhookEndpointMetadata,
	WebhookStore
} from '$lib/ports/webhook-store';
import { WebhookTargetRejectedError } from '$lib/security/webhook-url';

const ORG: string = 'org-1';
const ENDPOINT_ID: string = '01900000-0000-7000-8000-000000000401';
const ACTOR_ID: string = 'user-1';

function metadata(overrides: Partial<WebhookEndpointMetadata> = {}): WebhookEndpointMetadata {
	return {
		id: ENDPOINT_ID,
		organizationId: ORG,
		url: 'https://hooks.example.com/signkit',
		description: null,
		status: 'active',
		events: ['envelope.completed'],
		secretPrefix: 'skwh1_abcdefgh',
		createdAt: '2026-09-13T00:00:00.000Z',
		createdByUserId: ACTOR_ID,
		revokedAt: null,
		revokedByUserId: null,
		...overrides
	};
}

function store(overrides: Partial<WebhookStore> = {}): WebhookStore {
	return {
		createEndpoint: vi.fn(),
		listEndpoints: vi.fn(),
		getEndpoint: vi.fn(),
		revokeEndpoint: vi.fn(),
		claimPendingDeliveries: vi.fn(async () => []),
		readClaimedDelivery: vi.fn(),
		completeDelivery: vi.fn(),
		failDelivery: vi.fn(),
		listDeliveryLogs: vi.fn(),
		...overrides
	};
}

describe('WebhookApplication.createEndpoint', () => {
	it('rejects a non-HTTPS target before persistence', async () => {
		const persistence = store();
		const app = new WebhookApplication(persistence, { newId: () => ENDPOINT_ID });
		await expect(
			app.createEndpoint(
				{ id: ACTOR_ID, organizationId: ORG },
				{
					idempotencyKey: 'wh-1',
					url: 'http://hooks.example.com/signkit',
					description: null,
					events: ['envelope.completed']
				}
			)
		).rejects.toBeInstanceOf(WebhookTargetRejectedError);
		expect(persistence.createEndpoint).not.toHaveBeenCalled();
	});

	it('creates an endpoint and returns the secret once', async () => {
		const persistence = store({
			createEndpoint: vi.fn(async (command: CreateWebhookEndpointCommand) => ({
				outcome: 'created' as const,
				endpoint: metadata({
					id: command.id,
					url: command.url,
					description: command.description,
					secretPrefix: command.secretPrefix,
					events: JSON.parse(command.eventsJson) as string[]
				})
			}))
		});
		const app = new WebhookApplication(persistence, { newId: () => ENDPOINT_ID });
		const result = await app.createEndpoint(
			{ id: ACTOR_ID, organizationId: ORG },
			{
				idempotencyKey: 'wh-1',
				url: 'https://hooks.example.com/signkit',
				description: ' Completions ',
				events: ['envelope.completed', 'envelope.sent']
			}
		);
		expect(result.outcome).toBe('created');
		if (result.outcome !== 'created') return;
		expect(result.secret.startsWith('skwh1_')).toBe(true);
		expect(result.endpoint.events).toEqual(['envelope.sent', 'envelope.completed']);
		expect(result.endpoint.description).toBe('Completions');
		expect(persistence.createEndpoint).toHaveBeenCalledOnce();
	});
});

describe('WebhookApplication.drainPendingDeliveries', () => {
	it('marks a successful dispatch delivered', async () => {
		const persistence = store({
			claimPendingDeliveries: vi.fn(async () => [
				{
					organizationId: ORG,
					endpointId: ENDPOINT_ID,
					auditEventId: '01900000-0000-7000-8000-000000000501',
					envelopeId: '01900000-0000-7000-8000-000000000001',
					eventType: 'envelope.completed',
					payloadJson: '{"eventType":"envelope.completed"}',
					endpointUrl: 'https://hooks.example.com/signkit',
					signingSecret: 'skwh1_abcdefghijklmnopqrstuvwxyz0123456789ABCDE',
					claimToken: 'claim-1',
					status: 'processing' as const,
					attempts: 1,
					availableAt: '2026-09-13T00:00:00.000Z',
					lockedAt: '2026-09-13T00:00:00.000Z'
				}
			]),
			completeDelivery: vi.fn(async () => ({ outcome: 'completed' as const }))
		});
		const dispatch = vi.fn(async () => ({
			ok: true as const,
			status: 200
		}));
		const app = new WebhookApplication(persistence, {
			now: () => new Date('2026-09-13T00:00:00.000Z'),
			dispatch
		});
		const result = await app.drainPendingDeliveries(10);
		expect(result).toEqual({ claimed: 1, delivered: 1, retried: 0, failed: 0 });
		expect(persistence.completeDelivery).toHaveBeenCalledOnce();
	});
});
