import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	PdfSealApiApplicationPort,
	PublicPdfSealStatus,
	RequestPdfSealApplicationResult
} from '$lib/application/pdf-seals/pdf-seal-api';
import {
	createPdfSealRequestHandler,
	createPdfSealStatusHandler,
	type PdfSealApiRuntime
} from './pdf-seal';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const PATHNAME: string = `/api/v1/envelopes/${ENVELOPE_ID}/pdf-seal`;

function event(
	input: {
		method?: 'GET' | 'POST';
		body?: string;
		headers?: HeadersInit;
		locals?: App.Locals;
		envelopeId?: string;
	} = {}
): RequestEvent {
	const envelopeId: string = input.envelopeId ?? ENVELOPE_ID;
	return createHttpRequestEvent({
		pathname: `/api/v1/envelopes/${envelopeId}/pdf-seal`,
		method: input.method ?? 'GET',
		body: input.body,
		headers: input.headers,
		locals: input.locals ?? instanceScopedLocals('active'),
		params: { envelopeId },
		jsonBodyContentType: input.method === 'POST'
	});
}

function application(
	options: {
		request?: RequestPdfSealApplicationResult;
		status?: PublicPdfSealStatus | null;
	} = {}
): PdfSealApiApplicationPort {
	return {
		request: vi.fn(async (): Promise<RequestPdfSealApplicationResult> =>
			Promise.resolve<RequestPdfSealApplicationResult>(
				options.request ?? {
					outcome: 'requested',
					request: {
						envelopeId: ENVELOPE_ID,
						jobId: '01900000-0000-7000-8000-000000000002',
						requestedProfile: 'pades-b-b',
						requestedAt: '2026-09-23T00:00:00.000Z'
					}
				}
			)
		),
		findStatus: vi.fn(async () =>
			Promise.resolve(
				options.status === undefined
					? { envelopeId: ENVELOPE_ID, status: 'not_requested' as const }
					: options.status
			)
		)
	};
}

function runtime(app: PdfSealApiApplicationPort = application()): PdfSealApiRuntime {
	return {
		application: app,
		requestPolicy: {
			requestedProfile: 'pades-b-b',
			signerCertificateSha256: 'a'.repeat(64),
			sealPolicyId: 'seal-policy-v1',
			validationPolicyId: 'validation-policy-v1',
			tsaPolicyId: null,
			tsaTrustBundleSha256: null
		}
	};
}

describe('PDF seal API handlers', () => {
	it('authorizes and validates identifiers before resolving dependencies', async () => {
		const resolver = vi.fn(() => runtime());
		const unauthorized: Response = await createPdfSealStatusHandler(resolver)(
			event({ locals: instanceScopedLocals('anonymous') })
		);
		const invalid: Response = await createPdfSealStatusHandler(resolver)(
			event({ envelopeId: 'not-a-uuid' })
		);
		expect(unauthorized.status).toBe(401);
		expect(invalid.status).toBe(400);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('returns durable status while projecting the configured disabled state', async () => {
		const app: PdfSealApiApplicationPort = application();
		const disabledRuntime: PdfSealApiRuntime = { application: app, requestPolicy: null };
		const response: Response = await createPdfSealStatusHandler(() => disabledRuntime)(event());
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(app.findStatus).toHaveBeenCalledWith(ENVELOPE_ID, false);
		expect(await response.json()).toEqual({
			pdfSeal: { envelopeId: ENVELOPE_ID, status: 'not_requested' }
		});
	});

	it('accepts an explicit policy-matching request and passes authenticated provenance', async () => {
		const app: PdfSealApiApplicationPort = application();
		const response: Response = await createPdfSealRequestHandler(() => runtime(app))(
			event({
				method: 'POST',
				body: JSON.stringify({ requestedProfile: 'pades-b-b' }),
				headers: { 'idempotency-key': 'seal-request-1' }
			})
		);
		expect(response.status).toBe(202);
		expect(app.request).toHaveBeenCalledWith(
			{ id: 'user-1', createdByUserId: 'user-1', actorType: 'user' },
			ENVELOPE_ID,
			expect.objectContaining({
				idempotencyKey: 'seal-request-1',
				requestedProfile: 'pades-b-b'
			})
		);
		const text: string = await response.text();
		expect(text).not.toMatch(/objectKey|receipt|audit|provider|token/i);
	});

	it('marks same-key replay and maps durable conflicts', async () => {
		const request = {
			envelopeId: ENVELOPE_ID,
			jobId: '01900000-0000-7000-8000-000000000002',
			requestedProfile: 'pades-b-b' as const,
			requestedAt: '2026-09-23T00:00:00.000Z'
		};
		const replay: Response = await createPdfSealRequestHandler(() =>
			runtime(application({ request: { outcome: 'replayed', request } }))
		)(
			event({
				method: 'POST',
				body: JSON.stringify({ requestedProfile: 'pades-b-b' }),
				headers: { 'idempotency-key': 'seal-request-1' }
			})
		);
		expect(replay.headers.get('idempotency-replayed')).toBe('true');

		for (const [outcome, status] of [
			['idempotency_conflict', 409],
			['not_found', 404],
			['source_unavailable', 409]
		] as const) {
			const response: Response = await createPdfSealRequestHandler(() =>
				runtime(application({ request: { outcome } }))
			)(
				event({
					method: 'POST',
					body: JSON.stringify({ requestedProfile: 'pades-b-b' }),
					headers: { 'idempotency-key': `seal-${outcome}` }
				})
			);
			expect(response.status).toBe(status);
		}
	});

	it('rejects disabled or policy-mismatched requests without calling persistence', async () => {
		const app: PdfSealApiApplicationPort = application();
		const disabledResponse: Response = await createPdfSealRequestHandler(() => ({
			application: app,
			requestPolicy: null
		}))(
			event({
				method: 'POST',
				body: JSON.stringify({ requestedProfile: 'pades-b-b' }),
				headers: { 'idempotency-key': 'seal-disabled' }
			})
		);
		const mismatchResponse: Response = await createPdfSealRequestHandler(() => runtime(app))(
			event({
				method: 'POST',
				body: JSON.stringify({ requestedProfile: 'pades-b-t' }),
				headers: { 'idempotency-key': 'seal-mismatch' }
			})
		);
		expect(disabledResponse.status).toBe(409);
		expect(mismatchResponse.status).toBe(409);
		expect(app.request).not.toHaveBeenCalled();
	});

	it('requires a valid idempotency key and bounded strict JSON', async () => {
		const missingKey: Response = await createPdfSealRequestHandler(() => runtime())(
			event({ method: 'POST', body: JSON.stringify({ requestedProfile: 'pades-b-b' }) })
		);
		const extraField: Response = await createPdfSealRequestHandler(() => runtime())(
			event({
				method: 'POST',
				body: JSON.stringify({ requestedProfile: 'pades-b-b', source: 'discover-me' }),
				headers: { 'idempotency-key': 'seal-extra' }
			})
		);
		expect(missingKey.status).toBe(400);
		expect(extraField.status).toBe(400);
	});

	it('uses the canonical endpoint path', () => {
		expect(PATHNAME).toBe('/api/v1/envelopes/01900000-0000-7000-8000-000000000001/pdf-seal');
	});
});
