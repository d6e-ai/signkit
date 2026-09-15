import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	RecipientSentPdfApplicationPort,
	RecipientSentPdfResult
} from '$lib/application/signing/recipient-sent-pdf';
import { recipientSessionCookieName } from '$lib/server/recipient-session';
import { createRecipientSentPdfHandler } from './recipient-sent-pdf';

const TOKEN: string = `skr1_${'A'.repeat(43)}`;
const ENVELOPE_ID: string = '01910000-0000-7000-8000-000000000001';
const OTHER_ENVELOPE_ID: string = '01910000-0000-7000-8000-000000000011';
const COOKIE_NAME: string = recipientSessionCookieName(ENVELOPE_ID) as string;
const BYTES: Uint8Array = new TextEncoder().encode('%PDF-1.7\nbody\n%%EOF\n');
const SHA256: string = 'a'.repeat(64);

function event(
	options: { cookie?: string; method?: string; envelopeId?: string; documentId?: string } = {}
): RequestEvent {
	const envelopeId: string = options.envelopeId ?? ENVELOPE_ID;
	const cookieName: string | null = recipientSessionCookieName(envelopeId);
	const cookies = {
		get: (name: string): string | undefined =>
			cookieName !== null && name === cookieName ? options.cookie : undefined
	} as unknown as Cookies;
	const pathname =
		options.documentId === undefined
			? `/sign/${envelopeId}/agreement.pdf`
			: `/sign/${envelopeId}/documents/${options.documentId}.pdf`;
	return {
		cookies,
		params: {
			envelopeId,
			...(options.documentId === undefined ? {} : { documentId: options.documentId })
		},
		platform: { env: { DB: {} as D1Database, OBJECTS: {} as R2Bucket } },
		request: new Request(`https://signkit.example${pathname}`, {
			method: options.method ?? 'GET'
		}),
		url: new URL(`https://signkit.example${pathname}`)
	} as unknown as RequestEvent;
}

function application(result: RecipientSentPdfResult): RecipientSentPdfApplicationPort {
	return { read: vi.fn(async (): Promise<RecipientSentPdfResult> => result) };
}

const ok: RecipientSentPdfResult = {
	outcome: 'ok',
	bytes: BYTES,
	sha256: SHA256,
	byteSize: BYTES.byteLength
};

const unseal = async (): Promise<string> => TOKEN;

describe('recipient sent PDF HTTP handler', () => {
	it('serves application/pdf with private, unframeable headers', async () => {
		const app: RecipientSentPdfApplicationPort = application(ok);
		const response: Response = await createRecipientSentPdfHandler(
			() => app,
			unseal
		)(event({ cookie: 'sealed' }));

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/pdf');
		expect(response.headers.get('cache-control')).toBe(
			'private, no-store, max-age=0, must-revalidate'
		);
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('vary')).toBe('Cookie');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
		expect(response.headers.get('x-frame-options')).toBe('DENY');
		expect(response.headers.get('content-length')).toBe(String(BYTES.byteLength));
		expect(app.read).toHaveBeenCalledWith(TOKEN, ENVELOPE_ID, undefined);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
	});

	it('names the download generically, never after the envelope or recipient', async () => {
		const response: Response = await createRecipientSentPdfHandler(
			() => application(ok),
			unseal
		)(event({ cookie: 'sealed' }));
		expect(response.headers.get('content-disposition')).toBe(
			'attachment; filename="agreement.pdf"'
		);
	});

	it.each([
		['no session cookie', undefined],
		['a cookie that will not unseal', 'garbage']
	] as const)('answers %s with an opaque, empty 404', async (_name, cookie) => {
		const resolveApplication = vi.fn(() => application(ok));
		const response: Response = await createRecipientSentPdfHandler(
			resolveApplication,
			async (): Promise<string | null> => null
		)(event({ cookie }));

		expect(response.status).toBe(404);
		expect(await response.text()).toBe('');
		expect(response.headers.get('content-type')).toBeNull();
		expect(resolveApplication).not.toHaveBeenCalled();
	});

	it('answers a non-UUIDv7 path with the same opaque 404 without reading cookies', async () => {
		const resolveApplication = vi.fn(() => application(ok));
		const cookies = { get: vi.fn() } as unknown as Cookies;
		const response: Response = await createRecipientSentPdfHandler(
			resolveApplication,
			unseal
		)({
			cookies,
			params: { envelopeId: 'not-a-uuid' },
			platform: { env: { DB: {} as D1Database, OBJECTS: {} as R2Bucket } },
			request: new Request('https://signkit.example/sign/not-a-uuid/agreement.pdf'),
			url: new URL('https://signkit.example/sign/not-a-uuid/agreement.pdf')
		} as unknown as RequestEvent);

		expect(response.status).toBe(404);
		expect(cookies.get).not.toHaveBeenCalled();
		expect(resolveApplication).not.toHaveBeenCalled();
	});

	it('does not use another envelope cookie when the path names a different envelope', async () => {
		const resolveApplication = vi.fn(() => application(ok));
		const cookies = {
			get: vi.fn((name: string): string | undefined =>
				name === COOKIE_NAME ? 'sealed-for-other-envelope' : undefined
			)
		} as unknown as Cookies;
		const response: Response = await createRecipientSentPdfHandler(
			resolveApplication,
			unseal
		)({
			cookies,
			params: { envelopeId: OTHER_ENVELOPE_ID },
			platform: { env: { DB: {} as D1Database, OBJECTS: {} as R2Bucket } },
			request: new Request(`https://signkit.example/sign/${OTHER_ENVELOPE_ID}/agreement.pdf`),
			url: new URL(`https://signkit.example/sign/${OTHER_ENVELOPE_ID}/agreement.pdf`)
		} as unknown as RequestEvent);

		expect(response.status).toBe(404);
		expect(cookies.get).toHaveBeenCalledWith(recipientSessionCookieName(OTHER_ENVELOPE_ID));
		expect(cookies.get).not.toHaveBeenCalledWith(COOKIE_NAME);
		expect(resolveApplication).not.toHaveBeenCalled();
	});

	it('answers inactive access with the same opaque 404 as an unknown path', async () => {
		const response: Response = await createRecipientSentPdfHandler(
			() => application({ outcome: 'not_found' }),
			unseal
		)(event({ cookie: 'sealed' }));

		expect(response.status).toBe(404);
		expect(await response.text()).toBe('');
	});

	it.each([
		['an unresolvable runtime', null],
		['an integrity failure', application({ outcome: 'unavailable' })]
	] as const)('answers %s with a fixed, empty 503', async (_name, resolved) => {
		const response: Response = await createRecipientSentPdfHandler(
			() => resolved,
			unseal
		)(event({ cookie: 'sealed' }));

		expect(response.status).toBe(503);
		expect(await response.text()).toBe('');
		expect(response.headers.get('cache-control')).toBe(
			'private, no-store, max-age=0, must-revalidate'
		);
	});

	it('never leaks a provider error, an identifier, or an object key', async () => {
		const exploding: RecipientSentPdfApplicationPort = {
			read: async (): Promise<RecipientSentPdfResult> => {
				throw new Error('r2: NoSuchKey sent-documents/v1/organizations/org-1/...');
			}
		};
		const response: Response = await createRecipientSentPdfHandler(
			() => exploding,
			unseal
		)(event({ cookie: 'sealed' }));

		expect(response.status).toBe(503);
		const body: string = await response.text();
		expect(body).toBe('');
		expect(JSON.stringify([...response.headers.entries()])).not.toMatch(
			/org-1|sent-documents|NoSuchKey|skr1_/
		);
	});

	it('rejects a write method with the same opaque 404', async () => {
		const resolveApplication = vi.fn(() => application(ok));
		const response: Response = await createRecipientSentPdfHandler(
			resolveApplication,
			unseal
		)(event({ cookie: 'sealed', method: 'POST' }));

		expect(response.status).toBe(404);
		expect(resolveApplication).not.toHaveBeenCalled();
	});

	it('answers HEAD with the headers but no body', async () => {
		const response: Response = await createRecipientSentPdfHandler(
			() => application(ok),
			unseal
		)(event({ cookie: 'sealed', method: 'HEAD' }));

		expect(response.status).toBe(200);
		expect(response.headers.get('content-length')).toBe(String(BYTES.byteLength));
		expect(await response.text()).toBe('');
	});

	it('serves one document from the pinned set when documentId is in the path', async () => {
		const documentId: string = '01900000-0000-7000-8000-000000000021';
		const app: RecipientSentPdfApplicationPort = application(ok);
		const response: Response = await createRecipientSentPdfHandler(
			() => app,
			unseal
		)(event({ cookie: 'sealed', documentId }));

		expect(response.status).toBe(200);
		expect(app.read).toHaveBeenCalledWith(TOKEN, ENVELOPE_ID, documentId);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
	});

	it('answers a non-UUIDv7 documentId with the same opaque 404', async () => {
		const resolveApplication = vi.fn(() => application(ok));
		const response: Response = await createRecipientSentPdfHandler(
			resolveApplication,
			unseal
		)(event({ cookie: 'sealed', documentId: 'legacy' }));

		expect(response.status).toBe(404);
		expect(resolveApplication).not.toHaveBeenCalled();
	});
});
