import { createHash } from 'node:crypto';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { Envelope } from '$lib/domain/envelope';
import { draftArchiveKey } from '$lib/application/drafts/draft-persistence';
import { exportMarkdownToDocx } from '$lib/adapters/documents/docx-export';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import { createDocxExportHandler } from './docx-export';
import { createHttpRequestEvent, organizationScopedLocals } from './http-handler-test-support';

const organizationId = '01900000-0000-7000-8000-000000000002';
const envelopeId = '01900000-0000-7000-8000-000000000001';
const pathname = `/api/v1/envelopes/${envelopeId}/docx`;
const commitSha = '0123456789abcdef0123456789abcdef01234567';
const archiveBytes = new TextEncoder().encode('archive-bytes');
const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex');
const archiveKey = draftArchiveKey(organizationId, envelopeId, archiveSha256);

function locals(state: App.Locals['identityState'] = 'authorized'): App.Locals {
	return organizationScopedLocals(state, organizationId);
}

function envelope(overrides: Partial<Envelope> = {}): Envelope {
	return {
		id: envelopeId,
		organizationId,
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

class MemoryObjectStore implements ObjectStore {
	readonly putImmutable = vi.fn(async (): Promise<ObjectMetadata> => {
		throw new Error('Unexpected object write');
	});

	constructor(private readonly body: Uint8Array | null) {}

	async head(): Promise<ObjectMetadata | null> {
		return null;
	}

	async get(): Promise<ReadableStream<Uint8Array> | null> {
		if (this.body === null) return null;
		const body = this.body;
		return new ReadableStream<Uint8Array>({
			start(controller): void {
				controller.enqueue(body);
				controller.close();
			}
		});
	}

	async delete(): Promise<void> {}
	async list(): Promise<{ objects: []; truncated: false }> {
		return { objects: [], truncated: false };
	}
	async deleteMany(): Promise<void> {}
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
		const objects = new MemoryObjectStore(archiveBytes);
		const handler: RequestHandler = createDocxExportHandler(() => ({
			envelopes: {
				findForOrganization: async () => envelope()
			},
			objects,
			repository: {
				read: async () => [{ path: 'documents/agreement.md', content: '# Agreement\n' }],
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
		expect(objects.putImmutable).not.toHaveBeenCalled();
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect(bytes[0]).toBe(0x50);
		expect(bytes[1]).toBe(0x4b);
		const expected = exportMarkdownToDocx({
			commitSha,
			documents: [{ path: 'documents/agreement.md', content: '# Agreement\n' }]
		});
		expect(bytes.byteLength).toBe(expected.byteLength);
	});

	it('returns 404 when the envelope is outside the authorized organization', async () => {
		const handler: RequestHandler = createDocxExportHandler(() => ({
			envelopes: { findForOrganization: async () => null },
			objects: new MemoryObjectStore(null),
			repository: {
				read: async () => [],
				commit: async () => {
					throw new Error('Unexpected repository commit');
				}
			}
		}));
		const response: Response = await handler(
			createHttpRequestEvent({ pathname, locals: locals(), params: { envelopeId } })
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:envelope-not-found'
		});
	});

	it('returns 409 when the envelope has no pinned revision', async () => {
		const handler: RequestHandler = createDocxExportHandler(() => ({
			envelopes: {
				findForOrganization: async () =>
					envelope({
						repositoryHead: null,
						repositoryArchiveKey: null,
						repositoryArchiveSha256: null
					})
			},
			objects: new MemoryObjectStore(null),
			repository: {
				read: async () => [],
				commit: async () => {
					throw new Error('Unexpected repository commit');
				}
			}
		}));
		const response: Response = await handler(
			createHttpRequestEvent({ pathname, locals: locals(), params: { envelopeId } })
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:docx-export-empty'
		});
	});
});
