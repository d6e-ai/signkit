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
		.map((segment) => {
			const match = /^\[([^\]]+)\]$/.exec(segment);
			return match === null ? segment : `{${match[1]}}`;
		})
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
