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

const CONTACT: Record<string, unknown> = {
	type: 'object',
	required: ['id', 'email', 'name', 'locale', 'version', 'createdAt', 'updatedAt'],
	properties: {
		id: UUIDV7,
		email: {
			type: 'string',
			format: 'email',
			maxLength: 320,
			description:
				'Trimmed, lower-case mailbox used for owner-scoped uniqueness and recipient prefilling.'
		},
		name: {
			type: 'string',
			minLength: 1,
			maxLength: 200,
			description: 'Display name copied into a recipient draft when this contact is selected.'
		},
		locale: {
			type: 'string',
			enum: ['en', 'ja'],
			description: 'Preferred recipient locale copied into a recipient draft.'
		},
		version: {
			type: 'integer',
			minimum: 1,
			maximum: 2_147_483_647,
			description: 'Optimistic-concurrency version required by replacement and deletion.'
		},
		createdAt: { type: 'string', format: 'date-time' },
		updatedAt: { type: 'string', format: 'date-time' }
	},
	additionalProperties: false
};

const FIELD_GEOMETRY: Record<string, unknown> = {
	type: 'object',
	description:
		'Where the field sits on the rendered document, as unit-square fractions of one page. Resolution- and zoom-independent.',
	required: ['page', 'x', 'y', 'width', 'height'],
	properties: {
		page: { type: 'integer', minimum: 1, maximum: 100000 },
		x: { type: 'number', minimum: 0, maximum: 1 },
		y: { type: 'number', minimum: 0, maximum: 1 },
		width: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
		height: { type: 'number', exclusiveMinimum: 0, maximum: 1 }
	},
	additionalProperties: false
};

const ENVELOPE_RECIPIENT: Record<string, unknown> = {
	type: 'object',
	description:
		'Operator-safe recipient projection. Omits capability hashes, ciphertext, and secret tokens.',
	required: ['id', 'email', 'name', 'role', 'locale', 'routingOrder', 'status'],
	properties: {
		id: UUIDV7,
		envelopeId: UUIDV7,
		email: {
			type: 'string',
			format: 'email',
			maxLength: 320,
			description: 'Lower-case normalized mailbox.'
		},
		name: { type: 'string', minLength: 1, maxLength: 200 },
		role: { type: 'string', enum: [...recipientRoles] },
		locale: { type: 'string', enum: ['en', 'ja'] },
		routingOrder: { type: 'integer', minimum: 1, maximum: 1000 },
		status: {
			type: 'string',
			enum: ['pending', 'viewed', 'completed', 'declined']
		}
	},
	additionalProperties: false
};

const ENVELOPE_FIELD: Record<string, unknown> = {
	type: 'object',
	description: 'Operator-safe field projection. Labels can carry PII and are never echoed back.',
	required: [
		'id',
		'recipientId',
		'documentId',
		'documentPath',
		'fieldType',
		'required',
		'position',
		'geometry'
	],
	properties: {
		id: UUIDV7,
		recipientId: UUIDV7,
		documentId: { anyOf: [UUIDV7, { type: 'null' }] },
		documentPath: { type: ['string', 'null'] },
		fieldType: { type: 'string', enum: [...fieldTypes] },
		required: { type: 'boolean' },
		position: { type: 'integer', minimum: 0, maximum: 100000 },
		geometry: {
			anyOf: [{ $ref: '#/components/schemas/FieldGeometry' }, { type: 'null' }]
		}
	},
	additionalProperties: false
};

const MARKDOWN_DOCUMENT_LEAF: Record<string, unknown> = {
	type: 'object',
	required: ['id', 'position', 'kind', 'title', 'path', 'contentSha256'],
	properties: {
		id: UUIDV7,
		position: { type: 'integer', minimum: 0 },
		kind: { type: 'string', enum: ['markdown'] },
		title: { type: 'string' },
		path: { type: 'string' },
		contentSha256: { type: 'string' }
	},
	additionalProperties: false
};

const PDF_DOCUMENT_LEAF: Record<string, unknown> = {
	type: 'object',
	required: [
		'id',
		'position',
		'kind',
		'title',
		'sha256',
		'byteSize',
		'pageCount',
		'pageWidth',
		'pageHeight'
	],
	properties: {
		id: UUIDV7,
		position: { type: 'integer', minimum: 0 },
		kind: { type: 'string', enum: ['pdf'] },
		title: { type: 'string' },
		sha256: { type: 'string' },
		byteSize: { type: 'integer', minimum: 0 },
		pageCount: { type: 'integer', minimum: 1 },
		pageWidth: { type: 'number', minimum: 0 },
		pageHeight: { type: 'number', minimum: 0 }
	},
	additionalProperties: false
};

const DOCUMENT_SET_LEAF: Record<string, unknown> = {
	oneOf: [
		{ $ref: '#/components/schemas/MarkdownDocumentLeaf' },
		{ $ref: '#/components/schemas/PdfDocumentLeaf' }
	]
};

const DOCUMENT_SET_MANIFEST: Record<string, unknown> = {
	type: 'object',
	required: ['schema', 'documents'],
	properties: {
		schema: { type: 'string', enum: ['signkit-document-set-v1'] },
		documents: {
			type: 'array',
			items: { $ref: '#/components/schemas/DocumentSetLeaf' }
		}
	},
	additionalProperties: false
};

const DRAFT_WORKSPACE_SNAPSHOT: Record<string, unknown> = {
	type: 'object',
	required: ['generation', 'documents'],
	properties: {
		generation: { type: 'integer', minimum: 0 },
		commitSha: { type: ['string', 'null'] },
		archiveSha256: { type: ['string', 'null'] },
		documents: {
			type: 'array',
			items: {
				type: 'object',
				required: ['path', 'content'],
				properties: {
					path: { type: 'string' },
					content: { type: 'string' }
				},
				additionalProperties: false
			}
		},
		documentSet: {
			anyOf: [{ $ref: '#/components/schemas/DocumentSetManifest' }, { type: 'null' }]
		}
	},
	additionalProperties: false
};

const DRAFT_COMMIT_REQUEST: Record<string, unknown> = {
	type: 'object',
	required: ['expectedGeneration', 'message', 'edits'],
	additionalProperties: false,
	properties: {
		expectedGeneration: { type: 'integer', minimum: 0, maximum: 2_147_483_646 },
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
					path: {
						type: 'string',
						maxLength: 240,
						pattern: '^documents/[a-zA-Z0-9][a-zA-Z0-9._-]*\\.md$'
					},
					content: { type: 'string' }
				}
			}
		},
		provenance: {
			type: 'object',
			additionalProperties: false,
			properties: {
				automationRunId: { type: 'string', minLength: 1, maxLength: 200 },
				externalId: { type: 'string', minLength: 1, maxLength: 200 }
			}
		}
	}
};

const DRAFT_REVISION_RECEIPT: Record<string, unknown> = {
	type: 'object',
	required: ['revision'],
	properties: {
		revision: {
			type: 'object',
			required: ['generation', 'commitSha', 'archiveSha256'],
			properties: {
				generation: { type: 'integer', minimum: 0 },
				commitSha: { type: 'string' },
				archiveSha256: { type: 'string' }
			},
			additionalProperties: false
		}
	},
	additionalProperties: false
};

const READY_ENVELOPE_REQUEST: Record<string, unknown> = {
	type: 'object',
	required: ['expectedGeneration', 'recipients'],
	additionalProperties: false,
	properties: {
		expectedGeneration: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
		recipients: {
			type: 'array',
			minItems: 1,
			maxItems: 50,
			items: {
				type: 'object',
				required: ['email', 'name', 'role', 'locale', 'routingOrder'],
				additionalProperties: false,
				properties: {
					email: {
						type: 'string',
						format: 'email',
						maxLength: 320,
						pattern:
							"^(?:[A-Za-z0-9_'+-]+\\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\\.)+[A-Za-z]{2,}$"
					},
					name: { type: 'string', minLength: 1, maxLength: 200 },
					role: { type: 'string', enum: ['signer', 'approver', 'viewer', 'cc'] },
					locale: { type: 'string', enum: ['en', 'ja'] },
					routingOrder: { type: 'integer', minimum: 1, maximum: 1000 }
				}
			}
		}
	}
};

const READY_ENVELOPE_RECEIPT: Record<string, unknown> = {
	type: 'object',
	required: ['ready'],
	properties: {
		ready: {
			type: 'object',
			required: [
				'envelopeId',
				'status',
				'generation',
				'commitSha',
				'recipients',
				'updatedAt',
				'auditEventId'
			],
			properties: {
				envelopeId: UUIDV7,
				status: { type: 'string', enum: ['ready'] },
				generation: { type: 'integer', minimum: 1 },
				commitSha: { type: 'string' },
				recipients: {
					type: 'array',
					items: { $ref: '#/components/schemas/EnvelopeRecipient' }
				},
				updatedAt: { type: 'string', format: 'date-time' },
				auditEventId: UUIDV7
			},
			additionalProperties: false
		}
	},
	additionalProperties: false
};

const PLACE_FIELDS_REQUEST: Record<string, unknown> = {
	type: 'object',
	required: ['expectedGeneration', 'expectedFieldGeneration', 'fields'],
	additionalProperties: false,
	properties: {
		expectedGeneration: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
		expectedFieldGeneration: { type: 'integer', minimum: 0, maximum: 2_147_483_646 },
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
					label: { type: 'string', minLength: 1, maxLength: 200 },
					required: { type: 'boolean' },
					position: { type: 'integer', minimum: 0, maximum: 100000 },
					geometry: { $ref: '#/components/schemas/FieldGeometry' }
				}
			}
		}
	}
};

const PLACE_FIELDS_RECEIPT: Record<string, unknown> = {
	type: 'object',
	required: ['fields'],
	properties: {
		fields: {
			type: 'object',
			required: [
				'envelopeId',
				'generation',
				'fieldGeneration',
				'commitSha',
				'fields',
				'updatedAt',
				'auditEventId'
			],
			properties: {
				envelopeId: UUIDV7,
				generation: { type: 'integer', minimum: 1 },
				fieldGeneration: { type: 'integer', minimum: 0 },
				commitSha: { type: 'string' },
				fields: {
					type: 'array',
					items: { $ref: '#/components/schemas/EnvelopeField' }
				},
				updatedAt: { type: 'string', format: 'date-time' },
				auditEventId: UUIDV7
			},
			additionalProperties: false
		}
	},
	additionalProperties: false
};

const SEND_ENVELOPE_REQUEST: Record<string, unknown> = {
	type: 'object',
	required: ['expectedGeneration', 'expectedReadyAuditEventId'],
	additionalProperties: false,
	properties: {
		expectedGeneration: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
		expectedReadyAuditEventId: UUIDV7
	}
};

const SEND_ENVELOPE_RECEIPT: Record<string, unknown> = {
	type: 'object',
	required: ['sent'],
	properties: {
		sent: {
			type: 'object',
			required: [
				'envelopeId',
				'status',
				'generation',
				'commitSha',
				'readyAuditEventId',
				'queuedDeliveryCount',
				'reservedCapabilityCount',
				'initialCapabilityExpiresAt',
				'updatedAt',
				'auditEventId'
			],
			properties: {
				envelopeId: UUIDV7,
				status: { type: 'string', enum: ['sent'] },
				generation: { type: 'integer', minimum: 1 },
				commitSha: { type: 'string' },
				readyAuditEventId: UUIDV7,
				queuedDeliveryCount: { type: 'integer', minimum: 0 },
				reservedCapabilityCount: { type: 'integer', minimum: 0 },
				initialCapabilityExpiresAt: { type: 'string', format: 'date-time' },
				updatedAt: { type: 'string', format: 'date-time' },
				auditEventId: UUIDV7
			},
			additionalProperties: false
		}
	},
	additionalProperties: false
};

const VOID_ENVELOPE_REQUEST: Record<string, unknown> = {
	type: 'object',
	required: ['expectedStatus', 'expectedGeneration'],
	additionalProperties: false,
	properties: {
		expectedStatus: {
			type: 'string',
			enum: ['draft', 'ready', 'sent', 'in_progress']
		},
		expectedGeneration: { type: 'integer', minimum: 0, maximum: 2_147_483_647 }
	}
};

const VOID_ENVELOPE_RECEIPT: Record<string, unknown> = {
	type: 'object',
	required: ['voided'],
	properties: {
		voided: {
			type: 'object',
			required: [
				'envelopeId',
				'status',
				'previousStatus',
				'generation',
				'voidedAt',
				'revokedCapabilityCount',
				'auditEventId'
			],
			properties: {
				envelopeId: UUIDV7,
				status: { type: 'string', enum: ['voided'] },
				previousStatus: {
					type: 'string',
					enum: ['draft', 'ready', 'sent', 'in_progress']
				},
				generation: { type: 'integer', minimum: 0 },
				voidedAt: { type: 'string', format: 'date-time' },
				revokedCapabilityCount: { type: 'integer', minimum: 0 },
				auditEventId: UUIDV7
			},
			additionalProperties: false
		}
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

const contactIdParam = {
	name: 'contactId',
	in: 'path',
	required: true,
	schema: UUIDV7
};

const contactCursorParam = {
	name: 'cursor',
	in: 'query',
	required: false,
	description:
		'Owner-scoped contact UUID cursor. It contains no name, email address, or search text.',
	schema: UUIDV7
};

const contactLimitParam = {
	name: 'limit',
	in: 'query',
	required: false,
	schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 }
};

const contactMutationProperties: Record<string, unknown> = {
	email: { type: 'string', format: 'email', maxLength: 320 },
	name: { type: 'string', minLength: 1, maxLength: 200 },
	locale: { type: 'string', enum: ['en', 'ja'] }
};

const contactResponse = (status: string, description: string): Record<string, unknown> =>
	jsonResponse(status, description, {
		type: 'object',
		required: ['contact'],
		additionalProperties: false,
		properties: { contact: { $ref: '#/components/schemas/Contact' } }
	});

const contactPageResponse = jsonResponse('200', 'Owner-scoped contact page', {
	type: 'object',
	required: ['items', 'nextCursor'],
	additionalProperties: false,
	properties: {
		items: { type: 'array', items: { $ref: '#/components/schemas/Contact' } },
		nextCursor: {
			type: ['string', 'null'],
			pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
			description: 'A contact UUID only; never a name, email address, or search term.'
		}
	}
});

const idempotencyReplayedHeader = {
	description: 'True only when this response safely replays an earlier mutation result.',
	schema: { type: 'string', enum: ['true'] }
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

const DRAFT_REVISION_ITEM: Record<string, unknown> = {
	type: 'object',
	required: ['generation', 'commitSha', 'timestamp', 'message', 'actorType'],
	properties: {
		generation: { type: 'integer', minimum: 0 },
		commitSha: {
			type: 'string',
			pattern: '^[0-9a-fA-F]{40}$',
			description: 'Verified Git commit SHA.'
		},
		timestamp: { type: 'string', format: 'date-time' },
		message: { type: 'string', description: 'Clean commit message from verified Git object.' },
		actorType: { type: 'string', enum: ['user', 'agent', 'system'] },
		provenance: {
			type: 'object',
			additionalProperties: false,
			properties: {
				automationRunId: { type: 'string' },
				externalId: { type: 'string' }
			}
		}
	},
	additionalProperties: false
};

const DRAFT_REVISION_HISTORY_PAGE: Record<string, unknown> = {
	type: 'object',
	required: ['revisions', 'truncated', 'nextCursor'],
	properties: {
		revisions: {
			type: 'array',
			items: DRAFT_REVISION_ITEM
		},
		truncated: {
			type: 'boolean',
			description: 'True when more revisions exist beyond this page.'
		},
		nextCursor: {
			type: ['integer', 'null'],
			description:
				'Cursor generation for fetching the next page, or null if at the earliest revision.'
		}
	},
	additionalProperties: false
};

const DRAFT_EXACT_REVISION: Record<string, unknown> = {
	type: 'object',
	required: [
		'generation',
		'commitSha',
		'archiveSha256',
		'timestamp',
		'message',
		'actorType',
		'documents',
		'documentSet'
	],
	properties: {
		generation: { type: 'integer', minimum: 0 },
		commitSha: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
		archiveSha256: {
			type: 'string',
			pattern: '^[0-9a-fA-F]{64}$',
			description: 'SHA-256 digest of immutable archive bytes.'
		},
		timestamp: { type: 'string', format: 'date-time' },
		message: { type: 'string' },
		actorType: { type: 'string', enum: ['user', 'agent', 'system'] },
		provenance: {
			type: 'object',
			additionalProperties: false,
			properties: {
				automationRunId: { type: 'string' },
				externalId: { type: 'string' }
			}
		},
		document: {
			type: 'object',
			description: 'Selected document when path query is specified.',
			required: ['path', 'content'],
			properties: {
				path: { type: 'string' },
				content: { type: 'string' }
			},
			additionalProperties: false
		},
		documents: {
			type: 'array',
			items: {
				type: 'object',
				required: ['path', 'content'],
				properties: {
					path: { type: 'string' },
					content: { type: 'string' }
				},
				additionalProperties: false
			}
		},
		documentSet: {
			type: ['object', 'null'],
			description: 'Manifest leaf metadata describing documents, ordering, and digests.'
		}
	},
	additionalProperties: false
};

const REVISION_DIFF_DOCUMENT_CHANGE: Record<string, unknown> = {
	type: 'object',
	required: [
		'documentId',
		'kind',
		'pathChanged',
		'changeType',
		'addition',
		'removal',
		'titleChanged',
		'orderChanged',
		'contentChanged',
		'title',
		'position',
		'content'
	],
	properties: {
		documentId: { type: 'string' },
		kind: { type: 'string', enum: ['markdown', 'pdf'] },
		path: { type: 'string', description: 'Markdown document path; absent for PDF leaves.' },
		previousPath: {
			type: 'string',
			description: 'Previous Markdown path; present only when the document was renamed.'
		},
		pathChanged: { type: 'boolean' },
		changeType: { type: 'string', enum: ['added', 'removed', 'modified', 'unchanged'] },
		addition: { type: 'boolean' },
		removal: { type: 'boolean' },
		titleChanged: { type: 'boolean' },
		orderChanged: { type: 'boolean' },
		contentChanged: { type: 'boolean' },
		title: {
			type: 'object',
			required: ['current', 'changed'],
			properties: {
				current: { type: 'string' },
				previous: { type: 'string' },
				changed: { type: 'boolean' }
			},
			additionalProperties: false
		},
		position: {
			type: 'object',
			required: ['changed'],
			properties: {
				current: { type: 'integer' },
				previous: { type: 'integer' },
				changed: { type: 'boolean' }
			},
			additionalProperties: false
		},
		content: {
			type: 'object',
			required: ['changed', 'additions', 'deletions'],
			properties: {
				changed: { type: 'boolean' },
				previousSha256: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
				currentSha256: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
				unifiedDiff: { type: 'string' },
				additions: { type: 'integer' },
				deletions: { type: 'integer' },
				truncated: { type: 'boolean' }
			},
			additionalProperties: false
		},
		pdf: {
			type: 'object',
			description: 'Present only for PDF leaves.',
			properties: {
				previousByteSize: { type: 'integer' },
				currentByteSize: { type: 'integer' },
				previousPageCount: { type: 'integer' },
				currentPageCount: { type: 'integer' },
				previousPageWidth: { type: 'number' },
				currentPageWidth: { type: 'number' },
				previousPageHeight: { type: 'number' },
				currentPageHeight: { type: 'number' }
			},
			additionalProperties: false
		}
	},
	additionalProperties: false
};

const REVISION_DIFF: Record<string, unknown> = {
	type: 'object',
	required: ['schema', 'base', 'head', 'summary', 'changes', 'unifiedText', 'truncated'],
	properties: {
		schema: { type: 'string', const: 'signkit-revision-diff-v1' },
		base: {
			type: 'object',
			required: ['generation', 'commitSha'],
			properties: {
				generation: { type: 'integer' },
				commitSha: { type: ['string', 'null'] }
			},
			additionalProperties: false
		},
		head: {
			type: 'object',
			required: ['generation', 'commitSha'],
			properties: {
				generation: { type: 'integer' },
				commitSha: { type: ['string', 'null'] },
				message: { type: ['string', 'null'] }
			},
			additionalProperties: false
		},
		summary: {
			type: 'object',
			required: [
				'documentsAdded',
				'documentsRemoved',
				'documentsModified',
				'documentsReordered',
				'titlesChanged',
				'totalChanges'
			],
			properties: {
				documentsAdded: { type: 'integer' },
				documentsRemoved: { type: 'integer' },
				documentsModified: { type: 'integer' },
				documentsReordered: { type: 'integer' },
				titlesChanged: { type: 'integer' },
				totalChanges: { type: 'integer' }
			},
			additionalProperties: false
		},
		changes: {
			type: 'array',
			items: REVISION_DIFF_DOCUMENT_CHANGE
		},
		unifiedText: {
			type: 'string',
			description: 'Concatenated unified diff text across bounded changes.'
		},
		truncated: { type: 'boolean' },
		truncationReason: {
			type: 'string',
			enum: ['diff_bytes_limit', 'file_count_limit']
		}
	},
	additionalProperties: false
};

const revisionRefParam = {
	name: 'revisionRef',
	in: 'path',
	required: true,
	description: 'Generation 0-2147483647 or a 40-character hexadecimal Git commit SHA.',
	schema: {
		type: 'string',
		pattern: '^([0-9]{1,10}|[0-9a-fA-F]{40})$'
	}
};

const revisionPathQueryParam = {
	name: 'path',
	in: 'query',
	required: false,
	description: 'Specific document path to read (e.g. documents/agreement.md).',
	schema: { type: 'string' }
};

const revisionLimitParam = {
	name: 'limit',
	in: 'query',
	required: false,
	description: 'Maximum number of revision history items to return (1-100, default 50).',
	schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
};

const revisionCursorParam = {
	name: 'cursor',
	in: 'query',
	required: false,
	description: 'Cursor generation to paginate historical revisions.',
	schema: { type: 'integer', minimum: 0, maximum: 2147483647 }
};

const diffBaseParam = {
	name: 'base',
	in: 'query',
	required: false,
	description: 'Base revision reference (generation or commit SHA). Defaults to head - 1.',
	schema: { type: 'string', pattern: '^([0-9]{1,10}|[0-9a-fA-F]{40})$' }
};

const diffHeadParam = {
	name: 'head',
	in: 'query',
	required: false,
	description: 'Head revision reference (generation or commit SHA). Defaults to current revision.',
	schema: { type: 'string', pattern: '^([0-9]{1,10}|[0-9a-fA-F]{40})$' }
};

const diffFormatParam = {
	name: 'format',
	in: 'query',
	required: false,
	description: 'Diff presentation format: json (default), text, or unified.',
	schema: { type: 'string', enum: ['json', 'text', 'unified'], default: 'json' }
};

const diffIncludeUnifiedParam = {
	name: 'includeUnified',
	in: 'query',
	required: false,
	description: 'Whether to compute unified diff text for modified text files.',
	schema: { type: 'boolean', default: true }
};

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
			{ name: 'Contacts' },
			{ name: 'Webhooks' },
			{ name: 'API keys' },
			{ name: 'Instance' },
			{ name: 'Signing' },
			{ name: 'Completion artifacts' },
			{ name: 'PDF seals' }
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
			'/api/v1/contacts': {
				get: op({
					summary: 'List contacts owned by the caller',
					operationId: 'listContacts',
					description:
						'Human-session-only. The owner is always the verified d6e-auth subject with a currently active local instance membership. The request cannot select another owner or an organization.',
					tags: ['Contacts'],
					security: [{ SessionCookie: [] }],
					parameters: [contactCursorParam, contactLimitParam],
					responses: contactPageResponse
				}),
				post: op({
					summary: 'Create a contact owned by the caller',
					operationId: 'createContact',
					description:
						'Creates a contact only after the sender explicitly asks to save it. Preparing or sending an envelope never creates contacts. Email uniqueness is scoped to the verified owner after the same trim/lower-case normalization used for envelope recipients.',
					tags: ['Contacts'],
					security: [{ SessionCookie: [] }],
					parameters: [idempotencyHeader],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['email', 'name', 'locale'],
									additionalProperties: false,
									properties: contactMutationProperties
								}
							}
						}
					},
					responses: {
						...contactResponse('201', 'Created contact'),
						'200': {
							description: 'Safely replayed contact creation',
							headers: { 'Idempotency-Replayed': idempotencyReplayedHeader },
							content: {
								'application/json': {
									schema: {
										type: 'object',
										required: ['contact'],
										additionalProperties: false,
										properties: { contact: { $ref: '#/components/schemas/Contact' } }
									}
								}
							}
						}
					}
				})
			},
			'/api/v1/contacts/search': {
				post: op({
					summary: 'Search contacts owned by the caller',
					operationId: 'searchContacts',
					description:
						'Human-session-only bounded search. The query is carried in a JSON body rather than the URL so contact PII does not enter request URLs, routine access logs, or cursors.',
					tags: ['Contacts'],
					security: [{ SessionCookie: [] }],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['query'],
									additionalProperties: false,
									properties: {
										query: { type: 'string', minLength: 1, maxLength: 200 },
										cursor: UUIDV7,
										limit: {
											type: 'integer',
											minimum: 1,
											maximum: 100,
											default: 25
										}
									}
								}
							}
						}
					},
					responses: contactPageResponse
				})
			},
			'/api/v1/contacts/{contactId}': {
				put: op({
					summary: 'Replace a contact owned by the caller',
					operationId: 'replaceContact',
					description:
						'Full owner-scoped replacement with optimistic concurrency. Unknown and cross-owner identifiers have the same opaque not-found response.',
					tags: ['Contacts'],
					security: [{ SessionCookie: [] }],
					parameters: [contactIdParam, idempotencyHeader],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['email', 'name', 'locale', 'expectedVersion'],
									additionalProperties: false,
									properties: {
										...contactMutationProperties,
										expectedVersion: { type: 'integer', minimum: 1, maximum: 2_147_483_646 }
									}
								}
							}
						}
					},
					responses: {
						'200': {
							description: 'Updated or safely replayed contact',
							headers: { 'Idempotency-Replayed': idempotencyReplayedHeader },
							content: {
								'application/json': {
									schema: {
										type: 'object',
										required: ['contact'],
										additionalProperties: false,
										properties: { contact: { $ref: '#/components/schemas/Contact' } }
									}
								}
							}
						}
					}
				}),
				delete: op({
					summary: 'Delete a contact owned by the caller',
					operationId: 'deleteContact',
					description:
						'Deletes only the owner-scoped contact projection. Existing envelope recipients and immutable evidence are unchanged. Unknown and cross-owner identifiers have the same opaque not-found response.',
					tags: ['Contacts'],
					security: [{ SessionCookie: [] }],
					parameters: [contactIdParam, idempotencyHeader],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['expectedVersion'],
									additionalProperties: false,
									properties: {
										expectedVersion: { type: 'integer', minimum: 1, maximum: 2_147_483_647 }
									}
								}
							}
						}
					},
					responses: {
						'200': {
							description: 'Contact deletion receipt, including safe replay',
							headers: { 'Idempotency-Replayed': idempotencyReplayedHeader },
							content: {
								'application/json': {
									schema: {
										type: 'object',
										required: ['deleted'],
										additionalProperties: false,
										properties: {
											deleted: {
												type: 'object',
												required: ['id', 'deletedAt'],
												additionalProperties: false,
												properties: {
													id: UUIDV7,
													deletedAt: { type: 'string', format: 'date-time' }
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
							recipients: {
								type: 'array',
								items: { $ref: '#/components/schemas/EnvelopeRecipient' }
							},
							readyAuditEventId: { anyOf: [UUIDV7, { type: 'null' }] },
							fields: {
								type: 'array',
								items: { $ref: '#/components/schemas/EnvelopeField' }
							}
						},
						additionalProperties: false
					})
				})
			},
			'/api/v1/envelopes/{envelopeId}/draft': {
				get: op({
					summary: 'Read the current draft workspace',
					operationId: 'getEnvelopeDraft',
					tags: ['Envelopes'],
					parameters: [envelopeIdParam],
					responses: jsonResponse('200', 'Draft workspace snapshot', {
						$ref: '#/components/schemas/DraftWorkspaceSnapshot'
					})
				})
			},
			'/api/v1/envelopes/{envelopeId}/revisions': {
				get: op({
					summary: 'List bounded revision history',
					operationId: 'listEnvelopeRevisions',
					tags: ['Envelopes'],
					parameters: [envelopeIdParam, revisionLimitParam, revisionCursorParam],
					responses: jsonResponse('200', 'Revision history page', DRAFT_REVISION_HISTORY_PAGE)
				})
			},
			'/api/v1/envelopes/{envelopeId}/revisions/diff': {
				get: op({
					summary: 'Compute structured bounded document-set diff',
					operationId: 'diffEnvelopeRevisions',
					tags: ['Envelopes'],
					parameters: [
						envelopeIdParam,
						diffBaseParam,
						diffHeadParam,
						diffFormatParam,
						diffIncludeUnifiedParam
					],
					responses: {
						'200': {
							description: 'Structured revision diff or unified diff text',
							content: {
								'application/json': { schema: REVISION_DIFF },
								'text/plain': { schema: { type: 'string' } }
							}
						}
					}
				})
			},
			'/api/v1/envelopes/{envelopeId}/revisions/{revisionRef}': {
				get: op({
					summary: 'Read exact draft revision',
					operationId: 'getEnvelopeRevision',
					tags: ['Envelopes'],
					parameters: [envelopeIdParam, revisionRefParam, revisionPathQueryParam],
					responses: {
						...jsonResponse('200', 'Exact revision snapshot', DRAFT_EXACT_REVISION),
						'404': {
							description: 'Envelope, revision, or document path not found',
							content: { 'application/problem+json': { schema: PROBLEM } }
						}
					}
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
								schema: { $ref: '#/components/schemas/DraftCommitRequest' }
							}
						}
					},
					responses: jsonResponse('201', 'Draft revision', {
						$ref: '#/components/schemas/DraftRevisionReceipt'
					})
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
					responses: jsonResponse('201', 'Draft revision', {
						$ref: '#/components/schemas/DraftRevisionReceipt'
					})
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
					responses: jsonResponse('201', 'Draft revision', {
						$ref: '#/components/schemas/DraftRevisionReceipt'
					})
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
					responses: jsonResponse('201', 'Draft revision', {
						$ref: '#/components/schemas/DraftRevisionReceipt'
					})
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
								schema: { $ref: '#/components/schemas/ReadyEnvelopeRequest' }
							}
						}
					},
					responses: jsonResponse('200', 'Ready receipt', {
						$ref: '#/components/schemas/ReadyEnvelopeReceipt'
					})
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
								schema: { $ref: '#/components/schemas/PlaceFieldsRequest' }
							}
						}
					},
					responses: jsonResponse('200', 'Field placement receipt', {
						$ref: '#/components/schemas/PlaceFieldsReceipt'
					})
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
								schema: { $ref: '#/components/schemas/SendEnvelopeRequest' }
							}
						}
					},
					responses: jsonResponse('202', 'Send receipt', {
						$ref: '#/components/schemas/SendEnvelopeReceipt'
					})
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
								schema: { $ref: '#/components/schemas/VoidEnvelopeRequest' }
							}
						}
					},
					responses: jsonResponse('200', 'Void receipt', {
						$ref: '#/components/schemas/VoidEnvelopeReceipt'
					})
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
			'/api/v1/envelopes/{envelopeId}/pdf-seal': {
				get: op({
					summary: 'Read certificate-backed PDF seal status',
					operationId: 'getEnvelopePdfSeal',
					description:
						'Returns only public verification state and content digests. Object keys, provider receipts, claim tokens, and audit hashes are never exposed.',
					tags: ['Envelopes', 'PDF seals'],
					parameters: [envelopeIdParam],
					responses: jsonResponse('200', 'PDF seal status', {
						type: 'object',
						required: ['pdfSeal'],
						additionalProperties: false,
						properties: { pdfSeal: { type: 'object' } }
					})
				}),
				post: op({
					summary: 'Explicitly request a certificate-backed PDF seal',
					operationId: 'requestEnvelopePdfSeal',
					description:
						'Creates one durable seal job only for the exact published completion PDF. Historical completion PDFs are never discovered or sealed automatically.',
					tags: ['Envelopes', 'PDF seals'],
					parameters: [envelopeIdParam, idempotencyHeader],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['requestedProfile'],
									additionalProperties: false,
									properties: {
										requestedProfile: {
											type: 'string',
											enum: ['pades-b-b', 'pades-b-t']
										}
									}
								}
							}
						}
					},
					responses: {
						'202': {
							description: 'Created, safely replayed, or already-existing envelope seal request',
							headers: { 'Idempotency-Replayed': idempotencyReplayedHeader },
							content: {
								'application/json': {
									schema: {
										type: 'object',
										required: ['pdfSeal'],
										additionalProperties: false,
										properties: { pdfSeal: { type: 'object' } }
									}
								}
							}
						}
					}
				})
			},
			'/api/v1/envelopes/{envelopeId}/pdf-seal/pdf': {
				get: op({
					summary: 'Download the published certificate-backed PDF',
					operationId: 'getEnvelopePdfSealPdf',
					description:
						'Returns only the atomically published, independently validated sealed PDF. The stored bytes are length-checked and SHA-256 verified on every read.',
					tags: ['Envelopes', 'PDF seals'],
					parameters: [envelopeIdParam],
					responses: {
						'200': {
							description: 'Verified certificate-backed application/pdf bytes.',
							content: {
								'application/pdf': { schema: { type: 'string', format: 'binary' } }
							}
						},
						'404': {
							description: 'Envelope not found or a validated PDF seal is not published',
							content: {
								'application/problem+json': {
									schema: { $ref: '#/components/schemas/ProblemDetail' }
								}
							}
						},
						'503': {
							description: 'The published sealed PDF could not be verified or read',
							content: {
								'application/problem+json': {
									schema: { $ref: '#/components/schemas/ProblemDetail' }
								}
							}
						}
					}
				}),
				head: op({
					summary: 'Inspect the published certificate-backed PDF download',
					operationId: 'headEnvelopePdfSealPdf',
					description:
						'Performs the same publication and integrity verification as GET while returning headers only.',
					tags: ['Envelopes', 'PDF seals'],
					parameters: [envelopeIdParam],
					responses: {
						'200': {
							description: 'Verified certificate-backed PDF metadata.',
							headers: {
								'Content-Type': { schema: { type: 'string', const: 'application/pdf' } },
								'Content-Length': { schema: { type: 'integer', minimum: 1 } },
								ETag: { schema: { type: 'string' } }
							}
						},
						'404': {
							description: 'Envelope not found or a validated PDF seal is not published',
							content: {
								'application/problem+json': {
									schema: { $ref: '#/components/schemas/ProblemDetail' }
								}
							}
						},
						'503': {
							description: 'The published sealed PDF could not be verified or read',
							content: {
								'application/problem+json': {
									schema: { $ref: '#/components/schemas/ProblemDetail' }
								}
							}
						}
					}
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
			'/api/v1/system/instance-invitations/drain': {
				post: op({
					summary: 'Drain pending instance invitation deliveries',
					operationId: 'drainInstanceInvitationDeliveries',
					tags: ['System', 'Instance'],
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
			'/api/v1/system/docx-conversions/drain': {
				post: op({
					summary: 'Drain pending DOCX conversion jobs',
					operationId: 'drainDocxConversions',
					tags: ['System'],
					security: [{ DeliveryWorkerSecret: [] }],
					responses: jsonResponse('200', 'Drain batch result', { type: 'object' })
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
			'/api/v1/system/pdf-seals/drain': {
				post: op({
					summary: 'Drain explicitly requested PDF seal jobs',
					operationId: 'drainPdfSeals',
					tags: ['System', 'Completion artifacts'],
					security: [{ DeliveryWorkerSecret: [] }],
					responses: jsonResponse('200', 'PDF seal drain batch result', { type: 'object' })
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
					parameters: [
						{
							...idempotencyHeader,
							description:
								'Exact retries are supported until the fixed seven-day invitation expiry; reuse after expiry conflicts.'
						}
					],
					requestBody: JSON_BODY,
					responses: jsonResponse('201', 'Created invitation with scheduled email delivery', {
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
			'/api/v1/recipient/context': {
				get: op({
					summary: 'Read browserless recipient context',
					description:
						'Requires the recipient invitation capability as a bearer credential, without a browser cookie or Origin header. Instance API keys have no recipient authority.',
					operationId: 'getRecipientCliContext',
					tags: ['Signing'],
					security: [{ RecipientCapability: [] }],
					responses: jsonResponse('200', 'Recipient context', { type: 'object' })
				})
			},
			'/api/v1/recipient/documents': {
				get: op({
					summary: 'Discover pinned recipient documents and own fields',
					description:
						'Returns the recipient-owned field declarations and fieldGeneration, but no Markdown source or storage keys.',
					operationId: 'getRecipientCliDocuments',
					tags: ['Signing'],
					security: [{ RecipientCapability: [] }],
					responses: jsonResponse('200', 'Pinned documents and own fields', { type: 'object' })
				})
			},
			'/api/v1/recipient/documents/{envelopeId}.pdf': {
				get: op({
					summary: 'Download one pinned recipient PDF',
					description:
						'Bound to the active recipient capability and pinned sent revision. Supply documentId for document-set envelopes; omit it only for legacy sent PDFs. Never place the capability in the URL.',
					operationId: 'downloadRecipientCliDocumentPdf',
					tags: ['Signing'],
					security: [{ RecipientCapability: [] }],
					parameters: [envelopeIdParam, { ...documentIdQueryParam, required: false }],
					responses: {
						'200': {
							description: 'Pinned agreement PDF',
							content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } }
						}
					}
				})
			},
			'/api/v1/recipient/viewed': {
				post: op({
					summary: 'Record a browserless recipient view',
					operationId: 'recordRecipientCliViewed',
					tags: ['Signing'],
					security: [{ RecipientCapability: [] }],
					parameters: [idempotencyHeader],
					requestBody: JSON_BODY,
					responses: jsonResponse('200', 'View receipt', { type: 'object' })
				})
			},
			'/api/v1/recipient/sign': {
				post: op({
					summary: 'Sign as the authorized recipient without a browser',
					description:
						'Requires explicit recipient intent in the client; the invitation capability, expected field generation, idempotency key, and every owned field value are validated server-side. An agent must not silently sign for someone else.',
					operationId: 'signRecipientCli',
					tags: ['Signing'],
					security: [{ RecipientCapability: [] }],
					parameters: [idempotencyHeader],
					requestBody: JSON_BODY,
					responses: jsonResponse('200', 'Signature receipt', { type: 'object' })
				})
			},
			'/api/v1/recipient/approve': {
				post: op({
					summary: 'Approve as the authorized recipient without a browser',
					operationId: 'approveRecipientCli',
					tags: ['Signing'],
					security: [{ RecipientCapability: [] }],
					parameters: [idempotencyHeader],
					requestBody: JSON_BODY,
					responses: jsonResponse('200', 'Approval receipt', { type: 'object' })
				})
			},
			'/api/v1/recipient/decline': {
				post: op({
					summary: 'Decline as the authorized recipient without a browser',
					operationId: 'declineRecipientCli',
					tags: ['Signing'],
					security: [{ RecipientCapability: [] }],
					parameters: [idempotencyHeader],
					requestBody: JSON_BODY,
					responses: jsonResponse('200', 'Decline receipt', { type: 'object' })
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
				Envelope: ENVELOPE,
				Contact: CONTACT,
				FieldGeometry: FIELD_GEOMETRY,
				EnvelopeRecipient: ENVELOPE_RECIPIENT,
				EnvelopeField: ENVELOPE_FIELD,
				MarkdownDocumentLeaf: MARKDOWN_DOCUMENT_LEAF,
				PdfDocumentLeaf: PDF_DOCUMENT_LEAF,
				DocumentSetLeaf: DOCUMENT_SET_LEAF,
				DocumentSetManifest: DOCUMENT_SET_MANIFEST,
				DraftWorkspaceSnapshot: DRAFT_WORKSPACE_SNAPSHOT,
				DraftCommitRequest: DRAFT_COMMIT_REQUEST,
				DraftRevisionReceipt: DRAFT_REVISION_RECEIPT,
				ReadyEnvelopeRequest: READY_ENVELOPE_REQUEST,
				ReadyEnvelopeReceipt: READY_ENVELOPE_RECEIPT,
				PlaceFieldsRequest: PLACE_FIELDS_REQUEST,
				PlaceFieldsReceipt: PLACE_FIELDS_RECEIPT,
				SendEnvelopeRequest: SEND_ENVELOPE_REQUEST,
				SendEnvelopeReceipt: SEND_ENVELOPE_RECEIPT,
				VoidEnvelopeRequest: VOID_ENVELOPE_REQUEST,
				VoidEnvelopeReceipt: VOID_ENVELOPE_RECEIPT,
				DraftRevisionItem: DRAFT_REVISION_ITEM,
				DraftRevisionHistoryPage: DRAFT_REVISION_HISTORY_PAGE,
				DraftExactRevision: DRAFT_EXACT_REVISION,
				RevisionDiff: REVISION_DIFF
			}
		}
	};
}
