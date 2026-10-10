import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import {
	PdfSealDownloadError,
	type PdfSealDownloadApplicationPort
} from '$lib/application/pdf-seals/pdf-seal-download';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';
import { createPdfSealDownloadHandler } from './pdf-seal-download';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const BYTES: Uint8Array<ArrayBuffer> = new TextEncoder().encode('%PDF-sealed');
const SHA256: string = 'a'.repeat(64);

function event(input?: {
	method?: 'GET' | 'HEAD';
	envelopeId?: string;
	locals?: App.Locals;
}): RequestEvent {
	const envelopeId: string = input?.envelopeId ?? ENVELOPE_ID;
	return createHttpRequestEvent({
		pathname: `/api/v1/envelopes/${envelopeId}/pdf-seal/pdf`,
		method: input?.method ?? 'GET',
		params: { envelopeId },
		locals: input?.locals ?? instanceScopedLocals('active')
	});
}

function application(
	result: Awaited<ReturnType<PdfSealDownloadApplicationPort['read']>> = {
		outcome: 'available',
		pdf: {
			bytes: BYTES,
			sha256: SHA256,
			byteSize: BYTES.byteLength,
			achievedProfile: 'pades-b-b'
		}
	}
): PdfSealDownloadApplicationPort & { read: ReturnType<typeof vi.fn> } {
	return { read: vi.fn(async () => result) };
}

describe('PDF seal download HTTP handler', () => {
	it('authorizes before resolving storage or reading an envelope', async () => {
		const resolve = vi.fn(() => application());
		const response = await createPdfSealDownloadHandler(resolve)(
			event({ locals: instanceScopedLocals('anonymous') })
		);
		expect(response.status).toBe(401);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('validates the envelope id before resolving storage', async () => {
		const resolve = vi.fn(() => application());
		const response = await createPdfSealDownloadHandler(resolve)(event({ envelopeId: 'bad-id' }));
		expect(response.status).toBe(400);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('returns a private exact attachment for GET and no body for HEAD', async () => {
		const app = application();
		const handler = createPdfSealDownloadHandler(() => app);
		const response = await handler(event());
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/pdf');
		expect(response.headers.get('content-length')).toBe(String(BYTES.byteLength));
		expect(response.headers.get('cache-control')).toContain('private, no-store');
		expect(response.headers.get('etag')).toBe(`"${SHA256}"`);
		expect(response.headers.get('content-disposition')).toBe(
			'attachment; filename="sealed-agreement.pdf"'
		);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);

		const head = await handler(event({ method: 'HEAD' }));
		expect(head.status).toBe(200);
		expect(head.headers.get('content-length')).toBe(String(BYTES.byteLength));
		expect(await head.text()).toBe('');
		expect(app.read).toHaveBeenCalledTimes(2);
	});

	it('distinguishes an unknown envelope from an unpublished seal', async () => {
		const missing = await createPdfSealDownloadHandler(() => application({ outcome: 'not_found' }))(
			event()
		);
		expect(missing.status).toBe(404);
		expect((await missing.json()) as { type: string }).toMatchObject({
			type: 'urn:signkit:problem:envelope-not-found'
		});

		const unpublished = await createPdfSealDownloadHandler(() =>
			application({ outcome: 'not_published' })
		)(event());
		expect(unpublished.status).toBe(404);
		expect((await unpublished.json()) as { type: string }).toMatchObject({
			type: 'urn:signkit:problem:pdf-seal-not-published'
		});
	});

	it('returns a fixed 503 and logs no internal object detail', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const unavailable = await createPdfSealDownloadHandler(() => null)(event());
		expect(unavailable.status).toBe(503);

		const failed = await createPdfSealDownloadHandler(() => ({
			read: async () => {
				throw new PdfSealDownloadError('pdf_seal_object_mismatch');
			}
		}))(event());
		expect(failed.status).toBe(503);
		const logged: string = errorSpy.mock.calls.flat().join(' ');
		expect(logged).toContain('pdf_seal_object_mismatch');
		expect(logged).not.toContain('pdf-seals/v1');
		errorSpy.mockRestore();
	});
});
