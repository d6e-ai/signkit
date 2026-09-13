import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthenticateApiKeyResult } from '$lib/ports/api-key-authentication-store';
import type {
	ApiKeyOrganizationGrantMetadata,
	GrantApiKeyOrganizationCommand,
	GrantApiKeyOrganizationStoreResult,
	ListApiKeyOrganizationGrantsStoreResult,
	RevokeApiKeyOrganizationGrantCommand,
	RevokeApiKeyOrganizationGrantStoreResult
} from '$lib/ports/api-key-store';
import { hashApiKey, issueApiKey, type IssuedApiKey } from '$lib/security/api-key';
import { PostgresApiKeyAuthenticationStore } from './postgres-api-key-authentication-store';
import { PostgresApiKeyStore } from './postgres-api-key-store';

const TEST_DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const CI_ENABLED: boolean =
	process.env.CI !== undefined &&
	process.env.CI.trim() !== '' &&
	!['0', 'false', 'no'].includes(process.env.CI.toLowerCase());
if (CI_ENABLED && TEST_DATABASE_URL === undefined) {
	throw new Error('POSTGRES_TEST_URL is required when PostgreSQL integration tests run in CI');
}
const postgresDescribe = TEST_DATABASE_URL === undefined ? describe.skip : describe;

const OWNER_ID: string = 'user-owner-1';
const OTHER_OWNER_ID: string = 'user-owner-2';
const ORG_ADMIN_ID: string = 'user_d6e_org_admin';
const KEY_ID: string = '01900000-0000-7000-8000-000000000201';
const OTHER_KEY_ID: string = '01900000-0000-7000-8000-000000000202';
const GRANT_ID: string = '01900000-0000-7000-8000-000000000301';
const SECOND_GRANT_ID: string = '01900000-0000-7000-8000-000000000302';
const THIRD_GRANT_ID: string = '01900000-0000-7000-8000-000000000303';
const ORG_A: string = 'org-alpha';
const ORG_B: string = 'org-beta';
const AT: string = '2026-09-12T12:00:00.000Z';
const LATER: string = '2026-09-13T12:00:00.000Z';
const EXPIRES_AT: string = '2026-12-11T12:00:00.000Z';
const NOW: string = '2026-09-13T00:00:00.000Z';
const REQUEST_HASH: string = 'a'.repeat(64);
const OTHER_REQUEST_HASH: string = 'b'.repeat(64);

const MIGRATION_PATHS: readonly string[] = readdirSync('migrations/postgres')
	.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
	.sort()
	.map((name: string): string => `migrations/postgres/${name}`);

let sql: ReturnType<typeof postgres> | null = null;
const schemaName: string = `signkit_grants_${process.pid}_${randomUUID().replaceAll('-', '')}`;

function database(): ReturnType<typeof postgres> {
	if (sql === null) throw new Error('PostgreSQL test connection is not initialized');
	return sql;
}

function grantCommand(
	overrides: Partial<GrantApiKeyOrganizationCommand> = {}
): GrantApiKeyOrganizationCommand {
	return {
		actor: { type: 'user', id: OWNER_ID },
		idempotencyKey: 'grant-1',
		requestFingerprint: REQUEST_HASH,
		grantId: GRANT_ID,
		apiKeyId: KEY_ID,
		organizationId: ORG_A,
		organizationName: 'Alpha',
		grantingOrganizationRole: 'owner',
		grantedAt: AT,
		...overrides
	};
}

function revokeCommand(
	overrides: Partial<RevokeApiKeyOrganizationGrantCommand> = {}
): RevokeApiKeyOrganizationGrantCommand {
	return {
		actor: { type: 'user', id: OWNER_ID },
		idempotencyKey: 'revoke-1',
		requestFingerprint: REQUEST_HASH,
		apiKeyId: KEY_ID,
		grantId: GRANT_ID,
		revokedAt: LATER,
		ownerScope: true,
		organizationScope: null,
		...overrides
	};
}

/**
 * PostgreSQL parity for the API key organization grant model and the request-path
 * authentication snapshot. Every case here has a matching D1 case in
 * `d1-api-key-grant-store.integration.spec.ts` and
 * `d1-api-key-authentication-store.spec.ts`; the two dialects must agree on every
 * outcome, because a deployment profile must never be a security boundary.
 */
postgresDescribe('PostgreSQL API key organization grants integration', () => {
	let tokens: Map<string, string> = new Map<string, string>();

	beforeAll(async () => {
		const databaseUrl: string = TEST_DATABASE_URL as string;
		sql = postgres(databaseUrl, { max: 1, onnotice: (): void => undefined });
		await database().unsafe(`CREATE SCHEMA "${schemaName}"`);
		await database().unsafe(`SET search_path TO "${schemaName}"`);
		await database().unsafe(`SET TIME ZONE 'UTC'`);
		for (const path of MIGRATION_PATHS) {
			await database().unsafe(readFileSync(path, 'utf8'));
		}
	});

	afterAll(async () => {
		if (sql === null) return;
		await sql.unsafe('SET search_path TO public');
		await sql.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
		await sql.end({ timeout: 5 });
		sql = null;
	});

	beforeEach(async () => {
		await database().unsafe(
			'TRUNCATE instance_member, organization, api_key, api_key_organization_grant, ' +
				'api_key_organization_grant_command, api_key_organization_grant_revoke_command CASCADE'
		);
		tokens = new Map<string, string>();
		await database()`
			INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES (${OWNER_ID}, 'member', 'active', ${AT}::timestamptz, ${AT}::timestamptz)
		`;
		await database()`
			INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES (${OTHER_OWNER_ID}, 'member', 'active', ${AT}::timestamptz, ${AT}::timestamptz)
		`;
		await database()`
			INSERT INTO organization (id, d6e_organization_id, name, created_at)
			VALUES (${ORG_A}, ${ORG_A}, 'Alpha', ${AT}::timestamptz)
		`;
		await database()`
			INSERT INTO organization (id, d6e_organization_id, name, created_at)
			VALUES (${ORG_B}, ${ORG_B}, 'Beta', ${AT}::timestamptz)
		`;
		for (const [id, owner] of [
			[KEY_ID, OWNER_ID],
			[OTHER_KEY_ID, OTHER_OWNER_ID]
		] as const) {
			const issued: IssuedApiKey = await issueApiKey();
			tokens.set(id, issued.token);
			await database()`
				INSERT INTO api_key (
					id, name, token_hash, key_prefix, scopes_json, owner_user_id,
					created_at, expires_at, revoked_at, last_used_at,
					rate_window_started_at, rate_window_count
				) VALUES (
					${id}, ${`Agent ${id}`}, ${issued.tokenHash}, ${issued.keyPrefix},
					'["envelopes:read"]', ${owner}, ${AT}::timestamptz, ${EXPIRES_AT}::timestamptz,
					NULL, NULL, NULL, 0
				)
			`;
		}
	});

	function store(): PostgresApiKeyStore {
		return new PostgresApiKeyStore(database());
	}

	function authentication(): PostgresApiKeyAuthenticationStore {
		return new PostgresApiKeyAuthenticationStore(database());
	}

	async function countRows(table: string): Promise<number> {
		const rows = await database()<
			{ value: number }[]
		>`SELECT count(*)::int AS value FROM ${database().unsafe(table)}`;
		return rows[0]?.value ?? 0;
	}

	async function setMemberStatus(userId: string, status: 'active' | 'suspended'): Promise<void> {
		await database()`
			UPDATE instance_member SET status = ${status}, updated_at = ${LATER}::timestamptz
			WHERE user_id = ${userId}
		`;
	}

	async function authenticate(
		organizationId: string = ORG_A,
		at: string = NOW,
		apiKeyId: string = KEY_ID
	): Promise<AuthenticateApiKeyResult> {
		return authentication().authenticateApiKey({
			tokenHash: await hashApiKey(tokens.get(apiKeyId) as string),
			organizationId,
			at
		});
	}

	describe('grant', () => {
		it('writes the grant and its receipt atomically', async () => {
			const result: GrantApiKeyOrganizationStoreResult =
				await store().grantApiKeyOrganization(grantCommand());

			expect(result).toEqual({
				outcome: 'granted',
				grant: {
					id: GRANT_ID,
					apiKeyId: KEY_ID,
					organizationId: ORG_A,
					grantedByUserId: OWNER_ID,
					grantedOrganizationRole: 'owner',
					grantedAt: AT,
					revokedAt: null,
					revokedByUserId: null,
					revokedByAuthority: null
				}
			});
			expect(await countRows('api_key_organization_grant')).toBe(1);
			expect(await countRows('api_key_organization_grant_command')).toBe(1);
		});

		it('projects an organization that has never created an envelope here', async () => {
			await database()`DELETE FROM organization WHERE id = ${ORG_A}`;

			const result: GrantApiKeyOrganizationStoreResult =
				await store().grantApiKeyOrganization(grantCommand());

			expect(result.outcome).toBe('granted');
			const rows = await database()<
				{ id: string; d6e: string; name: string }[]
			>`SELECT id, d6e_organization_id AS "d6e", name FROM organization WHERE id = ${ORG_A}`;
			expect(rows).toEqual([{ id: ORG_A, d6e: ORG_A, name: 'Alpha' }]);
		});

		it('grants several organizations to one key', async () => {
			expect((await store().grantApiKeyOrganization(grantCommand())).outcome).toBe('granted');
			const second: GrantApiKeyOrganizationStoreResult = await store().grantApiKeyOrganization(
				grantCommand({
					idempotencyKey: 'grant-2',
					requestFingerprint: OTHER_REQUEST_HASH,
					grantId: SECOND_GRANT_ID,
					organizationId: ORG_B,
					organizationName: 'Beta',
					grantingOrganizationRole: 'admin'
				})
			);

			expect(second.outcome).toBe('granted');
			expect(await countRows('api_key_organization_grant')).toBe(2);
		});

		it('replays an exact idempotency key without writing a second grant', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			const replay: GrantApiKeyOrganizationStoreResult = await store().grantApiKeyOrganization(
				grantCommand({ grantId: SECOND_GRANT_ID })
			);

			expect(replay.outcome).toBe('replayed');
			expect(replay.outcome === 'replayed' && replay.grant.id).toBe(GRANT_ID);
			expect(await countRows('api_key_organization_grant')).toBe(1);
			expect(await countRows('api_key_organization_grant_command')).toBe(1);
		});

		it('reports a fresh key for an already granted organization as already granted', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			const again: GrantApiKeyOrganizationStoreResult = await store().grantApiKeyOrganization(
				grantCommand({
					idempotencyKey: 'grant-2',
					requestFingerprint: OTHER_REQUEST_HASH,
					grantId: SECOND_GRANT_ID
				})
			);

			expect(again.outcome).toBe('already_granted');
			expect(again.outcome === 'already_granted' && again.grant.id).toBe(GRANT_ID);
			expect(await countRows('api_key_organization_grant_command')).toBe(1);
		});

		it('rejects a reused idempotency key for a different organization', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			const conflict: GrantApiKeyOrganizationStoreResult = await store().grantApiKeyOrganization(
				grantCommand({
					grantId: SECOND_GRANT_ID,
					organizationId: ORG_B,
					organizationName: 'Beta',
					requestFingerprint: OTHER_REQUEST_HASH
				})
			);

			expect(conflict).toEqual({ outcome: 'idempotency_conflict' });
			expect(await countRows('api_key_organization_grant')).toBe(1);
		});

		it('reports an unknown key opaquely', async () => {
			expect(
				await store().grantApiKeyOrganization(
					grantCommand({ apiKeyId: '01900000-0000-7000-8000-0000000009ff' })
				)
			).toEqual({ outcome: 'not_found' });
		});

		it('reports another owner key identically to an unknown key', async () => {
			expect(
				await store().grantApiKeyOrganization(grantCommand({ apiKeyId: OTHER_KEY_ID }))
			).toEqual({ outcome: 'not_found' });
			expect(await countRows('api_key_organization_grant')).toBe(0);
		});

		it('refuses to grant on a revoked key', async () => {
			await database()`UPDATE api_key SET revoked_at = ${AT}::timestamptz WHERE id = ${KEY_ID}`;
			expect(await store().grantApiKeyOrganization(grantCommand())).toEqual({
				outcome: 'key_not_active'
			});
			expect(await countRows('api_key_organization_grant')).toBe(0);
		});

		it('refuses to grant on an expired key', async () => {
			await database()`
				UPDATE api_key SET expires_at = ${'2026-09-12T18:00:00.000Z'}::timestamptz
				WHERE id = ${KEY_ID}
			`;
			expect(await store().grantApiKeyOrganization(grantCommand({ grantedAt: LATER }))).toEqual({
				outcome: 'key_not_active'
			});
		});

		it('fails closed for a suspended owner', async () => {
			await setMemberStatus(OWNER_ID, 'suspended');
			expect(await store().grantApiKeyOrganization(grantCommand())).toEqual({
				outcome: 'owner_not_active'
			});
			expect(await countRows('api_key_organization_grant')).toBe(0);
			expect(await countRows('api_key_organization_grant_command')).toBe(0);
		});

		/**
		 * Two administrators racing the same (key, organization) pair. The partial
		 * unique index admits one and the loser resolves to the existing grant, so no
		 * duplicate live grant can ever exist.
		 */
		it('serializes concurrent grants of the same organization', async () => {
			const results: GrantApiKeyOrganizationStoreResult[] = await Promise.all([
				store().grantApiKeyOrganization(grantCommand()),
				store().grantApiKeyOrganization(
					grantCommand({
						idempotencyKey: 'grant-2',
						requestFingerprint: OTHER_REQUEST_HASH,
						grantId: SECOND_GRANT_ID
					})
				)
			]);

			expect(results.map((result) => result.outcome).sort()).toEqual([
				'already_granted',
				'granted'
			]);
			expect(await countRows('api_key_organization_grant')).toBe(1);
			expect(await countRows('api_key_organization_grant_command')).toBe(1);
		});

		it('re-grants a previously revoked organization as a new row', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			await store().revokeApiKeyOrganizationGrant(revokeCommand());
			const regrant: GrantApiKeyOrganizationStoreResult = await store().grantApiKeyOrganization(
				grantCommand({
					idempotencyKey: 'grant-2',
					requestFingerprint: OTHER_REQUEST_HASH,
					grantId: SECOND_GRANT_ID,
					grantedAt: LATER
				})
			);

			expect(regrant.outcome).toBe('granted');
			expect(regrant.outcome === 'granted' && regrant.grant.id).toBe(SECOND_GRANT_ID);
			expect(await countRows('api_key_organization_grant')).toBe(2);
		});
	});

	describe('list', () => {
		it('returns the key grant history newest first and paginates', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			await store().grantApiKeyOrganization(
				grantCommand({
					idempotencyKey: 'grant-2',
					requestFingerprint: OTHER_REQUEST_HASH,
					grantId: SECOND_GRANT_ID,
					organizationId: ORG_B,
					organizationName: 'Beta',
					grantedAt: LATER
				})
			);

			const first: ListApiKeyOrganizationGrantsStoreResult =
				await store().listApiKeyOrganizationGrants({
					actor: { type: 'user', id: OWNER_ID },
					apiKeyId: KEY_ID,
					cursor: null,
					limit: 1
				});
			expect(first.outcome === 'listed' && first.page.nextCursor).toBe(SECOND_GRANT_ID);

			const second: ListApiKeyOrganizationGrantsStoreResult =
				await store().listApiKeyOrganizationGrants({
					actor: { type: 'user', id: OWNER_ID },
					apiKeyId: KEY_ID,
					cursor: SECOND_GRANT_ID,
					limit: 25
				});
			expect(
				second.outcome === 'listed' &&
					second.page.items.map((item: ApiKeyOrganizationGrantMetadata): string => item.id)
			).toEqual([GRANT_ID]);
		});

		it('fails an unknown cursor closed as an empty page', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			const result: ListApiKeyOrganizationGrantsStoreResult =
				await store().listApiKeyOrganizationGrants({
					actor: { type: 'user', id: OWNER_ID },
					apiKeyId: KEY_ID,
					cursor: 'not-a-cursor',
					limit: 25
				});
			expect(result.outcome === 'listed' && result.page.items).toEqual([]);
		});

		it('reports another owner key identically to an unknown key', async () => {
			expect(
				await store().listApiKeyOrganizationGrants({
					actor: { type: 'user', id: OWNER_ID },
					apiKeyId: OTHER_KEY_ID,
					cursor: null,
					limit: 25
				})
			).toEqual({ outcome: 'not_found' });
		});

		it('fails closed for a suspended owner', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			await setMemberStatus(OWNER_ID, 'suspended');
			expect(
				await store().listApiKeyOrganizationGrants({
					actor: { type: 'user', id: OWNER_ID },
					apiKeyId: KEY_ID,
					cursor: null,
					limit: 25
				})
			).toEqual({ outcome: 'owner_not_active' });
		});
	});

	describe('revoke', () => {
		it('lets the key owner revoke and records the owner authority', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			const result: RevokeApiKeyOrganizationGrantStoreResult =
				await store().revokeApiKeyOrganizationGrant(revokeCommand());

			expect(result).toEqual({
				outcome: 'revoked',
				grant: {
					id: GRANT_ID,
					apiKeyId: KEY_ID,
					organizationId: ORG_A,
					grantedByUserId: OWNER_ID,
					grantedOrganizationRole: 'owner',
					grantedAt: AT,
					revokedAt: LATER,
					revokedByUserId: OWNER_ID,
					revokedByAuthority: 'key_owner'
				}
			});
			expect(await countRows('api_key_organization_grant_revoke_command')).toBe(1);
		});

		/**
		 * The organization-side control, and the reason the revoking actor carries no
		 * foreign key: this administrator holds no local instance membership at all.
		 */
		it('lets an organization administrator with no instance membership revoke', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			const result: RevokeApiKeyOrganizationGrantStoreResult =
				await store().revokeApiKeyOrganizationGrant(
					revokeCommand({
						actor: { type: 'user', id: ORG_ADMIN_ID },
						organizationScope: ORG_A
					})
				);

			expect(result.outcome).toBe('revoked');
			expect(result.outcome === 'revoked' && result.grant.revokedByAuthority).toBe(
				'organization_admin'
			);
			expect(result.outcome === 'revoked' && result.grant.revokedByUserId).toBe(ORG_ADMIN_ID);
		});

		it('refuses an organization administrator scoped to a different organization', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			expect(
				await store().revokeApiKeyOrganizationGrant(
					revokeCommand({
						actor: { type: 'user', id: ORG_ADMIN_ID },
						organizationScope: ORG_B
					})
				)
			).toEqual({ outcome: 'not_found' });
			expect(await countRows('api_key_organization_grant_revoke_command')).toBe(0);
		});

		it('refuses a caller who neither owns the key nor administers the organization', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			expect(
				await store().revokeApiKeyOrganizationGrant(
					revokeCommand({ actor: { type: 'user', id: OTHER_OWNER_ID }, organizationScope: null })
				)
			).toEqual({ outcome: 'not_found' });
		});

		it('records the owner authority when a caller holds both', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			const result: RevokeApiKeyOrganizationGrantStoreResult =
				await store().revokeApiKeyOrganizationGrant(revokeCommand({ organizationScope: ORG_A }));
			expect(result.outcome === 'revoked' && result.grant.revokedByAuthority).toBe('key_owner');
		});

		it('lets a suspended owner still revoke through organization authority', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			await setMemberStatus(OWNER_ID, 'suspended');
			const result: RevokeApiKeyOrganizationGrantStoreResult =
				await store().revokeApiKeyOrganizationGrant(revokeCommand({ organizationScope: ORG_A }));
			expect(result.outcome === 'revoked' && result.grant.revokedByAuthority).toBe(
				'organization_admin'
			);
		});

		it('reports a suspended owner with no organization authority as owner_not_active', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			await setMemberStatus(OWNER_ID, 'suspended');
			expect(await store().revokeApiKeyOrganizationGrant(revokeCommand())).toEqual({
				outcome: 'owner_not_active'
			});
		});

		it('replays an exact idempotency key, including for an actor since suspended', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			await store().revokeApiKeyOrganizationGrant(revokeCommand());
			await setMemberStatus(OWNER_ID, 'suspended');

			const replay: RevokeApiKeyOrganizationGrantStoreResult =
				await store().revokeApiKeyOrganizationGrant(revokeCommand());
			expect(replay.outcome).toBe('replayed');
			expect(await countRows('api_key_organization_grant_revoke_command')).toBe(1);
		});

		it('reports a fresh key against an already revoked grant explicitly', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			await store().revokeApiKeyOrganizationGrant(revokeCommand());
			const again: RevokeApiKeyOrganizationGrantStoreResult =
				await store().revokeApiKeyOrganizationGrant(
					revokeCommand({ idempotencyKey: 'revoke-2', requestFingerprint: OTHER_REQUEST_HASH })
				);

			expect(again.outcome).toBe('already_revoked');
			expect(await countRows('api_key_organization_grant_revoke_command')).toBe(1);
		});

		it('rejects a reused idempotency key for a different grant', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			await store().grantApiKeyOrganization(
				grantCommand({
					idempotencyKey: 'grant-2',
					requestFingerprint: OTHER_REQUEST_HASH,
					grantId: SECOND_GRANT_ID,
					organizationId: ORG_B,
					organizationName: 'Beta'
				})
			);
			await store().revokeApiKeyOrganizationGrant(revokeCommand());

			expect(
				await store().revokeApiKeyOrganizationGrant(
					revokeCommand({ grantId: SECOND_GRANT_ID, requestFingerprint: OTHER_REQUEST_HASH })
				)
			).toEqual({ outcome: 'idempotency_conflict' });
		});

		it('reports an unknown grant and a cross-key grant opaquely', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			expect(
				await store().revokeApiKeyOrganizationGrant(revokeCommand({ grantId: THIRD_GRANT_ID }))
			).toEqual({ outcome: 'not_found' });
			expect(
				await store().revokeApiKeyOrganizationGrant(revokeCommand({ apiKeyId: OTHER_KEY_ID }))
			).toEqual({ outcome: 'not_found' });
		});

		it('serializes concurrent revocations of the same grant', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			const results: RevokeApiKeyOrganizationGrantStoreResult[] = await Promise.all([
				store().revokeApiKeyOrganizationGrant(revokeCommand()),
				store().revokeApiKeyOrganizationGrant(
					revokeCommand({ idempotencyKey: 'revoke-2', requestFingerprint: OTHER_REQUEST_HASH })
				)
			]);

			expect(results.map((result) => result.outcome).sort()).toEqual([
				'already_revoked',
				'revoked'
			]);
			expect(await countRows('api_key_organization_grant_revoke_command')).toBe(1);
		});

		it('revokes a grant whose key has since been revoked', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			await database()`UPDATE api_key SET revoked_at = ${LATER}::timestamptz WHERE id = ${KEY_ID}`;
			expect((await store().revokeApiKeyOrganizationGrant(revokeCommand())).outcome).toBe(
				'revoked'
			);
		});
	});

	describe('request-path authentication', () => {
		it('resolves a live key with a live grant into an organization-scoped principal', async () => {
			await store().grantApiKeyOrganization(grantCommand());

			expect(await authenticate()).toEqual({
				outcome: 'authenticated',
				principal: {
					apiKeyId: KEY_ID,
					keyPrefix: expect.stringMatching(/^signkit_/) as unknown as string,
					ownerUserId: OWNER_ID,
					organizationId: ORG_A,
					organizationName: 'Alpha',
					scopes: ['envelopes:read'],
					expiresAt: EXPIRES_AT
				}
			});
		});

		it('refuses an organization the key holds no grant for', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			expect(await authenticate(ORG_B)).toEqual({ outcome: 'organization_grant_required' });
		});

		it('reaches exactly the requested organization when several are granted', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			await store().grantApiKeyOrganization(
				grantCommand({
					idempotencyKey: 'grant-2',
					requestFingerprint: OTHER_REQUEST_HASH,
					grantId: SECOND_GRANT_ID,
					organizationId: ORG_B,
					organizationName: 'Beta',
					grantingOrganizationRole: 'admin'
				})
			);

			const alpha: AuthenticateApiKeyResult = await authenticate(ORG_A);
			const beta: AuthenticateApiKeyResult = await authenticate(ORG_B);
			expect(alpha.outcome === 'authenticated' && alpha.principal.organizationId).toBe(ORG_A);
			expect(beta.outcome === 'authenticated' && beta.principal.organizationId).toBe(ORG_B);
		});

		it('stops authenticating the instant the grant is revoked', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			expect((await authenticate()).outcome).toBe('authenticated');
			await store().revokeApiKeyOrganizationGrant(revokeCommand());
			expect(await authenticate()).toEqual({ outcome: 'organization_grant_required' });
		});

		it('reports an unknown token hash opaquely', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			expect(
				await authentication().authenticateApiKey({
					tokenHash: await hashApiKey(`signkit_${'z'.repeat(43)}`),
					organizationId: ORG_A,
					at: NOW
				})
			).toEqual({ outcome: 'invalid_token' });
		});

		it('reports a revoked key opaquely', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			await database()`UPDATE api_key SET revoked_at = ${AT}::timestamptz WHERE id = ${KEY_ID}`;
			expect(await authenticate()).toEqual({ outcome: 'invalid_token' });
		});

		it('reports an expired key opaquely, treating expiry as strictly future', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			await database()`
				UPDATE api_key SET expires_at = ${NOW}::timestamptz WHERE id = ${KEY_ID}
			`;
			expect(await authenticate(ORG_A, NOW)).toEqual({ outcome: 'invalid_token' });
		});

		it('reports a suspended owner opaquely', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			await setMemberStatus(OWNER_ID, 'suspended');
			expect(await authenticate()).toEqual({ outcome: 'invalid_token' });
		});

		it('never resolves a grant belonging to another key', async () => {
			await database()`
				INSERT INTO api_key_organization_grant (
					id, api_key_id, organization_id, granted_by_user_id,
					granted_organization_role, granted_at
				) VALUES (
					${GRANT_ID}, ${OTHER_KEY_ID}, ${ORG_A}, ${OTHER_OWNER_ID}, 'owner', ${AT}::timestamptz
				)
			`;
			expect(await authenticate(ORG_A, NOW, KEY_ID)).toEqual({
				outcome: 'organization_grant_required'
			});
		});

		it('looks the key up by token hash and never by its display prefix', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			expect(
				await authentication().authenticateApiKey({
					tokenHash: 'signkit_abcdefgh',
					organizationId: ORG_A,
					at: NOW
				})
			).toEqual({ outcome: 'invalid_token' });
		});

		it('returns no token or hash material in the principal', async () => {
			await store().grantApiKeyOrganization(grantCommand());
			const token: string = tokens.get(KEY_ID) as string;
			const serialized: string = JSON.stringify(await authenticate());

			expect(serialized).not.toContain(token);
			expect(serialized).not.toContain(await hashApiKey(token));
		});
	});
});
