import { describe, expect, it, vi } from 'vitest';
import { WebhookApplication, type WebhookDispatchRequest } from './webhook-service';
import type {
	CreateWebhookEndpointCommand,
	ResealWebhookSigningSecretCommand,
	WebhookEndpointMetadata,
	WebhookStore
} from '$lib/ports/webhook-store';
import { AesGcmWebhookSigningSecretSealer } from '$lib/security/webhook-signing-secret';
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

const TEST_KEY: string = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function sealer(): AesGcmWebhookSigningSecretSealer {
	return new AesGcmWebhookSigningSecretSealer(TEST_KEY);
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
		listStaleSigningSecrets: vi.fn(async () => []),
		resealSigningSecret: vi.fn(async () => ({ outcome: 'resealed' as const })),
		listDeliveryLogs: vi.fn(),
		...overrides
	};
}

describe('WebhookApplication.createEndpoint', () => {
	it('rejects a non-HTTPS target before persistence', async () => {
		const persistence = store();
		const app = new WebhookApplication(persistence, sealer(), { newId: () => ENDPOINT_ID });
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
		const app = new WebhookApplication(persistence, sealer(), { newId: () => ENDPOINT_ID });
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
		const command = vi.mocked(persistence.createEndpoint).mock.calls[0][0];
		expect(command.signingSecret.startsWith('skwhs1_')).toBe(true);
		expect(command.signingSecret).not.toBe(result.secret);
		expect(command.sealingKeyId).toMatch(/^[0-9a-f]{16}$/);
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
					signingSecret: 'skwh1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
					sealingKeyId: null,
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
		const app = new WebhookApplication(persistence, sealer(), {
			now: () => new Date('2026-09-13T00:00:00.000Z'),
			dispatch
		});
		const result = await app.drainPendingDeliveries(10);
		expect(result).toEqual({ claimed: 1, delivered: 1, retried: 0, failed: 0 });
		expect(persistence.completeDelivery).toHaveBeenCalledOnce();
	});

	it('unseals a stored signing secret before dispatch and never passes ciphertext', async () => {
		const plaintext: string = 'skwh1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
		const secretSealer = sealer();
		const sealed = await secretSealer.seal(plaintext, {
			organizationId: ORG,
			endpointId: ENDPOINT_ID
		});
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
					signingSecret: sealed.sealedSigningSecret,
					sealingKeyId: sealed.sealingKeyId,
					claimToken: 'claim-1',
					status: 'processing' as const,
					attempts: 1,
					availableAt: '2026-09-13T00:00:00.000Z',
					lockedAt: '2026-09-13T00:00:00.000Z'
				}
			]),
			completeDelivery: vi.fn(async () => ({ outcome: 'completed' as const }))
		});
		const dispatch = vi.fn(async (_request: WebhookDispatchRequest) => {
			void _request;
			return { ok: true as const, status: 200 };
		});
		const app = new WebhookApplication(persistence, secretSealer, {
			now: () => new Date('2026-09-13T00:00:00.000Z'),
			dispatch
		});
		await app.drainPendingDeliveries(10);
		const dispatchedRequest = dispatch.mock.calls[0]?.[0];
		expect(dispatchedRequest?.secret).toBe(plaintext);
		expect(dispatchedRequest?.secret.startsWith('skwh1_')).toBe(true);
		expect(sealed.sealedSigningSecret.startsWith('skwhs1_')).toBe(true);
	});

	it('reseals a stale signing secret onto the active key during a drain batch', async () => {
		const plaintext: string = 'skwh1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
		const secretSealer = sealer();
		const resealSigningSecret = vi.fn(async (_command: ResealWebhookSigningSecretCommand) => {
			void _command;
			return { outcome: 'resealed' as const };
		});
		const persistence = store({
			listStaleSigningSecrets: vi.fn(async () => [
				{
					organizationId: ORG,
					endpointId: ENDPOINT_ID,
					signingSecret: plaintext,
					sealingKeyId: null
				}
			]),
			resealSigningSecret
		});
		const app = new WebhookApplication(persistence, secretSealer, {
			now: () => new Date('2026-09-13T00:00:00.000Z')
		});
		await app.drainPendingDeliveries(10);
		expect(resealSigningSecret).toHaveBeenCalledOnce();
		const command = resealSigningSecret.mock.calls[0]?.[0];
		if (command === undefined) throw new Error('expected resealSigningSecret to have been called');
		expect(command).toMatchObject({
			organizationId: ORG,
			endpointId: ENDPOINT_ID,
			previousSealingKeyId: null
		});
		expect(command.signingSecret.startsWith('skwhs1_')).toBe(true);
		expect(command.sealingKeyId).toBe(await secretSealer.currentSealingKeyId());
		await expect(
			secretSealer.open(
				command.signingSecret,
				{ organizationId: ORG, endpointId: ENDPOINT_ID },
				command.sealingKeyId
			)
		).resolves.toBe(plaintext);
	});
});
