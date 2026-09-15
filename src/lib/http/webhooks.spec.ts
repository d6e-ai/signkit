import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	CreateWebhookResult,
	WebhookApplicationPort,
	WebhookRequestActor
} from '$lib/application/webhooks/webhook-service';
import type { WebhookEndpointMetadata } from '$lib/ports/webhook-store';
import { WebhookHostNotAllowedError } from '$lib/security/webhook-allowed-hosts';
import { createWebhookHttpHandlers, type WebhookApplicationResolver } from './webhooks';
import { createHttpRequestEvent, organizationScopedLocals } from './http-handler-test-support';
import { expectProblemResponse } from './problem-response-test-support';

const organizationId: string = '01900000-0000-7000-8000-000000000002';
const webhookId: string = '01900000-0000-7000-8000-000000000401';

const endpoint: WebhookEndpointMetadata = {
	id: webhookId,
	organizationId,
	url: 'https://hooks.example.com/signkit',
	description: 'Completions',
	status: 'active',
	events: ['envelope.completed'],
	secretPrefix: 'skwh1_abcdefgh',
	createdAt: '2026-09-13T00:00:00.000Z',
	createdByUserId: 'user-1',
	revokedAt: null,
	revokedByUserId: null
};

function locals(state: App.Locals['identityState'] = 'authorized'): App.Locals {
	return organizationScopedLocals(state, organizationId);
}

function event(input: {
	pathname?: string;
	method?: string;
	body?: string;
	headers?: HeadersInit;
	locals?: App.Locals;
	params?: Record<string, string>;
	search?: string;
}): RequestEvent {
	return createHttpRequestEvent({
		pathname: input.pathname ?? '/api/v1/webhooks',
		method: input.method,
		body: input.body,
		headers: input.headers,
		locals: input.locals ?? locals(),
		params: input.params,
		search: input.search,
		jsonBodyContentType: true
	});
}

function application(): WebhookApplicationPort {
	return {
		createEndpoint: vi.fn(async (): Promise<CreateWebhookResult> => ({
			outcome: 'created',
			endpoint,
			secret: 'skwh1_abcdefghijklmnopqrstuvwxyz0123456789ABCDE'
		})),
		listEndpoints: vi.fn(async () => ({ items: [endpoint], nextCursor: null })),
		getEndpoint: vi.fn(async () => endpoint),
		revokeEndpoint: vi.fn(async () => ({ outcome: 'revoked' as const, endpoint })),
		listDeliveryLogs: vi.fn(async () => ({ items: [], nextCursor: null })),
		drainPendingDeliveries: vi.fn(async () => ({
			claimed: 0,
			delivered: 0,
			retried: 0,
			failed: 0
		}))
	};
}

describe('webhook HTTP handlers', () => {
	it('authorizes before parsing or resolving dependencies', async () => {
		const resolver: WebhookApplicationResolver = vi.fn(() => null);
		const response = await createWebhookHttpHandlers(resolver).create(
			event({
				method: 'POST',
				locals: locals('anonymous'),
				body: '{',
				headers: { 'idempotency-key': 'wh-1' }
			})
		);
		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('refuses an authenticated API key on webhook management', async () => {
		const resolver: WebhookApplicationResolver = vi.fn(() => null);
		const response = await createWebhookHttpHandlers(resolver).create(
			event({
				method: 'POST',
				locals: {
					...locals(),
					apiKeyAuthentication: {
						state: 'authenticated',
						principal: {
							apiKeyId: webhookId,
							keyPrefix: 'signkit_abcdefgh',
							ownerUserId: 'user-1',
							organizationId,
							organizationName: 'Workspace',
							scopes: ['envelopes:read'],
							expiresAt: '2026-12-11T00:00:00.000Z'
						}
					}
				},
				body: JSON.stringify({
					url: 'https://hooks.example.com/signkit',
					events: ['envelope.completed']
				}),
				headers: { 'idempotency-key': 'wh-1' }
			})
		);
		await expectProblemResponse(response, {
			status: 403,
			type: 'urn:signkit:problem:api-key-not-permitted'
		});
		expect(resolver).not.toHaveBeenCalled();
	});

	it('forbids organization members from managing webhooks', async () => {
		const resolver: WebhookApplicationResolver = vi.fn(() => null);
		const authorized = organizationScopedLocals('authorized', organizationId);
		const memberLocals: App.Locals = {
			...authorized,
			memberships: authorized.memberships.map((membership) => ({
				...membership,
				role: 'member'
			}))
		};
		const response = await createWebhookHttpHandlers(resolver).list(
			event({ locals: memberLocals })
		);
		await expectProblemResponse(response, {
			status: 403,
			type: 'urn:signkit:problem:webhook-forbidden'
		});
		expect(resolver).not.toHaveBeenCalled();
	});

	it('creates a webhook and returns the secret once', async () => {
		const app = application();
		const response = await createWebhookHttpHandlers(() => app).create(
			event({
				method: 'POST',
				body: JSON.stringify({
					url: 'https://hooks.example.com/signkit',
					events: ['envelope.completed']
				}),
				headers: { 'idempotency-key': 'wh-1' }
			})
		);
		expect(response.status).toBe(201);
		const body = (await response.json()) as { webhook: { id: string }; secret: string };
		expect(body.webhook.id).toBe(webhookId);
		expect(body.secret.startsWith('skwh1_')).toBe(true);
		expect(app.createEndpoint).toHaveBeenCalledWith(
			{ id: 'user-1', organizationId } satisfies WebhookRequestActor,
			expect.objectContaining({
				idempotencyKey: 'wh-1',
				url: 'https://hooks.example.com/signkit'
			})
		);
	});

	it('lists webhooks without secrets', async () => {
		const app = application();
		const response = await createWebhookHttpHandlers(() => app).list(event({}));
		expect(response.status).toBe(200);
		const serialized = await response.text();
		expect(serialized).not.toContain('skwh1_abcdefghijklmnopqrstuvwxyz');
		expect(JSON.parse(serialized)).toEqual({ items: [endpoint], nextCursor: null });
	});

	it('returns 404 for an unknown webhook in the authorized organization', async () => {
		const app = application();
		(app.getEndpoint as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
		const response = await createWebhookHttpHandlers(() => app).get(
			event({
				pathname: `/api/v1/webhooks/${webhookId}`,
				params: { webhookId }
			})
		);
		await expectProblemResponse(response, {
			status: 404,
			type: 'urn:signkit:problem:webhook-not-found'
		});
	});

	it('maps a destination-allowlist denial to a 400 validation failure on url', async () => {
		const app = application();
		(app.createEndpoint as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new WebhookHostNotAllowedError('Webhook destinations are not configured for this deployment')
		);
		const response = await createWebhookHttpHandlers(() => app).create(
			event({
				method: 'POST',
				body: JSON.stringify({
					url: 'https://hooks.example.com/signkit',
					events: ['envelope.completed']
				}),
				headers: { 'idempotency-key': 'wh-1' }
			})
		);
		const body = await expectProblemResponse(response, {
			status: 400,
			type: 'urn:signkit:problem:validation-failed'
		});
		expect(body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'url' })]));
		expect(JSON.stringify(body)).not.toContain('hooks.example.com/signkit');
	});
});
