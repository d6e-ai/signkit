import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { Envelope } from '$lib/domain/envelope';
import { DraftEnvelopeNotFoundError } from '$lib/application/drafts/draft-persistence';
import type { DocxConversionService } from '$lib/application/documents/docx-conversion-service';
import { DocxExportError, exportMarkdownToDocx } from '$lib/adapters/documents/docx-export';
import { createDocxExportHandler } from './docx-export';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';
import { expectProblemResponse } from './problem-response-test-support';

const envelopeId = '01900000-0000-7000-8000-000000000001';
const pathname = `/api/v1/envelopes/${envelopeId}/docx`;
const commitSha = '0123456789abcdef0123456789abcdef01234567';
const archiveSha256 = 'a'.repeat(64);
const archiveKey = `drafts/v1/${envelopeId}/${archiveSha256}.tar.gz`;

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

function durableExportService(
	findEnvelope: () => Promise<Envelope | null>
): Pick<DocxConversionService, 'enqueueExport' | 'processInline' | 'readExportResult'> {
	let pinnedCommitSha: string | null = null;
	return {
		enqueueExport: vi.fn(async () => {
			const current: Envelope | null = await findEnvelope();
			if (current === null) throw new DraftEnvelopeNotFoundError();
			pinnedCommitSha = current.sentCommitSha ?? current.repositoryHead;
			if (
				pinnedCommitSha === null ||
				current.repositoryArchiveKey === null ||
				current.repositoryArchiveSha256 === null
			) {
				throw new DocxExportError('empty_draft', 'No pinned revision');
			}
			return { outcome: 'enqueued', job: { id: 'job-1' } } as never;
		}),
		processInline: vi.fn(
			async () =>
				({
					jobId: 'job-1',
					outcome: 'succeeded',
					job: { direction: 'export', sourceCommitSha: pinnedCommitSha }
				}) as never
		),
		readExportResult: vi.fn(async () =>
			exportMarkdownToDocx({
				commitSha: pinnedCommitSha ?? '',
				documents: [{ path: 'documents/agreement.md', content: '# Agreement\n' }]
			})
		)
	};
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

	it('returns the durable export result pinned to its source commit', async () => {
		const handler: RequestHandler = createDocxExportHandler(() =>
			durableExportService(async () => envelope())
		);

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
		const handler: RequestHandler = createDocxExportHandler(() =>
			durableExportService(async () => null)
		);
		const response: Response = await handler(
			createHttpRequestEvent({ pathname, locals: locals(), params: { envelopeId } })
		);
		await expectProblemResponse(response, {
			status: 404,
			type: 'urn:signkit:problem:envelope-not-found'
		});
	});

	it('returns 409 when the envelope has no pinned revision', async () => {
		const handler: RequestHandler = createDocxExportHandler(() =>
			durableExportService(async () =>
				envelope({
					repositoryHead: null,
					repositoryArchiveKey: null,
					repositoryArchiveSha256: null
				})
			)
		);
		const response: Response = await handler(
			createHttpRequestEvent({ pathname, locals: locals(), params: { envelopeId } })
		);
		await expectProblemResponse(response, {
			status: 409,
			type: 'urn:signkit:problem:docx-export-empty'
		});
	});

	it('returns unavailable rather than empty when a stored export fails integrity checks', async () => {
		const service: Pick<
			DocxConversionService,
			'enqueueExport' | 'processInline' | 'readExportResult'
		> = {
			enqueueExport: vi.fn(async () => ({
				outcome: 'existing',
				job: { id: 'job-integrity-failed' }
			})) as never,
			processInline: vi.fn(async () => ({
				jobId: 'job-integrity-failed',
				outcome: 'integrity_failed' as const,
				errorCode: 'docx_integrity_failed'
			})),
			readExportResult: vi.fn()
		};
		const response: Response = await createDocxExportHandler(() => service)(
			createHttpRequestEvent({ pathname, locals: locals(), params: { envelopeId } })
		);

		await expectProblemResponse(response, {
			status: 503,
			type: 'urn:signkit:problem:docx-export-unavailable'
		});
		expect(service.readExportResult).not.toHaveBeenCalled();
	});

	it('returns 409 only for the stored empty-draft export failure', async () => {
		const service: Pick<
			DocxConversionService,
			'enqueueExport' | 'processInline' | 'readExportResult'
		> = {
			enqueueExport: vi.fn(async () => ({
				outcome: 'existing',
				job: { id: 'job-empty-draft' }
			})) as never,
			processInline: vi.fn(async () => ({
				jobId: 'job-empty-draft',
				outcome: 'permanently_failed' as const,
				errorCode: 'empty_draft'
			})),
			readExportResult: vi.fn()
		};
		const response: Response = await createDocxExportHandler(() => service)(
			createHttpRequestEvent({ pathname, locals: locals(), params: { envelopeId } })
		);

		await expectProblemResponse(response, {
			status: 409,
			type: 'urn:signkit:problem:docx-export-empty'
		});
	});
});
