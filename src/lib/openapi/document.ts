import { WEBHOOK_AUDIT_EVENT_TYPES } from '$lib/domain/audit';
import { recipientRoles, fieldTypes } from '$lib/domain/envelope';
import { MAX_SIGNATURE_ASSET_BYTES } from '$lib/application/documents/signature-asset';

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
		'createdByUserId',
		'title',
		'status',
		'repositoryGeneration',
		'fieldGeneration',
		'createdAt',
		'updatedAt'
	],
	properties: {
		id: UUIDV7,
		createdByUserId: { type: 'string' },
		title: { type: 'string' },
		status: {
			type: 'string',
			enum: ['draft', 'ready', 'sent', 'in_progress', 'completed', 'declined', 'expired', 'voided']
		},
		repositoryGeneration: { type: 'integer' },
		repositoryHead: {
			type: ['string', 'null'],
			description: 'Current Git commit SHA. A content identifier, not an object-store key.'
		},
		repositoryArchiveSha256: {
			type: ['string', 'null'],
			description: 'SHA-256 digest of the draft archive bytes. Not a storage locator.'
		},
		sentCommitSha: {
			type: ['string', 'null'],
			description: 'Git commit SHA pinned at send. A content identifier, not an object-store key.'
		},
		fieldGeneration: { type: 'integer' },
		createdAt: { type: 'string', format: 'date-time' },
		updatedAt: { type: 'string', format: 'date-time' }
	},
	additionalProperties: false
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
	description?: string;
	operationId: string;
	tags: readonly string[];
	security?: readonly Record<string, readonly string[]>[];
	parameters?: unknown[];
	requestBody?: unknown;
	responses: Record<string, unknown>;
	includeProblemResponses?: boolean;
}): Record<string, unknown> {
	return {
		summary: input.summary,
		...(input.description === undefined ? {} : { description: input.description }),
		operationId: input.operationId,
		tags: [...input.tags],
		security: input.security ?? [{ SignKitApiKey: [] }, { SessionCookie: [] }],
		...(input.parameters === undefined
			? {}
			: {
					parameters: input.parameters.filter(
						(parameter: unknown): boolean => parameter !== undefined
					)
				}),
		...(input.requestBody === undefined ? {} : { requestBody: input.requestBody }),
		responses:
			input.includeProblemResponses === false
				? { ...input.responses }
				: { ...PROBLEM_RESPONSES, ...input.responses }
	};
}

const envelopeIdParam = {
	name: 'envelopeId',
	in: 'path',
	required: true,
	schema: UUIDV7
};

const documentIdQueryParam = {
	name: 'documentId',
	in: 'query',
	required: true,
	schema: UUIDV7
};

const recipientIdParam = {
	name: 'recipientId',
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

const evidenceFormatQuery = {
	name: 'format',
	in: 'query',
	required: false,
	schema: { type: 'string', enum: ['json', 'markdown'], default: 'json' },
	description:
		'Published evidence representation. Markdown is selected only when format=markdown; otherwise JSON.'
};

const publicCompletionFormatQuery = {
	name: 'format',
	in: 'query',
	required: false,
	schema: { type: 'string', enum: ['json', 'markdown', 'pdf'] },
	description:
		'Public completion representation. The API default is json; the link default is markdown. Unknown values are an opaque 404. pdf returns application/pdf bytes and is opaque 404 until the visual PDF is published.'
};

const reissueBodyProperties: Record<string, unknown> = {
	recipientId: UUIDV7,
	reason: { type: 'string', maxLength: 500 }
};

const reissueReceipt = jsonResponse('200', 'Reissue receipt without capability material', {
	type: 'object',
	required: ['reissued'],
	additionalProperties: false,
	properties: {
		reissued: {
			type: 'object',
			required: ['envelopeId', 'recipientId', 'reissuedAt'],
			additionalProperties: false,
			properties: {
				envelopeId: UUIDV7,
				recipientId: UUIDV7,
				reissuedAt: { type: 'string', format: 'date-time' }
			}
		}
	}
});

const idempotencyHeader = {
	name: 'Idempotency-Key',
	in: 'header',
	required: true,
	schema: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[\\x21-\\x7E]+$' }
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
					summary: 'List envelopes',
					operationId: 'listEnvelopes',
					tags: ['Envelopes'],
					parameters: [
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
					parameters: [idempotencyHeader],
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
					parameters: [envelopeIdParam],
					responses: jsonResponse('200', 'Envelope detail', {
						type: 'object',
						required: ['envelope', 'recipients', 'readyAuditEventId', 'fields'],
						properties: {
							envelope: { $ref: '#/components/schemas/Envelope' },
							recipients: { type: 'array', items: { type: 'object' } },
							readyAuditEventId: { type: ['string', 'null'] },
							fields: { type: 'array', items: { type: 'object' } }
						}
					})
				})
			},
			'/api/v1/envelopes/{envelopeId}/draft': {
				get: op({
					summary: 'Read the current draft workspace',
					operationId: 'getEnvelopeDraft',
					tags: ['Envelopes'],
					parameters: [envelopeIdParam],
					responses: jsonResponse('200', 'Draft workspace snapshot', { type: 'object' })
				})
			},
			'/api/v1/envelopes/{envelopeId}/draft/commits': {
				post: op({
					summary: 'Commit draft Markdown edits',
					operationId: 'commitEnvelopeDraft',
					tags: ['Envelopes'],
					parameters: [envelopeIdParam, idempotencyHeader],
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
			'/api/v1/envelopes/{envelopeId}/draft/docx': {
				post: op({
					summary: 'Import a bounded DOCX file as a Markdown draft commit',
					operationId: 'importEnvelopeDocx',
					tags: ['Envelopes'],
					parameters: [
						envelopeIdParam,
						idempotencyHeader,
						{
							name: 'targetPath',
							in: 'query',
							required: true,
							schema: { type: 'string' }
						},
						{
							name: 'expectedGeneration',
							in: 'query',
							required: true,
							schema: { type: 'integer', minimum: 0 }
						}
					],
					requestBody: {
						required: true,
						description:
							'A raw WordprocessingML DOCX body. multipart/form-data is not supported: the whole request body is bounded and streamed against the size limit before it is buffered, which a multipart wrapper cannot preserve.',
						content: {
							'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
								schema: { type: 'string', format: 'binary' }
							},
							'application/octet-stream': {
								schema: { type: 'string', format: 'binary' }
							}
						}
					},
					responses: jsonResponse('201', 'Draft revision', { type: 'object' })
				})
			},
			'/api/v1/envelopes/{envelopeId}/documents/pdf': {
				post: op({
					summary: 'Append an uploaded PDF as a document in the envelope set',
					operationId: 'uploadEnvelopePdf',
					tags: ['Envelopes'],
					parameters: [
						envelopeIdParam,
						idempotencyHeader,
						{
							name: 'expectedGeneration',
							in: 'query',
							required: true,
							schema: { type: 'integer', minimum: 0 }
						},
						{
							name: 'title',
							in: 'query',
							required: false,
							schema: { type: 'string' }
						},
						{
							name: 'position',
							in: 'query',
							required: false,
							schema: { type: 'integer', minimum: 0, maximum: 19 }
						}
					],
					requestBody: {
						required: true,
						description:
							'A raw PDF body. multipart/form-data is not supported: the whole request body is bounded and streamed against the size limit before it is buffered, which a multipart wrapper cannot preserve.',
						content: {
							'application/pdf': {
								schema: { type: 'string', format: 'binary' }
							},
							'application/octet-stream': {
								schema: { type: 'string', format: 'binary' }
							}
						}
					},
					responses: jsonResponse('201', 'Draft revision', { type: 'object' })
				})
			},
			'/api/v1/envelopes/{envelopeId}/documents/order': {
				post: op({
					summary: 'Reorder or remove documents in the envelope set',
					operationId: 'orderEnvelopeDocuments',
					tags: ['Envelopes'],
					parameters: [envelopeIdParam, idempotencyHeader],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['expectedGeneration', 'documentIds'],
									additionalProperties: false,
									properties: {
										expectedGeneration: { type: 'integer', minimum: 0 },
										documentIds: {
											type: 'array',
											minItems: 1,
											maxItems: 20,
											items: UUIDV7
										}
									}
								}
							}
						}
					},
					responses: jsonResponse('201', 'Draft revision', { type: 'object' })
				})
			},
			'/api/v1/envelopes/{envelopeId}/docx': {
				get: op({
					summary: 'Export the pinned Markdown revision as DOCX',
					operationId: 'exportEnvelopeDocx',
					tags: ['Envelopes'],
					parameters: [envelopeIdParam],
					responses: {
						'200': {
							description: 'DOCX package derived from the pinned Git commit',
							content: {
								'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
									schema: { type: 'string', format: 'binary' }
								}
							}
						}
					}
				})
			},
			'/api/v1/envelopes/{envelopeId}/ready': {
				post: op({
					summary: 'Prepare a draft envelope for sending',
					operationId: 'readyEnvelope',
					tags: ['Envelopes'],
					parameters: [envelopeIdParam, idempotencyHeader],
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
					parameters: [envelopeIdParam, idempotencyHeader],
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
													'documentId',
													'fieldType',
													'label',
													'required',
													'position',
													'geometry'
												],
												additionalProperties: false,
												properties: {
													recipientId: UUIDV7,
													documentId: UUIDV7,
													fieldType: { type: 'string', enum: [...fieldTypes] },
													label: { type: 'string' },
													required: { type: 'boolean' },
													position: { type: 'integer', minimum: 0, maximum: 100000 },
													geometry: {
														type: 'object',
														description:
															'Where the field sits on the rendered document, as unit-square fractions of one page. Required: a field a signer cannot see is a field they cannot complete. The page must belong to the named document.',
														required: ['page', 'x', 'y', 'width', 'height'],
														additionalProperties: false,
														properties: {
															page: { type: 'integer', minimum: 1, maximum: 100000 },
															x: { type: 'number', minimum: 0, maximum: 1 },
															y: { type: 'number', minimum: 0, maximum: 1 },
															width: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
															height: { type: 'number', exclusiveMinimum: 0, maximum: 1 }
														}
													}
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
					parameters: [envelopeIdParam, idempotencyHeader],
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
					parameters: [envelopeIdParam, idempotencyHeader],
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
					parameters: [envelopeIdParam],
					responses: jsonResponse('200', 'Delivery status', { type: 'object' })
				})
			},
			'/api/v1/envelopes/{envelopeId}/completion-artifact': {
				get: op({
					summary: 'Read completion artifact publication status',
					operationId: 'getEnvelopeCompletionArtifact',
					tags: ['Envelopes', 'Completion artifacts'],
					parameters: [envelopeIdParam],
					responses: jsonResponse('200', 'Completion artifact status', { type: 'object' })
				})
			},
			'/api/v1/envelopes/{envelopeId}/evidence': {
				get: op({
					summary: 'Download published completion evidence',
					operationId: 'getEnvelopeEvidence',
					tags: ['Envelopes', 'Completion artifacts'],
					parameters: [envelopeIdParam, evidenceFormatQuery],
					responses: {
						'200': {
							description:
								'Immutable JSON or Markdown evidence bytes. Never includes object-store keys.',
							content: {
								'application/json': { schema: { type: 'object' } },
								'text/markdown': { schema: { type: 'string' } }
							}
						}
					}
				})
			},
			'/api/v1/envelopes/{envelopeId}/completion-artifact/evidence': {
				get: op({
					summary: 'Download published completion evidence',
					operationId: 'getEnvelopeCompletionArtifactEvidence',
					tags: ['Envelopes', 'Completion artifacts'],
					parameters: [envelopeIdParam, evidenceFormatQuery],
					responses: {
						'200': {
							description: 'Alias of GET /api/v1/envelopes/{envelopeId}/evidence.',
							content: {
								'application/json': { schema: { type: 'object' } },
								'text/markdown': { schema: { type: 'string' } }
							}
						}
					}
				})
			},
			'/api/v1/envelopes/{envelopeId}/document-pdf': {
				get: op({
					summary:
						'Render one document from the pinned revision as the PDF a recipient will be shown',
					operationId: 'getEnvelopeDocumentPdf',
					tags: ['Envelopes', 'Documents'],
					parameters: [envelopeIdParam, documentIdQueryParam],
					responses: {
						'200': {
							description: 'Deterministic application/pdf rendering of the pinned revision.',
							content: {
								'application/pdf': { schema: { type: 'string', format: 'binary' } }
							}
						}
					}
				})
			},
			'/api/v1/envelopes/{envelopeId}/document-pdf/pages': {
				get: op({
					summary: 'Read page geometry for one document and the ordered document-set summary',
					operationId: 'getEnvelopeDocumentPdfPages',
					tags: ['Envelopes', 'Documents'],
					parameters: [envelopeIdParam, documentIdQueryParam],
					responses: {
						'200': {
							description: 'Page geometry for the pinned revision.',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										required: [
											'commitSha',
											'generation',
											'documentId',
											'pageCount',
											'pageWidth',
											'pageHeight',
											'documents'
										],
										properties: {
											commitSha: { type: 'string' },
											generation: { type: 'integer' },
											documentId: UUIDV7,
											pageCount: { type: 'integer' },
											pageWidth: { type: 'number' },
											pageHeight: { type: 'number' },
											documents: {
												type: 'array',
												items: {
													type: 'object',
													required: [
														'documentId',
														'position',
														'kind',
														'title',
														'pageCount',
														'pageWidth',
														'pageHeight'
													],
													properties: {
														documentId: UUIDV7,
														position: { type: 'integer' },
														kind: { type: 'string', enum: ['markdown', 'pdf'] },
														title: { type: 'string' },
														pageCount: { type: 'integer' },
														pageWidth: { type: 'number' },
														pageHeight: { type: 'number' }
													}
												}
											}
										}
									}
								}
							}
						}
					}
				})
			},
			'/api/v1/envelopes/{envelopeId}/pdf': {
				get: op({
					summary: 'Download the published executed agreement PDF',
					operationId: 'getEnvelopePdf',
					tags: ['Envelopes', 'Completion artifacts'],
					parameters: [envelopeIdParam],
					responses: {
						'200': {
							description:
								'Verified application/pdf bytes. Cryptographic PAdES sealing is not included.',
							content: {
								'application/pdf': { schema: { type: 'string', format: 'binary' } }
							}
						}
					}
				})
			},
			'/api/v1/envelopes/{envelopeId}/completion-artifact/pdf': {
				get: op({
					summary: 'Download the published executed agreement PDF',
					operationId: 'getEnvelopeCompletionArtifactPdf',
					tags: ['Envelopes', 'Completion artifacts'],
					parameters: [envelopeIdParam],
					responses: {
						'200': {
							description: 'Alias of GET /api/v1/envelopes/{envelopeId}/pdf.',
							content: {
								'application/pdf': { schema: { type: 'string', format: 'binary' } }
							}
						}
					}
				})
			},
			'/api/v1/envelopes/{envelopeId}/reissue': {
				post: op({
					summary: 'Reissue a recipient capability',
					operationId: 'reissueEnvelopeRecipientCapability',
					tags: ['Envelopes'],
					security: [{ SessionCookie: [] }],
					parameters: [envelopeIdParam, idempotencyHeader],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['recipientId'],
									additionalProperties: false,
									properties: reissueBodyProperties
								}
							}
						}
					},
					responses: reissueReceipt
				})
			},
			'/api/v1/envelopes/{envelopeId}/recipients/{recipientId}/reissue': {
				post: op({
					summary: 'Reissue that recipient capability',
					operationId: 'reissueNamedRecipientCapability',
					tags: ['Envelopes'],
					security: [{ SessionCookie: [] }],
					parameters: [envelopeIdParam, recipientIdParam, idempotencyHeader],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									additionalProperties: false,
									properties: reissueBodyProperties
								}
							}
						}
					},
					responses: reissueReceipt
				})
			},
			'/api/v1/webhooks': {
				get: op({
					summary: 'List instance webhook endpoints',
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
					description:
						'The destination host must be in the deployer-configured SIGNKIT_WEBHOOK_ALLOWED_HOSTS allowlist (exact hosts and explicit wildcard suffixes of at least three labels). An absent, empty, or invalid allowlist denies creation by default; the policy is re-evaluated on every delivery attempt with redirects disabled.',
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
										url: {
											type: 'string',
											minLength: 12,
											maxLength: 2000,
											description:
												'HTTPS destination URL on the default port without credentials or fragment. The host must be allowlisted by the deployment; otherwise creation fails.'
										},
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
			'/api/v1/instance/bootstrap': {
				post: op({
					summary: 'Bootstrap the instance',
					operationId: 'bootstrapInstance',
					description:
						'Cookie-session-only first-owner claim on an empty instance. Uninitialized instances fail closed: the verified session email must exactly match the deployer-configured SIGNKIT_BOOTSTRAP_OWNER_EMAIL (403 bootstrap-owner-mismatch otherwise), or the local-development-only SIGNKIT_ALLOW_UNSAFE_FIRST_USER_BOOTSTRAP opt-in must apply on Node with NODE_ENV=development and a loopback public origin (403 bootstrap-owner-required otherwise). Runtime mode and public origin are independent checks, so a production proxy misconfigured with a loopback origin stays closed. A mismatched or unconfigured attempt never consumes the single empty-instance window. Already-bootstrapped instances answer 409.',
					tags: ['Instance'],
					security: [{ SessionCookie: [] }],
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
			'/api/v1/signing/signature-assets': {
				post: op({
					summary: 'Upload a same-origin drawn signature PNG',
					operationId: 'storeSigningSignatureAsset',
					tags: ['Signing'],
					security: [{ RecipientSessionCookie: [] }],
					parameters: [
						{
							name: 'envelopeId',
							in: 'query',
							required: true,
							schema: UUIDV7
						},
						{
							name: 'recipientId',
							in: 'query',
							required: true,
							schema: UUIDV7
						}
					],
					requestBody: {
						required: true,
						description: `Same-origin image/png body, at most ${MAX_SIGNATURE_ASSET_BYTES} bytes. Content-addressed; no Idempotency-Key.`,
						content: {
							'image/png': {
								schema: { type: 'string', format: 'binary' }
							}
						}
					},
					responses: jsonResponse('201', 'Stored signature asset reference', {
						type: 'object',
						required: ['assetRef'],
						additionalProperties: false,
						properties: {
							assetRef: {
								type: 'string',
								description: 'Content-addressed sig:sha256 digest. Not an object-store key.'
							}
						}
					})
				})
			},
			'/api/v1/completion-artifacts': {
				get: op({
					summary: 'Read a public completion artifact',
					operationId: 'getPublicCompletionArtifact',
					tags: ['Completion artifacts'],
					security: [{ CompletionArtifactGrant: [] }],
					includeProblemResponses: false,
					parameters: [publicCompletionFormatQuery],
					responses: {
						'200': {
							description:
								'Published completion artifact for a valid skca1 grant. Never includes storage keys, tenant IDs, or cookies.',
							content: {
								'application/json': { schema: { type: 'object' } },
								'text/markdown': { schema: { type: 'string' } },
								'application/pdf': { schema: { type: 'string', format: 'binary' } }
							}
						},
						'404': {
							description:
								'Opaque not found for unknown, expired, revoked, malformed, or unpublished format requests.',
							content: { 'text/plain': { schema: { type: 'string' } } }
						},
						'500': {
							description: 'Opaque internal error without tenant, object-key, or grant material.',
							content: { 'text/plain': { schema: { type: 'string' } } }
						}
					}
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
						'Instance API key. Live scopes: envelopes:read, drafts:write, envelopes:send.'
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
				RecipientCapability: {
					type: 'http',
					scheme: 'bearer',
					bearerFormat: 'skr1'
				},
				RecipientSessionCookie: {
					type: 'apiKey',
					in: 'cookie',
					name: 'signkit_recipient_{envelopeId}',
					description:
						'Envelope-scoped encrypted HttpOnly recipient session cookie from GET /s/{token}. Cookie name embeds the UUIDv7 envelope ID. Not an API key.'
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
