export const authoringCapabilities = {
	draftHistory: {
		format: 'git',
		archive: 'gzip',
		trackedFiles: ['documents/*.md'],
		commitEndpoint: '/api/v1/envelopes/{envelopeId}/draft/commits',
		docxImportEndpoint: '/api/v1/envelopes/{envelopeId}/draft/docx',
		docxExportEndpoint: '/api/v1/envelopes/{envelopeId}/docx',
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
		authentication: 'organization-session-or-api-key',
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
			node: 'smtp-or-cloudflare-email-rest'
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
		webSurface: '/{locale}/sign/{envelopeId}',
		authentication: 'bearer-capability',
		browserSession: 'envelope-scoped-encrypted-http-only-cookie',
		terminalDeclineReceipt: {
			browserSession: 'purpose-separated-envelope-scoped-encrypted-http-only-cookie',
			revalidation: 'command-audit-and-terminal-projection',
			retentionDays: 30,
			documentAccess: false,
			mutations: false
		},
		mutations: 'same-origin-cookie-context',
		roles: ['signer', 'approver', 'viewer'],
		states: ['sent', 'in_progress'],
		cache: 'no-store'
	}
} as const;
