import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import {
	CompletionEvidenceReadError,
	type CompletionEvidenceApplicationPort,
	type CompletionEvidenceResult,
	type CompletionPdfResult
} from '$lib/application/completion-artifacts/completion-evidence-service';
import { createCompletionEvidenceHandler } from './completion-evidence';
import { createCompletionPdfHandler } from './completion-pdf';
import { createHttpRequestEvent, organizationScopedLocals } from './http-handler-test-support';

const organizationId = '01900000-0000-7000-8000-000000000010';
const envelopeId = '01900000-0000-7000-8000-000000000020';

function authorizedLocals(): App.Locals {
	return organizationScopedLocals('authorized', organizationId);
}

function unauthorizedLocals(): App.Locals {
	return organizationScopedLocals('anonymous', organizationId);
}

function event(input: {
	pathname: string;
	search?: string;
	envelopeIdParam?: string;
	locals?: App.Locals;
}): RequestEvent {
	const params: Record<string, string> = {};
	if (input.envelopeIdParam !== undefined) {
		params.envelopeId = input.envelopeIdParam;
	} else {
		params.envelopeId = envelopeId;
	}

	return createHttpRequestEvent({
		pathname: input.pathname,
		method: 'GET',
		search: input.search,
		locals: input.locals ?? authorizedLocals(),
		params
	});
}

function mockService(
	overrides: Partial<CompletionEvidenceApplicationPort> = {}
): CompletionEvidenceApplicationPort {
	return {
		readEvidence: vi.fn(
			async (
				_orgId: string,
				_envId: string,
				format: 'json' | 'markdown' = 'json'
			): Promise<CompletionEvidenceResult | null> => ({
				content: format === 'json' ? '{"schema":"completion-manifest-v1"}' : '# Evidence',
				contentType: format === 'json' ? 'application/json' : 'text/markdown; charset=utf-8',
				digest: 'd'.repeat(64)
			})
		),
		readPdf: vi.fn(async (): Promise<CompletionPdfResult | null> => ({
			stream: new ReadableStream<Uint8Array>(),
			sha256: 'e'.repeat(64)
		})),
		envelopeExists: vi.fn(async () => true),
		...overrides
	};
}

describe('Completion Evidence HTTP Handler', () => {
	it('requires authorization', async () => {
		const service = mockService();
		const handler = createCompletionEvidenceHandler(() => service);
		const response = await handler(
			event({
				pathname: `/api/v1/envelopes/${envelopeId}/completion-artifact/evidence`,
				locals: unauthorizedLocals()
			})
		);
		expect(response.status).toBe(401);
		expect(service.readEvidence).not.toHaveBeenCalled();
	});

	it('validates UUID envelopeId parameter', async () => {
		const service = mockService();
		const handler = createCompletionEvidenceHandler(() => service);
		const response = await handler(
			event({
				pathname: `/api/v1/envelopes/bad-id/completion-artifact/evidence`,
				envelopeIdParam: 'bad-id'
			})
		);
		expect(response.status).toBe(400);
		expect(service.readEvidence).not.toHaveBeenCalled();
	});

	it('returns 200 with JSON evidence by default', async () => {
		const service = mockService();
		const handler = createCompletionEvidenceHandler(() => service);
		const response = await handler(event({ pathname: `/api/v1/envelopes/${envelopeId}/evidence` }));

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/json');
		expect(response.headers.get('cache-control')).toBe('private, no-cache');
		expect(response.headers.get('etag')).toBe(`"${'d'.repeat(64)}"`);
		expect(await response.text()).toBe('{"schema":"completion-manifest-v1"}');
		expect(service.readEvidence).toHaveBeenCalledWith(organizationId, envelopeId, 'json');
	});

	it('returns 200 with Markdown evidence when format=markdown is requested', async () => {
		const service = mockService();
		const handler = createCompletionEvidenceHandler(() => service);
		const response = await handler(
			event({
				pathname: `/api/v1/envelopes/${envelopeId}/completion-artifact/evidence`,
				search: '?format=markdown'
			})
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
		expect(await response.text()).toBe('# Evidence');
		expect(service.readEvidence).toHaveBeenCalledWith(organizationId, envelopeId, 'markdown');
	});

	it('returns 404 when evidence is not published or envelope does not exist', async () => {
		const serviceEvidenceMissing = mockService({
			readEvidence: async () => null,
			envelopeExists: async () => true
		});
		const handlerMissing = createCompletionEvidenceHandler(() => serviceEvidenceMissing);
		const resMissing = await handlerMissing(
			event({ pathname: `/api/v1/envelopes/${envelopeId}/evidence` })
		);
		expect(resMissing.status).toBe(404);
		const bodyMissing = (await resMissing.json()) as { type: string };
		expect(bodyMissing.type).toBe('urn:signkit:problem:completion-evidence-not-found');

		const serviceEnvMissing = mockService({
			readEvidence: async () => null,
			envelopeExists: async () => false
		});
		const handlerEnvMissing = createCompletionEvidenceHandler(() => serviceEnvMissing);
		const resEnvMissing = await handlerEnvMissing(
			event({ pathname: `/api/v1/envelopes/${envelopeId}/evidence` })
		);
		expect(resEnvMissing.status).toBe(404);
		const bodyEnvMissing = (await resEnvMissing.json()) as { type: string };
		expect(bodyEnvMissing.type).toBe('urn:signkit:problem:envelope-not-found');
	});

	it('logs a stable error name and code without object keys when evidence read fails', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const leakedKey =
			'completion-artifacts/v1/organizations/org-1/envelopes/env-1/sha256/abc.json.gz';
		const handler = createCompletionEvidenceHandler(() =>
			mockService({
				readEvidence: async () => {
					throw new CompletionEvidenceReadError('artifact_object_missing');
				}
			})
		);
		const response = await handler(event({ pathname: `/api/v1/envelopes/${envelopeId}/evidence` }));
		expect(response.status).toBe(503);
		const logged = String(errorSpy.mock.calls[0]?.[0]);
		expect(logged).toContain('completion_evidence_failed');
		expect(logged).toContain('CompletionEvidenceReadError');
		expect(logged).toContain('artifact_object_missing');
		expect(logged).not.toContain('completion-artifacts/');
		expect(logged).not.toContain(leakedKey);
		expect(logged).not.toContain('"message"');
		errorSpy.mockRestore();
	});
});

describe('Completion PDF HTTP Handler', () => {
	it('requires authorization', async () => {
		const service = mockService();
		const handler = createCompletionPdfHandler(() => service);
		const response = await handler(
			event({
				pathname: `/api/v1/envelopes/${envelopeId}/completion-artifact/pdf`,
				locals: unauthorizedLocals()
			})
		);
		expect(response.status).toBe(401);
		expect(service.readPdf).not.toHaveBeenCalled();
	});

	it('validates UUID envelopeId parameter', async () => {
		const service = mockService();
		const handler = createCompletionPdfHandler(() => service);
		const response = await handler(
			event({
				pathname: `/api/v1/envelopes/bad-id/pdf`,
				envelopeIdParam: 'bad-id'
			})
		);
		expect(response.status).toBe(400);
		expect(service.readPdf).not.toHaveBeenCalled();
	});

	it('returns 200 with immutable PDF stream, etag, and content disposition headers', async () => {
		const service = mockService();
		const handler = createCompletionPdfHandler(() => service);
		const response = await handler(event({ pathname: `/api/v1/envelopes/${envelopeId}/pdf` }));

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/pdf');
		expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(response.headers.get('etag')).toBe(`"${'e'.repeat(64)}"`);
		expect(response.headers.get('content-disposition')).toBe(
			`inline; filename="completion-${envelopeId}.pdf"`
		);
		expect(service.readPdf).toHaveBeenCalledWith(organizationId, envelopeId);
	});

	it('returns 404 when PDF is not published or envelope does not exist', async () => {
		const servicePdfMissing = mockService({
			readPdf: async () => null,
			envelopeExists: async () => true
		});
		const handlerMissing = createCompletionPdfHandler(() => servicePdfMissing);
		const resMissing = await handlerMissing(
			event({ pathname: `/api/v1/envelopes/${envelopeId}/pdf` })
		);
		expect(resMissing.status).toBe(404);
		const bodyMissing = (await resMissing.json()) as { type: string };
		expect(bodyMissing.type).toBe('urn:signkit:problem:completion-pdf-not-found');

		const serviceEnvMissing = mockService({
			readPdf: async () => null,
			envelopeExists: async () => false
		});
		const handlerEnvMissing = createCompletionPdfHandler(() => serviceEnvMissing);
		const resEnvMissing = await handlerEnvMissing(
			event({ pathname: `/api/v1/envelopes/${envelopeId}/pdf` })
		);
		expect(resEnvMissing.status).toBe(404);
		const bodyEnvMissing = (await resEnvMissing.json()) as { type: string };
		expect(bodyEnvMissing.type).toBe('urn:signkit:problem:envelope-not-found');
	});

	it('logs a stable error name and code without object keys when PDF read fails', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const handler = createCompletionPdfHandler(() =>
			mockService({
				readPdf: async () => {
					throw new CompletionEvidenceReadError('pdf_object_missing');
				}
			})
		);
		const response = await handler(event({ pathname: `/api/v1/envelopes/${envelopeId}/pdf` }));
		expect(response.status).toBe(503);
		const logged = String(errorSpy.mock.calls[0]?.[0]);
		expect(logged).toContain('completion_pdf_failed');
		expect(logged).toContain('CompletionEvidenceReadError');
		expect(logged).toContain('pdf_object_missing');
		expect(logged).not.toContain('completion-artifacts/');
		expect(logged).not.toContain('"message"');
		errorSpy.mockRestore();
	});
});
