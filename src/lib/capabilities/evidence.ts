export const evidenceCapabilities = {
	completionArtifact: {
		statusEndpoint: '/api/v1/envelopes/{envelopeId}/completion-artifact',
		workerEndpoint: '/api/v1/system/completion-artifacts/drain',
		workerAuthentication: 'bearer-secret',
		authentication: 'organization-session',
		discovery: 'reconciliation-job',
		manifestSchema: 'signkit-completion-manifest-v1',
		artifacts: ['json', 'markdown', 'pdf'],
		auditVerification: 'bounded-per-event-hash-rederivation',
		hashVersion: { current: 2, legacy: 1 },
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
		formats: ['json', 'markdown', 'pdf'],
		tokenPrefix: 'skca1',
		cookies: false
	}
} as const;
