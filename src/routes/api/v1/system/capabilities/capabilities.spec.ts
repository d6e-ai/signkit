import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { GET } from './+server';

function createEvent(platform?: App.Platform): RequestEvent {
	return {
		platform,
		request: new Request('https://signkit.example/api/v1/system/capabilities'),
		url: new URL('https://signkit.example/api/v1/system/capabilities')
	} as unknown as RequestEvent;
}

interface CapabilitiesResponse {
	apiKeyAuthentication: {
		scheme: string;
		tokenPrefix: string;
		organizationSelector: string;
		organizationSelectorRequired: boolean;
		grantModel: string;
		multipleOrganizationsPerKey: boolean;
		effectiveAuthority: string;
		enabledScopes: string[];
		mintedButUnusableScopes: string[];
		readEndpoints: string[];
		writeEndpoints?: Record<string, string[]>;
		mutations: boolean;
		cookieComposition: boolean;
		caching: string;
		lastUsedTracking: boolean;
		rateLimits: boolean | { durable: boolean; windowSeconds: number; maxRequests: number };
		actor?: { type: string; id: string };
		grantManagement: { create: string; list: string; revoke: string };
		grantAuthority: string;
		grantRevokeAuthority: string[];
	};
	name: string;
	apiVersion: string;
	runtime: 'node' | 'cloudflare' | 'vercel';
	supportedProfiles: {
		node: { database: string; objects: string; status: string };
		cloudflare: { database: string; objects: string; status: string };
		vercel: { database: string; objects: string; status: string };
	};
	draftHistory: {
		format: string;
		archive: string;
		trackedFiles: string[];
		commitEndpoint: string;
		concurrency: string;
		idempotency: string;
	};
	readiness: {
		endpoint: string;
		recipients: string;
		actionableRoles: string[];
		observerRoles: string[];
		preSendOnlyRoles: string[];
		concurrency: string;
		idempotency: string;
	};
	sending: {
		endpoint: string;
		concurrency: string;
		delivery: string;
		idempotency: string;
	};
	voiding: {
		endpoint: string;
		authentication: string;
		concurrency: string;
		terminalCleanup: string;
		idempotency: string;
	};
	delivery: {
		statusEndpoint: string;
		workerEndpoint: string;
		workerAuthentication: string;
		semantics: string;
		transports: {
			cloudflare: string;
			node: string;
		};
	};
	recipientAccess: {
		endpoint: string;
		documentsEndpoint: string;
		viewedEndpoint: string;
		declineEndpoint: string;
		approveEndpoint: string;
		signEndpoint: string;
		linkExchange: string;
		webSurface: string;
		authentication: string;
		browserSession: string;
		terminalDeclineReceipt: {
			browserSession: string;
			revalidation: string;
			retentionDays: number;
			documentAccess: boolean;
			mutations: boolean;
		};
		mutations: string;
		roles: string[];
		states: string[];
		cache: string;
	};
	completionArtifact: {
		statusEndpoint: string;
		workerEndpoint: string;
		workerAuthentication: string;
		authentication: string;
		discovery: string;
		manifestSchema: string;
		artifacts: string[];
		auditVerification: string;
		ccDelivery: string;
		publicArtifactGrants: string;
	};
	completionDelivery: {
		workerEndpoint: string;
		workerAuthentication: string;
		semantics: string;
		transports: {
			cloudflare: string;
			node: string;
		};
		roles: string[];
		prerequisite: string;
		tokenFormat: string;
		grantRetentionDays: number;
	};
	publicCompletionArtifact: {
		apiEndpoint: string;
		linkEndpoint: string;
		authentication: string;
		formats: string[];
		tokenPrefix: string;
		cookies: boolean;
	};
	automation: {
		idempotencyKeys: boolean;
		actorProvenance: boolean;
		webhooks: string;
	};
}

describe('GET /api/v1/system/capabilities', () => {
	it('advertises completion delivery and public artifact retrieval accurately without secrets', async () => {
		const response = await GET(createEvent());
		expect(response.status).toBe(200);

		const data = (await response.json()) as CapabilitiesResponse;
		expect(data.name).toBe('SignKit');
		expect(data.apiVersion).toBe('v1');
		expect(data.runtime).toBe('node');

		// Completion artifact capabilities
		expect(data.completionArtifact).toMatchObject({
			statusEndpoint: '/api/v1/envelopes/{envelopeId}/completion-artifact',
			workerEndpoint: '/api/v1/system/completion-artifacts/drain',
			workerAuthentication: 'bearer-secret',
			ccDelivery: 'supported',
			publicArtifactGrants: 'supported'
		});

		// Completion delivery capabilities
		expect(data.completionDelivery).toEqual({
			workerEndpoint: '/api/v1/system/completion-deliveries/drain',
			workerAuthentication: 'bearer-secret',
			semantics: 'at-least-once',
			transports: {
				cloudflare: 'email-binding',
				node: 'cloudflare-email-rest'
			},
			roles: ['signer', 'approver', 'viewer', 'cc'],
			prerequisite: 'published-completion-artifact',
			tokenFormat: 'skca1',
			grantRetentionDays: 30
		});

		// Public completion artifact capabilities
		expect(data.publicCompletionArtifact).toEqual({
			apiEndpoint: '/api/v1/completion-artifacts',
			linkEndpoint: '/c/{token}',
			authentication: 'bearer-token-or-path-token',
			formats: ['json', 'markdown'],
			tokenPrefix: 'skca1',
			cookies: false
		});

		// API key bearer authentication capabilities. The selector requirement and
		// the enabled/minted scope split are advertised because an agent integrator
		// cannot otherwise tell which minted scopes actually work yet.
		expect(data.apiKeyAuthentication).toEqual({
			scheme: 'bearer',
			tokenPrefix: 'signkit',
			organizationSelector: 'SignKit-Organization-Id',
			organizationSelectorRequired: true,
			grantModel: 'explicit-per-organization',
			multipleOrganizationsPerKey: true,
			effectiveAuthority: 'key-scopes-intersected-with-requested-live-grant',
			enabledScopes: ['envelopes:read', 'drafts:write', 'envelopes:send'],
			mintedButUnusableScopes: ['audit:read'],
			readEndpoints: [
				'/api/v1/envelopes',
				'/api/v1/envelopes/{envelopeId}',
				'/api/v1/envelopes/{envelopeId}/draft',
				'/api/v1/envelopes/{envelopeId}/deliveries',
				'/api/v1/envelopes/{envelopeId}/completion-artifact'
			],
			writeEndpoints: {
				'drafts:write': [
					'/api/v1/envelopes',
					'/api/v1/envelopes/{envelopeId}/draft/commits',
					'/api/v1/envelopes/{envelopeId}/ready',
					'/api/v1/envelopes/{envelopeId}/fields'
				],
				'envelopes:send': [
					'/api/v1/envelopes/{envelopeId}/send',
					'/api/v1/envelopes/{envelopeId}/void'
				]
			},
			mutations: true,
			cookieComposition: false,
			caching: 'none',
			lastUsedTracking: true,
			rateLimits: {
				durable: true,
				windowSeconds: 60,
				maxRequests: 120
			},
			actor: { type: 'agent', id: 'api-key-uuidv7' },
			grantManagement: {
				create: '/api/v1/api-keys/{apiKeyId}/organization-grants',
				list: '/api/v1/api-keys/{apiKeyId}/organization-grants',
				revoke: '/api/v1/api-keys/{apiKeyId}/organization-grants/{grantId}/revoke'
			},
			grantAuthority: 'key-owner-and-d6e-organization-owner-or-admin',
			grantRevokeAuthority: ['key_owner', 'organization_admin']
		});

		// No secrets or token material exposed
		const serialized = JSON.stringify(data);
		expect(serialized).not.toContain('DELIVERY_WORKER_SECRET');
		expect(serialized).not.toContain('DELIVERY_ENCRYPTION_KEY');
		expect(serialized).not.toContain('CLOUDFLARE_EMAIL_API_TOKEN');
		expect(serialized).not.toContain('skca1_');
		expect(serialized).not.toContain('skcd1_');
		expect(serialized).not.toContain('signkit_');
	});

	it('reflects cloudflare runtime when platform DB is present', async () => {
		const platform = { env: { DB: {} as D1Database } } as unknown as App.Platform;
		const response = await GET(createEvent(platform));
		const data = (await response.json()) as CapabilitiesResponse;
		expect(data.runtime).toBe('cloudflare');
	});
});
