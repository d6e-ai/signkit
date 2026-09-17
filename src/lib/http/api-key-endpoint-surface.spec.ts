import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyPrincipal } from '$lib/ports/api-key-authentication-store';
import type { ApiKeyScope } from '$lib/security/api-key';
import { DraftEnvelopeNotFoundError } from '$lib/application/drafts/draft-persistence';
import { createApiKeyHttpHandlers } from './api-keys';
import { createApiKeyRevokeHandler } from './api-key-revoke';
import { createCompletionArtifactStatusHandler } from './completion-artifact-status';
import { createCompletionEvidenceHandler } from './completion-evidence';
import { createCompletionPdfHandler } from './completion-pdf';
import { createDeliveryStatusHandler } from './delivery-status';
import { createDraftHttpHandlers } from './drafts';
import { createDocxExportHandler } from './docx-export';
import { createDocxImportHandler } from './docx-import';
import { createEnvelopeFieldsHandler } from './envelope-fields';
import { createEnvelopeHttpHandlers } from './envelopes';
import { createEnvelopeReadyHandler } from './envelope-ready';
import { createEnvelopeSendHandler } from './envelope-send';
import { createEnvelopeVoidHandler } from './envelope-void';
import { createInstanceBootstrapHandler } from './instance-bootstrap';
import { createInstanceInvitationHttpHandlers } from './instance-invitations';
import {
	createInstanceMemberHttpHandlers,
	createInstanceMemberMeHandler
} from './instance-members';
import { instanceScopedLocals } from './http-handler-test-support';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const KEY_ID: string = '01900000-0000-7000-8000-000000000201';

function principal(overrides: Partial<ApiKeyPrincipal> = {}): ApiKeyPrincipal {
	return {
		apiKeyId: KEY_ID,
		keyPrefix: 'signkit_abcdefgh',
		ownerUserId: 'user-1',
		scopes: ['envelopes:read'],
		expiresAt: '2026-12-11T00:00:00.000Z',
		...overrides
	};
}

/**
 * An active instance session is present on every request below, exactly as a
 * browser cookie would accompany a bearer. Key requests must still resolve to
 * the key's own authority, and failing keys must never fall back to this
 * session.
 */
function locals(
	apiKeyAuthentication: App.Locals['apiKeyAuthentication'] = { state: 'absent' }
): App.Locals {
	return { ...instanceScopedLocals('active'), apiKeyAuthentication };
}

function event(input: {
	pathname: string;
	method?: string;
	params?: Record<string, string>;
	apiKeyAuthentication?: App.Locals['apiKeyAuthentication'];
	search?: string;
	body?: string;
}): RequestEvent {
	const url: URL = new URL(`https://signkit.example${input.pathname}${input.search ?? ''}`);
	const method: string = input.method ?? 'GET';
	const headers: Headers = new Headers();
	if (method === 'POST') {
		headers.set('content-type', 'application/json');
		headers.set('idempotency-key', 'surface-1');
	}
	return {
		locals: locals(input.apiKeyAuthentication),
		params: input.params ?? {},
		platform: undefined,
		url,
		request: new Request(url, {
			method,
			headers,
			body: method === 'POST' ? (input.body ?? '{}') : undefined
		})
	} as unknown as RequestEvent;
}

async function problemType(response: Response): Promise<string> {
	return ((await response.json()) as { type: string }).type;
}

/**
 * Each read endpoint, paired with the service call it must make. The assertion
 * is always the same: an authorized caller reaches the service, and anything
 * the key authority refuses never does.
 */
interface ReadCase {
	name: string;
	pathname: string;
	params?: Record<string, string>;
	invoke: (apiKeyAuthentication: App.Locals['apiKeyAuthentication']) => Promise<{
		response: Response;
		reachedService: boolean;
	}>;
}

function envelopeListCase(): ReadCase {
	return {
		name: 'GET /api/v1/envelopes',
		pathname: '/api/v1/envelopes',
		invoke: async (apiKeyAuthentication) => {
			const actors: unknown[] = [];
			const handlers = createEnvelopeHttpHandlers(() => ({
				create: vi.fn(),
				get: vi.fn(),
				getDetail: vi.fn(),
				list: vi.fn(async (actor: unknown) => {
					actors.push(actor);
					return { items: [], nextCursor: null };
				})
			}));
			const response: Response = await handlers.list(
				event({ pathname: '/api/v1/envelopes', apiKeyAuthentication })
			);
			return { response, reachedService: actors.length === 1 };
		}
	};
}

function envelopeGetCase(): ReadCase {
	return {
		name: 'GET /api/v1/envelopes/{envelopeId}',
		pathname: `/api/v1/envelopes/${ENVELOPE_ID}`,
		params: { envelopeId: ENVELOPE_ID },
		invoke: async (apiKeyAuthentication) => {
			const getDetail = vi.fn(async () => null);
			const handlers = createEnvelopeHttpHandlers(() => ({
				create: vi.fn(),
				get: vi.fn(),
				getDetail,
				list: vi.fn()
			}));
			const response: Response = await handlers.get(
				event({
					pathname: `/api/v1/envelopes/${ENVELOPE_ID}`,
					params: { envelopeId: ENVELOPE_ID },
					apiKeyAuthentication
				})
			);
			return { response, reachedService: getDetail.mock.calls.length === 1 };
		}
	};
}

function draftGetCase(): ReadCase {
	return {
		name: 'GET /api/v1/envelopes/{envelopeId}/draft',
		pathname: `/api/v1/envelopes/${ENVELOPE_ID}/draft`,
		params: { envelopeId: ENVELOPE_ID },
		invoke: async (apiKeyAuthentication) => {
			const readWorkspace = vi.fn(async () => ({
				generation: 1,
				commitSha: 'commit-1',
				archiveKey: 'draft-repositories/v1/envelopes/e/sha256/a.git.gz',
				archiveSha256: 'a'.repeat(64),
				documents: [],
				documentSet: null
			}));
			const handlers = createDraftHttpHandlers(() => ({
				commit: vi.fn(),
				readWorkspace
			}));
			const response: Response = await handlers.get(
				event({
					pathname: `/api/v1/envelopes/${ENVELOPE_ID}/draft`,
					params: { envelopeId: ENVELOPE_ID },
					apiKeyAuthentication
				})
			);
			return { response, reachedService: readWorkspace.mock.calls.length === 1 };
		}
	};
}

function docxGetCase(): ReadCase {
	return {
		name: 'GET /api/v1/envelopes/{envelopeId}/docx',
		pathname: `/api/v1/envelopes/${ENVELOPE_ID}/docx`,
		params: { envelopeId: ENVELOPE_ID },
		invoke: async (apiKeyAuthentication) => {
			const enqueueExport = vi.fn(async () => {
				throw new DraftEnvelopeNotFoundError();
			});
			const handler: RequestHandler = createDocxExportHandler(
				(() =>
					({
						enqueueExport,
						processInline: vi.fn(),
						readExportResult: vi.fn()
					}) as never) as Parameters<typeof createDocxExportHandler>[0]
			);
			const response: Response = await handler(
				event({
					pathname: `/api/v1/envelopes/${ENVELOPE_ID}/docx`,
					params: { envelopeId: ENVELOPE_ID },
					apiKeyAuthentication
				})
			);
			return { response, reachedService: enqueueExport.mock.calls.length === 1 };
		}
	};
}

function deliveriesCase(): ReadCase {
	return {
		name: 'GET /api/v1/envelopes/{envelopeId}/deliveries',
		pathname: `/api/v1/envelopes/${ENVELOPE_ID}/deliveries`,
		params: { envelopeId: ENVELOPE_ID },
		invoke: async (apiKeyAuthentication) => {
			const find = vi.fn(async () => null);
			const handler: RequestHandler = createDeliveryStatusHandler(
				(() => ({ find }) as never) as Parameters<typeof createDeliveryStatusHandler>[0]
			);
			const response: Response = await handler(
				event({
					pathname: `/api/v1/envelopes/${ENVELOPE_ID}/deliveries`,
					params: { envelopeId: ENVELOPE_ID },
					apiKeyAuthentication
				})
			);
			return { response, reachedService: find.mock.calls.length === 1 };
		}
	};
}

function completionArtifactCase(): ReadCase {
	return {
		name: 'GET /api/v1/envelopes/{envelopeId}/completion-artifact',
		pathname: `/api/v1/envelopes/${ENVELOPE_ID}/completion-artifact`,
		params: { envelopeId: ENVELOPE_ID },
		invoke: async (apiKeyAuthentication) => {
			const find = vi.fn(async () => null);
			const handler: RequestHandler = createCompletionArtifactStatusHandler(
				(() => ({ find }) as never) as Parameters<typeof createCompletionArtifactStatusHandler>[0]
			);
			const response: Response = await handler(
				event({
					pathname: `/api/v1/envelopes/${ENVELOPE_ID}/completion-artifact`,
					params: { envelopeId: ENVELOPE_ID },
					apiKeyAuthentication
				})
			);
			return { response, reachedService: find.mock.calls.length === 1 };
		}
	};
}

function completionEvidenceCase(): ReadCase {
	return {
		name: 'GET /api/v1/envelopes/{envelopeId}/evidence',
		pathname: `/api/v1/envelopes/${ENVELOPE_ID}/evidence`,
		params: { envelopeId: ENVELOPE_ID },
		invoke: async (apiKeyAuthentication) => {
			const readEvidence = vi.fn(async () => null);
			const handler: RequestHandler = createCompletionEvidenceHandler(() => ({
				readEvidence,
				readPdf: vi.fn(),
				envelopeExists: vi.fn(async () => false)
			}));
			const response: Response = await handler(
				event({
					pathname: `/api/v1/envelopes/${ENVELOPE_ID}/evidence`,
					params: { envelopeId: ENVELOPE_ID },
					apiKeyAuthentication
				})
			);
			return { response, reachedService: readEvidence.mock.calls.length === 1 };
		}
	};
}

function completionPdfCase(): ReadCase {
	return {
		name: 'GET /api/v1/envelopes/{envelopeId}/pdf',
		pathname: `/api/v1/envelopes/${ENVELOPE_ID}/pdf`,
		params: { envelopeId: ENVELOPE_ID },
		invoke: async (apiKeyAuthentication) => {
			const readPdf = vi.fn(async () => null);
			const handler: RequestHandler = createCompletionPdfHandler(() => ({
				readEvidence: vi.fn(),
				readPdf,
				envelopeExists: vi.fn(async () => false)
			}));
			const response: Response = await handler(
				event({
					pathname: `/api/v1/envelopes/${ENVELOPE_ID}/pdf`,
					params: { envelopeId: ENVELOPE_ID },
					apiKeyAuthentication
				})
			);
			return { response, reachedService: readPdf.mock.calls.length === 1 };
		}
	};
}

const READ_CASES: readonly ReadCase[] = [
	envelopeListCase(),
	envelopeGetCase(),
	draftGetCase(),
	docxGetCase(),
	deliveriesCase(),
	completionArtifactCase(),
	completionEvidenceCase(),
	completionPdfCase()
];

describe('API key read surface', () => {
	for (const readCase of READ_CASES) {
		describe(readCase.name, () => {
			it('serves a key holding envelopes:read without touching the session', async () => {
				const { response, reachedService } = await readCase.invoke({
					state: 'authenticated',
					principal: principal()
				});

				expect(reachedService).toBe(true);
				// A null lookup is a 404, which still proves the request passed
				// authorization and reached the service.
				expect([200, 404].includes(response.status)).toBe(true);
			});

			it('refuses a key without the envelopes:read scope', async () => {
				const { response, reachedService } = await readCase.invoke({
					state: 'authenticated',
					principal: principal({ scopes: ['drafts:write', 'envelopes:send'] })
				});

				expect(response.status).toBe(403);
				expect(await problemType(response)).toBe('urn:signkit:problem:api-key-insufficient-scope');
				expect(reachedService).toBe(false);
			});

			it('refuses an unresolvable token opaquely before any durable read', async () => {
				const { response, reachedService } = await readCase.invoke({ state: 'invalid_token' });

				expect(response.status).toBe(401);
				expect(response.headers.get('www-authenticate')).toBe('Bearer');
				expect(reachedService).toBe(false);
			});

			it('refuses an exhausted key with a 429 before any durable read', async () => {
				const { response, reachedService } = await readCase.invoke({ state: 'rate_limited' });

				expect(response.status).toBe(429);
				expect(await problemType(response)).toBe('urn:signkit:problem:api-key-rate-limited');
				expect(reachedService).toBe(false);
			});

			it('still serves a plain session with no bearer presented', async () => {
				const { reachedService } = await readCase.invoke({ state: 'absent' });
				expect(reachedService).toBe(true);
			});
		});
	}

	it('accepts a key whose scope set merely includes envelopes:read', async () => {
		const scopes: readonly ApiKeyScope[] = ['drafts:write', 'envelopes:read', 'envelopes:send'];
		const { reachedService } = await envelopeListCase().invoke({
			state: 'authenticated',
			principal: principal({ scopes })
		});
		expect(reachedService).toBe(true);
	});

	it('acts as the key agent, never as the session user', async () => {
		const actors: unknown[] = [];
		const handlers = createEnvelopeHttpHandlers(() => ({
			create: vi.fn(),
			get: vi.fn(),
			getDetail: vi.fn(),
			list: vi.fn(async (actor: unknown) => {
				actors.push(actor);
				return { items: [], nextCursor: null };
			})
		}));

		await handlers.list(
			event({
				pathname: '/api/v1/envelopes',
				apiKeyAuthentication: { state: 'authenticated', principal: principal() }
			})
		);
		expect(actors).toEqual([{ id: KEY_ID, createdByUserId: 'user-1', actorType: 'agent' }]);

		await handlers.list(event({ pathname: '/api/v1/envelopes' }));
		expect(actors[1]).toEqual([{ id: 'user-1', createdByUserId: 'user-1', actorType: 'user' }][0]);
	});
});

/**
 * Envelope mutations now accept API keys that hold drafts:write or envelopes:send.
 * A live key missing the required scope is insufficient-scope, not a surface
 * refusal. Management paths stay session-only.
 */
describe('API key mutation surface', () => {
	const WRITE: readonly [
		string,
		ApiKeyScope,
		() => Promise<{ response: Response; called: boolean }>
	][] = [
		[
			'POST /api/v1/envelopes',
			'drafts:write',
			async () => {
				const create = vi.fn(async () => ({
					outcome: 'created' as const,
					envelope: {
						id: ENVELOPE_ID,
						createdByUserId: '01900000-0000-7000-8000-000000000001',
						title: 'Agreement',
						status: 'draft' as const,
						repositoryGeneration: 0,
						repositoryHead: null,
						repositoryArchiveKey: null,
						repositoryArchiveSha256: null,
						sentCommitSha: null,
						fieldGeneration: 0,
						createdAt: '2026-09-11T00:00:00.000Z',
						updatedAt: '2026-09-11T00:00:00.000Z'
					}
				}));
				const response: Response = await createEnvelopeHttpHandlers(() => ({
					create,
					get: vi.fn(),
					getDetail: vi.fn(),
					list: vi.fn()
				})).create(
					event({
						pathname: '/api/v1/envelopes',
						method: 'POST',
						body: JSON.stringify({ title: 'Agreement' }),
						apiKeyAuthentication: {
							state: 'authenticated',
							principal: principal({ scopes: ['drafts:write'] })
						}
					})
				);
				return { response, called: create.mock.calls.length === 1 };
			}
		],
		[
			'POST /api/v1/envelopes/{envelopeId}/send',
			'envelopes:send',
			async () => {
				const send = vi.fn(async () => ({ outcome: 'integrity_error' as const }));
				const response: Response = await createEnvelopeSendHandler(() => ({ send }))(
					event({
						pathname: `/api/v1/envelopes/${ENVELOPE_ID}/send`,
						method: 'POST',
						params: { envelopeId: ENVELOPE_ID },
						body: JSON.stringify({
							expectedGeneration: 1,
							expectedReadyAuditEventId: ENVELOPE_ID
						}),
						apiKeyAuthentication: {
							state: 'authenticated',
							principal: principal({ scopes: ['envelopes:send'] })
						}
					})
				);
				return { response, called: send.mock.calls.length === 1 };
			}
		]
	];

	it.each(WRITE)(
		'accepts an authenticated API key on %s with %s',
		async (_name, _scope, invoke) => {
			const { called } = await invoke();
			expect(called).toBe(true);
		}
	);

	it.each([
		[
			'POST /api/v1/envelopes',
			async (): Promise<Response> =>
				createEnvelopeHttpHandlers(() => ({
					create: vi.fn(),
					get: vi.fn(),
					getDetail: vi.fn(),
					list: vi.fn()
				})).create(
					event({
						pathname: '/api/v1/envelopes',
						method: 'POST',
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'POST /api/v1/envelopes/{envelopeId}/draft/commits',
			async (): Promise<Response> =>
				createDraftHttpHandlers(() => ({ commit: vi.fn(), readWorkspace: vi.fn() })).commit(
					event({
						pathname: `/api/v1/envelopes/${ENVELOPE_ID}/draft/commits`,
						method: 'POST',
						params: { envelopeId: ENVELOPE_ID },
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'POST /api/v1/envelopes/{envelopeId}/draft/docx',
			async (): Promise<Response> =>
				createDocxImportHandler(() => ({ enqueueImport: vi.fn(), processInline: vi.fn() }))(
					event({
						pathname: `/api/v1/envelopes/${ENVELOPE_ID}/draft/docx`,
						method: 'POST',
						params: { envelopeId: ENVELOPE_ID },
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'POST /api/v1/envelopes/{envelopeId}/ready',
			async (): Promise<Response> =>
				createEnvelopeReadyHandler(() => null)(
					event({
						pathname: `/api/v1/envelopes/${ENVELOPE_ID}/ready`,
						method: 'POST',
						params: { envelopeId: ENVELOPE_ID },
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'POST /api/v1/envelopes/{envelopeId}/fields',
			async (): Promise<Response> =>
				createEnvelopeFieldsHandler(() => null)(
					event({
						pathname: `/api/v1/envelopes/${ENVELOPE_ID}/fields`,
						method: 'POST',
						params: { envelopeId: ENVELOPE_ID },
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'POST /api/v1/envelopes/{envelopeId}/send',
			async (): Promise<Response> =>
				createEnvelopeSendHandler(() => null)(
					event({
						pathname: `/api/v1/envelopes/${ENVELOPE_ID}/send`,
						method: 'POST',
						params: { envelopeId: ENVELOPE_ID },
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'POST /api/v1/envelopes/{envelopeId}/void',
			async (): Promise<Response> =>
				createEnvelopeVoidHandler(() => null)(
					event({
						pathname: `/api/v1/envelopes/${ENVELOPE_ID}/void`,
						method: 'POST',
						params: { envelopeId: ENVELOPE_ID },
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		]
	] as const)('refuses a live key missing the mutation scope on %s', async (_name, invoke) => {
		const response: Response = await invoke();
		expect(response.status).toBe(403);
		expect(await problemType(response)).toBe('urn:signkit:problem:api-key-insufficient-scope');
	});

	it.each([
		[
			'POST /api/v1/envelopes',
			async (): Promise<Response> =>
				createEnvelopeHttpHandlers(() => ({
					create: vi.fn(),
					get: vi.fn(),
					getDetail: vi.fn(),
					list: vi.fn()
				})).create(
					event({
						pathname: '/api/v1/envelopes',
						method: 'POST',
						apiKeyAuthentication: { state: 'invalid_token' }
					})
				)
		],
		[
			'POST /api/v1/envelopes/{envelopeId}/void',
			async (): Promise<Response> =>
				createEnvelopeVoidHandler(() => null)(
					event({
						pathname: `/api/v1/envelopes/${ENVELOPE_ID}/void`,
						method: 'POST',
						params: { envelopeId: ENVELOPE_ID },
						apiKeyAuthentication: { state: 'invalid_token' }
					})
				)
		]
	] as const)('keeps malformed or unauthorized bearers opaque 401 on %s', async (_name, invoke) => {
		const response: Response = await invoke();
		expect(response.status).toBe(401);
		expect(await problemType(response)).toBe('urn:signkit:problem:api-key-authentication-required');
		expect(response.headers.get('www-authenticate')).toBe('Bearer');
	});
});

describe('API key rejected surface', () => {
	/**
	 * Privilege escalation: a key must never mint another key, bootstrap the
	 * instance, or administer members.
	 */
	const MANAGEMENT: readonly [string, () => Promise<Response>][] = [
		[
			'POST /api/v1/instance/bootstrap',
			async (): Promise<Response> =>
				createInstanceBootstrapHandler(() => null)(
					event({
						pathname: '/api/v1/instance/bootstrap',
						method: 'POST',
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'POST /api/v1/api-keys',
			async (): Promise<Response> =>
				createApiKeyHttpHandlers(() => null).create(
					event({
						pathname: '/api/v1/api-keys',
						method: 'POST',
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'GET /api/v1/api-keys',
			async (): Promise<Response> =>
				createApiKeyHttpHandlers(() => null).list(
					event({
						pathname: '/api/v1/api-keys',
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'POST /api/v1/api-keys/{apiKeyId}/revoke',
			async (): Promise<Response> =>
				createApiKeyRevokeHandler(() => null)(
					event({
						pathname: `/api/v1/api-keys/${KEY_ID}/revoke`,
						method: 'POST',
						params: { apiKeyId: KEY_ID },
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'GET /api/v1/instance/members/me',
			async (): Promise<Response> =>
				createInstanceMemberMeHandler(() => null)(
					event({
						pathname: '/api/v1/instance/members/me',
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'GET /api/v1/instance/members',
			async (): Promise<Response> =>
				createInstanceMemberHttpHandlers(() => null).list(
					event({
						pathname: '/api/v1/instance/members',
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'POST /api/v1/instance/members/{userId}/role',
			async (): Promise<Response> =>
				createInstanceMemberHttpHandlers(() => null).setRole(
					event({
						pathname: '/api/v1/instance/members/user-2/role',
						method: 'POST',
						params: { userId: 'user-2' },
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'POST /api/v1/instance/members/{userId}/status',
			async (): Promise<Response> =>
				createInstanceMemberHttpHandlers(() => null).setStatus(
					event({
						pathname: '/api/v1/instance/members/user-2/status',
						method: 'POST',
						params: { userId: 'user-2' },
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'POST /api/v1/instance/invitations',
			async (): Promise<Response> =>
				createInstanceInvitationHttpHandlers(() => null).create(
					event({
						pathname: '/api/v1/instance/invitations',
						method: 'POST',
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'GET /api/v1/instance/invitations',
			async (): Promise<Response> =>
				createInstanceInvitationHttpHandlers(() => null).list(
					event({
						pathname: '/api/v1/instance/invitations',
						method: 'POST',
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'POST /api/v1/instance/invitations/accept',
			async (): Promise<Response> =>
				createInstanceInvitationHttpHandlers(() => null).accept(
					event({
						pathname: '/api/v1/instance/invitations/accept',
						method: 'POST',
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'POST /api/v1/instance/invitations/{invitationId}/revoke',
			async (): Promise<Response> =>
				createInstanceInvitationHttpHandlers(() => null).revoke(
					event({
						pathname: `/api/v1/instance/invitations/${KEY_ID}/revoke`,
						method: 'POST',
						params: { invitationId: KEY_ID },
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		]
	];

	it.each(MANAGEMENT)('refuses an authenticated API key on %s', async (_name, invoke) => {
		const response: Response = await invoke();

		expect(response.status).toBe(403);
		expect(await problemType(response)).toBe('urn:signkit:problem:api-key-not-permitted');
	});
});
