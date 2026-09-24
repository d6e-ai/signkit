import { describe, expect, it } from 'vitest';
import { openApiDocument } from './document';
import { commitDraftSchema } from '$lib/http/drafts';
import { readySchema } from '$lib/http/envelope-ready';
import { fieldsSchema } from '$lib/http/envelope-fields';
import { sendSchema } from '$lib/http/envelope-send';
import { voidSchema } from '$lib/http/envelope-void';

describe('OpenAPI mutation schema drift and validity', () => {
	const document = openApiDocument() as {
		paths: Record<
			string,
			Record<string, { requestBody?: unknown; responses?: Record<string, unknown> }>
		>;
		components: {
			schemas: Record<string, Record<string, unknown>>;
		};
	};
	const schemas = document.components.schemas;

	it('registers all required concrete named schemas in components.schemas', () => {
		const requiredSchemas = [
			'ProblemDetail',
			'Envelope',
			'Contact',
			'FieldGeometry',
			'EnvelopeRecipient',
			'EnvelopeField',
			'MarkdownDocumentLeaf',
			'PdfDocumentLeaf',
			'DocumentSetLeaf',
			'DocumentSetManifest',
			'DraftWorkspaceSnapshot',
			'DraftCommitRequest',
			'DraftRevisionReceipt',
			'ReadyEnvelopeRequest',
			'ReadyEnvelopeReceipt',
			'PlaceFieldsRequest',
			'PlaceFieldsReceipt',
			'SendEnvelopeRequest',
			'SendEnvelopeReceipt',
			'VoidEnvelopeRequest',
			'VoidEnvelopeReceipt'
		];

		for (const name of requiredSchemas) {
			expect(schemas[name], `Schema ${name} should be registered`).toBeDefined();
		}
	});

	it('describes the document manifest and ready recipient wire shapes', () => {
		expect(schemas.DocumentSetManifest.properties).toEqual(
			expect.objectContaining({
				schema: { type: 'string', enum: ['signkit-document-set-v1'] }
			})
		);
		expect((schemas.EnvelopeRecipient.properties as Record<string, unknown>).envelopeId).toEqual({
			type: 'string',
			pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		});
	});

	it('ensures mutation endpoints link to named request and receipt schemas via $ref', () => {
		const commitPost = document.paths['/api/v1/envelopes/{envelopeId}/draft/commits'].post;
		expect(commitPost.requestBody).toEqual(
			expect.objectContaining({
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/DraftCommitRequest' }
					}
				}
			})
		);
		expect(commitPost.responses?.['201']).toEqual(
			expect.objectContaining({
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/DraftRevisionReceipt' }
					}
				}
			})
		);

		const readyPost = document.paths['/api/v1/envelopes/{envelopeId}/ready'].post;
		expect(readyPost.requestBody).toEqual(
			expect.objectContaining({
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/ReadyEnvelopeRequest' }
					}
				}
			})
		);
		expect(readyPost.responses?.['200']).toEqual(
			expect.objectContaining({
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/ReadyEnvelopeReceipt' }
					}
				}
			})
		);

		const fieldsPost = document.paths['/api/v1/envelopes/{envelopeId}/fields'].post;
		expect(fieldsPost.requestBody).toEqual(
			expect.objectContaining({
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/PlaceFieldsRequest' }
					}
				}
			})
		);
		expect(fieldsPost.responses?.['200']).toEqual(
			expect.objectContaining({
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/PlaceFieldsReceipt' }
					}
				}
			})
		);

		const sendPost = document.paths['/api/v1/envelopes/{envelopeId}/send'].post;
		expect(sendPost.requestBody).toEqual(
			expect.objectContaining({
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/SendEnvelopeRequest' }
					}
				}
			})
		);
		expect(sendPost.responses?.['202']).toEqual(
			expect.objectContaining({
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/SendEnvelopeReceipt' }
					}
				}
			})
		);

		const voidPost = document.paths['/api/v1/envelopes/{envelopeId}/void'].post;
		expect(voidPost.requestBody).toEqual(
			expect.objectContaining({
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/VoidEnvelopeRequest' }
					}
				}
			})
		);
		expect(voidPost.responses?.['200']).toEqual(
			expect.objectContaining({
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/VoidEnvelopeReceipt' }
					}
				}
			})
		);
	});

	it('ensures draft and envelope read endpoints return concrete schemas', () => {
		const draftGet = document.paths['/api/v1/envelopes/{envelopeId}/draft'].get;
		expect(draftGet.responses?.['200']).toEqual(
			expect.objectContaining({
				content: {
					'application/json': {
						schema: { $ref: '#/components/schemas/DraftWorkspaceSnapshot' }
					}
				}
			})
		);

		const envelopeGet = document.paths['/api/v1/envelopes/{envelopeId}'].get;
		const envelopeProps = (
			envelopeGet.responses?.['200'] as {
				content: { 'application/json': { schema: { properties: Record<string, unknown> } } };
			}
		).content['application/json'].schema.properties;
		expect(envelopeProps.recipients).toEqual({
			type: 'array',
			items: { $ref: '#/components/schemas/EnvelopeRecipient' }
		});
		expect(envelopeProps.fields).toEqual({
			type: 'array',
			items: { $ref: '#/components/schemas/EnvelopeField' }
		});
	});

	it('validates canonical commit example against server commitDraftSchema', () => {
		const example = {
			expectedGeneration: 0,
			message: 'Initial agreement draft',
			edits: [
				{
					path: 'documents/agreement.md',
					content: '# Mutual Non-Disclosure Agreement\n\nThis agreement is entered into...'
				}
			],
			provenance: {
				automationRunId: 'run-2026-09-24-001',
				externalId: 'workflow-step-1'
			}
		};

		const result = commitDraftSchema.safeParse(example);
		expect(result.success).toBe(true);

		// Extraneous property rejected due to .strict()
		const invalidExtraneous = { ...example, extraField: 'not-allowed' };
		expect(commitDraftSchema.safeParse(invalidExtraneous).success).toBe(false);
	});

	it('validates canonical ready example against server readySchema', () => {
		const example = {
			expectedGeneration: 1,
			recipients: [
				{
					email: 'signer@example.com',
					name: 'Jane Doe',
					role: 'signer',
					locale: 'en',
					routingOrder: 1
				},
				{
					email: 'approver@example.com',
					name: 'John Smith',
					role: 'approver',
					locale: 'en',
					routingOrder: 2
				}
			]
		};

		const result = readySchema.safeParse(example);
		expect(result.success).toBe(true);

		// Extraneous property rejected
		const invalidExtraneous = { ...example, unexpected: true };
		expect(readySchema.safeParse(invalidExtraneous).success).toBe(false);

		// Prefill role rejected in ready
		const invalidRole = {
			expectedGeneration: 1,
			recipients: [
				{
					email: 'prefill@example.com',
					name: 'Prefill User',
					role: 'prefill',
					locale: 'en',
					routingOrder: 1
				}
			]
		};
		expect(readySchema.safeParse(invalidRole).success).toBe(false);
	});

	it('validates canonical fields example against server fieldsSchema', () => {
		const example = {
			expectedGeneration: 1,
			expectedFieldGeneration: 0,
			fields: [
				{
					recipientId: '0191eb70-6523-74b2-b7b5-2fa75bb6d001',
					documentId: '0191eb70-6523-74b2-b7b5-2fa75bb6d002',
					fieldType: 'signature',
					label: 'Signer Signature',
					required: true,
					position: 0,
					geometry: {
						page: 1,
						x: 0.1,
						y: 0.7,
						width: 0.25,
						height: 0.05
					}
				}
			]
		};

		const result = fieldsSchema.safeParse(example);
		expect(result.success).toBe(true);

		// Extraneous property rejected
		const invalidExtraneous = { ...example, extra: 123 };
		expect(fieldsSchema.safeParse(invalidExtraneous).success).toBe(false);

		// Geometry dimensions must be within (0, 1]
		const invalidGeometry = {
			...example,
			fields: [
				{
					...example.fields[0],
					geometry: {
						page: 1,
						x: 0.1,
						y: 0.7,
						width: 1.5,
						height: 0.05
					}
				}
			]
		};
		expect(fieldsSchema.safeParse(invalidGeometry).success).toBe(false);
	});

	it('validates canonical send example against server sendSchema', () => {
		const example = {
			expectedGeneration: 1,
			expectedReadyAuditEventId: '0191eb70-6523-74b2-b7b5-2fa75bb6d003'
		};

		const result = sendSchema.safeParse(example);
		expect(result.success).toBe(true);

		const invalidExtraneous = { ...example, invalid: 'reject' };
		expect(sendSchema.safeParse(invalidExtraneous).success).toBe(false);

		const invalidUuid = {
			expectedGeneration: 1,
			expectedReadyAuditEventId: 'not-a-uuid'
		};
		expect(sendSchema.safeParse(invalidUuid).success).toBe(false);
	});

	it('validates canonical void example against server voidSchema', () => {
		const example = {
			expectedStatus: 'sent',
			expectedGeneration: 1
		};

		const result = voidSchema.safeParse(example);
		expect(result.success).toBe(true);

		const invalidExtraneous = { ...example, invalid: 42 };
		expect(voidSchema.safeParse(invalidExtraneous).success).toBe(false);

		const invalidStatus = {
			expectedStatus: 'completed',
			expectedGeneration: 1
		};
		expect(voidSchema.safeParse(invalidStatus).success).toBe(false);
	});
});
