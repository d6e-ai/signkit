export const evidenceCapabilities = {
	completionArtifact: {
		statusEndpoint: '/api/v1/envelopes/{envelopeId}/completion-artifact',
		workerEndpoint: '/api/v1/system/completion-artifacts/drain',
		workerAuthentication: 'bearer-secret',
		authentication: 'instance-session',
		discovery: 'reconciliation-job',
		manifestSchema: 'signkit-completion-manifest-v1',
		artifacts: ['json', 'markdown', 'pdf'],
		auditVerification: 'bounded-per-event-hash-rederivation',
		hashVersion: { current: 3, legacy: [] },
		ccDelivery: 'supported',
		publicArtifactGrants: 'supported'
	},
	pdfSeal: {
		statusEndpoint: '/api/v1/envelopes/{envelopeId}/pdf-seal',
		requestEndpoint: '/api/v1/envelopes/{envelopeId}/pdf-seal',
		workerEndpoint: '/api/v1/system/pdf-seals/drain',
		workerAuthentication: 'bearer-secret',
		authentication: 'instance-session-or-api-key',
		discovery: 'explicit-request-only',
		supportedProfiles: ['pades-b-b', 'pades-b-t'],
		publication: 'independently-validated-atomic',
		privateKeyCustody: 'external-provider'
	},
	completionDelivery: {
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
	},
	publicCompletionArtifact: {
		apiEndpoint: '/api/v1/completion-artifacts',
		linkEndpoint: '/c/{token}',
		authentication: 'bearer-token-or-path-token',
		formats: ['json', 'markdown', 'pdf'],
		tokenPrefix: 'skca1',
		cookies: false
	}
} as const;
