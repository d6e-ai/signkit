import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyPrincipal } from '$lib/ports/api-key-authentication-store';
import type { ApiKeyScope } from '$lib/security/api-key';
import { createApiKeyHttpHandlers } from './api-keys';
import { createApiKeyRevokeHandler } from './api-key-revoke';
import { createApiKeyOrganizationGrantHandlers } from './api-key-organization-grants';
import { createCompletionArtifactStatusHandler } from './completion-artifact-status';
import { createDeliveryStatusHandler } from './delivery-status';
import { createDraftHttpHandlers } from './drafts';
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

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const KEY_ID: string = '01900000-0000-7000-8000-000000000201';
const GRANT_ID: string = '01900000-0000-7000-8000-000000000301';
const GRANTED_ORG: string = 'org-granted';
const SESSION_ORG: string = 'org-session';

function principal(overrides: Partial<ApiKeyPrincipal> = {}): ApiKeyPrincipal {
	return {
		apiKeyId: KEY_ID,
		keyPrefix: 'signkit_abcdefgh',
		ownerUserId: 'user-1',
		organizationId: GRANTED_ORG,
		organizationName: 'Granted',
		scopes: ['envelopes:read'],
		expiresAt: '2026-12-11T00:00:00.000Z',
		...overrides
	};
}

/**
 * A session that is fully authorized for a *different* organization than the key
 * was granted. Every read below must scope to the granted organization, never to
 * this one, and every rejection below must happen despite this session being
 * present and valid.
 */
function locals(
	apiKeyAuthentication: App.Locals['apiKeyAuthentication'] = { state: 'absent' }
): App.Locals {
	return {
		apiKeyAuthentication,
		identityState: 'authorized',
		memberships: [
			{
				joinedAt: '2026-09-11T00:00:00.000Z',
				role: 'owner',
				organization: {
					id: SESSION_ORG,
					name: 'Session',
					slug: 'session',
					status: 'active'
				}
			}
		],
		organizationId: SESSION_ORG,
		principal: { subject: 'user-1', email: 'user@example.com', name: 'User' }
	};
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
 * Each read endpoint, paired with the organization-scoped call it must make. The
 * assertion is always the same: the organization handed to the durable layer is
 * the one the key's grant proved, never the session's.
 */
interface ReadCase {
	name: string;
	pathname: string;
	params?: Record<string, string>;
	invoke: (apiKeyAuthentication: App.Locals['apiKeyAuthentication']) => Promise<{
		response: Response;
		organizationIds: string[];
	}>;
}

function envelopeListCase(): ReadCase {
	return {
		name: 'GET /api/v1/envelopes',
		pathname: '/api/v1/envelopes',
		invoke: async (apiKeyAuthentication) => {
			const organizationIds: string[] = [];
			const handlers = createEnvelopeHttpHandlers(() => ({
				create: vi.fn(),
				get: vi.fn(),
				list: vi.fn(async (actor: { organizationId: string }) => {
					organizationIds.push(actor.organizationId);
					return { items: [], nextCursor: null };
				})
			}));
			const response: Response = await handlers.list(
				event({ pathname: '/api/v1/envelopes', apiKeyAuthentication })
			);
			return { response, organizationIds };
		}
	};
}

function envelopeGetCase(): ReadCase {
	return {
		name: 'GET /api/v1/envelopes/{envelopeId}',
		pathname: `/api/v1/envelopes/${ENVELOPE_ID}`,
		params: { envelopeId: ENVELOPE_ID },
		invoke: async (apiKeyAuthentication) => {
			const organizationIds: string[] = [];
			const handlers = createEnvelopeHttpHandlers(() => ({
				create: vi.fn(),
				get: vi.fn(async (actor: { organizationId: string }) => {
					organizationIds.push(actor.organizationId);
					return null;
				}),
				list: vi.fn()
			}));
			const response: Response = await handlers.get(
				event({
					pathname: `/api/v1/envelopes/${ENVELOPE_ID}`,
					params: { envelopeId: ENVELOPE_ID },
					apiKeyAuthentication
				})
			);
			return { response, organizationIds };
		}
	};
}

function draftGetCase(): ReadCase {
	return {
		name: 'GET /api/v1/envelopes/{envelopeId}/draft',
		pathname: `/api/v1/envelopes/${ENVELOPE_ID}/draft`,
		params: { envelopeId: ENVELOPE_ID },
		invoke: async (apiKeyAuthentication) => {
			const organizationIds: string[] = [];
			const handlers = createDraftHttpHandlers(() => ({
				commit: vi.fn(),
				readWorkspace: vi.fn(async (input: { organizationId: string }) => {
					organizationIds.push(input.organizationId);
					return {
						generation: 1,
						commitSha: 'commit-1',
						archiveKey: 'draft-repositories/v1/organizations/o/envelopes/e/sha256/a.git.gz',
						archiveSha256: 'a'.repeat(64),
						documents: []
					};
				})
			}));
			const response: Response = await handlers.get(
				event({
					pathname: `/api/v1/envelopes/${ENVELOPE_ID}/draft`,
					params: { envelopeId: ENVELOPE_ID },
					apiKeyAuthentication
				})
			);
			return { response, organizationIds };
		}
	};
}

function deliveriesCase(): ReadCase {
	return {
		name: 'GET /api/v1/envelopes/{envelopeId}/deliveries',
		pathname: `/api/v1/envelopes/${ENVELOPE_ID}/deliveries`,
		params: { envelopeId: ENVELOPE_ID },
		invoke: async (apiKeyAuthentication) => {
			const organizationIds: string[] = [];
			const handler: RequestHandler = createDeliveryStatusHandler(
				() =>
					({
						find: vi.fn(async (organizationId: string) => {
							organizationIds.push(organizationId);
							return null;
						})
					}) as never
			);
			const response: Response = await handler(
				event({
					pathname: `/api/v1/envelopes/${ENVELOPE_ID}/deliveries`,
					params: { envelopeId: ENVELOPE_ID },
					apiKeyAuthentication
				})
			);
			return { response, organizationIds };
		}
	};
}

function completionArtifactCase(): ReadCase {
	return {
		name: 'GET /api/v1/envelopes/{envelopeId}/completion-artifact',
		pathname: `/api/v1/envelopes/${ENVELOPE_ID}/completion-artifact`,
		params: { envelopeId: ENVELOPE_ID },
		invoke: async (apiKeyAuthentication) => {
			const organizationIds: string[] = [];
			const handler: RequestHandler = createCompletionArtifactStatusHandler(
				() =>
					({
						find: vi.fn(async (organizationId: string) => {
							organizationIds.push(organizationId);
							return null;
						})
					}) as never
			);
			const response: Response = await handler(
				event({
					pathname: `/api/v1/envelopes/${ENVELOPE_ID}/completion-artifact`,
					params: { envelopeId: ENVELOPE_ID },
					apiKeyAuthentication
				})
			);
			return { response, organizationIds };
		}
	};
}

const READ_CASES: readonly ReadCase[] = [
	envelopeListCase(),
	envelopeGetCase(),
	draftGetCase(),
	deliveriesCase(),
	completionArtifactCase()
];

describe('API key read surface', () => {
	for (const readCase of READ_CASES) {
		describe(readCase.name, () => {
			it('scopes to the granted organization and never to the session organization', async () => {
				const { organizationIds } = await readCase.invoke({
					state: 'authenticated',
					principal: principal()
				});

				expect(organizationIds).toEqual([GRANTED_ORG]);
				expect(organizationIds).not.toContain(SESSION_ORG);
			});

			it('refuses a key without the envelopes:read scope', async () => {
				const { response, organizationIds } = await readCase.invoke({
					state: 'authenticated',
					principal: principal({ scopes: ['audit:read', 'drafts:write', 'envelopes:send'] })
				});

				expect(response.status).toBe(403);
				expect(await problemType(response)).toBe('urn:signkit:problem:api-key-insufficient-scope');
				expect(organizationIds).toEqual([]);
			});

			it('refuses an unresolvable token opaquely before any durable read', async () => {
				const { response, organizationIds } = await readCase.invoke({ state: 'invalid_token' });

				expect(response.status).toBe(401);
				expect(response.headers.get('www-authenticate')).toBe('Bearer');
				expect(organizationIds).toEqual([]);
			});

			it('refuses a missing organization selector', async () => {
				const { response, organizationIds } = await readCase.invoke({
					state: 'organization_selector_invalid'
				});

				expect(response.status).toBe(400);
				expect(await problemType(response)).toBe(
					'urn:signkit:problem:api-key-organization-selector-required'
				);
				expect(organizationIds).toEqual([]);
			});

			it('refuses a key with no grant for the requested organization', async () => {
				const { response, organizationIds } = await readCase.invoke({
					state: 'organization_grant_required'
				});

				expect(response.status).toBe(403);
				expect(await problemType(response)).toBe(
					'urn:signkit:problem:api-key-organization-grant-required'
				);
				expect(organizationIds).toEqual([]);
			});

			it('still serves a plain session with no bearer presented', async () => {
				const { organizationIds } = await readCase.invoke({ state: 'absent' });
				expect(organizationIds).toEqual([SESSION_ORG]);
			});
		});
	}

	it('accepts a key whose scope set merely includes envelopes:read', async () => {
		const scopes: readonly ApiKeyScope[] = [
			'audit:read',
			'drafts:write',
			'envelopes:read',
			'envelopes:send'
		];
		const { organizationIds } = await envelopeListCase().invoke({
			state: 'authenticated',
			principal: principal({ scopes })
		});
		expect(organizationIds).toEqual([GRANTED_ORG]);
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
						organizationId: GRANTED_ORG,
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
				createEnvelopeHttpHandlers(() => ({ create: vi.fn(), get: vi.fn(), list: vi.fn() })).create(
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
				createEnvelopeHttpHandlers(() => ({ create: vi.fn(), get: vi.fn(), list: vi.fn() })).create(
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
	 * Privilege escalation: a key must never mint another key, grant itself an
	 * organization, revoke a grant, bootstrap the instance, or administer members.
	 */
	const MANAGEMENT: readonly [string, () => Promise<Response>][] = [
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
			'POST /api/v1/api-keys/{apiKeyId}/organization-grants',
			async (): Promise<Response> =>
				createApiKeyOrganizationGrantHandlers(() => null).create(
					event({
						pathname: `/api/v1/api-keys/${KEY_ID}/organization-grants`,
						method: 'POST',
						params: { apiKeyId: KEY_ID },
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'GET /api/v1/api-keys/{apiKeyId}/organization-grants',
			async (): Promise<Response> =>
				createApiKeyOrganizationGrantHandlers(() => null).list(
					event({
						pathname: `/api/v1/api-keys/${KEY_ID}/organization-grants`,
						params: { apiKeyId: KEY_ID },
						apiKeyAuthentication: { state: 'authenticated', principal: principal() }
					})
				)
		],
		[
			'POST /api/v1/api-keys/{apiKeyId}/organization-grants/{grantId}/revoke',
			async (): Promise<Response> =>
				createApiKeyOrganizationGrantHandlers(() => null).revoke(
					event({
						pathname: `/api/v1/api-keys/${KEY_ID}/organization-grants/${GRANT_ID}/revoke`,
						method: 'POST',
						params: { apiKeyId: KEY_ID, grantId: GRANT_ID },
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
						pathname: `/api/v1/instance/invitations/${GRANT_ID}/revoke`,
						method: 'POST',
						params: { invitationId: GRANT_ID },
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

	/**
	 * Bootstrap keeps its own distinct shape and must not be reshaped by this
	 * slice. Its deployment-secret bearer check runs constant-time *before*
	 * identity, so a request carrying an API key never reaches the API key guard at
	 * all -- it gets the same opaque 404 as any caller without the secret. That is
	 * still fail-closed, and preserving it matters because the 404 is deliberately
	 * indistinguishable from an unconfigured or wrong secret.
	 */
	it('answers an API key on POST /api/v1/instance/bootstrap with the opaque secret-gate 404', async () => {
		const response: Response = await createInstanceBootstrapHandler(() => null)(
			event({
				pathname: '/api/v1/instance/bootstrap',
				method: 'POST',
				apiKeyAuthentication: { state: 'authenticated', principal: principal() }
			})
		);

		expect(response.status).toBe(404);
	});
});
