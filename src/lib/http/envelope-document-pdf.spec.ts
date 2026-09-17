import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	EnvelopeDocumentPdfApplicationPort,
	EnvelopeDocumentPdfResult
} from '$lib/application/documents/envelope-document-pdf';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';
import { createEnvelopeDocumentPdfHandler } from './envelope-document-pdf';

const ENVELOPE_ID = '01900000-0000-7000-8000-000000000001';
const DOCUMENT_ID = '01900000-0000-7000-8000-000000000010';
const BYTES: Uint8Array = new TextEncoder().encode('%PDF-1.7\nbody\n%%EOF\n');

const ok: EnvelopeDocumentPdfResult = {
	outcome: 'ok',
	pdf: {
		bytes: BYTES,
		sha256: 'a'.repeat(64),
		byteSize: BYTES.byteLength,
		commitSha: 'b'.repeat(40),
		generation: 3,
		documentId: DOCUMENT_ID,
		pageCount: 2,
		pageWidth: 595.28,
		pageHeight: 841.89,
		documents: [
			{
				documentId: DOCUMENT_ID,
				position: 0,
				kind: 'markdown',
				title: 'agreement',
				pageCount: 2,
				pageWidth: 595.28,
				pageHeight: 841.89
			}
		]
	}
};

function event(
	options: {
		path?: string;
		envelopeId?: string;
		identityState?: App.Locals['identityState'];
	} = {}
): RequestEvent {
	return createHttpRequestEvent({
		pathname: `/api/v1/envelopes/${ENVELOPE_ID}/${options.path ?? 'document-pdf'}`,
		search: `?documentId=${DOCUMENT_ID}`,
		locals: instanceScopedLocals(options.identityState ?? 'active'),
		params: { envelopeId: options.envelopeId ?? ENVELOPE_ID },
		platform: { env: { DB: {} as D1Database, OBJECTS: {} as R2Bucket } } as App.Platform
	});
}

function application(result: EnvelopeDocumentPdfResult): EnvelopeDocumentPdfApplicationPort {
	return { read: vi.fn(async (): Promise<EnvelopeDocumentPdfResult> => result) };
}

describe('envelope document PDF handler', () => {
	it('streams the rendering scoped to the authorized instance', async () => {
		const app: EnvelopeDocumentPdfApplicationPort = application(ok);
		const response: Response = await createEnvelopeDocumentPdfHandler(() => app, 'pdf')(event());

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/pdf');
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		// The placement editor fetches these bytes and draws them itself, so no
		// origin needs framing permission and none is granted.
		expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
		expect(response.headers.get('x-frame-options')).toBe('DENY');
		expect(app.read).toHaveBeenCalledWith(ENVELOPE_ID, DOCUMENT_ID);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
	});

	it('returns the page map the placement editor needs, and no document bytes', async () => {
		const response: Response = await createEnvelopeDocumentPdfHandler(
			() => application(ok),
			'pages'
		)(event({ path: 'document-pdf/pages' }));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			commitSha: ok.outcome === 'ok' ? ok.pdf.commitSha : '',
			generation: 3,
			documentId: DOCUMENT_ID,
			pageCount: 2,
			pageWidth: 595.28,
			pageHeight: 841.89,
			documents: [
				{
					documentId: DOCUMENT_ID,
					position: 0,
					kind: 'markdown',
					title: 'agreement',
					pageCount: 2,
					pageWidth: 595.28,
					pageHeight: 841.89
				}
			]
		});
	});

	it('refuses an unauthenticated caller before resolving any store', async () => {
		const resolveApplication = vi.fn(() => application(ok));

		const response: Response = await createEnvelopeDocumentPdfHandler(
			resolveApplication,
			'pdf'
		)(event({ identityState: 'anonymous' }));

		expect(response.status).toBe(401);
		expect(resolveApplication).not.toHaveBeenCalled();
	});

	it('rejects an envelope ID that is not a UUID', async () => {
		const response: Response = await createEnvelopeDocumentPdfHandler(
			() => application(ok),
			'pdf'
		)(event({ envelopeId: 'not-a-uuid' }));
		expect(response.status).toBe(400);
	});

	it.each([
		['not_found', 404],
		['no_documents', 409],
		['unavailable', 503]
	] as const)('maps %s to an RFC 9457 problem', async (outcome, status) => {
		const response: Response = await createEnvelopeDocumentPdfHandler(
			() => application({ outcome }),
			'pdf'
		)(event());

		expect(response.status).toBe(status);
		expect(response.headers.get('content-type')).toContain('application/problem+json');
		const problem = (await response.json()) as { detail: string };
		expect(problem.detail).not.toContain('sent-documents');
	});

	it('does not leak a renderer failure to the caller', async () => {
		const exploding: EnvelopeDocumentPdfApplicationPort = {
			read: async (): Promise<EnvelopeDocumentPdfResult> => {
				throw new Error('r2: NoSuchKey draft-repositories/v1/envelopes/env-1/...');
			}
		};
		const response: Response = await createEnvelopeDocumentPdfHandler(
			() => exploding,
			'pdf'
		)(event());

		expect(response.status).toBe(503);
		expect(await response.text()).not.toMatch(/NoSuchKey|draft-repositories|org-1/);
	});
});
