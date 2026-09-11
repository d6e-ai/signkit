import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import {
	DraftEnvelopeNotFoundError,
	DraftIntegrityError,
	DraftReadConflictError,
	type DraftWorkspaceSnapshot
} from '$lib/application/drafts/draft-persistence';
import { createDraftHttpHandlers, type DraftPersistenceResolver } from './drafts';

const organizationId = '01900000-0000-7000-8000-000000000002';
const envelopeId = '01900000-0000-7000-8000-000000000001';
const pathname = `/api/v1/envelopes/${envelopeId}/draft`;

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
								id: organizationId,
								name: 'Workspace',
								slug: 'workspace',
								status: 'active'
							}
						}
					]
				: [],
		organizationId: state === 'authorized' ? organizationId : null,
		principal:
			state === 'authorized' ? { subject: 'user-1', email: 'user@example.com', name: 'User' } : null
	};
}

function event(
	input: {
		locals?: App.Locals;
		envelopeId?: string;
		platform?: App.Platform;
	} = {}
): RequestEvent {
	const selectedEnvelopeId: string = input.envelopeId ?? envelopeId;
	const selectedPathname: string = `/api/v1/envelopes/${selectedEnvelopeId}/draft`;
	const url: URL = new URL(`https://signkit.example${selectedPathname}`);
	return {
		locals: input.locals ?? locals(),
		params: { envelopeId: selectedEnvelopeId },
		platform: input.platform,
		request: new Request(url),
		url
	} as RequestEvent;
}

function workspace(overrides: Partial<DraftWorkspaceSnapshot> = {}): DraftWorkspaceSnapshot {
	return {
		generation: 2,
		commitSha: '1'.repeat(40),
		archiveKey: `draft-repositories/private/${envelopeId}.git.gz`,
		archiveSha256: 'a'.repeat(64),
		documents: [{ path: 'documents/agreement.md', content: '# Agreement' }],
		...overrides
	};
}

async function invoke(handler: RequestHandler, requestEvent: RequestEvent): Promise<Response> {
	return handler(requestEvent);
}

describe('draft HTTP handlers', () => {
	it('authorizes before resolving draft persistence', async () => {
		const resolver: DraftPersistenceResolver = vi.fn(() => null);
		const response: Response = await invoke(
			createDraftHttpHandlers(resolver).get,
			event({ locals: locals('anonymous') })
		);

		expect(response.status).toBe(401);
		expect(response.headers.get('content-type')).toBe('application/problem+json');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:authentication-required',
			status: 401
		});
		expect(resolver).not.toHaveBeenCalled();
	});

	it('rejects an invalid envelope UUID before resolving dependencies', async () => {
		const resolver: DraftPersistenceResolver = vi.fn(() => null);
		const response: Response = await invoke(
			createDraftHttpHandlers(resolver).get,
			event({ envelopeId: 'not-a-uuid' })
		);

		expect(response.status).toBe(400);
		expect(response.headers.get('content-type')).toBe('application/problem+json');
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:validation-failed',
			status: 400,
			detail: 'The envelope ID must be a UUID.'
		});
		expect(resolver).not.toHaveBeenCalled();
	});

	it('passes platform to the resolver and scopes the read using only authenticated organization', async () => {
		const readWorkspace = vi.fn(async (): Promise<DraftWorkspaceSnapshot> => workspace());
		const resolver: DraftPersistenceResolver = vi.fn(() => ({ readWorkspace }));
		const platform: App.Platform = { env: {} } as App.Platform;
		const response: Response = await invoke(
			createDraftHttpHandlers(resolver).get,
			event({ platform })
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('content-type')).toBe('application/json');
		expect(resolver).toHaveBeenCalledWith({ locals: locals(), platform });
		expect(readWorkspace).toHaveBeenCalledWith({ organizationId, envelopeId });
	});

	it('returns only the public draft workspace fields', async () => {
		const resolver: DraftPersistenceResolver = () => ({
			readWorkspace: async (): Promise<DraftWorkspaceSnapshot> => workspace()
		});
		const response: Response = await invoke(createDraftHttpHandlers(resolver).get, event());
		const body: Record<string, unknown> = await response.json();

		expect(body).toEqual({
			generation: 2,
			commitSha: '1'.repeat(40),
			archiveSha256: 'a'.repeat(64),
			documents: [{ path: 'documents/agreement.md', content: '# Agreement' }]
		});
		expect(body).not.toHaveProperty('archiveKey');
		expect(body).not.toHaveProperty('archive');
	});

	it('fails closed when persistence is not configured', async () => {
		const response: Response = await invoke(createDraftHttpHandlers(() => null).get, event());

		expect(response.status).toBe(503);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:draft-service-unavailable',
			status: 503
		});
	});

	it('fails closed when persistence resolution throws', async () => {
		const response: Response = await invoke(
			createDraftHttpHandlers(() => {
				throw new Error('provider initialization failed');
			}).get,
			event()
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ status: 503 });
	});

	it('maps an organization-scoped missing envelope to a tenant-safe 404', async () => {
		const response: Response = await invoke(
			createDraftHttpHandlers(() => ({
				readWorkspace: async (): Promise<never> => {
					throw new DraftEnvelopeNotFoundError();
				}
			})).get,
			event()
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			type: 'urn:signkit:problem:envelope-not-found',
			title: 'Envelope not found',
			status: 404,
			detail: 'No envelope was found in the authorized organization.',
			instance: pathname
		});
	});

	it.each([
		new DraftIntegrityError('archive hash mismatch'),
		new DraftReadConflictError(),
		new Error('object storage timed out')
	])('fails closed when a workspace cannot be safely read (%s)', async (failure: Error) => {
		const response: Response = await invoke(
			createDraftHttpHandlers(() => ({
				readWorkspace: async (): Promise<never> => {
					throw failure;
				}
			})).get,
			event()
		);

		expect(response.status).toBe(503);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({
			type: 'urn:signkit:problem:draft-service-unavailable',
			title: 'Draft service unavailable',
			status: 503,
			detail: 'The draft workspace could not be read safely.',
			instance: pathname
		});
	});
});
