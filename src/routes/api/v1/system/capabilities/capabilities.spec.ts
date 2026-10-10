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
		authority: string;
		effectiveAuthority: string;
		enabledScopes: string[];
		readEndpoints: string[];
		writeEndpoints?: Record<string, string[]>;
		mutations: boolean;
		cookieComposition: boolean;
		caching: string;
		lastUsedTracking: boolean;
		rateLimits: boolean | { durable: boolean; windowSeconds: number; maxRequests: number };
		actor?: { type: string; id: string };
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
		revisionListEndpoint: string;
		revisionReadEndpoint: string;
		revisionDiffEndpoint: string;
		docxImportEndpoint: string;
		docxExportEndpoint: string;
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
	pdfSeal: {
		statusEndpoint: string;
		requestEndpoint: string;
		downloadEndpoint: string;
		workerEndpoint: string;
		discovery: string;
		supportedProfiles: string[];
		publication: string;
		privateKeyCustody: string;
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
	webhooks: {
		status: string;
		destinationAllowlist: {
			env: string;
			default: string;
			entryKinds: string[];
		};
		ssrfDefense: string[];
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
		expect(data.draftHistory).toMatchObject({
			revisionListEndpoint: '/api/v1/envelopes/{envelopeId}/revisions',
			revisionReadEndpoint: '/api/v1/envelopes/{envelopeId}/revisions/{revisionRef}',
			revisionDiffEndpoint: '/api/v1/envelopes/{envelopeId}/revisions/diff'
		});

		// Completion artifact capabilities
		expect(data.completionArtifact).toMatchObject({
			statusEndpoint: '/api/v1/envelopes/{envelopeId}/completion-artifact',
			workerEndpoint: '/api/v1/system/completion-artifacts/drain',
			workerAuthentication: 'bearer-secret',
			ccDelivery: 'supported',
			publicArtifactGrants: 'supported'
		});
		expect(data.pdfSeal).toMatchObject({
			statusEndpoint: '/api/v1/envelopes/{envelopeId}/pdf-seal',
			requestEndpoint: '/api/v1/envelopes/{envelopeId}/pdf-seal',
			downloadEndpoint: '/api/v1/envelopes/{envelopeId}/pdf-seal/pdf',
			workerEndpoint: '/api/v1/system/pdf-seals/drain',
			discovery: 'explicit-request-only',
			supportedProfiles: ['pades-b-b', 'pades-b-t'],
			publication: 'independently-validated-atomic',
			privateKeyCustody: 'external-provider'
		});

		// Completion delivery capabilities
		expect(data.completionDelivery).toEqual({
			workerEndpoint: '/api/v1/system/completion-deliveries/drain',
			workerAuthentication: 'bearer-secret',
			semantics: 'at-least-once',
			transports: {
				cloudflare: 'email-binding',
				node: 'smtp-or-cloudflare-email-rest'
			},
			roles: ['signer', 'approver', 'viewer', 'cc'],
			prerequisite: 'published-completion-artifact',
			tokenFormat: 'skca1',
			grantRetentionDays: 30
		});

		// Public completion artifact capabilities
		expect(data.completionArtifact.artifacts).toEqual(['json', 'markdown', 'pdf']);
		expect(data.publicCompletionArtifact).toEqual({
			apiEndpoint: '/api/v1/completion-artifacts',
			linkEndpoint: '/c/{token}',
			authentication: 'bearer-token-or-path-token',
			formats: ['json', 'markdown', 'pdf'],
			tokenPrefix: 'skca1',
			cookies: false
		});

		// API key bearer authentication capabilities. The owner-membership requirement
		// and exact live scope set are advertised for agent integrators.
		expect(data.apiKeyAuthentication).toEqual({
			scheme: 'bearer',
			tokenPrefix: 'signkit',
			authority: 'active-instance-member-key-owner',
			effectiveAuthority: 'key-scopes-intersected-with-active-owner-membership',
			enabledScopes: ['envelopes:read', 'drafts:write', 'envelopes:send'],
			readEndpoints: [
				'/api/v1/envelopes',
				'/api/v1/envelopes/{envelopeId}',
				'/api/v1/envelopes/{envelopeId}/draft',
				'/api/v1/envelopes/{envelopeId}/revisions',
				'/api/v1/envelopes/{envelopeId}/revisions/{revisionRef}',
				'/api/v1/envelopes/{envelopeId}/revisions/diff',
				'/api/v1/envelopes/{envelopeId}/docx',
				'/api/v1/envelopes/{envelopeId}/deliveries',
				'/api/v1/envelopes/{envelopeId}/completion-artifact',
				'/api/v1/envelopes/{envelopeId}/pdf-seal',
				'/api/v1/envelopes/{envelopeId}/pdf-seal/pdf',
				'/api/v1/envelopes/{envelopeId}/evidence',
				'/api/v1/envelopes/{envelopeId}/completion-artifact/evidence',
				'/api/v1/envelopes/{envelopeId}/pdf',
				'/api/v1/envelopes/{envelopeId}/completion-artifact/pdf'
			],
			writeEndpoints: {
				'drafts:write': [
					'/api/v1/envelopes',
					'/api/v1/envelopes/{envelopeId}/draft/commits',
					'/api/v1/envelopes/{envelopeId}/draft/docx',
					'/api/v1/envelopes/{envelopeId}/documents/pdf',
					'/api/v1/envelopes/{envelopeId}/documents/order',
					'/api/v1/envelopes/{envelopeId}/ready',
					'/api/v1/envelopes/{envelopeId}/fields'
				],
				'envelopes:send': [
					'/api/v1/envelopes/{envelopeId}/send',
					'/api/v1/envelopes/{envelopeId}/void',
					'/api/v1/envelopes/{envelopeId}/pdf-seal'
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
			actor: { type: 'agent', id: 'api-key-uuidv7' }
		});

		// Webhook destinations are deployer-allowlisted and deny by default; the
		// capability advertisement names the variable so operators know where
		// the policy lives without exposing its value.
		expect(data.webhooks.destinationAllowlist).toEqual({
			env: 'SIGNKIT_WEBHOOK_ALLOWED_HOSTS',
			default: 'deny',
			entryKinds: ['exact-host', 'wildcard-suffix']
		});
		expect(data.webhooks.ssrfDefense).toEqual(
			expect.arrayContaining(['deployer-destination-allowlist', 'no-redirects'])
		);

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
