import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { CompletionArtifactStatusService } from '$lib/application/completion-artifacts/completion-artifact-status';
import type { CompletionArtifactStore } from '$lib/ports/completion-artifact-store';
import type {
	CompletionArtifactPdfRecord,
	CompletionArtifactPdfStore
} from '$lib/ports/completion-artifact-pdf-store';
import {
	createCompletionArtifactStatusHandler,
	type CompletionArtifactStatusServiceResolver
} from './completion-artifact-status';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';

function locals(state: App.Locals['identityState'] = 'active'): App.Locals {
	return instanceScopedLocals(state);
}

function event(
	envelopeId: string = ENVELOPE_ID,
	state: App.Locals['identityState'] = 'active'
): RequestEvent {
	return createHttpRequestEvent({
		pathname: `/api/v1/envelopes/${envelopeId}/completion-artifact`,
		locals: locals(state),
		params: { envelopeId }
	});
}

function service(
	findCompletionArtifactStatus = vi.fn(),
	pdfRecord: CompletionArtifactPdfRecord | null | undefined = undefined
) {
	const store: CompletionArtifactStore = {
		claimPendingCompletionArtifacts: vi.fn(),
		readClaimedCompletionArtifact: vi.fn(),
		readCompletionEvidence: vi.fn(),
		publishCompletionArtifact: vi.fn(),
		failCompletionArtifact: vi.fn(),
		findCompletionArtifactStatus
	};
	if (pdfRecord === undefined) {
		return new CompletionArtifactStatusService(store);
	}
	const pdfStore: CompletionArtifactPdfStore = {
		publishCompletionArtifactPdf: vi.fn(async () => {
			throw new Error('unused');
		}),
		readCompletionArtifactPdf: vi.fn(async () => pdfRecord)
	};
	return new CompletionArtifactStatusService(store, pdfStore);
}

describe('completion artifact status HTTP handler', () => {
	it('authorizes and validates the envelope ID before resolving persistence', async () => {
		const resolver: CompletionArtifactStatusServiceResolver = vi.fn(() => null);
		const unauthorized: Response = await createCompletionArtifactStatusHandler(resolver)(
			event(ENVELOPE_ID, 'anonymous')
		);
		const invalid: Response = await createCompletionArtifactStatusHandler(resolver)(
			event('not-a-uuid')
		);

		expect(unauthorized.status).toBe(401);
		expect(invalid.status).toBe(400);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('returns only the allowlisted publication status and content digests', async () => {
		const find = vi.fn(async () => ({
			envelopeId: ENVELOPE_ID,
			envelopeCompleted: true,
			jobStatus: 'published' as const,
			attempts: 1,
			lastError: null,
			availableAt: null,
			published: {
				envelopeId: ENVELOPE_ID,
				manifestSha256: 'm'.repeat(64),
				jsonSha256: 'j'.repeat(64),
				markdownSha256: 'd'.repeat(64),
				publishedAt: '2026-09-12T00:00:00.000Z',
				auditEventId: 'audit-event-1'
			}
		}));
		const response: Response = await createCompletionArtifactStatusHandler(() => service(find))(
			event()
		);
		const body: string = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(find).toHaveBeenCalledWith(ENVELOPE_ID);
		expect(body).toContain('published');
		expect(body).toContain('m'.repeat(64));
		expect(body).toContain('"pdfStatus":"unavailable"');
		expect(body).not.toContain('completion-artifacts/v1');
		expect(body).not.toContain('audit-event-1');
	});

	it('reports a published PDF status without exposing its object key or digest', async () => {
		const find = vi.fn(async () => ({
			envelopeId: ENVELOPE_ID,
			envelopeCompleted: true,
			jobStatus: 'published' as const,
			attempts: 1,
			lastError: null,
			availableAt: null,
			published: {
				envelopeId: ENVELOPE_ID,
				manifestSha256: 'm'.repeat(64),
				jsonSha256: 'j'.repeat(64),
				markdownSha256: 'd'.repeat(64),
				publishedAt: '2026-09-12T00:00:00.000Z',
				auditEventId: 'audit-event-1'
			}
		}));
		const pdfRecord: CompletionArtifactPdfRecord = {
			envelopeId: ENVELOPE_ID,
			pdfObjectKey: 'completion-artifacts/v1/envelopes/env/sha256/abc.pdf',
			pdfSha256: 'a'.repeat(64),
			pdfByteSize: 1024,
			pdfManifestObjectKey: 'completion-artifacts/v1/envelopes/env/sha256/abc.json.gz',
			pdfManifestSha256: 'a'.repeat(64),
			publishedAt: '2026-09-12T00:00:00.000Z'
		};
		const response: Response = await createCompletionArtifactStatusHandler(() =>
			service(find, pdfRecord)
		)(event());
		const body: string = await response.text();

		expect(response.status).toBe(200);
		expect(body).toContain('"pdfStatus":"published"');
		expect(body).not.toContain('completion-artifacts/v1');
		expect(body).not.toContain('a'.repeat(64));
	});

	it('returns not found for a missing envelope', async () => {
		const find = vi.fn(async () => null);
		const response: Response = await createCompletionArtifactStatusHandler(() => service(find))(
			event()
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:envelope-not-found'
		});
	});
});
