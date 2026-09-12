import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { CompletionArtifactStatusService } from '$lib/application/completion-artifacts/completion-artifact-status';
import type { CompletionArtifactStore } from '$lib/ports/completion-artifact-store';
import {
	createCompletionArtifactStatusHandler,
	type CompletionArtifactStatusServiceResolver
} from './completion-artifact-status';

const ORGANIZATION_ID: string = '01900000-0000-7000-8000-000000000002';
const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';

function locals(state: App.Locals['identityState'] = 'authorized'): App.Locals {
	return {
		identityState: state,
		memberships:
			state === 'authorized'
				? [
						{
							joinedAt: '2026-09-11T00:00:00.000Z',
							role: 'owner',
							organization: {
								id: ORGANIZATION_ID,
								name: 'Workspace',
								slug: 'workspace',
								status: 'active'
							}
						}
					]
				: [],
		organizationId: state === 'authorized' ? ORGANIZATION_ID : null,
		principal:
			state === 'authorized' ? { subject: 'user-1', email: 'user@example.com', name: 'User' } : null
	};
}

function event(
	envelopeId: string = ENVELOPE_ID,
	state: App.Locals['identityState'] = 'authorized'
): RequestEvent {
	const url: URL = new URL(
		`https://signkit.example/api/v1/envelopes/${envelopeId}/completion-artifact`
	);
	return {
		locals: locals(state),
		params: { envelopeId },
		request: new Request(url),
		url
	} as RequestEvent;
}

function service(findCompletionArtifactStatus = vi.fn()) {
	const store: CompletionArtifactStore = {
		claimPendingCompletionArtifacts: vi.fn(),
		readClaimedCompletionArtifact: vi.fn(),
		readCompletionEvidence: vi.fn(),
		publishCompletionArtifact: vi.fn(),
		failCompletionArtifact: vi.fn(),
		findCompletionArtifactStatus
	};
	return new CompletionArtifactStatusService(store);
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
		expect(find).toHaveBeenCalledWith(ORGANIZATION_ID, ENVELOPE_ID);
		expect(body).toContain('published');
		expect(body).toContain('m'.repeat(64));
		expect(body).not.toContain('completion-artifacts/v1');
		expect(body).not.toContain('audit-event-1');
	});

	it('returns the same tenant-scoped not-found result for a missing envelope', async () => {
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
