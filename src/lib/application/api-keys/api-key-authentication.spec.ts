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
	it('hashes the token and forwards the requested organization and instant', async () => {
		const fake = store({
			outcome: 'authenticated',
			principal: {
				apiKeyId: '01900000-0000-7000-8000-000000000201',
				keyPrefix: 'signkit_abcdefgh',
				ownerUserId: 'user-1',
				organizationId: 'org-alpha',
				organizationName: 'Alpha',
				scopes: ['envelopes:read'],
				expiresAt: '2026-12-11T00:00:00.000Z'
			}
		});
		const application = new ApiKeyAuthenticationApplication(fake.store, (): Date => NOW);

		const result = await application.authenticate({ token: TOKEN, organizationId: 'org-alpha' });

		expect(result.outcome).toBe('authenticated');
		expect(fake.queries).toEqual([
			{
				tokenHash: await hashApiKey(TOKEN),
				organizationId: 'org-alpha',
				at: NOW.toISOString()
			}
		]);
	});

	/**
	 * The selector is validated before the token is hashed or read, so a request
	 * that omitted it cannot be used to probe whether the token would otherwise
	 * have worked. Proving the store was never called is the point.
	 */
	it.each([
		['a missing selector', null],
		['an empty selector', ''],
		['an overlong selector', 'o'.repeat(201)],
		['a selector with whitespace', 'org alpha']
	])('refuses %s before any durable read', async (_name, organizationId) => {
		const fake = store();
		const application = new ApiKeyAuthenticationApplication(fake.store, (): Date => NOW);

		const result = await application.authenticate({ token: TOKEN, organizationId });

		expect(result).toEqual({ outcome: 'organization_selector_invalid' });
		expect(fake.store.authenticateApiKey).not.toHaveBeenCalled();
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

		const result = await application.authenticate({ token, organizationId: 'org-alpha' });

		expect(result).toEqual({ outcome: 'invalid_token' });
		expect(fake.store.authenticateApiKey).not.toHaveBeenCalled();
	});

	it.each(['invalid_token', 'organization_grant_required', 'integrity_error'] as const)(
		'passes the store outcome %s through unchanged',
		async (outcome) => {
			const fake = store({ outcome });
			const application = new ApiKeyAuthenticationApplication(fake.store, (): Date => NOW);

			expect(await application.authenticate({ token: TOKEN, organizationId: 'org-alpha' })).toEqual(
				{ outcome }
			);
		}
	);

	it('never retains the token or its hash after answering', async () => {
		const fake = store();
		const application = new ApiKeyAuthenticationApplication(fake.store, (): Date => NOW);
		await application.authenticate({ token: TOKEN, organizationId: 'org-alpha' });

		// The service is stateless: nothing enumerable on it may carry credential
		// material, so a later error report or log of the instance cannot leak it.
		expect(JSON.stringify(application)).not.toContain(TOKEN);
		expect(JSON.stringify(application)).not.toContain(await hashApiKey(TOKEN));
	});
});
