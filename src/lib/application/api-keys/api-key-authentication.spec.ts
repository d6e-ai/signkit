import { describe, expect, it, vi } from 'vitest';
import type {
	ApiKeyAuthenticationStore,
	AuthenticateApiKeyQuery,
	AuthenticateApiKeyResult
} from '$lib/ports/api-key-authentication-store';
import { hashApiKey } from '$lib/security/api-key';
import { ApiKeyAuthenticationApplication } from './api-key-authentication';

const TOKEN: string = `signkit_${'a'.repeat(43)}`;
const NOW: Date = new Date('2026-09-13T00:00:00.000Z');

function store(result: AuthenticateApiKeyResult = { outcome: 'invalid_token' }): {
	store: ApiKeyAuthenticationStore;
	queries: AuthenticateApiKeyQuery[];
} {
	const queries: AuthenticateApiKeyQuery[] = [];
	return {
		queries,
		store: {
			authenticateApiKey: vi.fn(
				async (query: AuthenticateApiKeyQuery): Promise<AuthenticateApiKeyResult> => {
					queries.push(query);
					return result;
				}
			)
		}
	};
}

describe('ApiKeyAuthenticationApplication', () => {
	it('hashes the token and forwards only the hash and the instant', async () => {
		const fake = store({
			outcome: 'authenticated',
			principal: {
				apiKeyId: '01900000-0000-7000-8000-000000000201',
				keyPrefix: 'signkit_abcdefgh',
				ownerUserId: 'user-1',
				scopes: ['envelopes:read'],
				expiresAt: '2026-12-11T00:00:00.000Z'
			}
		});
		const application = new ApiKeyAuthenticationApplication(fake.store, (): Date => NOW);

		const result = await application.authenticate({ token: TOKEN });

		expect(result.outcome).toBe('authenticated');
		expect(result).toEqual({
			outcome: 'authenticated',
			principal: {
				apiKeyId: '01900000-0000-7000-8000-000000000201',
				keyPrefix: 'signkit_abcdefgh',
				ownerUserId: 'user-1',
				scopes: ['envelopes:read'],
				expiresAt: '2026-12-11T00:00:00.000Z'
			}
		});
		expect(fake.queries).toEqual([
			{
				tokenHash: await hashApiKey(TOKEN),
				at: NOW.toISOString()
			}
		]);
		// The query carries no tenant selector: one deployment database is the
		// sole instance boundary, so instance authority follows from the key alone.
		expect(Object.keys(fake.queries[0]).sort()).toEqual(['at', 'tokenHash']);
	});

	/**
	 * Defense in depth: the hooks layer already parsed the bearer, but a service
	 * must never trust that. An unparsable token resolves to the opaque outcome
	 * rather than throwing out of `hashApiKey`.
	 */
	it.each([
		['a recipient capability', `skr1_${'a'.repeat(43)}`],
		['a completion access grant', `skca1_${'a'.repeat(43)}`],
		['a truncated key', `signkit_${'a'.repeat(42)}`],
		['an empty token', '']
	])('answers %s with the opaque outcome and no durable read', async (_name, token) => {
		const fake = store();
		const application = new ApiKeyAuthenticationApplication(fake.store, (): Date => NOW);

		const result = await application.authenticate({ token });

		expect(result).toEqual({ outcome: 'invalid_token' });
		expect(fake.store.authenticateApiKey).not.toHaveBeenCalled();
	});

	it.each(['invalid_token', 'rate_limited', 'integrity_error'] as const)(
		'passes the store outcome %s through unchanged',
		async (outcome) => {
			const fake = store({ outcome });
			const application = new ApiKeyAuthenticationApplication(fake.store, (): Date => NOW);

			expect(await application.authenticate({ token: TOKEN })).toEqual({ outcome });
		}
	);

	it('never retains the token or its hash after answering', async () => {
		const fake = store();
		const application = new ApiKeyAuthenticationApplication(fake.store, (): Date => NOW);
		await application.authenticate({ token: TOKEN });

		// The service is stateless: nothing enumerable on it may carry credential
		// material, so a later error report or log of the instance cannot leak it.
		expect(JSON.stringify(application)).not.toContain(TOKEN);
		expect(JSON.stringify(application)).not.toContain(await hashApiKey(TOKEN));
	});
});
