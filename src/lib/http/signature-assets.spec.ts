import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	SignatureAssetApplicationPort,
	StoreSignatureAssetResult
} from '$lib/application/documents/signature-asset';
import { RECIPIENT_SESSION_COOKIE } from '$lib/server/recipient-session';
import {
	createSignatureAssetHandler,
	type RecipientSessionUnsealer,
	type SignatureAssetApplicationResolver
} from './signature-assets';

const envelopeId: string = '01900000-0000-7000-8000-000000000001';
const recipientId: string = '01900000-0000-7000-8000-000000000002';
const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBytes(extra: number = 32): Uint8Array {
	const bytes = new Uint8Array(PNG_MAGIC.byteLength + extra);
	bytes.set(PNG_MAGIC);
	return bytes;
}

function buildEvent(options: {
	pathname?: string;
	origin?: string | null;
	contentType?: string | null;
	cookie?: string | null;
	body?: Uint8Array | null;
}): { event: RequestEvent; deleted: ReturnType<typeof vi.fn> } {
	const pathname =
		options.pathname ??
		`/api/v1/signing/signature-assets?envelopeId=${envelopeId}&recipientId=${recipientId}`;
	const headers = new Headers();
	if (options.origin !== null) headers.set('origin', options.origin ?? 'https://signkit.example');
	if (options.contentType !== null) headers.set('content-type', options.contentType ?? 'image/png');
	const deleted = vi.fn();
	const cookie: string | undefined =
		'cookie' in options && options.cookie === null
			? undefined
			: (options.cookie ?? 'sealed-session');
	const cookies = {
		get: vi.fn((name: string): string | undefined =>
			name === RECIPIENT_SESSION_COOKIE ? cookie : undefined
		),
		delete: deleted
	} as unknown as Cookies;
	const body = options.body === undefined ? pngBytes() : options.body;
	const request = new Request(`https://signkit.example${pathname}`, {
		method: 'POST',
		headers,
		body: body === null ? undefined : (body as BodyInit)
	});
	return {
		event: {
			cookies,
			platform: { env: { DB: {} as D1Database } },
			request,
			url: new URL(request.url)
		} as unknown as RequestEvent,
		deleted
	};
}

function application(result: StoreSignatureAssetResult): SignatureAssetApplicationPort {
	return { store: vi.fn(async () => result) };
}

const unseal: RecipientSessionUnsealer = async () => 'valid-token';

describe('signature asset HTTP handler', () => {
	it('rejects a cross-origin request', async () => {
		const { event } = buildEvent({ origin: 'https://evil.example' });
		const resolver: SignatureAssetApplicationResolver = () =>
			application({ outcome: 'stored', assetRef: 'sig:sha256:' + 'a'.repeat(64) });
		const response = await createSignatureAssetHandler(resolver, unseal)(event);
		expect(response.status).toBe(403);
	});

	it('rejects an invalid envelopeId or recipientId', async () => {
		const { event } = buildEvent({
			pathname: '/api/v1/signing/signature-assets?envelopeId=not-a-uuid&recipientId=' + recipientId
		});
		const resolver: SignatureAssetApplicationResolver = () =>
			application({ outcome: 'stored', assetRef: 'sig:sha256:' + 'a'.repeat(64) });
		const response = await createSignatureAssetHandler(resolver, unseal)(event);
		expect(response.status).toBe(400);
	});

	it('requires an image/png content type', async () => {
		const { event } = buildEvent({ contentType: 'application/octet-stream' });
		const resolver: SignatureAssetApplicationResolver = () =>
			application({ outcome: 'stored', assetRef: 'sig:sha256:' + 'a'.repeat(64) });
		const response = await createSignatureAssetHandler(resolver, unseal)(event);
		expect(response.status).toBe(415);
	});

	it('returns 404 without an active recipient session cookie', async () => {
		const { event } = buildEvent({ cookie: null });
		const resolver: SignatureAssetApplicationResolver = () =>
			application({ outcome: 'stored', assetRef: 'sig:sha256:' + 'a'.repeat(64) });
		const response = await createSignatureAssetHandler(resolver, unseal)(event);
		expect(response.status).toBe(404);
	});

	it('stores a valid PNG and returns its assetRef', async () => {
		const assetRef = 'sig:sha256:' + 'a'.repeat(64);
		const { event } = buildEvent({});
		const store = application({ outcome: 'stored', assetRef });
		const response = await createSignatureAssetHandler(() => store, unseal)(event);
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ assetRef });
		expect(store.store).toHaveBeenCalledWith(
			expect.objectContaining({
				token: 'valid-token',
				expectedEnvelopeId: envelopeId,
				expectedRecipientId: recipientId
			})
		);
	});

	it.each([
		['not_found', 404],
		['context_mismatch', 404],
		['too_large', 413],
		['invalid_image', 400],
		['integrity_error', 503]
	] as const)('maps %s to status %i', async (outcome, status) => {
		const { event } = buildEvent({});
		const resolver: SignatureAssetApplicationResolver = () => application({ outcome });
		const response = await createSignatureAssetHandler(resolver, unseal)(event);
		expect(response.status).toBe(status);
	});

	it('returns 503 when the application cannot be resolved', async () => {
		const { event } = buildEvent({});
		const resolver: SignatureAssetApplicationResolver = () => null;
		const response = await createSignatureAssetHandler(resolver, unseal)(event);
		expect(response.status).toBe(503);
	});
});
