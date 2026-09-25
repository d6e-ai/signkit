import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from './document';

const API_ROOT = 'src/routes/api/v1';
const HANDLER_EXPORT = /^export const (GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/gm;
const OPENAPI_METHODS = [
	'get',
	'put',
	'post',
	'delete',
	'options',
	'head',
	'patch',
	'trace'
] as const;

interface RouteOperation {
	path: string;
	method: string;
}

function collectServerFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			collectServerFiles(full, acc);
			continue;
		}
		if (entry.name === '+server.ts') acc.push(full);
	}
	return acc;
}

function fileToOpenApiPath(file: string): string {
	const relative = file.slice(`${API_ROOT}/`.length).replace(/\/\+server\.ts$/, '');
	if (relative === '+server.ts' || relative.length === 0) return '/api/v1';
	const suffix = relative
		.split('/')
		.map((segment) => segment.replace(/\[([^\]]+)\]/g, '{$1}'))
		.join('/');
	return `/api/v1/${suffix}`;
}

function exportedMethods(file: string): string[] {
	const source = readFileSync(file, 'utf8');
	const methods = new Set<string>();
	for (const match of source.matchAll(HANDLER_EXPORT)) {
		methods.add(match[1].toLowerCase());
	}
	return [...methods].sort();
}

function shippedApiV1Operations(): RouteOperation[] {
	const operations: RouteOperation[] = [];
	for (const file of collectServerFiles(API_ROOT)) {
		const path = fileToOpenApiPath(file);
		for (const method of exportedMethods(file)) {
			operations.push({ path, method });
		}
	}
	return operations.sort(compareOperations);
}

function openApiOperations(document: Record<string, unknown>): RouteOperation[] {
	const paths = document.paths as Record<string, Record<string, unknown>>;
	const operations: RouteOperation[] = [];
	for (const [path, item] of Object.entries(paths)) {
		for (const method of OPENAPI_METHODS) {
			if (item[method] !== undefined) operations.push({ path, method });
		}
	}
	return operations.sort(compareOperations);
}

function compareOperations(left: RouteOperation, right: RouteOperation): number {
	return `${left.path} ${left.method}`.localeCompare(`${right.path} ${right.method}`);
}

function pathItem(
	document: Record<string, unknown>,
	path: string
): Record<string, Record<string, unknown>> {
	const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
	const item = paths[path];
	expect(item).toBeDefined();
	return item;
}

describe('OpenAPI 3.1 /api/v1 route parity', () => {
	it('enumerates every shipped public/operator handler exactly once', () => {
		const document = openApiDocument();
		expect(openApiOperations(document)).toEqual(shippedApiV1Operations());
	});

	it('advertises browserless recipient operations without granting sender API-key authority', () => {
		const document = openApiDocument();
		for (const path of [
			'/api/v1/recipient/context',
			'/api/v1/recipient/documents',
			'/api/v1/recipient/documents/{envelopeId}.pdf',
			'/api/v1/recipient/viewed',
			'/api/v1/recipient/sign',
			'/api/v1/recipient/approve',
			'/api/v1/recipient/decline'
		]) {
			const operation = pathItem(document, path);
			for (const method of Object.values(operation)) {
				expect(method.security).toEqual([{ RecipientCapability: [] }]);
			}
		}
		for (const path of [
			'/api/v1/recipient/viewed',
			'/api/v1/recipient/sign',
			'/api/v1/recipient/approve',
			'/api/v1/recipient/decline'
		]) {
			expect(pathItem(document, path).post.parameters).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true })
				])
			);
		}
	});

	it('documents the webhook destination allowlist default-deny on creation', () => {
		const document = openApiDocument();
		const post = pathItem(document, '/api/v1/webhooks').post;
		expect(post.description).toContain('SIGNKIT_WEBHOOK_ALLOWED_HOSTS');
		expect(post.description).toContain('denies creation by default');
		const urlSchema = (
			post.requestBody as {
				content: {
					'application/json': {
						schema: { properties: { url: { description: string } } };
					};
				};
			}
		).content['application/json'].schema.properties.url;
		expect(urlSchema.description).toContain('allowlisted');
	});

	it('documents session-only reissue aliases with UUIDv7, idempotency, and no API-key security', () => {
		const document = openApiDocument();
		for (const path of [
			'/api/v1/envelopes/{envelopeId}/reissue',
			'/api/v1/envelopes/{envelopeId}/recipients/{recipientId}/reissue'
		]) {
			const post = pathItem(document, path).post;
			expect(post.security).toEqual([{ SessionCookie: [] }]);
			const parameters = post.parameters as Array<{
				name: string;
				in: string;
				required: boolean;
				schema?: { pattern?: string };
			}>;
			expect(parameters).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: 'envelopeId', in: 'path', required: true }),
					expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true })
				])
			);
			const envelopeId = parameters.find((parameter) => parameter.name === 'envelopeId');
			expect(envelopeId?.schema?.pattern).toContain('-7');
			const bodySchema = (
				post.requestBody as {
					content: { 'application/json': { schema: { additionalProperties: boolean } } };
				}
			).content['application/json'].schema;
			expect(bodySchema.additionalProperties).toBe(false);
		}
	});

	it('documents owner-scoped contacts without putting search PII in URLs or cursors', () => {
		const document = openApiDocument();
		const collection = pathItem(document, '/api/v1/contacts');
		const search = pathItem(document, '/api/v1/contacts/search').post;
		const item = pathItem(document, '/api/v1/contacts/{contactId}');

		for (const operation of [collection.get, collection.post, search, item.put, item.delete]) {
			expect(operation.security).toEqual([{ SessionCookie: [] }]);
			expect(operation.security).not.toEqual(expect.arrayContaining([{ SignKitApiKey: [] }]));
		}

		const listParameters = collection.get.parameters as Array<{
			name: string;
			in: string;
			description?: string;
		}>;
		expect(listParameters.map((parameter) => parameter.name)).toEqual(['cursor', 'limit']);
		expect(listParameters.find((parameter) => parameter.name === 'cursor')?.description).toContain(
			'no name, email address, or search text'
		);
		expect(search.parameters).toBeUndefined();

		const searchSchema = (
			search.requestBody as {
				content: {
					'application/json': {
						schema: {
							required: string[];
							additionalProperties: boolean;
							properties: Record<string, unknown>;
						};
					};
				};
			}
		).content['application/json'].schema;
		expect(searchSchema.required).toEqual(['query']);
		expect(searchSchema.additionalProperties).toBe(false);
		expect(Object.keys(searchSchema.properties).sort()).toEqual(['cursor', 'limit', 'query']);

		for (const operation of [collection.post, item.put, item.delete]) {
			expect(operation.parameters).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true })
				])
			);
		}
		expect(collection.get.parameters).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ name: 'Idempotency-Key' })])
		);
		expect(search.parameters).toBeUndefined();

		for (const operation of [collection.post, search, item.put, item.delete]) {
			const schema = (
				operation.requestBody as {
					content: {
						'application/json': {
							schema: {
								additionalProperties: boolean;
								properties: Record<string, { maximum?: number }>;
							};
						};
					};
				}
			).content['application/json'].schema;
			expect(schema.additionalProperties).toBe(false);
		}

		const updateSchema = (
			item.put.requestBody as {
				content: {
					'application/json': { schema: { properties: { expectedVersion: { maximum: number } } } };
				};
			}
		).content['application/json'].schema;
		const deleteSchema = (
			item.delete.requestBody as {
				content: {
					'application/json': {
						schema: { properties: { expectedVersion: { maximum: number } } };
					};
				};
			}
		).content['application/json'].schema;
		expect(updateSchema.properties.expectedVersion.maximum).toBe(2_147_483_646);
		expect(deleteSchema.properties.expectedVersion.maximum).toBe(2_147_483_647);

		const contactSchema = (
			document.components as {
				schemas: { Contact: { properties: { version: { maximum: number } } } };
			}
		).schemas.Contact;
		expect(contactSchema.properties.version.maximum).toBe(2_147_483_647);
	});

	it('documents operator evidence and PDF aliases with envelopes:read auth and no internal keys', () => {
		const document = openApiDocument();
		const evidenceFormat = {
			name: 'format',
			in: 'query',
			schema: { type: 'string', enum: ['json', 'markdown'], default: 'json' }
		};
		for (const path of [
			'/api/v1/envelopes/{envelopeId}/evidence',
			'/api/v1/envelopes/{envelopeId}/completion-artifact/evidence'
		]) {
			const get = pathItem(document, path).get;
			expect(get.security).toEqual([{ SignKitApiKey: [] }, { SessionCookie: [] }]);
			expect(get.parameters).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: 'envelopeId', in: 'path', required: true }),
					expect.objectContaining(evidenceFormat)
				])
			);
			const content = (get.responses as { '200': { content: Record<string, unknown> } })['200']
				.content;
			expect(content).toHaveProperty('application/json');
			expect(content).toHaveProperty('text/markdown');
			expect(content).not.toHaveProperty('application/pdf');
		}

		for (const path of [
			'/api/v1/envelopes/{envelopeId}/pdf',
			'/api/v1/envelopes/{envelopeId}/completion-artifact/pdf'
		]) {
			const get = pathItem(document, path).get;
			expect(get.security).toEqual([{ SignKitApiKey: [] }, { SessionCookie: [] }]);
			const content = (get.responses as { '200': { content: Record<string, unknown> } })['200']
				.content;
			expect(content).toHaveProperty('application/pdf');
		}

		expect(JSON.stringify(document)).not.toContain('repositoryArchiveKey');
	});

	it('documents signature-asset upload as cookie, PNG, UUIDv7 query, and 64 KiB bound', () => {
		const document = openApiDocument();
		const post = pathItem(document, '/api/v1/signing/signature-assets').post;
		expect(post.security).toEqual([{ RecipientSessionCookie: [] }]);
		expect(post.parameters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: 'envelopeId', in: 'query', required: true }),
				expect.objectContaining({ name: 'recipientId', in: 'query', required: true })
			])
		);
		const requestBody = post.requestBody as {
			description: string;
			content: { 'image/png': unknown };
		};
		expect(requestBody.content['image/png']).toBeDefined();
		expect(requestBody.description).toContain('65536');
		expect(post.parameters).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ name: 'Idempotency-Key' })])
		);
		expect(
			(post.responses as { '201': { content: { 'application/json': { schema: unknown } } } })['201']
				.content['application/json'].schema
		).toEqual(
			expect.objectContaining({
				required: ['assetRef'],
				additionalProperties: false
			})
		);
	});

	it('documents public completion PDF format and opaque non-RFC9457 failures', () => {
		const document = openApiDocument();
		const get = pathItem(document, '/api/v1/completion-artifacts').get;
		expect(get.security).toEqual([{ CompletionArtifactGrant: [] }]);
		expect(get.parameters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'format',
					in: 'query',
					schema: { type: 'string', enum: ['json', 'markdown', 'pdf'] }
				})
			])
		);
		const responses = get.responses as Record<string, { content: Record<string, unknown> }>;
		expect(responses['200'].content).toHaveProperty('application/json');
		expect(responses['200'].content).toHaveProperty('text/markdown');
		expect(responses['200'].content).toHaveProperty('application/pdf');
		expect(responses['404'].content).toHaveProperty('text/plain');
		expect(responses['404'].content).not.toHaveProperty('application/problem+json');
		expect(responses['500'].content).toHaveProperty('text/plain');
		expect(responses['500'].content).not.toHaveProperty('application/problem+json');
	});
});
