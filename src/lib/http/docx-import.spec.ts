import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	CommitDraftInput,
	CommitDraftResult
} from '$lib/application/drafts/draft-persistence';
import { exportMarkdownToDocx } from '$lib/adapters/documents/docx-export';
import { CLOUDFLARE_DOCX_IMPORT_LIMITS } from '$lib/adapters/documents/docx-import';
import { DocxImportService } from '$lib/application/documents/docx-import-service';
import { createDocxImportHandler } from './docx-import';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';
import { expectProblemResponse } from './problem-response-test-support';

const envelopeId = '01900000-0000-7000-8000-000000000001';
const pathname = `/api/v1/envelopes/${envelopeId}/draft/docx`;

function locals(state: App.Locals['identityState'] = 'active'): App.Locals {
	return instanceScopedLocals(state);
}

function committed(): CommitDraftResult {
	return {
		outcome: 'committed',
		revision: {
			generation: 1,
			commitSha: 'a'.repeat(40),
			archiveKey: 'archive-key',
			archiveSha256: 'b'.repeat(64),
			updatedAt: '2026-09-11T00:00:00.000Z',
			auditEventId: '01900000-0000-7000-8000-000000000099'
		}
	};
}

function requestBody(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

function sampleDocx(): Uint8Array {
	return exportMarkdownToDocx({
		commitSha: 'a'.repeat(40),
		documents: [{ path: 'documents/agreement.md', content: '# Agreement\n\nHello.\n' }]
	});
}

describe('DOCX import HTTP handler', () => {
	it('returns 401 before resolving persistence', async () => {
		const resolver = vi.fn((): null => null);
		const handler: RequestHandler = createDocxImportHandler(resolver);
		const event: RequestEvent = createHttpRequestEvent({
			pathname,
			method: 'POST',
			locals: locals('anonymous'),
			params: { envelopeId }
		});
		const response: Response = await handler(event);
		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('requires Idempotency-Key', async () => {
		const response: Response = await createDocxImportHandler((): null => null)(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: {
					'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
				},
				body: requestBody(sampleDocx())
			})
		);
		await expectProblemResponse(response, {
			status: 400,
			type: 'urn:signkit:problem:idempotency-key-required'
		});
	});

	it('imports a DOCX as Markdown through the existing draft commit boundary', async () => {
		const commit = vi.fn<(input: CommitDraftInput) => Promise<CommitDraftResult>>(async () =>
			committed()
		);
		const handler: RequestHandler = createDocxImportHandler(() => ({ commit }));
		const docx = sampleDocx();
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname: `${pathname}?targetPath=documents/agreement.md&expectedGeneration=0`,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: {
					'idempotency-key': 'import-1',
					'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
				},
				body: requestBody(docx)
			})
		);
		expect(response.status).toBe(201);
		expect(commit).toHaveBeenCalledTimes(1);
		const input = commit.mock.calls[0]?.[0];
		expect(input).toBeDefined();
		expect(input?.edits).toHaveLength(1);
		expect(input?.edits[0]?.path).toBe('documents/agreement.md');
		expect(input?.edits[0]?.content).toContain('# Agreement');
		expect(JSON.stringify(input?.edits)).not.toContain('PK');
	});

	it('never forwards raw DOCX bytes into the draft commit', async () => {
		const commit = vi.fn<(input: CommitDraftInput) => Promise<CommitDraftResult>>(async () =>
			committed()
		);
		const service = new DocxImportService({ commit });
		const result = await service.importAndCommit({
			envelopeId,
			targetPath: 'documents/agreement.md',
			expectedGeneration: 0,
			actor: { id: 'user-1', name: 'User', email: 'user@example.com', type: 'user' },
			idempotencyKey: 'import-2',
			docxBytes: sampleDocx()
		});
		expect(result.outcome).toBe('committed');
		expect(commit.mock.calls[0]?.[0]?.edits[0]?.content.startsWith('#')).toBe(true);
		expect(commit.mock.calls[0]?.[0]?.edits[0]?.path.endsWith('.md')).toBe(true);
	});

	it('rejects a hostile empty upload without calling commit', async () => {
		const commit = vi.fn<(input: CommitDraftInput) => Promise<CommitDraftResult>>(async () =>
			committed()
		);
		const handler: RequestHandler = createDocxImportHandler(() => ({ commit }));
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname: `${pathname}?targetPath=documents/agreement.md&expectedGeneration=0`,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: {
					'idempotency-key': 'import-empty',
					'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
				},
				body: requestBody(new Uint8Array([0x50, 0x4b]))
			})
		);
		expect(response.status).toBe(400);
		expect(commit).not.toHaveBeenCalled();
	});

	it('rejects a multipart/form-data upload as unsupported media type instead of buffering it', async () => {
		const commit = vi.fn<(input: CommitDraftInput) => Promise<CommitDraftResult>>(async () =>
			committed()
		);
		const resolver = vi.fn(() => ({ commit }));
		const handler: RequestHandler = createDocxImportHandler(resolver);
		const form = new FormData();
		form.set('expectedGeneration', '0');
		form.set('targetPath', 'documents/agreement.md');
		form.set(
			'file',
			new File([requestBody(sampleDocx())], 'agreement.docx', {
				type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
			})
		);
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'idempotency-key': 'import-multipart' },
				body: form
			})
		);
		await expectProblemResponse(response, {
			status: 415,
			type: 'urn:signkit:problem:unsupported-media-type'
		});
		expect(resolver).not.toHaveBeenCalled();
		expect(commit).not.toHaveBeenCalled();
	});

	it('rejects a chunked (no Content-Length) body that exceeds the bound mid-stream', async () => {
		const commit = vi.fn<(input: CommitDraftInput) => Promise<CommitDraftResult>>(async () =>
			committed()
		);
		const handler: RequestHandler = createDocxImportHandler(() => ({ commit }));
		let cancelReason: unknown;
		const chunkBytes = 64 * 1024;
		const body = new ReadableStream<Uint8Array>({
			pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
				controller.enqueue(new Uint8Array(chunkBytes));
			},
			cancel(reason: unknown): void {
				cancelReason = reason;
			}
		});
		const url = new URL(
			`https://signkit.example${pathname}?targetPath=documents/agreement.md&expectedGeneration=0`
		);
		const request = new Request(url, {
			method: 'POST',
			headers: {
				'idempotency-key': 'import-chunked',
				'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
			},
			body,
			duplex: 'half'
		} as RequestInit & { duplex: 'half' });
		const event = {
			locals: locals(),
			params: { envelopeId },
			request,
			url
		} as unknown as RequestEvent;

		const response: Response = await handler(event);
		await expectProblemResponse(response, {
			status: 413,
			type: 'urn:signkit:problem:request-body-too-large'
		});
		expect(cancelReason).toBeDefined();
		expect(commit).not.toHaveBeenCalled();
	});

	it('applies the Cloudflare input bound when the D1 binding is present', async () => {
		const commit = vi.fn<(input: CommitDraftInput) => Promise<CommitDraftResult>>(async () =>
			committed()
		);
		const oversized = new Uint8Array(CLOUDFLARE_DOCX_IMPORT_LIMITS.maxInputBytes + 1);
		oversized[0] = 0x50;
		oversized[1] = 0x4b;
		const response: Response = await createDocxImportHandler(() => ({ commit }))(
			createHttpRequestEvent({
				pathname: `${pathname}?targetPath=documents/agreement.md&expectedGeneration=0`,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				platform: { env: { DB: {} as D1Database } } as App.Platform,
				headers: {
					'idempotency-key': 'import-cf-bound',
					'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
				},
				body: requestBody(oversized)
			})
		);
		await expectProblemResponse(response, {
			status: 413,
			type: 'urn:signkit:problem:request-body-too-large',
			detail: `The uploaded DOCX file must not exceed ${CLOUDFLARE_DOCX_IMPORT_LIMITS.maxInputBytes} bytes.`
		});
		expect(commit).not.toHaveBeenCalled();
	});
});
