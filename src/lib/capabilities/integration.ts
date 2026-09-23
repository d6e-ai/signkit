export const API_KEY_RATE_WINDOW_SECONDS: number = 60;
export const API_KEY_RATE_WINDOW_MAX_REQUESTS: number = 120;

export const integrationCapabilities = {
	apiKeyAuthentication: {
		scheme: 'bearer',
		tokenPrefix: 'signkit',
		authority: 'active-instance-member-key-owner',
		effectiveAuthority: 'key-scopes-intersected-with-active-owner-membership',
		enabledScopes: ['envelopes:read', 'drafts:write', 'envelopes:send'],
		readEndpoints: [
			'/api/v1/envelopes',
			'/api/v1/envelopes/{envelopeId}',
			'/api/v1/envelopes/{envelopeId}/draft',
			'/api/v1/envelopes/{envelopeId}/docx',
			'/api/v1/envelopes/{envelopeId}/deliveries',
			'/api/v1/envelopes/{envelopeId}/completion-artifact',
			'/api/v1/envelopes/{envelopeId}/pdf-seal',
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
			windowSeconds: API_KEY_RATE_WINDOW_SECONDS,
			maxRequests: API_KEY_RATE_WINDOW_MAX_REQUESTS
		},
		actor: { type: 'agent', id: 'api-key-uuidv7' }
	},
	webhooks: {
		status: 'supported',
		management: {
			create: '/api/v1/webhooks',
			list: '/api/v1/webhooks',
			get: '/api/v1/webhooks/{webhookId}',
			revoke: '/api/v1/webhooks/{webhookId}/revoke',
			deliveries: '/api/v1/webhooks/{webhookId}/deliveries'
		},
		workerEndpoint: '/api/v1/system/webhooks/drain',
		workerAuthentication: 'bearer-secret',
		signature: 'hmac-sha256-timestamp',
		secretReveal: 'once',
		tenantIsolation: 'instance',
		outbox: 'durable-atomic-with-audit-event',
		ssrfDefense: [
			'https-only',
			'no-ip-literals',
			'no-loopback',
			'no-private',
			'no-link-local',
			'no-multicast',
			'deployer-destination-allowlist',
			'no-redirects',
			'hostname-memoized-dns'
		],
		destinationAllowlist: {
			env: 'SIGNKIT_WEBHOOK_ALLOWED_HOSTS',
			default: 'deny',
			entryKinds: ['exact-host', 'wildcard-suffix']
		}
	},
	openapi: {
		document: '/api/v1/openapi.json',
		version: '3.1'
	},
	automation: {
		idempotencyKeys: true,
		actorProvenance: true,
		webhooks: 'supported'
	}
} as const;
