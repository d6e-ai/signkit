import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type {
	ApiKeyOrganizationGrantMetadata,
	GrantApiKeyOrganizationCommand,
	GrantApiKeyOrganizationStoreResult,
	ListApiKeyOrganizationGrantsStoreResult,
	RevokeApiKeyOrganizationGrantCommand,
	RevokeApiKeyOrganizationGrantStoreResult
} from '$lib/ports/api-key-store';
import { issueApiKey, type IssuedApiKey } from '$lib/security/api-key';
import { D1ApiKeyStore } from './d1-api-key-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const OWNER_ID: string = 'user-1';
const OTHER_OWNER_ID: string = 'user-2';
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
const REQUEST_HASH: string = 'a'.repeat(64);
const OTHER_REQUEST_HASH: string = 'b'.repeat(64);

interface Fixture {
	store: D1ApiKeyStore;
	sqlite: DatabaseSync;
}

async function createFixture(
	options: { keyRevokedAt?: string; keyExpiresAt?: string; projectOrganizations?: boolean } = {}
): Promise<Fixture> {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${OWNER_ID}', 'member', 'active', '${AT}', '${AT}');
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${OTHER_OWNER_ID}', 'member', 'active', '${AT}', '${AT}');
	`);
	if (options.projectOrganizations !== false) {
		sqlite.exec(`
			INSERT INTO organization (id, d6e_organization_id, name, created_at)
			VALUES ('${ORG_A}', '${ORG_A}', 'Alpha', '${AT}');
		`);
	}
	for (const [id, owner] of [
		[KEY_ID, OWNER_ID],
		[OTHER_KEY_ID, OTHER_OWNER_ID]
	] as const) {
		const issued: IssuedApiKey = await issueApiKey();
		sqlite.exec(`
			INSERT INTO api_key (
				id, name, token_hash, key_prefix, scopes_json, owner_user_id,
				created_at, expires_at, revoked_at, rate_window_count
			) VALUES (
				'${id}', 'Agent ${id}', '${issued.tokenHash}', '${issued.keyPrefix}',
				'["envelopes:read"]', '${owner}', '${AT}',
				'${id === KEY_ID ? (options.keyExpiresAt ?? EXPIRES_AT) : EXPIRES_AT}',
				${id === KEY_ID && options.keyRevokedAt !== undefined ? `'${options.keyRevokedAt}'` : 'NULL'},
				0
			)
		`);
	}
	return { store: new D1ApiKeyStore(sqliteD1Database(sqlite)), sqlite };
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

function countRows(sqlite: DatabaseSync, table: string): number {
	return (sqlite.prepare(`SELECT count(*) AS value FROM ${table}`).get() as { value: number })
		.value;
}

function setMemberStatus(
	sqlite: DatabaseSync,
	userId: string,
	status: 'active' | 'suspended'
): void {
	sqlite.exec(
		`UPDATE instance_member SET status = '${status}', updated_at = '${LATER}' WHERE user_id = '${userId}'`
	);
}

describe('D1ApiKeyStore organization grants', () => {
	describe('grant', () => {
		it('writes the grant and its receipt atomically', async () => {
			const fixture: Fixture = await createFixture();
			try {
				const result: GrantApiKeyOrganizationStoreResult =
					await fixture.store.grantApiKeyOrganization(grantCommand());

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
				expect(countRows(fixture.sqlite, 'api_key_organization_grant')).toBe(1);
				expect(countRows(fixture.sqlite, 'api_key_organization_grant_command')).toBe(1);
			} finally {
				fixture.sqlite.close();
			}
		});

		/**
		 * A d6e organization that has never created an envelope here has no
		 * projection row yet, and the grant's foreign key needs one. The command
		 * upserts it from the caller's own verified membership in the same batch.
		 */
		it('projects the organization from the verified membership when it is absent', async () => {
			const fixture: Fixture = await createFixture({ projectOrganizations: false });
			try {
				const result: GrantApiKeyOrganizationStoreResult =
					await fixture.store.grantApiKeyOrganization(grantCommand());

				expect(result.outcome).toBe('granted');
				const rows = fixture.sqlite
					.prepare('SELECT id, d6e_organization_id AS d6e, name FROM organization WHERE id = ?')
					.all(ORG_A);
				expect(rows).toEqual([{ id: ORG_A, d6e: ORG_A, name: 'Alpha' }]);
			} finally {
				fixture.sqlite.close();
			}
		});

		it('grants several organizations to one key', async () => {
			const fixture: Fixture = await createFixture();
			try {
				expect((await fixture.store.grantApiKeyOrganization(grantCommand())).outcome).toBe(
					'granted'
				);
				const second: GrantApiKeyOrganizationStoreResult =
					await fixture.store.grantApiKeyOrganization(
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
				expect(countRows(fixture.sqlite, 'api_key_organization_grant')).toBe(2);
			} finally {
				fixture.sqlite.close();
			}
		});

		it('replays an exact idempotency key without writing a second grant', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				const replay: GrantApiKeyOrganizationStoreResult =
					await fixture.store.grantApiKeyOrganization(grantCommand({ grantId: SECOND_GRANT_ID }));

				expect(replay.outcome).toBe('replayed');
				expect(replay.outcome === 'replayed' && replay.grant.id).toBe(GRANT_ID);
				expect(countRows(fixture.sqlite, 'api_key_organization_grant')).toBe(1);
				expect(countRows(fixture.sqlite, 'api_key_organization_grant_command')).toBe(1);
			} finally {
				fixture.sqlite.close();
			}
		});

		/**
		 * Distinct from a replay: a fresh idempotency key naming an organization the
		 * key already reaches is a no-op, and must not be reported as an idempotent
		 * replay of a request it never made.
		 */
		it('reports a fresh key for an already granted organization as already granted', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				const again: GrantApiKeyOrganizationStoreResult =
					await fixture.store.grantApiKeyOrganization(
						grantCommand({
							idempotencyKey: 'grant-2',
							requestFingerprint: OTHER_REQUEST_HASH,
							grantId: SECOND_GRANT_ID
						})
					);

				expect(again.outcome).toBe('already_granted');
				expect(again.outcome === 'already_granted' && again.grant.id).toBe(GRANT_ID);
				expect(countRows(fixture.sqlite, 'api_key_organization_grant_command')).toBe(1);
			} finally {
				fixture.sqlite.close();
			}
		});

		it('rejects a reused idempotency key for a different organization', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				const conflict: GrantApiKeyOrganizationStoreResult =
					await fixture.store.grantApiKeyOrganization(
						grantCommand({
							grantId: SECOND_GRANT_ID,
							organizationId: ORG_B,
							organizationName: 'Beta',
							requestFingerprint: OTHER_REQUEST_HASH
						})
					);

				expect(conflict).toEqual({ outcome: 'idempotency_conflict' });
				expect(countRows(fixture.sqlite, 'api_key_organization_grant')).toBe(1);
			} finally {
				fixture.sqlite.close();
			}
		});

		it('reports an unknown key opaquely', async () => {
			const fixture: Fixture = await createFixture();
			try {
				expect(
					await fixture.store.grantApiKeyOrganization(
						grantCommand({ apiKeyId: '01900000-0000-7000-8000-0000000009ff' })
					)
				).toEqual({ outcome: 'not_found' });
			} finally {
				fixture.sqlite.close();
			}
		});

		/**
		 * Cross-owner opacity: granting must never become a way to discover that
		 * another member's key id exists.
		 */
		it('reports another owner key identically to an unknown key', async () => {
			const fixture: Fixture = await createFixture();
			try {
				expect(
					await fixture.store.grantApiKeyOrganization(grantCommand({ apiKeyId: OTHER_KEY_ID }))
				).toEqual({ outcome: 'not_found' });
				expect(countRows(fixture.sqlite, 'api_key_organization_grant')).toBe(0);
			} finally {
				fixture.sqlite.close();
			}
		});

		it('refuses to grant on a revoked key', async () => {
			const fixture: Fixture = await createFixture({ keyRevokedAt: AT });
			try {
				expect(await fixture.store.grantApiKeyOrganization(grantCommand())).toEqual({
					outcome: 'key_not_active'
				});
				expect(countRows(fixture.sqlite, 'api_key_organization_grant')).toBe(0);
			} finally {
				fixture.sqlite.close();
			}
		});

		it('refuses to grant on an expired key', async () => {
			// The expiry is valid relative to creation but already past by the time the
			// grant is attempted, which is the case a live-key predicate must catch.
			const fixture: Fixture = await createFixture({
				keyExpiresAt: '2026-09-12T18:00:00.000Z'
			});
			try {
				expect(
					await fixture.store.grantApiKeyOrganization(grantCommand({ grantedAt: LATER }))
				).toEqual({ outcome: 'key_not_active' });
			} finally {
				fixture.sqlite.close();
			}
		});

		it('fails closed for a suspended owner', async () => {
			const fixture: Fixture = await createFixture();
			try {
				setMemberStatus(fixture.sqlite, OWNER_ID, 'suspended');
				expect(await fixture.store.grantApiKeyOrganization(grantCommand())).toEqual({
					outcome: 'owner_not_active'
				});
				expect(countRows(fixture.sqlite, 'api_key_organization_grant')).toBe(0);
				expect(countRows(fixture.sqlite, 'api_key_organization_grant_command')).toBe(0);
			} finally {
				fixture.sqlite.close();
			}
		});

		/**
		 * Two administrators racing the same (key, organization) pair with different
		 * idempotency keys: the live-grant uniqueness index admits one, and the loser
		 * resolves to the existing grant rather than erroring or duplicating it.
		 */
		it('serializes concurrent grants of the same organization', async () => {
			const fixture: Fixture = await createFixture();
			try {
				const results: GrantApiKeyOrganizationStoreResult[] = await Promise.all([
					fixture.store.grantApiKeyOrganization(grantCommand()),
					fixture.store.grantApiKeyOrganization(
						grantCommand({
							idempotencyKey: 'grant-2',
							requestFingerprint: OTHER_REQUEST_HASH,
							grantId: SECOND_GRANT_ID
						})
					)
				]);

				const outcomes: string[] = results.map((result) => result.outcome).sort();
				expect(outcomes).toEqual(['already_granted', 'granted']);
				expect(countRows(fixture.sqlite, 'api_key_organization_grant')).toBe(1);
				expect(countRows(fixture.sqlite, 'api_key_organization_grant_command')).toBe(1);
			} finally {
				fixture.sqlite.close();
			}
		});

		it('re-grants a previously revoked organization as a new row', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				await fixture.store.revokeApiKeyOrganizationGrant(revokeCommand());
				const regrant: GrantApiKeyOrganizationStoreResult =
					await fixture.store.grantApiKeyOrganization(
						grantCommand({
							idempotencyKey: 'grant-2',
							requestFingerprint: OTHER_REQUEST_HASH,
							grantId: SECOND_GRANT_ID,
							grantedAt: LATER
						})
					);

				expect(regrant.outcome).toBe('granted');
				expect(regrant.outcome === 'granted' && regrant.grant.id).toBe(SECOND_GRANT_ID);
				expect(countRows(fixture.sqlite, 'api_key_organization_grant')).toBe(2);
			} finally {
				fixture.sqlite.close();
			}
		});
	});

	describe('list', () => {
		it('returns the key grant history newest first', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				await fixture.store.grantApiKeyOrganization(
					grantCommand({
						idempotencyKey: 'grant-2',
						requestFingerprint: OTHER_REQUEST_HASH,
						grantId: SECOND_GRANT_ID,
						organizationId: ORG_B,
						organizationName: 'Beta',
						grantedAt: LATER
					})
				);

				const result: ListApiKeyOrganizationGrantsStoreResult =
					await fixture.store.listApiKeyOrganizationGrants({
						actor: { type: 'user', id: OWNER_ID },
						apiKeyId: KEY_ID,
						cursor: null,
						limit: 25
					});

				expect(result.outcome).toBe('listed');
				const ids: readonly string[] =
					result.outcome === 'listed'
						? result.page.items.map((item: ApiKeyOrganizationGrantMetadata): string => item.id)
						: [];
				expect(ids).toEqual([SECOND_GRANT_ID, GRANT_ID]);
			} finally {
				fixture.sqlite.close();
			}
		});

		it('paginates with an opaque cursor', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				await fixture.store.grantApiKeyOrganization(
					grantCommand({
						idempotencyKey: 'grant-2',
						requestFingerprint: OTHER_REQUEST_HASH,
						grantId: SECOND_GRANT_ID,
						organizationId: ORG_B,
						organizationName: 'Beta',
						grantedAt: LATER
					})
				);

				const first = await fixture.store.listApiKeyOrganizationGrants({
					actor: { type: 'user', id: OWNER_ID },
					apiKeyId: KEY_ID,
					cursor: null,
					limit: 1
				});
				expect(first.outcome === 'listed' && first.page.nextCursor).toBe(SECOND_GRANT_ID);

				const second = await fixture.store.listApiKeyOrganizationGrants({
					actor: { type: 'user', id: OWNER_ID },
					apiKeyId: KEY_ID,
					cursor: SECOND_GRANT_ID,
					limit: 1
				});
				expect(
					second.outcome === 'listed' &&
						second.page.items.map((item: ApiKeyOrganizationGrantMetadata): string => item.id)
				).toEqual([GRANT_ID]);
				expect(second.outcome === 'listed' && second.page.nextCursor).toBeNull();
			} finally {
				fixture.sqlite.close();
			}
		});

		it('fails an unknown cursor closed as an empty page', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				const result = await fixture.store.listApiKeyOrganizationGrants({
					actor: { type: 'user', id: OWNER_ID },
					apiKeyId: KEY_ID,
					cursor: 'not-a-cursor',
					limit: 25
				});
				expect(result.outcome === 'listed' && result.page.items).toEqual([]);
			} finally {
				fixture.sqlite.close();
			}
		});

		it('reports another owner key identically to an unknown key', async () => {
			const fixture: Fixture = await createFixture();
			try {
				expect(
					await fixture.store.listApiKeyOrganizationGrants({
						actor: { type: 'user', id: OWNER_ID },
						apiKeyId: OTHER_KEY_ID,
						cursor: null,
						limit: 25
					})
				).toEqual({ outcome: 'not_found' });
			} finally {
				fixture.sqlite.close();
			}
		});

		it('fails closed for a suspended owner', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				setMemberStatus(fixture.sqlite, OWNER_ID, 'suspended');
				expect(
					await fixture.store.listApiKeyOrganizationGrants({
						actor: { type: 'user', id: OWNER_ID },
						apiKeyId: KEY_ID,
						cursor: null,
						limit: 25
					})
				).toEqual({ outcome: 'owner_not_active' });
			} finally {
				fixture.sqlite.close();
			}
		});
	});

	describe('revoke', () => {
		it('lets the key owner revoke and records the owner authority', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				const result: RevokeApiKeyOrganizationGrantStoreResult =
					await fixture.store.revokeApiKeyOrganizationGrant(revokeCommand());

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
				expect(countRows(fixture.sqlite, 'api_key_organization_grant_revoke_command')).toBe(1);
			} finally {
				fixture.sqlite.close();
			}
		});

		/**
		 * The key owner must keep the ability to de-scope their own agent even after
		 * losing every d6e organization membership -- otherwise a departing operator
		 * could be left holding a key they cannot narrow.
		 */
		it('lets the key owner revoke with no organization scope at all', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				const result: RevokeApiKeyOrganizationGrantStoreResult =
					await fixture.store.revokeApiKeyOrganizationGrant(
						revokeCommand({ organizationScope: null })
					);

				expect(result.outcome).toBe('revoked');
				expect(result.outcome === 'revoked' && result.grant.revokedByAuthority).toBe('key_owner');
			} finally {
				fixture.sqlite.close();
			}
		});

		/**
		 * The organization-side control: a current d6e organization administrator can
		 * cut an agent off from their organization immediately, without owning the key
		 * and without any local instance membership.
		 */
		it('lets an organization administrator revoke a grant for their organization', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				const result: RevokeApiKeyOrganizationGrantStoreResult =
					await fixture.store.revokeApiKeyOrganizationGrant(
						revokeCommand({
							actor: { type: 'user', id: ORG_ADMIN_ID },
							ownerScope: true,
							organizationScope: ORG_A
						})
					);

				expect(result.outcome).toBe('revoked');
				expect(result.outcome === 'revoked' && result.grant.revokedByAuthority).toBe(
					'organization_admin'
				);
				expect(result.outcome === 'revoked' && result.grant.revokedByUserId).toBe(ORG_ADMIN_ID);
			} finally {
				fixture.sqlite.close();
			}
		});

		it('refuses an organization administrator scoped to a different organization', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				expect(
					await fixture.store.revokeApiKeyOrganizationGrant(
						revokeCommand({
							actor: { type: 'user', id: ORG_ADMIN_ID },
							organizationScope: ORG_B
						})
					)
				).toEqual({ outcome: 'not_found' });
				expect(countRows(fixture.sqlite, 'api_key_organization_grant_revoke_command')).toBe(0);
			} finally {
				fixture.sqlite.close();
			}
		});

		it('refuses a caller who neither owns the key nor administers the organization', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				expect(
					await fixture.store.revokeApiKeyOrganizationGrant(
						revokeCommand({
							actor: { type: 'user', id: OTHER_OWNER_ID },
							organizationScope: null
						})
					)
				).toEqual({ outcome: 'not_found' });
			} finally {
				fixture.sqlite.close();
			}
		});

		it('records the owner authority when a caller holds both', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				const result: RevokeApiKeyOrganizationGrantStoreResult =
					await fixture.store.revokeApiKeyOrganizationGrant(
						revokeCommand({ organizationScope: ORG_A })
					);

				expect(result.outcome === 'revoked' && result.grant.revokedByAuthority).toBe('key_owner');
			} finally {
				fixture.sqlite.close();
			}
		});

		it('lets a suspended owner still revoke through organization authority', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				setMemberStatus(fixture.sqlite, OWNER_ID, 'suspended');
				const result: RevokeApiKeyOrganizationGrantStoreResult =
					await fixture.store.revokeApiKeyOrganizationGrant(
						revokeCommand({ organizationScope: ORG_A })
					);

				expect(result.outcome === 'revoked' && result.grant.revokedByAuthority).toBe(
					'organization_admin'
				);
			} finally {
				fixture.sqlite.close();
			}
		});

		it('reports a suspended owner with no organization authority as owner_not_active', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				setMemberStatus(fixture.sqlite, OWNER_ID, 'suspended');
				expect(await fixture.store.revokeApiKeyOrganizationGrant(revokeCommand())).toEqual({
					outcome: 'owner_not_active'
				});
			} finally {
				fixture.sqlite.close();
			}
		});

		it('replays an exact idempotency key', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				await fixture.store.revokeApiKeyOrganizationGrant(revokeCommand());
				const replay: RevokeApiKeyOrganizationGrantStoreResult =
					await fixture.store.revokeApiKeyOrganizationGrant(revokeCommand());

				expect(replay.outcome).toBe('replayed');
				expect(replay.outcome === 'replayed' && replay.grant.revokedAt).toBe(LATER);
				expect(countRows(fixture.sqlite, 'api_key_organization_grant_revoke_command')).toBe(1);
			} finally {
				fixture.sqlite.close();
			}
		});

		/**
		 * Receipt before authority: an actor suspended after their own revoke must
		 * still see that revoke replay identically rather than be re-authorized under
		 * today's state.
		 */
		it('replays for an actor suspended after their own revoke', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				await fixture.store.revokeApiKeyOrganizationGrant(revokeCommand());
				setMemberStatus(fixture.sqlite, OWNER_ID, 'suspended');

				expect((await fixture.store.revokeApiKeyOrganizationGrant(revokeCommand())).outcome).toBe(
					'replayed'
				);
			} finally {
				fixture.sqlite.close();
			}
		});

		it('reports a fresh key against an already revoked grant explicitly', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				await fixture.store.revokeApiKeyOrganizationGrant(revokeCommand());
				const again: RevokeApiKeyOrganizationGrantStoreResult =
					await fixture.store.revokeApiKeyOrganizationGrant(
						revokeCommand({ idempotencyKey: 'revoke-2', requestFingerprint: OTHER_REQUEST_HASH })
					);

				expect(again.outcome).toBe('already_revoked');
				expect(countRows(fixture.sqlite, 'api_key_organization_grant_revoke_command')).toBe(1);
			} finally {
				fixture.sqlite.close();
			}
		});

		it('rejects a reused idempotency key for a different grant', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				await fixture.store.grantApiKeyOrganization(
					grantCommand({
						idempotencyKey: 'grant-2',
						requestFingerprint: OTHER_REQUEST_HASH,
						grantId: SECOND_GRANT_ID,
						organizationId: ORG_B,
						organizationName: 'Beta'
					})
				);
				await fixture.store.revokeApiKeyOrganizationGrant(revokeCommand());

				expect(
					await fixture.store.revokeApiKeyOrganizationGrant(
						revokeCommand({ grantId: SECOND_GRANT_ID, requestFingerprint: OTHER_REQUEST_HASH })
					)
				).toEqual({ outcome: 'idempotency_conflict' });
			} finally {
				fixture.sqlite.close();
			}
		});

		it('reports an unknown grant opaquely', async () => {
			const fixture: Fixture = await createFixture();
			try {
				expect(
					await fixture.store.revokeApiKeyOrganizationGrant(
						revokeCommand({ grantId: THIRD_GRANT_ID })
					)
				).toEqual({ outcome: 'not_found' });
			} finally {
				fixture.sqlite.close();
			}
		});

		it('reports a grant that belongs to a different key opaquely', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				expect(
					await fixture.store.revokeApiKeyOrganizationGrant(
						revokeCommand({ apiKeyId: OTHER_KEY_ID })
					)
				).toEqual({ outcome: 'not_found' });
			} finally {
				fixture.sqlite.close();
			}
		});

		it('serializes concurrent revocations of the same grant', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				const results: RevokeApiKeyOrganizationGrantStoreResult[] = await Promise.all([
					fixture.store.revokeApiKeyOrganizationGrant(revokeCommand()),
					fixture.store.revokeApiKeyOrganizationGrant(
						revokeCommand({
							idempotencyKey: 'revoke-2',
							requestFingerprint: OTHER_REQUEST_HASH,
							revokedAt: LATER
						})
					)
				]);

				expect(results.map((result) => result.outcome).sort()).toEqual([
					'already_revoked',
					'revoked'
				]);
				expect(countRows(fixture.sqlite, 'api_key_organization_grant_revoke_command')).toBe(1);
			} finally {
				fixture.sqlite.close();
			}
		});

		it('revokes a grant whose key has since expired', async () => {
			const fixture: Fixture = await createFixture();
			try {
				await fixture.store.grantApiKeyOrganization(grantCommand());
				fixture.sqlite.exec(`UPDATE api_key SET revoked_at = '${LATER}' WHERE id = '${KEY_ID}'`);

				// Retiring a grant on a dead key is harmless and must never be blocked.
				expect((await fixture.store.revokeApiKeyOrganizationGrant(revokeCommand())).outcome).toBe(
					'revoked'
				);
			} finally {
				fixture.sqlite.close();
			}
		});
	});
});
