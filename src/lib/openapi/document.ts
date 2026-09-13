import { WEBHOOK_AUDIT_EVENT_TYPES } from '$lib/domain/audit';
import { recipientRoles, fieldTypes } from '$lib/domain/envelope';

const UUIDV7: Record<string, unknown> = {
	type: 'string',
	pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
};

const PROBLEM: Record<string, unknown> = {
	type: 'object',
	required: ['type', 'title', 'status', 'detail', 'instance'],
	properties: {
		type: { type: 'string', format: 'uri' },
		title: { type: 'string' },
		status: { type: 'integer' },
		detail: { type: 'string' },
		instance: { type: 'string' },
		errors: {
			type: 'array',
			items: {
				type: 'object',
				required: ['path', 'message'],
				properties: {
					path: { type: 'string' },
					message: { type: 'string' }
				},
				additionalProperties: true
			}
		}
	},
	additionalProperties: true
};

const ENVELOPE: Record<string, unknown> = {
	type: 'object',
	required: [
		'id',
		'organizationId',
		'title',
		'status',
		'repositoryGeneration',
		'fieldGeneration',
		'createdAt',
		'updatedAt'
	],
	properties: {
		id: UUIDV7,
		organizationId: { type: 'string' },
		title: { type: 'string' },
		status: {
			type: 'string',
			enum: ['draft', 'ready', 'sent', 'in_progress', 'completed', 'declined', 'expired', 'voided']
		},
		repositoryGeneration: { type: 'integer' },
		repositoryHead: { type: ['string', 'null'] },
		repositoryArchiveKey: { type: ['string', 'null'] },
		repositoryArchiveSha256: { type: ['string', 'null'] },
		sentCommitSha: { type: ['string', 'null'] },
		fieldGeneration: { type: 'integer' },
		createdAt: { type: 'string', format: 'date-time' },
		updatedAt: { type: 'string', format: 'date-time' }
	},
	additionalProperties: true
};

const JSON_BODY: Record<string, unknown> = {
	required: true,
	content: { 'application/json': { schema: { type: 'object' } } }
};

const PROBLEM_RESPONSES: Record<string, unknown> = {
	'400': {
		description: 'Validation failed',
		content: {
			'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetail' } }
		}
	},
	'401': {
		description: 'Authentication required',
		content: {
			'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetail' } }
		}
	},
	'403': {
		description: 'Forbidden',
		content: {
			'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetail' } }
		}
	},
	'404': {
		description: 'Not found',
		content: {
			'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetail' } }
		}
	},
	'409': {
		description: 'Conflict',
		content: {
			'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetail' } }
		}
	},
	'413': {
		description: 'Request body too large',
		content: {
			'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetail' } }
		}
	},
	'415': {
		description: 'Unsupported media type',
		content: {
			'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetail' } }
		}
	},
	'503': {
		description: 'Service unavailable',
		content: {
			'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetail' } }
		}
	}
};

function jsonResponse(status: string, description: string, schema: Record<string, unknown>) {
	return {
		[status]: {
			description,
			content: { 'application/json': { schema } }
		}
	};
}

function op(input: {
	summary: string;
	operationId: string;
	tags: readonly string[];
	security?: readonly Record<string, readonly string[]>[];
	parameters?: unknown[];
	requestBody?: unknown;
	responses: Record<string, unknown>;
}): Record<string, unknown> {
	return {
		summary: input.summary,
		operationId: input.operationId,
		tags: [...input.tags],
		security: input.security ?? [{ SignKitApiKey: [] }, { SessionCookie: [] }],
		...(input.parameters === undefined ? {} : { parameters: input.parameters }),
		...(input.requestBody === undefined ? {} : { requestBody: input.requestBody }),
		responses: { ...input.responses, ...PROBLEM_RESPONSES }
	};
}

const envelopeIdParam = {
	name: 'envelopeId',
	in: 'path',
	required: true,
	schema: UUIDV7
};

const webhookIdParam = {
	name: 'webhookId',
	in: 'path',
	required: true,
	schema: UUIDV7
};

const idempotencyHeader = {
	name: 'Idempotency-Key',
	in: 'header',
	required: true,
	schema: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[\\x21-\\x7E]+$' }
};

const organizationHeader = {
	name: 'SignKit-Organization-Id',
	in: 'header',
	required: false,
	schema: { type: 'string', minLength: 1, maxLength: 200 },
	description: 'Required for API-key requests. Ignored for interactive sessions.'
};

/**
 * OpenAPI 3.1 document for the live `/api/v1` surface. Paths and bodies match
 * the implemented HTTP handlers; this is discovery, not a second contract.
 */
export function openApiDocument(): Record<string, unknown> {
	return {
		openapi: '3.1.0',
		info: {
			title: 'SignKit API',
			version: 'v1',
			description:
				'Agent-first e-signature HTTP API. Errors use RFC 9457 `application/problem+json`.'
		},
		jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
		servers: [{ url: '/' }],
		tags: [
			{ name: 'System' },
			{ name: 'Envelopes' },
			{ name: 'Webhooks' },
			{ name: 'API keys' },
			{ name: 'Instance' },
			{ name: 'Signing' },
			{ name: 'Completion artifacts' }
		],
		paths: {
			'/api/v1/system/capabilities': {
				get: op({
					summary: 'Read system capabilities',
					operationId: 'getCapabilities',
					tags: ['System'],
					security: [],
					responses: jsonResponse('200', 'Capability advertisement', { type: 'object' })
				})
			},
			'/api/v1/openapi.json': {
				get: op({
					summary: 'Read this OpenAPI 3.1 document',
					operationId: 'getOpenApiDocument',
					tags: ['System'],
					security: [],
					responses: jsonResponse('200', 'OpenAPI 3.1 document', { type: 'object' })
				})
			},
			'/api/v1/envelopes': {
				get: op({
					summary: 'List envelopes in the authorized organization',
					operationId: 'listEnvelopes',
					tags: ['Envelopes'],
					parameters: [
						organizationHeader,
						{
							name: 'cursor',
							in: 'query',
							required: false,
							schema: UUIDV7
						},
						{
							name: 'limit',
							in: 'query',
							required: false,
							schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
						}
					],
					responses: jsonResponse('200', 'Envelope page', {
						type: 'object',
						required: ['items', 'nextCursor'],
						properties: {
							items: { type: 'array', items: { $ref: '#/components/schemas/Envelope' } },
							nextCursor: { type: ['string', 'null'] }
						}
					})
				}),
				post: op({
					summary: 'Create a draft envelope',
					operationId: 'createEnvelope',
					tags: ['Envelopes'],
					parameters: [organizationHeader, idempotencyHeader],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['title'],
									additionalProperties: false,
									properties: { title: { type: 'string', minLength: 1, maxLength: 200 } }
								}
							}
						}
					},
					responses: jsonResponse('201', 'Created envelope', {
						type: 'object',
						required: ['envelope'],
						properties: { envelope: { $ref: '#/components/schemas/Envelope' } }
					})
				})
			},
			'/api/v1/envelopes/{envelopeId}': {
				get: op({
					summary: 'Get an envelope',
					operationId: 'getEnvelope',
					tags: ['Envelopes'],
					parameters: [organizationHeader, envelopeIdParam],
					responses: jsonResponse('200', 'Envelope', {
						type: 'object',
						required: ['envelope'],
						properties: { envelope: { $ref: '#/components/schemas/Envelope' } }
					})
				})
			},
			'/api/v1/envelopes/{envelopeId}/draft': {
				get: op({
					summary: 'Read the current draft workspace',
					operationId: 'getEnvelopeDraft',
					tags: ['Envelopes'],
					parameters: [organizationHeader, envelopeIdParam],
					responses: jsonResponse('200', 'Draft workspace snapshot', { type: 'object' })
				})
			},
			'/api/v1/envelopes/{envelopeId}/draft/commits': {
				post: op({
					summary: 'Commit draft Markdown edits',
					operationId: 'commitEnvelopeDraft',
					tags: ['Envelopes'],
					parameters: [organizationHeader, envelopeIdParam, idempotencyHeader],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['expectedGeneration', 'message', 'edits'],
									additionalProperties: false,
									properties: {
										expectedGeneration: { type: 'integer', minimum: 0 },
										message: { type: 'string', minLength: 1, maxLength: 200 },
										edits: {
											type: 'array',
											minItems: 1,
											maxItems: 50,
											items: {
												type: 'object',
												required: ['path', 'content'],
												additionalProperties: false,
												properties: {
													path: { type: 'string' },
													content: { type: 'string' }
												}
											}
										},
										provenance: {
											type: 'object',
											additionalProperties: false,
											properties: {
												automationRunId: { type: 'string' },
												externalId: { type: 'string' }
											}
										}
									}
								}
							}
						}
					},
					responses: jsonResponse('201', 'Draft revision', { type: 'object' })
				})
			},
			'/api/v1/envelopes/{envelopeId}/ready': {
				post: op({
					summary: 'Prepare a draft envelope for sending',
					operationId: 'readyEnvelope',
					tags: ['Envelopes'],
					parameters: [organizationHeader, envelopeIdParam, idempotencyHeader],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['expectedGeneration', 'recipients'],
									additionalProperties: false,
									properties: {
										expectedGeneration: { type: 'integer', minimum: 1 },
										recipients: {
											type: 'array',
											minItems: 1,
											maxItems: 50,
											items: {
												type: 'object',
												required: ['email', 'name', 'role', 'locale', 'routingOrder'],
												additionalProperties: false,
												properties: {
													email: { type: 'string', format: 'email' },
													name: { type: 'string' },
													role: { type: 'string', enum: [...recipientRoles] },
													locale: { type: 'string', enum: ['en', 'ja'] },
													routingOrder: { type: 'integer', minimum: 1, maximum: 1000 }
												}
											}
										}
									}
								}
							}
						}
					},
					responses: jsonResponse('200', 'Ready receipt', { type: 'object' })
				})
			},
			'/api/v1/envelopes/{envelopeId}/fields': {
				post: op({
					summary: 'Place fields on a ready envelope',
					operationId: 'placeEnvelopeFields',
					tags: ['Envelopes'],
					parameters: [organizationHeader, envelopeIdParam, idempotencyHeader],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['expectedGeneration', 'expectedFieldGeneration', 'fields'],
									additionalProperties: false,
									properties: {
										expectedGeneration: { type: 'integer', minimum: 1 },
										expectedFieldGeneration: { type: 'integer', minimum: 0 },
										fields: {
											type: 'array',
											minItems: 1,
											maxItems: 50,
											items: {
												type: 'object',
												required: [
													'recipientId',
													'documentPath',
													'fieldType',
													'label',
													'required',
													'position'
												],
												additionalProperties: false,
												properties: {
													recipientId: UUIDV7,
													documentPath: { type: 'string' },
													fieldType: { type: 'string', enum: [...fieldTypes] },
													label: { type: 'string' },
													required: { type: 'boolean' },
													position: { type: 'integer', minimum: 0, maximum: 100000 }
												}
											}
										}
									}
								}
							}
						}
					},
					responses: jsonResponse('200', 'Field placement receipt', { type: 'object' })
				})
			},
			'/api/v1/envelopes/{envelopeId}/send': {
				post: op({
					summary: 'Send a ready envelope',
					operationId: 'sendEnvelope',
					tags: ['Envelopes'],
					parameters: [organizationHeader, envelopeIdParam, idempotencyHeader],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['expectedGeneration', 'expectedReadyAuditEventId'],
									additionalProperties: false,
									properties: {
										expectedGeneration: { type: 'integer', minimum: 1 },
										expectedReadyAuditEventId: UUIDV7
									}
								}
							}
						}
					},
					responses: jsonResponse('202', 'Send receipt', { type: 'object' })
				})
			},
			'/api/v1/envelopes/{envelopeId}/void': {
				post: op({
					summary: 'Void an envelope',
					operationId: 'voidEnvelope',
					tags: ['Envelopes'],
					parameters: [organizationHeader, envelopeIdParam, idempotencyHeader],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['expectedStatus', 'expectedGeneration'],
									additionalProperties: false,
									properties: {
										expectedStatus: {
											type: 'string',
											enum: ['draft', 'ready', 'sent', 'in_progress']
										},
										expectedGeneration: { type: 'integer', minimum: 0 }
									}
								}
							}
						}
					},
					responses: jsonResponse('200', 'Void receipt', { type: 'object' })
				})
			},
			'/api/v1/envelopes/{envelopeId}/deliveries': {
				get: op({
					summary: 'Read invitation delivery status',
					operationId: 'getEnvelopeDeliveries',
					tags: ['Envelopes'],
					parameters: [organizationHeader, envelopeIdParam],
					responses: jsonResponse('200', 'Delivery status', { type: 'object' })
				})
			},
			'/api/v1/envelopes/{envelopeId}/completion-artifact': {
				get: op({
					summary: 'Read completion artifact publication status',
					operationId: 'getEnvelopeCompletionArtifact',
					tags: ['Envelopes', 'Completion artifacts'],
					parameters: [organizationHeader, envelopeIdParam],
					responses: jsonResponse('200', 'Completion artifact status', { type: 'object' })
				})
			},
			'/api/v1/webhooks': {
				get: op({
					summary: 'List organization webhook endpoints',
					operationId: 'listWebhooks',
					tags: ['Webhooks'],
					security: [{ SessionCookie: [] }],
					parameters: [
						{
							name: 'cursor',
							in: 'query',
							required: false,
							schema: { type: 'string' }
						},
						{
							name: 'limit',
							in: 'query',
							required: false,
							schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
						}
					],
					responses: jsonResponse('200', 'Webhook page', { type: 'object' })
				}),
				post: op({
					summary: 'Create a webhook endpoint',
					operationId: 'createWebhook',
					tags: ['Webhooks'],
					security: [{ SessionCookie: [] }],
					parameters: [idempotencyHeader],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['url', 'events'],
									additionalProperties: false,
									properties: {
										url: { type: 'string', minLength: 12, maxLength: 2000 },
										description: { type: ['string', 'null'], maxLength: 200 },
										events: {
											type: 'array',
											minItems: 1,
											maxItems: 20,
											items: {
												type: 'string',
												enum: [...WEBHOOK_AUDIT_EVENT_TYPES]
											}
										}
									}
								}
							}
						}
					},
					responses: jsonResponse('201', 'Created webhook and one-time secret', { type: 'object' })
				})
			},
			'/api/v1/webhooks/{webhookId}': {
				get: op({
					summary: 'Get a webhook endpoint',
					operationId: 'getWebhook',
					tags: ['Webhooks'],
					security: [{ SessionCookie: [] }],
					parameters: [webhookIdParam],
					responses: jsonResponse('200', 'Webhook endpoint', { type: 'object' })
				})
			},
			'/api/v1/webhooks/{webhookId}/revoke': {
				post: op({
					summary: 'Revoke a webhook endpoint',
					operationId: 'revokeWebhook',
					tags: ['Webhooks'],
					security: [{ SessionCookie: [] }],
					parameters: [webhookIdParam, idempotencyHeader],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: { type: 'object', additionalProperties: false, properties: {} }
							}
						}
					},
					responses: jsonResponse('200', 'Revoked webhook', { type: 'object' })
				})
			},
			'/api/v1/webhooks/{webhookId}/deliveries': {
				get: op({
					summary: 'List webhook delivery attempts',
					operationId: 'listWebhookDeliveries',
					tags: ['Webhooks'],
					security: [{ SessionCookie: [] }],
					parameters: [webhookIdParam],
					responses: jsonResponse('200', 'Webhook delivery log page', { type: 'object' })
				})
			},
			'/api/v1/system/webhooks/drain': {
				post: op({
					summary: 'Drain pending webhook deliveries',
					operationId: 'drainWebhooks',
					tags: ['Webhooks', 'System'],
					security: [{ DeliveryWorkerSecret: [] }],
					responses: jsonResponse('200', 'Drain batch result', { type: 'object' })
				})
			},
			'/api/v1/system/deliveries/drain': {
				post: op({
					summary: 'Drain pending invitation deliveries',
					operationId: 'drainDeliveries',
					tags: ['System'],
					security: [{ DeliveryWorkerSecret: [] }],
					responses: jsonResponse('200', 'Drain batch result', { type: 'object' })
				})
			},
			'/api/v1/system/deliveries/reseal-sweep': {
				post: op({
					summary: 'Reseal outstanding delivery capabilities',
					operationId: 'sweepDeliveryReseal',
					tags: ['System'],
					security: [{ DeliveryWorkerSecret: [] }],
					responses: jsonResponse('200', 'Sweep batch result', { type: 'object' })
				})
			},
			'/api/v1/system/completion-artifacts/drain': {
				post: op({
					summary: 'Drain pending completion artifact publication',
					operationId: 'drainCompletionArtifacts',
					tags: ['System', 'Completion artifacts'],
					security: [{ DeliveryWorkerSecret: [] }],
					responses: jsonResponse('200', 'Drain batch result', { type: 'object' })
				})
			},
			'/api/v1/system/completion-deliveries/drain': {
				post: op({
					summary: 'Drain pending completion deliveries',
					operationId: 'drainCompletionDeliveries',
					tags: ['System', 'Completion artifacts'],
					security: [{ DeliveryWorkerSecret: [] }],
					responses: jsonResponse('200', 'Drain batch result', { type: 'object' })
				})
			},
			'/api/v1/system/completion-deliveries/reseal-sweep': {
				post: op({
					summary: 'Reseal outstanding completion tokens',
					operationId: 'sweepCompletionDeliveryReseal',
					tags: ['System', 'Completion artifacts'],
					security: [{ DeliveryWorkerSecret: [] }],
					responses: jsonResponse('200', 'Sweep batch result', { type: 'object' })
				})
			},
			'/api/v1/system/envelopes/expiry-drain': {
				post: op({
					summary: 'Expire lapsed sent envelopes',
					operationId: 'drainEnvelopeExpiry',
					tags: ['System'],
					security: [{ DeliveryWorkerSecret: [] }],
					responses: jsonResponse('200', 'Drain batch result', { type: 'object' })
				})
			},
			'/api/v1/system/objects/orphan-sweep': {
				post: op({
					summary: 'Sweep unreferenced object-store uploads past the grace period',
					operationId: 'sweepOrphanObjects',
					tags: ['System'],
					security: [{ DeliveryWorkerSecret: [] }],
					responses: jsonResponse('200', 'Sweep batch result', { type: 'object' })
				})
			},
			'/api/v1/api-keys': {
				get: op({
					summary: 'List API keys owned by the caller',
					operationId: 'listApiKeys',
					tags: ['API keys'],
					security: [{ SessionCookie: [] }],
					responses: jsonResponse('200', 'API key page', { type: 'object' })
				}),
				post: op({
					summary: 'Mint an API key',
					operationId: 'createApiKey',
					tags: ['API keys'],
					security: [{ SessionCookie: [] }],
					parameters: [idempotencyHeader],
					requestBody: JSON_BODY,
					responses: jsonResponse('201', 'Created API key and one-time token', { type: 'object' })
				})
			},
			'/api/v1/api-keys/{apiKeyId}/revoke': {
				post: op({
					summary: 'Revoke an API key',
					operationId: 'revokeApiKey',
					tags: ['API keys'],
					security: [{ SessionCookie: [] }],
					parameters: [
						{ name: 'apiKeyId', in: 'path', required: true, schema: UUIDV7 },
						idempotencyHeader
					],
					requestBody: JSON_BODY,
					responses: jsonResponse('200', 'Revoked API key', { type: 'object' })
				})
			},
			'/api/v1/api-keys/{apiKeyId}/organization-grants': {
				get: op({
					summary: 'List organization grants for an API key',
					operationId: 'listApiKeyOrganizationGrants',
					tags: ['API keys'],
					security: [{ SessionCookie: [] }],
					parameters: [{ name: 'apiKeyId', in: 'path', required: true, schema: UUIDV7 }],
					responses: jsonResponse('200', 'Grant page', { type: 'object' })
				}),
				post: op({
					summary: 'Grant an API key access to an organization',
					operationId: 'createApiKeyOrganizationGrant',
					tags: ['API keys'],
					security: [{ SessionCookie: [] }],
					parameters: [
						{ name: 'apiKeyId', in: 'path', required: true, schema: UUIDV7 },
						idempotencyHeader
					],
					requestBody: JSON_BODY,
					responses: jsonResponse('201', 'Created grant', { type: 'object' })
				})
			},
			'/api/v1/api-keys/{apiKeyId}/organization-grants/{grantId}/revoke': {
				post: op({
					summary: 'Revoke an API key organization grant',
					operationId: 'revokeApiKeyOrganizationGrant',
					tags: ['API keys'],
					security: [{ SessionCookie: [] }],
					parameters: [
						{ name: 'apiKeyId', in: 'path', required: true, schema: UUIDV7 },
						{ name: 'grantId', in: 'path', required: true, schema: UUIDV7 },
						idempotencyHeader
					],
					requestBody: JSON_BODY,
					responses: jsonResponse('200', 'Revoked grant', { type: 'object' })
				})
			},
			'/api/v1/instance/bootstrap': {
				post: op({
					summary: 'Bootstrap the instance',
					operationId: 'bootstrapInstance',
					tags: ['Instance'],
					security: [{ BootstrapSecret: [] }],
					requestBody: JSON_BODY,
					responses: jsonResponse('200', 'Bootstrap result', { type: 'object' })
				})
			},
			'/api/v1/instance/members': {
				get: op({
					summary: 'List instance members',
					operationId: 'listInstanceMembers',
					tags: ['Instance'],
					security: [{ SessionCookie: [] }],
					responses: jsonResponse('200', 'Member page', { type: 'object' })
				})
			},
			'/api/v1/instance/members/me': {
				get: op({
					summary: 'Read the caller instance membership',
					operationId: 'getInstanceMemberMe',
					tags: ['Instance'],
					security: [{ SessionCookie: [] }],
					responses: jsonResponse('200', 'Caller membership', { type: 'object' })
				})
			},
			'/api/v1/instance/members/{userId}/role': {
				post: op({
					summary: 'Change an instance member role',
					operationId: 'changeInstanceMemberRole',
					tags: ['Instance'],
					security: [{ SessionCookie: [] }],
					parameters: [
						{ name: 'userId', in: 'path', required: true, schema: { type: 'string' } },
						idempotencyHeader
					],
					requestBody: JSON_BODY,
					responses: jsonResponse('200', 'Updated membership', { type: 'object' })
				})
			},
			'/api/v1/instance/members/{userId}/status': {
				post: op({
					summary: 'Change an instance member status',
					operationId: 'changeInstanceMemberStatus',
					tags: ['Instance'],
					security: [{ SessionCookie: [] }],
					parameters: [
						{ name: 'userId', in: 'path', required: true, schema: { type: 'string' } },
						idempotencyHeader
					],
					requestBody: JSON_BODY,
					responses: jsonResponse('200', 'Updated membership', { type: 'object' })
				})
			},
			'/api/v1/instance/invitations': {
				get: op({
					summary: 'List instance invitations',
					operationId: 'listInstanceInvitations',
					tags: ['Instance'],
					security: [{ SessionCookie: [] }],
					responses: jsonResponse('200', 'Invitation page', { type: 'object' })
				}),
				post: op({
					summary: 'Create an instance invitation',
					operationId: 'createInstanceInvitation',
					tags: ['Instance'],
					security: [{ SessionCookie: [] }],
					parameters: [idempotencyHeader],
					requestBody: JSON_BODY,
					responses: jsonResponse('201', 'Created invitation and one-time token', {
						type: 'object'
					})
				})
			},
			'/api/v1/instance/invitations/accept': {
				post: op({
					summary: 'Accept an instance invitation',
					operationId: 'acceptInstanceInvitation',
					tags: ['Instance'],
					security: [{ SessionCookie: [] }],
					parameters: [idempotencyHeader],
					requestBody: JSON_BODY,
					responses: jsonResponse('200', 'Accepted invitation', { type: 'object' })
				})
			},
			'/api/v1/instance/invitations/{invitationId}/revoke': {
				post: op({
					summary: 'Revoke an instance invitation',
					operationId: 'revokeInstanceInvitation',
					tags: ['Instance'],
					security: [{ SessionCookie: [] }],
					parameters: [
						{ name: 'invitationId', in: 'path', required: true, schema: UUIDV7 },
						idempotencyHeader
					],
					requestBody: JSON_BODY,
					responses: jsonResponse('200', 'Revoked invitation', { type: 'object' })
				})
			},
			'/api/v1/signing/context': {
				get: op({
					summary: 'Read recipient signing context',
					operationId: 'getSigningContext',
					tags: ['Signing'],
					security: [{ RecipientCapability: [] }],
					responses: jsonResponse('200', 'Signing context', { type: 'object' })
				})
			},
			'/api/v1/signing/documents': {
				get: op({
					summary: 'Read recipient documents',
					operationId: 'getSigningDocuments',
					tags: ['Signing'],
					security: [{ RecipientCapability: [] }],
					responses: jsonResponse('200', 'Documents', { type: 'object' })
				})
			},
			'/api/v1/signing/viewed': {
				post: op({
					summary: 'Record a recipient view',
					operationId: 'recordSigningViewed',
					tags: ['Signing'],
					security: [{ RecipientCapability: [] }],
					requestBody: JSON_BODY,
					responses: jsonResponse('200', 'View recorded', { type: 'object' })
				})
			},
			'/api/v1/signing/decline': {
				post: op({
					summary: 'Decline an envelope as a recipient',
					operationId: 'declineSigning',
					tags: ['Signing'],
					security: [{ RecipientCapability: [] }],
					requestBody: JSON_BODY,
					responses: jsonResponse('200', 'Decline receipt', { type: 'object' })
				})
			},
			'/api/v1/signing/approve': {
				post: op({
					summary: 'Approve an envelope as a recipient',
					operationId: 'approveSigning',
					tags: ['Signing'],
					security: [{ RecipientCapability: [] }],
					requestBody: JSON_BODY,
					responses: jsonResponse('200', 'Approval receipt', { type: 'object' })
				})
			},
			'/api/v1/signing/sign': {
				post: op({
					summary: 'Sign an envelope as a recipient',
					operationId: 'signSigning',
					tags: ['Signing'],
					security: [{ RecipientCapability: [] }],
					requestBody: JSON_BODY,
					responses: jsonResponse('200', 'Signature receipt', { type: 'object' })
				})
			},
			'/api/v1/completion-artifacts': {
				get: op({
					summary: 'Read a public completion artifact',
					operationId: 'getPublicCompletionArtifact',
					tags: ['Completion artifacts'],
					security: [{ CompletionArtifactGrant: [] }],
					responses: jsonResponse('200', 'Public completion artifact', { type: 'object' })
				})
			}
		},
		components: {
			securitySchemes: {
				SignKitApiKey: {
					type: 'http',
					scheme: 'bearer',
					bearerFormat: 'signkit',
					description:
						'Organization-scoped API key. Requires SignKit-Organization-Id. Live scopes: envelopes:read, drafts:write, envelopes:send.'
				},
				SessionCookie: {
					type: 'apiKey',
					in: 'cookie',
					name: 'signkit_session'
				},
				DeliveryWorkerSecret: {
					type: 'http',
					scheme: 'bearer',
					description: 'Deployment worker secret for drain endpoints.'
				},
				BootstrapSecret: {
					type: 'http',
					scheme: 'bearer',
					description: 'Instance bootstrap secret. Failures are opaque 404.'
				},
				RecipientCapability: {
					type: 'http',
					scheme: 'bearer',
					bearerFormat: 'skr1'
				},
				CompletionArtifactGrant: {
					type: 'http',
					scheme: 'bearer',
					bearerFormat: 'skca1'
				}
			},
			schemas: {
				ProblemDetail: PROBLEM,
				Envelope: ENVELOPE
			}
		}
	};
}
