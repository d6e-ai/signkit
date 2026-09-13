import { env } from '$env/dynamic/private';
import { json, type RequestHandler } from '@sveltejs/kit';

export const GET: RequestHandler = ({ platform }) => {
	const runtime = platform?.env?.DB ? 'cloudflare' : env.VERCEL ? 'vercel' : 'node';
	return json({
		name: 'SignKit',
		apiVersion: 'v1',
		runtime,
		supportedProfiles: {
			node: { database: 'postgresql', objects: 's3-compatible', status: 'scaffolded' },
			cloudflare: { database: 'd1', objects: 'r2', status: 'scaffolded' },
			vercel: { database: 'postgresql', objects: 's3-compatible', status: 'planned' }
		},
		draftHistory: {
			format: 'git',
			archive: 'gzip',
			trackedFiles: ['documents/*.md'],
			commitEndpoint: '/api/v1/envelopes/{envelopeId}/draft/commits',
			concurrency: 'expected-generation',
			idempotency: 'required'
		},
		readiness: {
			endpoint: '/api/v1/envelopes/{envelopeId}/ready',
			recipients: 'complete-graph',
			actionableRoles: ['signer', 'approver'],
			observerRoles: ['viewer'],
			preSendOnlyRoles: ['prefill'],
			concurrency: 'expected-generation',
			idempotency: 'required'
		},
		sending: {
			endpoint: '/api/v1/envelopes/{envelopeId}/send',
			concurrency: 'expected-generation-and-ready-audit-event',
			delivery: 'durable-outbox',
			idempotency: 'required'
		},
		voiding: {
			endpoint: '/api/v1/envelopes/{envelopeId}/void',
			authentication: 'organization-session',
			concurrency: 'expected-status-and-generation',
			terminalCleanup: 'atomic',
			idempotency: 'required'
		},
		delivery: {
			statusEndpoint: '/api/v1/envelopes/{envelopeId}/deliveries',
			workerEndpoint: '/api/v1/system/deliveries/drain',
			workerAuthentication: 'bearer-secret',
			semantics: 'at-least-once',
			transports: {
				cloudflare: 'email-binding',
				node: 'cloudflare-email-rest'
			}
		},
		recipientAccess: {
			endpoint: '/api/v1/signing/context',
			documentsEndpoint: '/api/v1/signing/documents',
			viewedEndpoint: '/api/v1/signing/viewed',
			declineEndpoint: '/api/v1/signing/decline',
			approveEndpoint: '/api/v1/signing/approve',
			signEndpoint: '/api/v1/signing/sign',
			linkExchange: '/s/{capability}',
			webSurface: '/{locale}/sign',
			authentication: 'bearer-capability',
			browserSession: 'encrypted-http-only-cookie',
			terminalDeclineReceipt: {
				browserSession: 'purpose-separated-encrypted-http-only-cookie',
				revalidation: 'command-audit-and-terminal-projection',
				retentionDays: 30,
				documentAccess: false,
				mutations: false
			},
			mutations: 'same-origin-cookie-context',
			roles: ['signer', 'approver', 'viewer'],
			states: ['sent', 'in_progress'],
			cache: 'no-store'
		},
		completionArtifact: {
			statusEndpoint: '/api/v1/envelopes/{envelopeId}/completion-artifact',
			workerEndpoint: '/api/v1/system/completion-artifacts/drain',
			workerAuthentication: 'bearer-secret',
			authentication: 'organization-session',
			discovery: 'reconciliation-job',
			manifestSchema: 'signkit-completion-manifest-v1',
			artifacts: ['json', 'markdown'],
			auditVerification: 'bounded-per-event-hash-rederivation',
			ccDelivery: 'supported',
			publicArtifactGrants: 'supported'
		},
		completionDelivery: {
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
		},
		publicCompletionArtifact: {
			apiEndpoint: '/api/v1/completion-artifacts',
			linkEndpoint: '/c/{token}',
			authentication: 'bearer-token-or-path-token',
			formats: ['json', 'markdown'],
			tokenPrefix: 'skca1',
			cookies: false
		},
		apiKeyAuthentication: {
			scheme: 'bearer',
			tokenPrefix: 'signkit',
			organizationSelector: 'SignKit-Organization-Id',
			organizationSelectorRequired: true,
			grantModel: 'explicit-per-organization',
			multipleOrganizationsPerKey: true,
			effectiveAuthority: 'key-scopes-intersected-with-requested-live-grant',
			enabledScopes: ['envelopes:read'],
			mintedButUnusableScopes: ['audit:read', 'drafts:write', 'envelopes:send'],
			readEndpoints: [
				'/api/v1/envelopes',
				'/api/v1/envelopes/{envelopeId}',
				'/api/v1/envelopes/{envelopeId}/draft',
				'/api/v1/envelopes/{envelopeId}/deliveries',
				'/api/v1/envelopes/{envelopeId}/completion-artifact'
			],
			mutations: false,
			cookieComposition: false,
			caching: 'none',
			lastUsedTracking: false,
			rateLimits: false,
			grantManagement: {
				create: '/api/v1/api-keys/{apiKeyId}/organization-grants',
				list: '/api/v1/api-keys/{apiKeyId}/organization-grants',
				revoke: '/api/v1/api-keys/{apiKeyId}/organization-grants/{grantId}/revoke'
			},
			grantAuthority: 'key-owner-and-d6e-organization-owner-or-admin',
			grantRevokeAuthority: ['key_owner', 'organization_admin']
		},
		automation: { idempotencyKeys: true, actorProvenance: true, webhooks: 'planned' }
	});
};
