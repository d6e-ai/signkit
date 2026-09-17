import { describe, expect, it, vi } from 'vitest';
import { WebhookApplication, type WebhookDispatchRequest } from './webhook-service';
import type {
	CreateWebhookEndpointCommand,
	FailWebhookDeliveryCommand,
	ResealWebhookSigningSecretCommand,
	WebhookEndpointMetadata,
	WebhookOutboxRow,
	WebhookStore
} from '$lib/ports/webhook-store';
import {
	parseWebhookAllowedHosts,
	WebhookHostNotAllowedError,
	type WebhookHostPolicy
} from '$lib/security/webhook-allowed-hosts';
import { AesGcmWebhookSigningSecretSealer } from '$lib/security/webhook-signing-secret';
import { WEBHOOK_MAX_ATTEMPTS, WEBHOOK_MAX_PAYLOAD_BYTES } from '$lib/security/webhook';
import { WebhookTargetRejectedError } from '$lib/security/webhook-url';

const ENDPOINT_ID: string = '01900000-0000-7000-8000-000000000401';
const ACTOR_ID: string = 'user-1';

function metadata(overrides: Partial<WebhookEndpointMetadata> = {}): WebhookEndpointMetadata {
	return {
		id: ENDPOINT_ID,
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

function claimedRow(overrides: Partial<WebhookOutboxRow> = {}): WebhookOutboxRow {
	return {
		endpointId: ENDPOINT_ID,
		auditEventId: '01900000-0000-7000-8000-000000000501',
		envelopeId: '01900000-0000-7000-8000-000000000001',
		eventType: 'envelope.completed',
		payloadJson: '{"eventType":"envelope.completed"}',
		endpointUrl: 'https://hooks.example.com/signkit',
		signingSecret: 'skwh1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
		sealingKeyId: null,
		claimToken: 'claim-1',
		status: 'processing',
		attempts: 1,
		availableAt: '2026-09-13T00:00:00.000Z',
		lockedAt: '2026-09-13T00:00:00.000Z',
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

function failDeliveryMock() {
	return vi.fn(async (_command: FailWebhookDeliveryCommand) => {
		void _command;
		return { outcome: 'failed' as const };
	});
}

/**
 * Every spec that reaches `https://hooks.example.com/…` opts into this
 * injected allowlist explicitly through the test-only constructor option.
 * Production never passes a static policy; it resolves
 * `SIGNKIT_WEBHOOK_ALLOWED_HOSTS` per operation.
 */
function allowlist(): WebhookHostPolicy {
	const parsed: WebhookHostPolicy | null = parseWebhookAllowedHosts('hooks.example.com');
	if (parsed === null) throw new Error('expected the test allowlist to parse');
	return parsed;
}

describe('WebhookApplication.createEndpoint', () => {
	it('rejects a non-HTTPS target before persistence', async () => {
		const persistence = store();
		const app = new WebhookApplication(persistence, sealer(), {
			allowedHostsPolicyForTests: allowlist(),
			newId: () => ENDPOINT_ID
		});
		await expect(
			app.createEndpoint(
				{ id: ACTOR_ID },
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
		const app = new WebhookApplication(persistence, sealer(), {
			allowedHostsPolicyForTests: allowlist(),
			newId: () => ENDPOINT_ID
		});
		const result = await app.createEndpoint(
			{ id: ACTOR_ID },
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
			allowedHostsPolicyForTests: allowlist(),
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
			endpointId: ENDPOINT_ID
		});
		const persistence = store({
			claimPendingDeliveries: vi.fn(async () => [
				{
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
			allowedHostsPolicyForTests: allowlist(),
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
					endpointId: ENDPOINT_ID,
					signingSecret: plaintext,
					sealingKeyId: null
				}
			]),
			resealSigningSecret
		});
		const app = new WebhookApplication(persistence, secretSealer, {
			allowedHostsPolicyForTests: allowlist(),
			now: () => new Date('2026-09-13T00:00:00.000Z')
		});
		await app.drainPendingDeliveries(10);
		expect(resealSigningSecret).toHaveBeenCalledOnce();
		const command = resealSigningSecret.mock.calls[0]?.[0];
		if (command === undefined) throw new Error('expected resealSigningSecret to have been called');
		expect(command).toMatchObject({
			endpointId: ENDPOINT_ID,
			previousSealingKeyId: null
		});
		expect(command.signingSecret.startsWith('skwhs1_')).toBe(true);
		expect(command.sealingKeyId).toBe(await secretSealer.currentSealingKeyId());
		await expect(
			secretSealer.open(command.signingSecret, { endpointId: ENDPOINT_ID }, command.sealingKeyId)
		).resolves.toBe(plaintext);
	});

	it('marks an oversized payload as a terminal non-retryable failure', async () => {
		const failDelivery = failDeliveryMock();
		const dispatch = vi.fn();
		const persistence = store({
			claimPendingDeliveries: vi.fn(async () => [
				claimedRow({ payloadJson: 'x'.repeat(WEBHOOK_MAX_PAYLOAD_BYTES + 1) })
			]),
			failDelivery
		});
		const app = new WebhookApplication(persistence, sealer(), {
			allowedHostsPolicyForTests: allowlist(),
			now: () => new Date('2026-09-13T00:00:00.000Z'),
			dispatch
		});
		await expect(app.drainPendingDeliveries(10)).resolves.toEqual({
			claimed: 1,
			delivered: 0,
			retried: 0,
			failed: 1
		});
		expect(dispatch).not.toHaveBeenCalled();
		expect(failDelivery).toHaveBeenCalledOnce();
		expect(failDelivery.mock.calls[0]?.[0]).toMatchObject({
			retryable: false,
			errorCode: 'payload_too_large',
			httpStatus: null
		});
	});

	it('marks SSRF rejection as a terminal non-retryable failure', async () => {
		const failDelivery = failDeliveryMock();
		const persistence = store({
			claimPendingDeliveries: vi.fn(async () => [claimedRow()]),
			failDelivery
		});
		const app = new WebhookApplication(persistence, sealer(), {
			allowedHostsPolicyForTests: allowlist(),
			now: () => new Date('2026-09-13T00:00:00.000Z'),
			dispatch: async () => {
				throw new WebhookTargetRejectedError('Webhook URL hostname is not a public DNS name');
			}
		});
		await expect(app.drainPendingDeliveries(10)).resolves.toEqual({
			claimed: 1,
			delivered: 0,
			retried: 0,
			failed: 1
		});
		expect(failDelivery).toHaveBeenCalledOnce();
		expect(failDelivery.mock.calls[0]?.[0]).toMatchObject({
			retryable: false,
			errorCode: 'ssrf_rejected',
			httpStatus: null
		});
	});

	it.each([400, 403, 404, 422])(
		'marks HTTP %s as a terminal non-retryable failure',
		async (status: number) => {
			const failDelivery = failDeliveryMock();
			const persistence = store({
				claimPendingDeliveries: vi.fn(async () => [claimedRow()]),
				failDelivery
			});
			const app = new WebhookApplication(persistence, sealer(), {
				allowedHostsPolicyForTests: allowlist(),
				now: () => new Date('2026-09-13T00:00:00.000Z'),
				dispatch: async () => ({
					ok: false as const,
					retryable: false,
					status,
					errorCode: `http_${status}`
				})
			});
			await expect(app.drainPendingDeliveries(10)).resolves.toEqual({
				claimed: 1,
				delivered: 0,
				retried: 0,
				failed: 1
			});
			expect(failDelivery).toHaveBeenCalledOnce();
			expect(failDelivery.mock.calls[0]?.[0]).toMatchObject({
				retryable: false,
				errorCode: `http_${status}`,
				httpStatus: status
			});
		}
	);

	it.each([408, 429, 500, 503])(
		'keeps HTTP %s retryable before the attempt ceiling',
		async (status: number) => {
			const failDelivery = failDeliveryMock();
			const persistence = store({
				claimPendingDeliveries: vi.fn(async () => [claimedRow({ attempts: 1 })]),
				failDelivery
			});
			const app = new WebhookApplication(persistence, sealer(), {
				allowedHostsPolicyForTests: allowlist(),
				now: () => new Date('2026-09-13T00:00:00.000Z'),
				dispatch: async () => ({
					ok: false as const,
					retryable: true,
					status,
					errorCode: `http_${status}`
				})
			});
			await expect(app.drainPendingDeliveries(10)).resolves.toEqual({
				claimed: 1,
				delivered: 0,
				retried: 1,
				failed: 0
			});
			expect(failDelivery.mock.calls[0]?.[0]).toMatchObject({
				retryable: true,
				errorCode: `http_${status}`,
				httpStatus: status
			});
		}
	);

	it('turns a retryable HTTP 5xx terminal at the attempt ceiling', async () => {
		const failDelivery = failDeliveryMock();
		const persistence = store({
			claimPendingDeliveries: vi.fn(async () => [claimedRow({ attempts: WEBHOOK_MAX_ATTEMPTS })]),
			failDelivery
		});
		const app = new WebhookApplication(persistence, sealer(), {
			allowedHostsPolicyForTests: allowlist(),
			now: () => new Date('2026-09-13T00:00:00.000Z'),
			dispatch: async () => ({
				ok: false as const,
				retryable: true,
				status: 500,
				errorCode: 'http_500'
			})
		});
		await expect(app.drainPendingDeliveries(10)).resolves.toEqual({
			claimed: 1,
			delivered: 0,
			retried: 0,
			failed: 1
		});
		expect(failDelivery.mock.calls[0]?.[0]).toMatchObject({
			retryable: false,
			errorCode: 'http_500'
		});
	});
});

describe('WebhookApplication destination allowlist', () => {
	function wildcardPolicy(): WebhookHostPolicy {
		const parsed: WebhookHostPolicy | null = parseWebhookAllowedHosts('*.hooks.example.com');
		if (parsed === null) throw new Error('expected the wildcard policy to parse');
		return parsed;
	}

	it('denies creation by default when no policy is injected', async () => {
		const persistence = store();
		const app = new WebhookApplication(persistence, sealer(), { newId: () => ENDPOINT_ID });
		await expect(
			app.createEndpoint(
				{ id: ACTOR_ID },
				{
					idempotencyKey: 'wh-1',
					url: 'https://hooks.example.com/signkit',
					description: null,
					events: ['envelope.completed']
				}
			)
		).rejects.toBeInstanceOf(WebhookHostNotAllowedError);
		expect(persistence.createEndpoint).not.toHaveBeenCalled();
	});

	it('denies creation for a host outside the injected policy', async () => {
		const persistence = store();
		const app = new WebhookApplication(persistence, sealer(), {
			newId: () => ENDPOINT_ID,
			allowedHostsPolicyForTests: allowlist()
		});
		await expect(
			app.createEndpoint(
				{ id: ACTOR_ID },
				{
					idempotencyKey: 'wh-1',
					url: 'https://evil.example.com/signkit',
					description: null,
					events: ['envelope.completed']
				}
			)
		).rejects.toBeInstanceOf(WebhookHostNotAllowedError);
		expect(persistence.createEndpoint).not.toHaveBeenCalled();
	});

	it('allows a wildcard subdomain but not the bare suffix on creation', async () => {
		const persistence = store({
			createEndpoint: vi.fn(async (command: CreateWebhookEndpointCommand) => ({
				outcome: 'created' as const,
				endpoint: metadata({ id: command.id, url: command.url })
			}))
		});
		const app = new WebhookApplication(persistence, sealer(), {
			newId: () => ENDPOINT_ID,
			allowedHostsPolicyForTests: wildcardPolicy()
		});
		const allowed = await app.createEndpoint(
			{ id: ACTOR_ID },
			{
				idempotencyKey: 'wh-1',
				url: 'https://a.hooks.example.com/signkit',
				description: null,
				events: ['envelope.completed']
			}
		);
		expect(allowed.outcome).toBe('created');
		await expect(
			app.createEndpoint(
				{ id: ACTOR_ID },
				{
					idempotencyKey: 'wh-2',
					url: 'https://hooks.example.com/signkit',
					description: null,
					events: ['envelope.completed']
				}
			)
		).rejects.toBeInstanceOf(WebhookHostNotAllowedError);
	});

	it('fails a delivery terminally when the policy no longer covers the endpoint host', async () => {
		const failDelivery = failDeliveryMock();
		const dispatch = vi.fn(async () => ({ ok: true as const, status: 200 }));
		const persistence = store({
			createEndpoint: vi.fn(async (command: CreateWebhookEndpointCommand) => ({
				outcome: 'created' as const,
				endpoint: metadata({ id: command.id, url: command.url })
			})),
			claimPendingDeliveries: vi.fn(async () => [claimedRow()]),
			failDelivery
		});
		let calls = 0;
		const app = new WebhookApplication(persistence, sealer(), {
			now: () => new Date('2026-09-13T00:00:00.000Z'),
			dispatch,
			// Creation-time policy covers the host; by delivery time the
			// deployer has removed the allowlist, so the attempt must fail
			// closed even though the endpoint row still exists.
			allowedHostsResolver: () => {
				calls += 1;
				return calls === 1 ? allowlist() : null;
			}
		});
		const created = await app.createEndpoint(
			{ id: ACTOR_ID },
			{
				idempotencyKey: 'wh-1',
				url: 'https://hooks.example.com/signkit',
				description: null,
				events: ['envelope.completed']
			}
		);
		expect(created.outcome).toBe('created');
		await expect(app.drainPendingDeliveries(10)).resolves.toEqual({
			claimed: 1,
			delivered: 0,
			retried: 0,
			failed: 1
		});
		expect(dispatch).not.toHaveBeenCalled();
		expect(failDelivery).toHaveBeenCalledOnce();
		expect(failDelivery.mock.calls[0]?.[0]).toMatchObject({
			retryable: false,
			errorCode: 'host_not_allowed',
			httpStatus: null
		});
	});

	it('runs the policy check before any dispatch network work', async () => {
		const failDelivery = failDeliveryMock();
		const dispatch = vi.fn(async () => ({ ok: true as const, status: 200 }));
		const persistence = store({
			claimPendingDeliveries: vi.fn(async () => [
				claimedRow({ endpointUrl: 'https://evil.example.com/signkit' })
			]),
			failDelivery
		});
		const app = new WebhookApplication(persistence, sealer(), {
			now: () => new Date('2026-09-13T00:00:00.000Z'),
			dispatch,
			allowedHostsPolicyForTests: allowlist()
		});
		await expect(app.drainPendingDeliveries(10)).resolves.toEqual({
			claimed: 1,
			delivered: 0,
			retried: 0,
			failed: 1
		});
		expect(dispatch).not.toHaveBeenCalled();
		expect(failDelivery.mock.calls[0]?.[0]).toMatchObject({
			retryable: false,
			errorCode: 'host_not_allowed'
		});
	});

	it('still applies the DNS public-address checks for allowlisted hosts', async () => {
		const failDelivery = failDeliveryMock();
		const persistence = store({
			claimPendingDeliveries: vi.fn(async () => [claimedRow()]),
			failDelivery
		});
		const app = new WebhookApplication(persistence, sealer(), {
			now: () => new Date('2026-09-13T00:00:00.000Z'),
			dispatch: async () => {
				throw new WebhookTargetRejectedError('Webhook hostname resolved to a blocked address');
			},
			allowedHostsPolicyForTests: allowlist()
		});
		await expect(app.drainPendingDeliveries(10)).resolves.toEqual({
			claimed: 1,
			delivered: 0,
			retried: 0,
			failed: 1
		});
		expect(failDelivery.mock.calls[0]?.[0]).toMatchObject({
			retryable: false,
			errorCode: 'ssrf_rejected'
		});
	});
});
