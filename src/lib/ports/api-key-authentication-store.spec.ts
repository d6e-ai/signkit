import { describe, expect, it, vi } from 'vitest';
import type {
	ApiKeyAuthenticationStore,
	ApiKeyPrincipal,
	AuthenticateApiKeyQuery,
	AuthenticateApiKeyResult
} from './api-key-authentication-store';

/**
 * The authentication port carries no runtime values -- only the shapes below --
 * so this spec pins the instance-boundary contract instead: the query is the
 * token hash plus an instant with no tenant selector, the principal is a
 * machine actor with no human identity, and the outcome set is closed.
 */
describe('API key authentication port contract', () => {
	it('queries by token hash and instant only, with no tenant selector', async () => {
		const queries: AuthenticateApiKeyQuery[] = [];
		const store: ApiKeyAuthenticationStore = {
			authenticateApiKey: vi.fn(
				async (query: AuthenticateApiKeyQuery): Promise<AuthenticateApiKeyResult> => {
					queries.push(query);
					return { outcome: 'invalid_token' };
				}
			)
		};

		await store.authenticateApiKey({ tokenHash: 'a'.repeat(64), at: '2026-09-13T00:00:00.000Z' });

		expect(Object.keys(queries[0]).sort()).toEqual(['at', 'tokenHash']);
		expect(queries[0]).not.toHaveProperty('organizationId');
	});

	it('authenticates into a machine principal with no human identity attached', () => {
		const principal: ApiKeyPrincipal = {
			apiKeyId: '01900000-0000-7000-8000-000000000201',
			keyPrefix: 'signkit_abcdefgh',
			ownerUserId: 'user-1',
			scopes: ['envelopes:read'],
			expiresAt: '2026-12-11T00:00:00.000Z'
		};

		expect(Object.keys(principal).sort()).toEqual([
			'apiKeyId',
			'expiresAt',
			'keyPrefix',
			'ownerUserId',
			'scopes'
		]);
		expect(principal).not.toHaveProperty('organizationId');
		expect(principal).not.toHaveProperty('organizationName');
		expect(principal).not.toHaveProperty('token');
		expect(principal).not.toHaveProperty('tokenHash');
		expect(principal).not.toHaveProperty('name');
		expect(principal).not.toHaveProperty('email');
	});

	it('closes the outcome set to authenticated, invalid_token, rate_limited, and integrity_error', () => {
		const outcomes: AuthenticateApiKeyResult[] = [
			{
				outcome: 'authenticated',
				principal: {
					apiKeyId: '01900000-0000-7000-8000-000000000201',
					keyPrefix: 'signkit_abcdefgh',
					ownerUserId: 'user-1',
					scopes: ['envelopes:read'],
					expiresAt: '2026-12-11T00:00:00.000Z'
				}
			},
			{ outcome: 'invalid_token' },
			{ outcome: 'rate_limited' },
			{ outcome: 'integrity_error' }
		];

		// Exhaustive without a default: adding an outcome (a tenant selector
		// refusal, a grant requirement) becomes a compile error here.
		for (const result of outcomes) {
			switch (result.outcome) {
				case 'authenticated':
					expect(result.principal.apiKeyId).toBe('01900000-0000-7000-8000-000000000201');
					break;
				case 'invalid_token':
				case 'rate_limited':
				case 'integrity_error':
					expect(result).toEqual({ outcome: result.outcome });
					break;
				default: {
					const _exhaustive: never = result;
					throw new Error(`Unhandled authentication outcome: ${JSON.stringify(_exhaustive)}`);
				}
			}
		}
	});
});
