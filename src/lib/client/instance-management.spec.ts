import { describe, expect, it, vi } from 'vitest';
import {
	createInstanceManagementClient,
	defaultNewIdempotencyKey,
	InstanceManagementApiError,
	InstanceManagementClient,
	type CreateApiKeyResponse,
	type CreateInstanceInvitationResponse
} from './instance-management';

const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mockJsonResponse(
	data: unknown,
	status = 200,
	headersInit?: Record<string, string>
): Response {
	const headers = new Headers({
		'content-type': 'application/json',
		...headersInit
	});
	return new Response(JSON.stringify(data), {
		status,
		headers
	});
}

function mockProblemResponse(
	problem: {
		type: string;
		title: string;
		status: number;
		detail: string;
		instance: string;
		errors?: readonly { path: string; message: string }[];
	},
	headersInit?: Record<string, string>
): Response {
	const headers = new Headers({
		'content-type': 'application/problem+json',
		...headersInit
	});
	return new Response(JSON.stringify(problem), {
		status: problem.status,
		headers
	});
}

describe('InstanceManagementClient', () => {
	describe('Idempotency-Key generation and injection', () => {
		it('mints a UUIDv4 by default via crypto.randomUUID', async () => {
			const randomUUIDSpy = vi.spyOn(globalThis.crypto, 'randomUUID');
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
				mockJsonResponse({ member: null, bootstrapped: false })
			);
			const client = createInstanceManagementClient({ fetch: fetchMock });

			try {
				await client.bootstrapOwner();

				expect(randomUUIDSpy).toHaveBeenCalledOnce();
				const call = fetchMock.mock.calls[0];
				const headers = call?.[1]?.headers as Record<string, string>;
				expect(headers['idempotency-key']).toMatch(uuidV4Regex);
				expect(headers['idempotency-key']).toBe(randomUUIDSpy.mock.results[0]?.value);
			} finally {
				randomUUIDSpy.mockRestore();
			}
		});

		it('allows dependency injection of newIdempotencyKey', async () => {
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
				mockJsonResponse({ member: null, bootstrapped: false })
			);
			const customKeyGenerator = vi.fn(() => 'custom-injected-idempotency-key');
			const client = new InstanceManagementClient({
				fetch: fetchMock,
				newIdempotencyKey: customKeyGenerator
			});

			await client.bootstrapOwner();

			expect(customKeyGenerator).toHaveBeenCalledOnce();
			const call = fetchMock.mock.calls[0];
			const headers = call?.[1]?.headers as Record<string, string>;
			expect(headers['idempotency-key']).toBe('custom-injected-idempotency-key');
		});

		it('allows per-request idempotencyKey override', async () => {
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
				mockJsonResponse({ member: null, bootstrapped: false })
			);
			const client = createInstanceManagementClient({
				fetch: fetchMock,
				newIdempotencyKey: () => 'default-key'
			});

			await client.bootstrapOwner({ idempotencyKey: 'explicit-per-request-key' });

			const call = fetchMock.mock.calls[0];
			const headers = call?.[1]?.headers as Record<string, string>;
			expect(headers['idempotency-key']).toBe('explicit-per-request-key');
		});

		it('fails when crypto.randomUUID is not available and no generator is injected', () => {
			const originalCrypto = globalThis.crypto;
			try {
				Object.defineProperty(globalThis, 'crypto', {
					configurable: true,
					value: {}
				});
				expect(() => defaultNewIdempotencyKey()).toThrow(
					/crypto\.randomUUID\(\) is required to mint an Idempotency-Key/
				);
			} finally {
				Object.defineProperty(globalThis, 'crypto', {
					configurable: true,
					value: originalCrypto
				});
			}
		});
	});

	describe('Endpoints, HTTP methods, headers, and request bodies', () => {
		it('GET members/me (getCurrentMember / getMembersMe / getMe)', async () => {
			const mockData = {
				member: {
					userId: 'usr-001',
					role: 'owner',
					status: 'active',
					createdAt: '2026-09-01T00:00:00Z',
					updatedAt: '2026-09-01T00:00:00Z'
				},
				bootstrapped: true
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockJsonResponse(mockData));
			const client = createInstanceManagementClient({ fetch: fetchMock });

			const result = await client.getCurrentMember();

			expect(fetchMock).toHaveBeenCalledOnce();
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe('/api/v1/instance/members/me');
			expect(init?.method).toBe('GET');
			expect(init?.credentials).toBe('same-origin');
			expect(result).toEqual(mockData);

			// Test alias methods
			await client.getMembersMe();
			await client.getMe();
			expect(fetchMock).toHaveBeenCalledTimes(3);
		});

		it('POST bootstrap owner as a cookie-session-only request with no authorization header', async () => {
			const mockMember = {
				userId: 'usr-owner',
				role: 'owner',
				status: 'active',
				createdAt: '2026-09-01T00:00:00Z',
				updatedAt: '2026-09-01T00:00:00Z'
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
				mockJsonResponse({ member: mockMember, bootstrapped: true }, 201)
			);
			const client = createInstanceManagementClient({
				fetch: fetchMock,
				newIdempotencyKey: () => 'bootstrap-idemp-1'
			});

			const result = await client.bootstrapOwner();
			expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/instance/bootstrap', {
				method: 'POST',
				credentials: 'same-origin',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': 'bootstrap-idemp-1'
				},
				body: '{}'
			});
			expect(result).toEqual({
				member: mockMember,
				bootstrapped: true,
				replayed: false
			});
		});

		it('GET list members with and without pagination parameters', async () => {
			const mockPage = {
				members: [
					{
						userId: 'usr-001',
						role: 'owner',
						status: 'active',
						createdAt: '2026-09-01T00:00:00Z',
						updatedAt: '2026-09-01T00:00:00Z'
					}
				],
				nextCursor: 'cursor-2'
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockJsonResponse(mockPage));
			const client = createInstanceManagementClient({ fetch: fetchMock });

			// Without query params
			const res1 = await client.listMembers();
			expect(fetchMock).toHaveBeenLastCalledWith(
				'/api/v1/instance/members',
				expect.objectContaining({ method: 'GET', credentials: 'same-origin' })
			);
			expect(res1).toEqual(mockPage);

			// With pagination query params
			await client.listMembers({ cursor: 'cursor-1', limit: 50 });
			expect(fetchMock).toHaveBeenLastCalledWith(
				'/api/v1/instance/members?cursor=cursor-1&limit=50',
				expect.objectContaining({ method: 'GET' })
			);
		});

		it('POST set member role with positional and object signatures', async () => {
			const mockResponse = {
				member: {
					userId: 'usr-002',
					role: 'admin',
					status: 'active',
					createdAt: '2026-09-01T00:00:00Z',
					updatedAt: '2026-09-02T00:00:00Z'
				},
				appliedAt: '2026-09-02T00:00:00Z',
				revokedInvitationCount: 0
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockJsonResponse(mockResponse));
			const client = createInstanceManagementClient({
				fetch: fetchMock,
				newIdempotencyKey: () => 'role-key'
			});

			// Positional arguments
			const res1 = await client.setMemberRole('usr-002', 'admin');
			expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/instance/members/usr-002/role', {
				method: 'POST',
				credentials: 'same-origin',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': 'role-key'
				},
				body: JSON.stringify({ role: 'admin' })
			});
			expect(res1).toEqual({
				...mockResponse,
				replayed: false
			});

			// Object argument
			await client.setMemberRole({ userId: 'usr-003', role: 'member' });
			expect(fetchMock).toHaveBeenLastCalledWith(
				'/api/v1/instance/members/usr-003/role',
				expect.objectContaining({
					method: 'POST',
					body: JSON.stringify({ role: 'member' })
				})
			);
		});

		it('POST set member status with positional and object signatures', async () => {
			const mockResponse = {
				member: {
					userId: 'usr-002',
					role: 'member',
					status: 'suspended',
					createdAt: '2026-09-01T00:00:00Z',
					updatedAt: '2026-09-02T00:00:00Z'
				},
				appliedAt: '2026-09-02T00:00:00Z',
				revokedInvitationCount: 1
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockJsonResponse(mockResponse));
			const client = createInstanceManagementClient({
				fetch: fetchMock,
				newIdempotencyKey: () => 'status-key'
			});

			// Positional arguments
			const res1 = await client.setMemberStatus('usr-002', 'suspended');
			expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/instance/members/usr-002/status', {
				method: 'POST',
				credentials: 'same-origin',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': 'status-key'
				},
				body: JSON.stringify({ status: 'suspended' })
			});
			expect(res1).toEqual({
				...mockResponse,
				replayed: false
			});

			// Object argument
			await client.setMemberStatus({ userId: 'usr-003', status: 'active' });
			expect(fetchMock).toHaveBeenLastCalledWith(
				'/api/v1/instance/members/usr-003/status',
				expect.objectContaining({
					method: 'POST',
					body: JSON.stringify({ status: 'active' })
				})
			);
		});

		it('POST create invitation', async () => {
			const mockData = {
				invitation: {
					id: 'inv-001',
					role: 'admin',
					status: 'pending',
					invitedByUserId: 'usr-001',
					createdAt: '2026-09-01T00:00:00Z',
					expiresAt: '2026-09-08T00:00:00Z',
					acceptedAt: null,
					acceptedByUserId: null,
					revokedAt: null,
					revokedByUserId: null
				},
				delivery: { status: 'scheduled' as const }
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockJsonResponse(mockData, 201));
			const client = createInstanceManagementClient({
				fetch: fetchMock,
				newIdempotencyKey: () => 'inv-key'
			});

			const res: CreateInstanceInvitationResponse = await client.createInvitation({
				email: 'alice@example.com',
				role: 'admin',
				locale: 'en'
			});

			expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/instance/invitations', {
				method: 'POST',
				credentials: 'same-origin',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': 'inv-key'
				},
				body: JSON.stringify({ email: 'alice@example.com', role: 'admin', locale: 'en' })
			});
			expect(res).toEqual({
				invitation: mockData.invitation,
				delivery: { status: 'scheduled' },
				replayed: false
			});
		});

		it('GET list invitations with and without pagination', async () => {
			const mockData = {
				invitations: [
					{
						id: 'inv-001',
						role: 'member',
						status: 'pending',
						invitedByUserId: 'usr-001',
						createdAt: '2026-09-01T00:00:00Z',
						expiresAt: '2026-09-08T00:00:00Z',
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: null,
						revokedByUserId: null
					}
				],
				nextCursor: null
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockJsonResponse(mockData));
			const client = createInstanceManagementClient({ fetch: fetchMock });

			const res = await client.listInvitations({ cursor: 'inv-cursor', limit: 10 });
			expect(fetchMock).toHaveBeenLastCalledWith(
				'/api/v1/instance/invitations?cursor=inv-cursor&limit=10',
				expect.objectContaining({ method: 'GET' })
			);
			expect(res).toEqual(mockData);
		});

		it('POST revoke invitation', async () => {
			const mockData = {
				invitation: {
					id: 'inv-001',
					role: 'member',
					status: 'revoked',
					invitedByUserId: 'usr-001',
					createdAt: '2026-09-01T00:00:00Z',
					expiresAt: '2026-09-08T00:00:00Z',
					acceptedAt: null,
					acceptedByUserId: null,
					revokedAt: '2026-09-02T00:00:00Z',
					revokedByUserId: 'usr-001'
				}
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockJsonResponse(mockData));
			const client = createInstanceManagementClient({
				fetch: fetchMock,
				newIdempotencyKey: () => 'revoke-inv-key'
			});

			const res = await client.revokeInvitation('inv-001');
			expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/instance/invitations/inv-001/revoke', {
				method: 'POST',
				credentials: 'same-origin',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': 'revoke-inv-key'
				},
				body: '{}'
			});
			expect(res).toEqual({
				invitation: mockData.invitation,
				replayed: false
			});
		});

		it('POST accept invitation', async () => {
			const mockData = {
				invitation: {
					id: 'inv-001',
					role: 'member',
					status: 'accepted',
					invitedByUserId: 'usr-001',
					createdAt: '2026-09-01T00:00:00Z',
					expiresAt: '2026-09-08T00:00:00Z',
					acceptedAt: '2026-09-02T00:00:00Z',
					acceptedByUserId: 'usr-002',
					revokedAt: null,
					revokedByUserId: null
				},
				member: {
					userId: 'usr-002',
					role: 'member',
					status: 'active',
					createdAt: '2026-09-02T00:00:00Z',
					updatedAt: '2026-09-02T00:00:00Z'
				}
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockJsonResponse(mockData));
			const client = createInstanceManagementClient({
				fetch: fetchMock,
				newIdempotencyKey: () => 'accept-key'
			});

			const res = await client.acceptInvitation('ski1_token_value_abc');
			expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/instance/invitations/accept', {
				method: 'POST',
				credentials: 'same-origin',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': 'accept-key'
				},
				body: JSON.stringify({ token: 'ski1_token_value_abc' })
			});
			expect(res).toEqual({
				invitation: mockData.invitation,
				member: mockData.member,
				replayed: false
			});
		});

		it('POST create API key', async () => {
			const mockApiKey = {
				id: 'key-001',
				name: 'Production Key',
				keyPrefix: 'signkit_prod',
				scopes: ['envelopes:read', 'envelopes:send'],
				createdAt: '2026-09-01T00:00:00Z',
				expiresAt: '2026-12-01T00:00:00Z',
				lastUsedAt: null,
				revokedAt: null
			};
			const mockData = {
				apiKey: mockApiKey,
				token: 'signkit_secret_token_12345'
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockJsonResponse(mockData, 201));
			const client = createInstanceManagementClient({
				fetch: fetchMock,
				newIdempotencyKey: () => 'api-key-create-idemp'
			});

			const res: CreateApiKeyResponse = await client.createApiKey({
				name: 'Production Key',
				scopes: ['envelopes:read', 'envelopes:send'],
				expiresAt: '2026-12-01T00:00:00Z'
			});

			expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/api-keys', {
				method: 'POST',
				credentials: 'same-origin',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': 'api-key-create-idemp'
				},
				body: JSON.stringify({
					name: 'Production Key',
					scopes: ['envelopes:read', 'envelopes:send'],
					expiresAt: '2026-12-01T00:00:00Z'
				})
			});
			expect(res).toEqual({
				apiKey: mockApiKey,
				token: 'signkit_secret_token_12345',
				secret: 'signkit_secret_token_12345',
				replayed: false
			});
		});

		it('GET list API keys with pagination', async () => {
			const mockData = {
				page: {
					items: [
						{
							id: 'key-001',
							name: 'Production Key',
							keyPrefix: 'signkit_prod',
							scopes: ['envelopes:read'],
							createdAt: '2026-09-01T00:00:00Z',
							expiresAt: '2026-12-01T00:00:00Z',
							lastUsedAt: null,
							revokedAt: null
						}
					],
					nextCursor: 'key-cursor-next'
				}
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockJsonResponse(mockData));
			const client = createInstanceManagementClient({ fetch: fetchMock });

			const res = await client.listApiKeys({ cursor: 'key-cursor-cur', limit: 20 });
			expect(fetchMock).toHaveBeenLastCalledWith(
				'/api/v1/api-keys?cursor=key-cursor-cur&limit=20',
				expect.objectContaining({ method: 'GET' })
			);
			expect(res).toEqual(mockData);
		});

		it('POST revoke API key', async () => {
			const mockData = {
				apiKey: {
					id: 'key-001',
					name: 'Production Key',
					keyPrefix: 'signkit_prod',
					scopes: ['envelopes:read'],
					createdAt: '2026-09-01T00:00:00Z',
					expiresAt: '2026-12-01T00:00:00Z',
					lastUsedAt: null,
					revokedAt: '2026-09-02T00:00:00Z'
				}
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockJsonResponse(mockData));
			const client = createInstanceManagementClient({
				fetch: fetchMock,
				newIdempotencyKey: () => 'api-key-revoke-idemp'
			});

			const res = await client.revokeApiKey('key-001');
			expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/api-keys/key-001/revoke', {
				method: 'POST',
				credentials: 'same-origin',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': 'api-key-revoke-idemp'
				},
				body: '{}'
			});
			expect(res).toEqual({
				apiKey: mockData.apiKey,
				replayed: false
			});
		});
	});

	describe('Replay header and optional one-time secret modeling', () => {
		it('models scheduled invitation delivery on replayed creation (HTTP 200 + idempotency-replayed)', async () => {
			const mockData = {
				invitation: {
					id: 'inv-001',
					role: 'admin',
					status: 'pending',
					invitedByUserId: 'usr-001',
					createdAt: '2026-09-01T00:00:00Z',
					expiresAt: '2026-09-08T00:00:00Z',
					acceptedAt: null,
					acceptedByUserId: null,
					revokedAt: null,
					revokedByUserId: null
				},
				delivery: { status: 'scheduled' as const }
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
				mockJsonResponse(mockData, 200, { 'idempotency-replayed': 'true' })
			);
			const client = createInstanceManagementClient({ fetch: fetchMock });

			const res = await client.createInvitation({ email: 'bob@example.com', role: 'admin' });

			expect(res.replayed).toBe(true);
			expect(res.delivery).toEqual({ status: 'scheduled' });
			expect(res.invitation).toEqual(mockData.invitation);
		});

		it('models API key secret as absent on replayed creation (HTTP 200 + idempotency-replayed)', async () => {
			const mockData = {
				apiKey: {
					id: 'key-001',
					name: 'Key',
					keyPrefix: 'signkit_test',
					scopes: ['envelopes:read'],
					createdAt: '2026-09-01T00:00:00Z',
					expiresAt: '2026-12-01T00:00:00Z',
					lastUsedAt: null,
					revokedAt: null
				}
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
				mockJsonResponse(mockData, 200, { 'idempotency-replayed': 'true' })
			);
			const client = createInstanceManagementClient({ fetch: fetchMock });

			const res = await client.createApiKey({ name: 'Key', scopes: ['envelopes:read'] });

			expect(res.replayed).toBe(true);
			expect(res.token).toBeUndefined();
			expect(res.secret).toBeUndefined();
			expect(res.apiKey).toEqual(mockData.apiKey);
		});

		it('reports replayed: true on mutation replays with idempotency-replayed header', async () => {
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
				mockJsonResponse(
					{
						member: {
							userId: 'usr-002',
							role: 'admin',
							status: 'active',
							createdAt: '2026-09-01T00:00:00Z',
							updatedAt: '2026-09-02T00:00:00Z'
						},
						appliedAt: '2026-09-02T00:00:00Z',
						revokedInvitationCount: 0
					},
					200,
					{ 'idempotency-replayed': 'true' }
				)
			);
			const client = createInstanceManagementClient({ fetch: fetchMock });

			const res = await client.setMemberRole('usr-002', 'admin');
			expect(res.replayed).toBe(true);
		});
	});

	describe('Error handling: 401, 403, 409, 503 RFC 9457 problems without internal leakage', () => {
		it('parses 401 Unauthorized RFC 9457 problem', async () => {
			const problem = {
				type: 'urn:signkit:problem:unauthorized',
				title: 'Unauthorized',
				status: 401,
				detail: 'Authentication is required to access this resource.',
				instance: '/api/v1/instance/members/me'
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockProblemResponse(problem));
			const client = createInstanceManagementClient({ fetch: fetchMock });

			await expect(client.getCurrentMember()).rejects.toSatisfy((error: unknown) => {
				expect(error).toBeInstanceOf(InstanceManagementApiError);
				const apiError = error as InstanceManagementApiError;
				expect(apiError.status).toBe(401);
				expect(apiError.type).toBe('urn:signkit:problem:unauthorized');
				expect(apiError.title).toBe('Unauthorized');
				expect(apiError.detail).toBe('Authentication is required to access this resource.');
				expect(apiError.instance).toBe('/api/v1/instance/members/me');
				// Check that no raw Response instance or unparsed internal data is attached
				expect((apiError as unknown as Record<string, unknown>)['response']).toBeUndefined();
				expect((apiError as unknown as Record<string, unknown>)['rawBody']).toBeUndefined();
				return true;
			});
		});

		it('parses 403 Forbidden RFC 9457 problem', async () => {
			const problem = {
				type: 'urn:signkit:problem:instance-member-forbidden',
				title: 'Instance member actor not permitted',
				status: 403,
				detail: 'The authenticated caller is not permitted to administer this instance member.',
				instance: '/api/v1/instance/members/usr-002/role'
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockProblemResponse(problem));
			const client = createInstanceManagementClient({ fetch: fetchMock });

			await expect(client.setMemberRole('usr-002', 'owner')).rejects.toSatisfy((error: unknown) => {
				expect(error).toBeInstanceOf(InstanceManagementApiError);
				const apiError = error as InstanceManagementApiError;
				expect(apiError.status).toBe(403);
				expect(apiError.type).toBe('urn:signkit:problem:instance-member-forbidden');
				expect(apiError.title).toBe('Instance member actor not permitted');
				expect(apiError.detail).toBe(problem.detail);
				return true;
			});
		});

		it('parses 409 Conflict RFC 9457 problem (e.g. idempotency conflict)', async () => {
			const problem = {
				type: 'urn:signkit:problem:instance-member-idempotency-conflict',
				title: 'Idempotency key conflict',
				status: 409,
				detail:
					'The Idempotency-Key was already used for a different instance member role change request.',
				instance: '/api/v1/instance/members/usr-002/role'
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockProblemResponse(problem));
			const client = createInstanceManagementClient({ fetch: fetchMock });

			await expect(client.setMemberRole('usr-002', 'admin')).rejects.toSatisfy((error: unknown) => {
				expect(error).toBeInstanceOf(InstanceManagementApiError);
				const apiError = error as InstanceManagementApiError;
				expect(apiError.status).toBe(409);
				expect(apiError.type).toBe('urn:signkit:problem:instance-member-idempotency-conflict');
				return true;
			});
		});

		it('parses 503 Service Unavailable RFC 9457 problem (persistence unavailable)', async () => {
			const problem = {
				type: 'urn:signkit:problem:persistence-unavailable',
				title: 'Instance member persistence unavailable',
				status: 503,
				detail: 'The durable instance store is not configured for this deployment.',
				instance: '/api/v1/instance/members'
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockProblemResponse(problem));
			const client = createInstanceManagementClient({ fetch: fetchMock });

			await expect(client.listMembers()).rejects.toSatisfy((error: unknown) => {
				expect(error).toBeInstanceOf(InstanceManagementApiError);
				const apiError = error as InstanceManagementApiError;
				expect(apiError.status).toBe(503);
				expect(apiError.type).toBe('urn:signkit:problem:persistence-unavailable');
				return true;
			});
		});

		it('parses validation errors if present in problem detail', async () => {
			const problem = {
				type: 'urn:signkit:problem:validation-failed',
				title: 'Request validation failed',
				status: 400,
				detail: 'Validation failed.',
				instance: '/api/v1/api-keys',
				errors: [{ path: 'name', message: 'Name is required' }]
			};
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockProblemResponse(problem));
			const client = createInstanceManagementClient({ fetch: fetchMock });

			await expect(client.createApiKey({ name: '', scopes: ['envelopes:read'] })).rejects.toSatisfy(
				(error: unknown) => {
					expect(error).toBeInstanceOf(InstanceManagementApiError);
					const apiError = error as InstanceManagementApiError;
					expect(apiError.status).toBe(400);
					expect(apiError.errors).toEqual([{ path: 'name', message: 'Name is required' }]);
					return true;
				}
			);
		});
	});

	describe('Malformed JSON handling', () => {
		it('handles malformed JSON or HTML body on error responses gracefully without exposing raw body', async () => {
			const rawInternalHtml = '<html><body>502 Bad Gateway: SQL server crashed</body></html>';
			const fetchMock = vi.fn<typeof globalThis.fetch>(
				async () =>
					new Response(rawInternalHtml, {
						status: 502,
						statusText: 'Bad Gateway',
						headers: { 'content-type': 'text/html' }
					})
			);
			const client = createInstanceManagementClient({ fetch: fetchMock });

			await expect(client.getCurrentMember()).rejects.toSatisfy((error: unknown) => {
				expect(error).toBeInstanceOf(InstanceManagementApiError);
				const apiError = error as InstanceManagementApiError;
				expect(apiError.status).toBe(502);
				expect(apiError.title).toBe('Bad Gateway');
				// Crucial: Must NOT contain raw internal HTML or stack dump
				expect(apiError.message).not.toContain('SQL server crashed');
				expect(apiError.detail).not.toContain('SQL server crashed');
				expect((apiError as unknown as Record<string, unknown>)['rawBody']).toBeUndefined();
				return true;
			});
		});

		it('handles malformed JSON on 200 OK responses with typed error', async () => {
			const fetchMock = vi.fn<typeof globalThis.fetch>(
				async () =>
					new Response('{ invalid json chunk ...', {
						status: 200,
						headers: { 'content-type': 'application/json' }
					})
			);
			const client = createInstanceManagementClient({ fetch: fetchMock });

			await expect(client.getCurrentMember()).rejects.toSatisfy((error: unknown) => {
				expect(error).toBeInstanceOf(InstanceManagementApiError);
				const apiError = error as InstanceManagementApiError;
				expect(apiError.status).toBe(200);
				expect(apiError.type).toBe('urn:signkit:problem:invalid-response-json');
				expect(apiError.title).toBe('Invalid response JSON');
				expect(apiError.message).not.toContain('invalid json chunk');
				return true;
			});
		});
	});

	describe('No accidental token retention in client', () => {
		it('does not expose or retain a legacy invitation token returned by an older server', async () => {
			const sensitiveInvitationToken = 'ski1_very_secret_one_time_token_xyz987';
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
				mockJsonResponse(
					{
						invitation: {
							id: 'inv-123',
							role: 'member',
							status: 'pending',
							invitedByUserId: 'usr-1',
							createdAt: '2026-09-01T00:00:00Z',
							expiresAt: '2026-09-08T00:00:00Z',
							acceptedAt: null,
							acceptedByUserId: null,
							revokedAt: null,
							revokedByUserId: null
						},
						token: sensitiveInvitationToken,
						delivery: { status: 'scheduled' }
					},
					201
				)
			);
			const client = createInstanceManagementClient({ fetch: fetchMock });

			const response = await client.createInvitation({
				email: 'carol@example.com',
				role: 'member'
			});
			expect(response).toEqual({
				invitation: expect.objectContaining({ id: 'inv-123' }),
				delivery: { status: 'scheduled' },
				replayed: false
			});
			expect(response).not.toHaveProperty('token');

			// Assert client object does not retain the token in any property
			const clientProperties = Object.getOwnPropertyNames(client);
			for (const prop of clientProperties) {
				const val = (client as unknown as Record<string, unknown>)[prop];
				expect(val).not.toBe(sensitiveInvitationToken);
				expect(JSON.stringify(val) ?? '').not.toContain(sensitiveInvitationToken);
			}
		});

		it('does not retain API key secret in the client instance after createApiKey', async () => {
			const sensitiveApiKeySecret = 'signkit_top_secret_key_material_abc456';
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
				mockJsonResponse(
					{
						apiKey: {
							id: 'key-123',
							name: 'SecretKey',
							keyPrefix: 'signkit_sec',
							scopes: ['envelopes:read'],
							createdAt: '2026-09-01T00:00:00Z',
							expiresAt: '2026-12-01T00:00:00Z',
							lastUsedAt: null,
							revokedAt: null
						},
						token: sensitiveApiKeySecret
					},
					201
				)
			);
			const client = createInstanceManagementClient({ fetch: fetchMock });

			const response = await client.createApiKey({
				name: 'SecretKey',
				scopes: ['envelopes:read']
			});
			expect(response.token).toBe(sensitiveApiKeySecret);
			expect(response.secret).toBe(sensitiveApiKeySecret);

			// Assert client object does not retain the secret in any property
			const clientProperties = Object.getOwnPropertyNames(client);
			for (const prop of clientProperties) {
				const val = (client as unknown as Record<string, unknown>)[prop];
				expect(val).not.toBe(sensitiveApiKeySecret);
				expect(JSON.stringify(val) ?? '').not.toContain(sensitiveApiKeySecret);
			}
		});
	});

	describe('Static type safety (compile-time only, never invoked)', () => {
		it('rejects invalid scopes, null expiry, and mismatched role/status overloads', () => {
			function typeOnlyChecks(client: InstanceManagementClient): void {
				// @ts-expect-error scopes must be a valid ApiKeyScope, not an arbitrary string
				void client.createApiKey({ name: 'x', scopes: ['not-a-real-scope'] });
				// @ts-expect-error expiresAt may not be null; omit the field instead
				void client.createApiKey({ name: 'x', scopes: ['envelopes:read'], expiresAt: null });
				// @ts-expect-error a SetMemberRoleInput object cannot be paired with a role string
				void client.setMemberRole({ userId: 'u', role: 'admin' }, 'owner');
				// @ts-expect-error a SetMemberStatusInput object cannot be paired with a status string
				void client.setMemberStatus({ userId: 'u', status: 'active' }, 'suspended');
			}
			expect(typeof typeOnlyChecks).toBe('function');
		});
	});
});
