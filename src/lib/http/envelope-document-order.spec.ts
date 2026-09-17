import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import {
	DraftDocumentSetError,
	DraftGenerationConflictError,
	type CommitDraftResult
} from '$lib/application/drafts/draft-persistence';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';
import { expectProblemResponse } from './problem-response-test-support';
import { createDocumentOrderHandler } from './envelope-document-order';

const envelopeId = '01900000-0000-7000-8000-000000000001';
const firstId = '01900000-0000-7000-8000-000000000021';
const secondId = '01900000-0000-7000-8000-000000000022';
const pathname = `/api/v1/envelopes/${envelopeId}/documents/order`;

function locals(state: App.Locals['identityState'] = 'active'): App.Locals {
	return instanceScopedLocals(state);
}

function committed(): CommitDraftResult {
	return {
		outcome: 'committed',
		revision: {
			generation: 2,
			commitSha: 'a'.repeat(40),
			archiveKey: 'archive-key',
			archiveSha256: 'b'.repeat(64),
			updatedAt: '2026-09-11T00:00:00.000Z',
			auditEventId: '01900000-0000-7000-8000-000000000099'
		}
	};
}

function orderBody(
	overrides: { expectedGeneration?: number; documentIds?: readonly string[] } = {}
): string {
	return JSON.stringify({
		expectedGeneration: overrides.expectedGeneration ?? 1,
		documentIds: overrides.documentIds ?? [secondId, firstId]
	});
}

describe('document order HTTP handler', () => {
	it('returns 401 before resolving persistence', async () => {
		const resolvePersistence = vi.fn((): null => null);
		const handler: RequestHandler = createDocumentOrderHandler(resolvePersistence);
		const event: RequestEvent = createHttpRequestEvent({
			pathname,
			method: 'POST',
			locals: locals('anonymous'),
			params: { envelopeId }
		});
		const response: Response = await handler(event);
		expect(response.status).toBe(401);
		expect(resolvePersistence).not.toHaveBeenCalled();
	});

	it('rejects a non-UUID envelope ID', async () => {
		const handler: RequestHandler = createDocumentOrderHandler((): null => null);
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname: '/api/v1/envelopes/not-a-uuid/documents/order',
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
		const handler: RequestHandler = createDocumentOrderHandler((): null => null);
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'content-type': 'application/json' },
				body: orderBody()
			})
		);
		await expectProblemResponse(response, {
			status: 400,
			type: 'urn:signkit:problem:idempotency-key-required'
		});
	});

	it('rejects an unsupported media type', async () => {
		const handler: RequestHandler = createDocumentOrderHandler((): null => null);
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'idempotency-key': 'order-1', 'content-type': 'text/plain' },
				body: orderBody()
			})
		);
		await expectProblemResponse(response, {
			status: 415,
			type: 'urn:signkit:problem:unsupported-media-type'
		});
	});

	it('rejects a body larger than the bound', async () => {
		const handler: RequestHandler = createDocumentOrderHandler((): null => null);
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'idempotency-key': 'order-1', 'content-type': 'application/json' },
				body: 'x'.repeat(17 * 1024)
			})
		);
		await expectProblemResponse(response, {
			status: 413,
			type: 'urn:signkit:problem:request-body-too-large'
		});
	});

	it('rejects duplicate document IDs', async () => {
		const commit = vi.fn(async () => committed());
		const handler: RequestHandler = createDocumentOrderHandler(() => ({ commit }));
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'idempotency-key': 'order-1', 'content-type': 'application/json' },
				body: orderBody({ documentIds: [firstId, firstId] })
			})
		);
		await expectProblemResponse(response, {
			status: 400,
			type: 'urn:signkit:problem:validation-failed'
		});
		expect(commit).not.toHaveBeenCalled();
	});

	it('reorders documents and returns 201 with a commit Location', async () => {
		const commit = vi.fn(async () => committed());
		const handler: RequestHandler = createDocumentOrderHandler(() => ({ commit }));
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'idempotency-key': 'order-1', 'content-type': 'application/json' },
				body: orderBody()
			})
		);
		expect(response.status).toBe(201);
		expect(response.headers.get('location')).toBe(
			`/api/v1/envelopes/${envelopeId}/draft/commits/${'a'.repeat(40)}`
		);
		expect(commit).toHaveBeenCalledWith(
			expect.objectContaining({
				edits: [],
				documentSet: { op: 'reorder', documentIds: [secondId, firstId] }
			})
		);
	});

	it('marks a replay with Idempotency-Replayed', async () => {
		const commit = vi.fn(async (): Promise<CommitDraftResult> => ({
			...committed(),
			outcome: 'replayed'
		}));
		const handler: RequestHandler = createDocumentOrderHandler(() => ({ commit }));
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'idempotency-key': 'order-1', 'content-type': 'application/json' },
				body: orderBody()
			})
		);
		expect(response.status).toBe(201);
		expect(response.headers.get('idempotency-replayed')).toBe('true');
	});

	it('maps a generation conflict to 409', async () => {
		const handler: RequestHandler = createDocumentOrderHandler(() => ({
			commit: async (): Promise<CommitDraftResult> => {
				throw new DraftGenerationConflictError(3);
			}
		}));
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'idempotency-key': 'order-1', 'content-type': 'application/json' },
				body: orderBody()
			})
		);
		await expectProblemResponse(response, {
			status: 409,
			type: 'urn:signkit:problem:draft-generation-conflict'
		});
	});

	it('maps a document-set conflict to 409', async () => {
		const handler: RequestHandler = createDocumentOrderHandler(() => ({
			commit: async (): Promise<CommitDraftResult> => {
				throw new DraftDocumentSetError('Unknown document id');
			}
		}));
		const response: Response = await handler(
			createHttpRequestEvent({
				pathname,
				method: 'POST',
				locals: locals(),
				params: { envelopeId },
				headers: { 'idempotency-key': 'order-1', 'content-type': 'application/json' },
				body: orderBody()
			})
		);
		await expectProblemResponse(response, {
			status: 409,
			type: 'urn:signkit:problem:envelope-document-set-conflict'
		});
	});
});
