import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import {
	DraftEnvelopeImmutableError,
	DraftEnvelopeNotFoundError,
	DraftGenerationConflictError,
	DraftIdempotencyConflictError,
	DraftIntegrityError,
	DraftReadConflictError,
	type CommitDraftResult,
	type DraftPersistenceService,
	type DraftWorkspaceSnapshot
} from '$lib/application/drafts/draft-persistence';
import { createDraftHttpHandlers, type DraftPersistenceResolver } from './drafts';
import { createHttpRequestEvent, organizationScopedLocals } from './http-handler-test-support';

const organizationId = '01900000-0000-7000-8000-000000000002';
const envelopeId = '01900000-0000-7000-8000-000000000001';
const pathname = `/api/v1/envelopes/${envelopeId}/draft`;
const commitPathname = `${pathname}/commits`;
type DraftPersistencePort = Pick<DraftPersistenceService, 'commit' | 'readWorkspace'>;

function locals(state: App.Locals['identityState'] = 'authorized'): App.Locals {
	return organizationScopedLocals(state, organizationId);
}

function event(
	input: {
		locals?: App.Locals;
		envelopeId?: string;
		platform?: App.Platform;
		commit?: boolean;
		body?: BodyInit;
		headers?: HeadersInit;
	} = {}
): RequestEvent {
	const selectedEnvelopeId: string = input.envelopeId ?? envelopeId;
	return createHttpRequestEvent({
		pathname: `/api/v1/envelopes/${selectedEnvelopeId}/draft${input.commit ? '/commits' : ''}`,
		method: input.commit ? 'POST' : 'GET',
		body: input.body,
		headers: input.headers,
		locals: input.locals ?? locals(),
		params: { envelopeId: selectedEnvelopeId },
		platform: input.platform
	});
}

function committedResult(outcome: CommitDraftResult['outcome'] = 'committed'): CommitDraftResult {
	return {
		outcome,
		revision: {
			generation: 3,
			commitSha: '2'.repeat(40),
			archiveKey: 'private/archive.git.gz',
			archiveSha256: 'b'.repeat(64),
			updatedAt: '2026-09-11T00:01:00.000Z',
			auditEventId: '01900000-0000-7000-8000-000000000009'
		}
	};
}

function persistence(overrides: Partial<DraftPersistencePort> = {}): DraftPersistencePort {
	return {
		readWorkspace: async (): Promise<DraftWorkspaceSnapshot> => workspace(),
		commit: async (): Promise<CommitDraftResult> => committedResult(),
		...overrides
	};
}

function commitBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		expectedGeneration: 2,
		message: 'Update agreement',
		edits: [{ path: 'documents/agreement.md', content: '# Updated agreement\n' }],
		...overrides
	});
}

function commitEvent(overrides: Parameters<typeof event>[0] = {}): RequestEvent {
	return event({
		commit: true,
		body: commitBody(),
		headers: {
			'content-type': 'application/json',
			'idempotency-key': 'draft-request-1'
		},
		...overrides
	});
}

function workspace(overrides: Partial<DraftWorkspaceSnapshot> = {}): DraftWorkspaceSnapshot {
	return {
		generation: 2,
		commitSha: '1'.repeat(40),
		archiveKey: `draft-repositories/private/${envelopeId}.git.gz`,
		archiveSha256: 'a'.repeat(64),
		documents: [{ path: 'documents/agreement.md', content: '# Agreement' }],
		documentSet: null,
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
		const resolver: DraftPersistenceResolver = vi.fn(() => persistence({ readWorkspace }));
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
		const resolver: DraftPersistenceResolver = () =>
			persistence({
				readWorkspace: async (): Promise<DraftWorkspaceSnapshot> => workspace()
			});
		const response: Response = await invoke(createDraftHttpHandlers(resolver).get, event());
		const body: Record<string, unknown> = await response.json();

		expect(body).toEqual({
			generation: 2,
			commitSha: '1'.repeat(40),
			archiveSha256: 'a'.repeat(64),
			documents: [{ path: 'documents/agreement.md', content: '# Agreement' }],
			documentSet: null
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
			createDraftHttpHandlers(() =>
				persistence({
					readWorkspace: async (): Promise<never> => {
						throw new DraftEnvelopeNotFoundError();
					}
				})
			).get,
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
			createDraftHttpHandlers(() =>
				persistence({
					readWorkspace: async (): Promise<never> => {
						throw failure;
					}
				})
			).get,
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

	it('authorizes a commit before reading its body or resolving persistence', async () => {
		const resolver: DraftPersistenceResolver = vi.fn(() => persistence());
		const response: Response = await invoke(
			createDraftHttpHandlers(resolver).commit,
			event({
				commit: true,
				locals: locals('anonymous'),
				body: 'not json'
			})
		);

		expect(response.status).toBe(401);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('validates the commit envelope UUID before resolving persistence', async () => {
		const resolver: DraftPersistenceResolver = vi.fn(() => persistence());
		const response: Response = await invoke(
			createDraftHttpHandlers(resolver).commit,
			commitEvent({ envelopeId: 'not-a-uuid' })
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:validation-failed',
			status: 400
		});
		expect(resolver).not.toHaveBeenCalled();
	});

	it('requires a valid idempotency key and application/json content', async () => {
		const handlers = createDraftHttpHandlers(() => persistence());
		const missingKey: Response = await invoke(
			handlers.commit,
			event({
				commit: true,
				body: commitBody(),
				headers: { 'content-type': 'application/json' }
			})
		);
		const wrongMediaType: Response = await invoke(
			handlers.commit,
			event({
				commit: true,
				body: commitBody(),
				headers: { 'content-type': 'text/plain', 'idempotency-key': 'draft-request-1' }
			})
		);

		expect(missingKey.status).toBe(400);
		expect(await missingKey.json()).toMatchObject({
			type: 'urn:signkit:problem:idempotency-key-required'
		});
		expect(wrongMediaType.status).toBe(415);
		expect(await wrongMediaType.json()).toMatchObject({
			type: 'urn:signkit:problem:unsupported-media-type'
		});
	});

	it('accepts an application/json content type with parameters', async () => {
		const response: Response = await invoke(
			createDraftHttpHandlers(() => persistence()).commit,
			commitEvent({
				headers: {
					'content-type': 'Application/JSON; charset=utf-8',
					'idempotency-key': 'draft-request-1'
				}
			})
		);

		expect(response.status).toBe(201);
	});

	it('bounds the streamed JSON body before parsing it', async () => {
		const commit = vi.fn(async (): Promise<CommitDraftResult> => committedResult());
		const response: Response = await invoke(
			createDraftHttpHandlers(() => persistence({ commit })).commit,
			commitEvent({ body: JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) }) })
		);

		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:request-body-too-large'
		});
		expect(commit).not.toHaveBeenCalled();
	});

	it('rejects malformed UTF-8 JSON before resolving persistence', async () => {
		const resolver: DraftPersistenceResolver = vi.fn(() => persistence());
		const response: Response = await invoke(
			createDraftHttpHandlers(resolver).commit,
			commitEvent({ body: '{"expectedGeneration":' })
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ type: 'urn:signkit:problem:invalid-json' });
		expect(resolver).not.toHaveBeenCalled();
	});

	it.each([
		['negative generation', { expectedGeneration: -1 }],
		['fractional generation', { expectedGeneration: 1.5 }],
		['generation outside the portable database range', { expectedGeneration: 2_147_483_647 }],
		['empty message', { message: '   ' }],
		['multiline message', { message: 'first\nsecond' }],
		['empty edits', { edits: [] }],
		[
			'duplicate paths',
			{
				edits: [
					{ path: 'documents/a.md', content: 'a' },
					{ path: 'documents/a.md', content: 'b' }
				]
			}
		],
		['path traversal', { edits: [{ path: 'documents/../secret.md', content: 'secret' }] }],
		['nested path', { edits: [{ path: 'documents/sub/agreement.md', content: 'nested' }] }],
		['NUL content', { edits: [{ path: 'documents/agreement.md', content: 'bad\u0000text' }] }],
		['unknown input', { organizationId: 'attacker-organization' }]
	])('rejects invalid commit input: %s', async (_label: string, bodyOverride: object) => {
		const commit = vi.fn(async (): Promise<CommitDraftResult> => committedResult());
		const response: Response = await invoke(
			createDraftHttpHandlers(() => persistence({ commit })).commit,
			commitEvent({ body: commitBody(bodyOverride as Record<string, unknown>) })
		);

		expect(response.status).toBe(400);
		expect(response.headers.get('content-type')).toBe('application/problem+json');
		expect(commit).not.toHaveBeenCalled();
	});

	it('enforces per-file and aggregate UTF-8 content limits', async () => {
		const commit = vi.fn(async (): Promise<CommitDraftResult> => committedResult());
		const handler: RequestHandler = createDraftHttpHandlers(() => persistence({ commit })).commit;
		const perFile: Response = await invoke(
			handler,
			commitEvent({
				body: commitBody({
					// Normalization adds the trailing newline, so this is one byte over.
					edits: [{ path: 'documents/large.md', content: 'a'.repeat(512 * 1024) }]
				})
			})
		);
		const aggregate: Response = await invoke(
			handler,
			commitEvent({
				body: commitBody({
					edits: [
						{ path: 'documents/a.md', content: 'a'.repeat(350 * 1024) },
						{ path: 'documents/b.md', content: 'b'.repeat(350 * 1024) },
						{ path: 'documents/c.md', content: 'c'.repeat(350 * 1024) }
					]
				})
			})
		);

		expect(perFile.status).toBe(400);
		expect(aggregate.status).toBe(400);
		expect(commit).not.toHaveBeenCalled();
	});

	it('accepts content exactly at the normalized per-file UTF-8 limit', async () => {
		const commit = vi.fn(async (): Promise<CommitDraftResult> => committedResult());
		const response: Response = await invoke(
			createDraftHttpHandlers(() => persistence({ commit })).commit,
			commitEvent({
				body: commitBody({
					edits: [{ path: 'documents/large.md', content: 'a'.repeat(512 * 1024 - 1) }]
				})
			})
		);

		expect(response.status).toBe(201);
		expect(commit).toHaveBeenCalledOnce();
	});

	it('commits using only authenticated scope and returns a public revision', async () => {
		const commit = vi.fn(async (): Promise<CommitDraftResult> => committedResult());
		const resolver: DraftPersistenceResolver = vi.fn(() => persistence({ commit }));
		const platform: App.Platform = { env: {} } as App.Platform;
		const response: Response = await invoke(
			createDraftHttpHandlers(resolver).commit,
			commitEvent({
				platform,
				body: commitBody({
					message: '  Update agreement  ',
					provenance: { automationRunId: ' run-1 ', externalId: ' contract-1 ' }
				})
			})
		);
		const body: Record<string, unknown> = await response.json();

		expect(response.status).toBe(201);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('location')).toBe(`${commitPathname}/${'2'.repeat(40)}`);
		expect(resolver).toHaveBeenCalledWith({ locals: locals(), platform });
		expect(commit).toHaveBeenCalledWith({
			organizationId,
			envelopeId,
			actor: { id: 'user-1', name: 'User', email: 'user@example.com', type: 'user' },
			idempotencyKey: 'draft-request-1',
			expectedGeneration: 2,
			message: 'Update agreement',
			edits: [{ path: 'documents/agreement.md', content: '# Updated agreement\n' }],
			provenance: { automationRunId: 'run-1', externalId: 'contract-1' }
		});
		expect(body).toEqual({
			revision: {
				generation: 3,
				commitSha: '2'.repeat(40),
				archiveSha256: 'b'.repeat(64)
			}
		});
		expect(JSON.stringify(body)).not.toContain('archiveKey');
		expect(JSON.stringify(body)).not.toContain('private/archive');
	});

	it('marks an idempotent replay while returning the original revision', async () => {
		const response: Response = await invoke(
			createDraftHttpHandlers(() =>
				persistence({ commit: async (): Promise<CommitDraftResult> => committedResult('replayed') })
			).commit,
			commitEvent()
		);

		expect(response.status).toBe(201);
		expect(response.headers.get('idempotency-replayed')).toBe('true');
		expect(await response.json()).toMatchObject({ revision: { generation: 3 } });
	});

	it.each([
		[new DraftIdempotencyConflictError(), 'urn:signkit:problem:draft-idempotency-conflict'],
		[new DraftGenerationConflictError(2), 'urn:signkit:problem:draft-generation-conflict'],
		[new DraftEnvelopeImmutableError(), 'urn:signkit:problem:envelope-state-conflict']
	])('maps a draft command conflict to 409', async (failure: Error, type: string) => {
		const response: Response = await invoke(
			createDraftHttpHandlers(() =>
				persistence({
					commit: async (): Promise<never> => {
						throw failure;
					}
				})
			).commit,
			commitEvent()
		);

		expect(response.status).toBe(409);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toMatchObject({ type, status: 409 });
	});

	it('maps a missing organization-scoped envelope to the tenant-safe 404', async () => {
		const response: Response = await invoke(
			createDraftHttpHandlers(() =>
				persistence({
					commit: async (): Promise<never> => {
						throw new DraftEnvelopeNotFoundError();
					}
				})
			).commit,
			commitEvent()
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:envelope-not-found',
			instance: commitPathname
		});
	});

	it.each([new DraftIntegrityError('bad archive'), new Error('object storage failed')])(
		'fails closed when a commit cannot be completed (%s)',
		async (failure: Error) => {
			const response: Response = await invoke(
				createDraftHttpHandlers(() =>
					persistence({
						commit: async (): Promise<never> => {
							throw failure;
						}
					})
				).commit,
				commitEvent()
			);

			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({
				type: 'urn:signkit:problem:draft-service-unavailable',
				title: 'Draft service unavailable',
				status: 503,
				detail: 'The draft revision could not be committed safely.',
				instance: commitPathname
			});
		}
	);

	it('fails closed when commit persistence is unavailable', async () => {
		const response: Response = await invoke(
			createDraftHttpHandlers(() => null).commit,
			commitEvent()
		);

		expect(response.status).toBe(503);
		expect(response.headers.get('cache-control')).toBe('no-store');
	});
});
