import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { CommitDraftResult } from '$lib/application/drafts/draft-persistence';
import { renderAgreementPdf } from '$lib/adapters/pdf/agreement-pdf';
import { renderRecipientMarkdown } from '$lib/security/recipient-markdown';
import { MAX_UPLOADED_PDF_BYTES } from '$lib/application/documents/uploaded-pdf';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import type {
	EnvelopeUploadedDocumentStore,
	InsertUploadedDocumentResult
} from '$lib/ports/envelope-uploaded-document-store';
import type { UploadedPdfUploadDependencies } from '$lib/application/documents/uploaded-pdf-runtime';
import { createPdfUploadHandler, type PdfUploadDependenciesResolver } from './envelope-pdf-upload';
import { createHttpRequestEvent, organizationScopedLocals } from './http-handler-test-support';
import { expectProblemResponse } from './problem-response-test-support';

const organizationId = '01900000-0000-7000-8000-000000000002';
const envelopeId = '01900000-0000-7000-8000-000000000001';
const pathname = `/api/v1/envelopes/${envelopeId}/documents/pdf`;

function locals(state: App.Locals['identityState'] = 'authorized'): App.Locals {
	return organizationScopedLocals(state, organizationId);
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

function samplePdfBytes(): Uint8Array {
	return renderAgreementPdf([
		{ title: 'Agreement', nodes: renderRecipientMarkdown('# Agreement\n\nHello.\n').nodes }
	]).bytes;
}

class FakeUploadedDocumentStore implements EnvelopeUploadedDocumentStore {
	async insert(): Promise<InsertUploadedDocumentResult> {
		return 'inserted';
	}

	async find(): Promise<null> {
		return null;
	}
}

function resolver(
	commit: (...args: never[]) => Promise<CommitDraftResult>
): PdfUploadDependenciesResolver {
	return (): UploadedPdfUploadDependencies => ({
		drafts: { commit: commit as UploadedPdfUploadDependencies['drafts']['commit'] },
		objects: new InMemoryObjectStore(),
		uploadedDocuments: new FakeUploadedDocumentStore()
	});
}

function requestBody(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

function multipartBody(bytes: Uint8Array, extra: Record<string, string> = {}): FormData {
	const form = new FormData();
	form.set('expectedGeneration', extra.expectedGeneration ?? '0');
	if (extra.title !== undefined) form.set('title', extra.title);
	form.set('file', new File([requestBody(bytes)], 'agreement.pdf', { type: 'application/pdf' }));
	return form;
}

describe('PDF upload HTTP handler', () => {
	it('returns 401 before resolving dependencies', async () => {
		const resolveDependencies = vi.fn((): null => null);
		const handler: RequestHandler = createPdfUploadHandler(resolveDependencies);
		const event: RequestEvent = createHttpRequestEvent({
			pathname,
			method: 'POST',
			locals: locals('anonymous'),
			params: { envelopeId }
		});
		const response: Response = await handler(event);
		expect(response.status).toBe(401);
		expect(resolveDependencies).not.toHaveBeenCalled();
	});

	it('rejects a non-UUID envelope ID', async () => {
		const handler: RequestHandler = createPdfUploadHandler((): null => null);
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname: '/api/v1/envelopes/not-a-uuid/documents/pdf',
				method: 'POST',
				locals: locals(),
				params: { envelopeId: 'not-a-uuid' }
			})
		);
		await expectProblemResponse(response, {
			status: 400,
			type: 'urn:signkit:problem:validation-failed'
		});
	});

	it('requires Idempotency-Key', async () => {
		const handler: RequestHandler = createPdfUploadHandler((): null => null);
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				body: multipartBody(samplePdfBytes())
			})
		);
		await expectProblemResponse(response, {
			status: 400,
			type: 'urn:signkit:problem:idempotency-key-required'
		});
	});

	it('rejects an unsupported media type', async () => {
		const handler: RequestHandler = createPdfUploadHandler((): null => null);
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'idempotency-key': 'upload-1', 'content-type': 'text/plain' },
				body: 'not a pdf'
			})
		);
		await expectProblemResponse(response, {
			status: 415,
			type: 'urn:signkit:problem:unsupported-media-type'
		});
	});

	it('rejects a multipart upload without a file field', async () => {
		const handler: RequestHandler = createPdfUploadHandler((): null => null);
		const form = new FormData();
		form.set('expectedGeneration', '0');
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'idempotency-key': 'upload-1' },
				body: form
			})
		);
		await expectProblemResponse(response, {
			status: 400,
			type: 'urn:signkit:problem:validation-failed'
		});
	});

	it('rejects a multipart file larger than the upload bound', async () => {
		const handler: RequestHandler = createPdfUploadHandler((): null => null);
		const oversized = new Uint8Array(MAX_UPLOADED_PDF_BYTES + 1);
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'idempotency-key': 'upload-1' },
				body: multipartBody(oversized)
			})
		);
		await expectProblemResponse(response, {
			status: 413,
			type: 'urn:signkit:problem:request-body-too-large'
		});
	});

	it('rejects a raw application/pdf body larger than the upload bound', async () => {
		const handler: RequestHandler = createPdfUploadHandler((): null => null);
		const oversized = new Uint8Array(MAX_UPLOADED_PDF_BYTES + 1);
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname: `${pathname}?expectedGeneration=0`,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'idempotency-key': 'upload-1', 'content-type': 'application/pdf' },
				body: oversized
			})
		);
		await expectProblemResponse(response, {
			status: 413,
			type: 'urn:signkit:problem:request-body-too-large'
		});
	});

	it('rejects a structurally invalid PDF as a 400 without ever calling commit', async () => {
		const commit = vi.fn(async () => committed());
		const handler: RequestHandler = createPdfUploadHandler(resolver(commit));
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'idempotency-key': 'upload-1' },
				body: multipartBody(new TextEncoder().encode('not a pdf'))
			})
		);
		await expectProblemResponse(response, {
			status: 400,
			type: 'urn:signkit:problem:validation-failed'
		});
		expect(commit).not.toHaveBeenCalled();
	});

	it('uploads a valid multipart PDF and returns 201 with a commit Location', async () => {
		const commit = vi.fn(async () => committed());
		const handler: RequestHandler = createPdfUploadHandler(resolver(commit));
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'idempotency-key': 'upload-1' },
				body: multipartBody(samplePdfBytes(), { title: 'Employment Agreement' })
			})
		);
		expect(response.status).toBe(201);
		expect(response.headers.get('location')).toBe(
			`/api/v1/envelopes/${envelopeId}/draft/commits/${'a'.repeat(40)}`
		);
		const body = (await response.json()) as { revision: { commitSha: string } };
		expect(body.revision.commitSha).toBe('a'.repeat(40));
		expect(commit).toHaveBeenCalledTimes(1);
	});

	it('uploads a valid raw application/pdf body and returns 201', async () => {
		const commit = vi.fn(async () => committed());
		const handler: RequestHandler = createPdfUploadHandler(resolver(commit));
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname: `${pathname}?expectedGeneration=0`,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'idempotency-key': 'upload-1', 'content-type': 'application/pdf' },
				body: requestBody(samplePdfBytes())
			})
		);
		expect(response.status).toBe(201);
		expect(commit).toHaveBeenCalledTimes(1);
	});

	it('marks a replay with Idempotency-Replayed', async () => {
		const commit = vi.fn(async (): Promise<CommitDraftResult> => ({
			...committed(),
			outcome: 'replayed'
		}));
		const handler: RequestHandler = createPdfUploadHandler(resolver(commit));
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'idempotency-key': 'upload-1' },
				body: multipartBody(samplePdfBytes())
			})
		);
		expect(response.status).toBe(201);
		expect(response.headers.get('idempotency-replayed')).toBe('true');
	});

	it('returns 503 when dependencies cannot be resolved', async () => {
		const handler: RequestHandler = createPdfUploadHandler((): null => null);
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'idempotency-key': 'upload-1' },
				body: multipartBody(samplePdfBytes())
			})
		);
		await expectProblemResponse(response, {
			status: 503,
			type: 'urn:signkit:problem:draft-service-unavailable'
		});
	});
});
