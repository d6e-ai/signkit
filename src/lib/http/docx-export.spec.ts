import { createHash } from 'node:crypto';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { Envelope } from '$lib/domain/envelope';
import { draftArchiveKey } from '$lib/application/drafts/draft-persistence';
import { exportMarkdownToDocx } from '$lib/adapters/documents/docx-export';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import { createDocxExportHandler } from './docx-export';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';
import { expectProblemResponse } from './problem-response-test-support';

const envelopeId = '01900000-0000-7000-8000-000000000001';
const pathname = `/api/v1/envelopes/${envelopeId}/docx`;
const commitSha = '0123456789abcdef0123456789abcdef01234567';
const archiveBytes = new TextEncoder().encode('archive-bytes');
const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex');
const archiveKey = draftArchiveKey(envelopeId, archiveSha256);

function locals(state: App.Locals['identityState'] = 'active'): App.Locals {
	return instanceScopedLocals(state);
}

function envelope(overrides: Partial<Envelope> = {}): Envelope {
	return {
		id: envelopeId,
		createdByUserId: '01900000-0000-7000-8000-000000000002',
		title: 'Agreement',
		status: 'ready',
		repositoryGeneration: 1,
		repositoryHead: commitSha,
		repositoryArchiveKey: archiveKey,
		repositoryArchiveSha256: archiveSha256,
		sentCommitSha: null,
		fieldGeneration: 0,
		createdAt: '2026-09-11T00:00:00.000Z',
		updatedAt: '2026-09-11T00:00:00.000Z',
		...overrides
	};
}

function objectStoreSeededWithArchive(): InMemoryObjectStore {
	const objects = new InMemoryObjectStore();
	objects.seed(archiveKey, archiveBytes, archiveSha256);
	return objects;
}

describe('DOCX export HTTP handler', () => {
	it('returns 401 before resolving export dependencies', async () => {
		const resolver = vi.fn((): null => null);
		const handler: RequestHandler = createDocxExportHandler(resolver);
		const event: RequestEvent = createHttpRequestEvent({
			pathname,
			locals: locals('anonymous'),
			params: { envelopeId }
		});
		const response: Response = await handler(event);
		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('exports the pinned revision and never writes objects', async () => {
		const objects = objectStoreSeededWithArchive();
		const handler: RequestHandler = createDocxExportHandler(() => ({
			envelopes: {
				findEnvelope: async () => envelope()
			},
			objects,
			repository: {
				read: async () => [{ path: 'documents/agreement.md', content: '# Agreement\n' }],
				readManifest: async () => null,
				commit: async () => {
					throw new Error('Unexpected repository commit');
				}
			}
		}));

		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				locals: locals(),
				params: { envelopeId }
			})
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe(
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
		);
		expect(response.headers.get('x-signkit-commit-sha')).toBe(commitSha);
		expect(objects.putCalls).toBe(0);
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect(bytes[0]).toBe(0x50);
		expect(bytes[1]).toBe(0x4b);
		const expected = exportMarkdownToDocx({
			commitSha,
			documents: [{ path: 'documents/agreement.md', content: '# Agreement\n' }]
		});
		expect(bytes.byteLength).toBe(expected.byteLength);
	});

	it('returns 404 when the envelope is not found', async () => {
		const handler: RequestHandler = createDocxExportHandler(() => ({
			envelopes: { findEnvelope: async () => null },
			objects: new InMemoryObjectStore(),
			repository: {
				read: async () => [],
				readManifest: async () => null,
				commit: async () => {
					throw new Error('Unexpected repository commit');
				}
			}
		}));
		const response: Response = await handler(
			createHttpRequestEvent({ pathname, locals: locals(), params: { envelopeId } })
		);
		await expectProblemResponse(response, {
			status: 404,
			type: 'urn:signkit:problem:envelope-not-found'
		});
	});

	it('returns 409 when the envelope has no pinned revision', async () => {
		const handler: RequestHandler = createDocxExportHandler(() => ({
			envelopes: {
				findEnvelope: async () =>
					envelope({
						repositoryHead: null,
						repositoryArchiveKey: null,
						repositoryArchiveSha256: null
					})
			},
			objects: new InMemoryObjectStore(),
			repository: {
				read: async () => [],
				readManifest: async () => null,
				commit: async () => {
					throw new Error('Unexpected repository commit');
				}
			}
		}));
		const response: Response = await handler(
			createHttpRequestEvent({ pathname, locals: locals(), params: { envelopeId } })
		);
		await expectProblemResponse(response, {
			status: 409,
			type: 'urn:signkit:problem:docx-export-empty'
		});
	});
});
