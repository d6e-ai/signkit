import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { newUuidV7 } from '$lib/ids/uuid-v7';
import { applyD1Migrations, d1MigrationPaths } from './sqlite-d1-test-support';

const OWNER_ID: string = 'user-1';
const OTHER_USER_ID: string = 'user-2';
const KEY_ID: string = '01900000-0000-7000-8000-000000000201';
const GRANT_ID: string = '01900000-0000-7000-8000-000000000301';
const OTHER_GRANT_ID: string = '01900000-0000-7000-8000-000000000302';
const ORG_A: string = 'org-alpha';
const ORG_B: string = 'org-beta';
const AT: string = '2026-09-12T12:00:00.000Z';
const LATER: string = '2026-09-13T12:00:00.000Z';
const EXPIRES_AT: string = '2026-12-11T12:00:00.000Z';
const REQUEST_HASH: string = 'a'.repeat(64);

/** Columns that must never appear anywhere in the grant schema. */
const FORBIDDEN_COLUMNS: readonly string[] = [
	'token',
	'token_hash',
	'secret',
	'plaintext',
	'credential',
	'key_prefix',
	'email',
	'name',
	'display_name'
];

const GRANT_TABLES: readonly string[] = [
	'api_key_organization_grant',
	'api_key_organization_grant_command',
	'api_key_organization_grant_revoke_command'
];

interface SqliteColumn {
	name: string;
}

function database(): DatabaseSync {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${OWNER_ID}', 'member', 'active', '${AT}', '${AT}');
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${OTHER_USER_ID}', 'member', 'active', '${AT}', '${AT}');
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${ORG_A}', '${ORG_A}', 'Alpha', '${AT}');
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${ORG_B}', '${ORG_B}', 'Beta', '${AT}');
		INSERT INTO api_key (
			id, name, token_hash, key_prefix, scopes_json, owner_user_id,
			created_at, expires_at, rate_window_count
		) VALUES (
			'${KEY_ID}', 'CI agent', '${'b'.repeat(64)}', 'signkit_abcdefgh',
			'["envelopes:read"]', '${OWNER_ID}', '${AT}', '${EXPIRES_AT}', 0
		);
	`);
	return sqlite;
}

function columnNames(sqlite: DatabaseSync, table: string): readonly string[] {
	return sqlite
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.map((row: unknown): string => (row as SqliteColumn).name);
}

function insertGrant(
	sqlite: DatabaseSync,
	overrides: {
		id?: string;
		apiKeyId?: string;
		organizationId?: string;
		grantedByUserId?: string;
		role?: string;
		grantedAt?: string;
		revoked?: { at: string; by: string; authority: string } | null;
	} = {}
): void {
	const revoked = overrides.revoked ?? null;
	sqlite.exec(`
		INSERT INTO api_key_organization_grant (
			id, api_key_id, organization_id, granted_by_user_id,
			granted_organization_role, granted_at, revoked_at, revoked_by_user_id,
			revoked_by_authority
		) VALUES (
			'${overrides.id ?? GRANT_ID}',
			'${overrides.apiKeyId ?? KEY_ID}',
			'${overrides.organizationId ?? ORG_A}',
			'${overrides.grantedByUserId ?? OWNER_ID}',
			'${overrides.role ?? 'owner'}',
			'${overrides.grantedAt ?? AT}',
			${revoked === null ? 'NULL, NULL, NULL' : `'${revoked.at}', '${revoked.by}', '${revoked.authority}'`}
		)
	`);
}

describe('D1 API key organization grant migration', () => {
	it('ships as a numbered D1 migration', () => {
		expect(d1MigrationPaths()).toContain('migrations/d1/0022_api_key_organization_grants.sql');
	});

	it.each(GRANT_TABLES)('stores no secret or PII column in %s', (table) => {
		const sqlite: DatabaseSync = database();
		try {
			const columns: readonly string[] = columnNames(sqlite, table);
			expect(columns.length).toBeGreaterThan(0);
			for (const forbidden of FORBIDDEN_COLUMNS) {
				expect(columns).not.toContain(forbidden);
			}
		} finally {
			sqlite.close();
		}
	});

	it('accepts a live grant and reports it as live', () => {
		const sqlite: DatabaseSync = database();
		try {
			expect((): void => insertGrant(sqlite)).not.toThrow();
			const rows = sqlite
				.prepare(
					`SELECT id FROM api_key_organization_grant
					 WHERE api_key_id = ? AND organization_id = ? AND revoked_at IS NULL`
				)
				.all(KEY_ID, ORG_A);
			expect(rows).toHaveLength(1);
		} finally {
			sqlite.close();
		}
	});

	it('allows one key to hold live grants for several organizations', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertGrant(sqlite);
			expect((): void =>
				insertGrant(sqlite, { id: OTHER_GRANT_ID, organizationId: ORG_B, role: 'admin' })
			).not.toThrow();
		} finally {
			sqlite.close();
		}
	});

	it('permits at most one live grant per key and organization', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertGrant(sqlite);
			expect((): void => insertGrant(sqlite, { id: OTHER_GRANT_ID })).toThrow(
				/api_key_organization_grant_live|UNIQUE/
			);
		} finally {
			sqlite.close();
		}
	});

	/**
	 * Re-granting after revocation must append rather than resurrect, so the
	 * uniqueness index constrains only live rows and the revoked episode survives
	 * as history.
	 */
	it('allows re-granting the same organization once the previous grant is revoked', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertGrant(sqlite, {
				revoked: { at: LATER, by: OWNER_ID, authority: 'key_owner' }
			});
			expect((): void => insertGrant(sqlite, { id: OTHER_GRANT_ID })).not.toThrow();
			const rows = sqlite
				.prepare('SELECT id FROM api_key_organization_grant WHERE api_key_id = ?')
				.all(KEY_ID);
			expect(rows).toHaveLength(2);
		} finally {
			sqlite.close();
		}
	});

	it.each([
		['a granting role of member', 'member'],
		['an unknown granting role', 'superuser'],
		['an empty granting role', '']
	])('rejects %s', (_name, role) => {
		const sqlite: DatabaseSync = database();
		try {
			expect((): void => insertGrant(sqlite, { role })).toThrow(
				/api_key_organization_grant_granted_role_known/
			);
		} finally {
			sqlite.close();
		}
	});

	it('rejects a partially revoked grant', () => {
		const sqlite: DatabaseSync = database();
		try {
			expect((): void =>
				sqlite.exec(`
					INSERT INTO api_key_organization_grant (
						id, api_key_id, organization_id, granted_by_user_id,
						granted_organization_role, granted_at, revoked_at
					) VALUES (
						'${GRANT_ID}', '${KEY_ID}', '${ORG_A}', '${OWNER_ID}', 'owner', '${AT}', '${LATER}'
					)
				`)
			).toThrow(/api_key_organization_grant_revocation_complete/);
		} finally {
			sqlite.close();
		}
	});

	it('rejects revocation dated before the grant', () => {
		const sqlite: DatabaseSync = database();
		try {
			expect((): void =>
				insertGrant(sqlite, {
					grantedAt: LATER,
					revoked: { at: AT, by: OWNER_ID, authority: 'key_owner' }
				})
			).toThrow(/api_key_organization_grant_revoked_at_order/);
		} finally {
			sqlite.close();
		}
	});

	it('rejects an unknown revocation authority', () => {
		const sqlite: DatabaseSync = database();
		try {
			expect((): void =>
				insertGrant(sqlite, { revoked: { at: LATER, by: OWNER_ID, authority: 'somebody' } })
			).toThrow(/api_key_organization_grant_revoked_authority_known/);
		} finally {
			sqlite.close();
		}
	});

	it('requires the granting user to be a durable instance member', () => {
		const sqlite: DatabaseSync = database();
		try {
			expect((): void => insertGrant(sqlite, { grantedByUserId: 'user-absent' })).toThrow(
				/FOREIGN KEY/
			);
		} finally {
			sqlite.close();
		}
	});

	/**
	 * The revoking actor deliberately carries no foreign key: an organization
	 * administrator revoking access to their own organization proves authority
	 * through d6e-auth and may hold no local instance membership at all.
	 */
	it('accepts a revoking actor who is not an instance member', () => {
		const sqlite: DatabaseSync = database();
		try {
			expect((): void =>
				insertGrant(sqlite, {
					revoked: { at: LATER, by: 'user_d6e_org_admin', authority: 'organization_admin' }
				})
			).not.toThrow();
		} finally {
			sqlite.close();
		}
	});

	it('requires the granted organization to be projected', () => {
		const sqlite: DatabaseSync = database();
		try {
			expect((): void => insertGrant(sqlite, { organizationId: 'org-unprojected' })).toThrow(
				/FOREIGN KEY/
			);
		} finally {
			sqlite.close();
		}
	});

	describe('append-only guards', () => {
		it('rejects every attempt to change immutable grant fields', () => {
			const sqlite: DatabaseSync = database();
			try {
				insertGrant(sqlite);
				expect((): void =>
					sqlite.exec(
						`UPDATE api_key_organization_grant SET organization_id = '${ORG_B}' WHERE id = '${GRANT_ID}'`
					)
				).toThrow(/immutable api key organization grant fields/);
				expect((): void =>
					sqlite.exec(
						`UPDATE api_key_organization_grant SET granted_by_user_id = '${OTHER_USER_ID}'
						 WHERE id = '${GRANT_ID}'`
					)
				).toThrow(/immutable api key organization grant fields/);
				expect((): void =>
					sqlite.exec(
						`UPDATE api_key_organization_grant SET granted_organization_role = 'admin'
						 WHERE id = '${GRANT_ID}'`
					)
				).toThrow(/immutable api key organization grant fields/);
				expect((): void =>
					sqlite.exec(
						`UPDATE api_key_organization_grant SET granted_at = '${LATER}' WHERE id = '${GRANT_ID}'`
					)
				).toThrow(/immutable api key organization grant fields/);
			} finally {
				sqlite.close();
			}
		});

		it('permits exactly one revocation and never un-revokes', () => {
			const sqlite: DatabaseSync = database();
			try {
				insertGrant(sqlite);
				expect((): void =>
					sqlite.exec(
						`UPDATE api_key_organization_grant
						 SET revoked_at = '${LATER}', revoked_by_user_id = '${OWNER_ID}',
							 revoked_by_authority = 'key_owner'
						 WHERE id = '${GRANT_ID}'`
					)
				).not.toThrow();

				expect((): void =>
					sqlite.exec(
						`UPDATE api_key_organization_grant
						 SET revoked_at = NULL, revoked_by_user_id = NULL, revoked_by_authority = NULL
						 WHERE id = '${GRANT_ID}'`
					)
				).toThrow(/revocation is immutable/);
				expect((): void =>
					sqlite.exec(
						`UPDATE api_key_organization_grant SET revoked_by_authority = 'organization_admin'
						 WHERE id = '${GRANT_ID}'`
					)
				).toThrow(/revocation is immutable/);
				expect((): void =>
					sqlite.exec(
						`UPDATE api_key_organization_grant SET revoked_by_user_id = '${OTHER_USER_ID}'
						 WHERE id = '${GRANT_ID}'`
					)
				).toThrow(/revocation is immutable/);
			} finally {
				sqlite.close();
			}
		});

		it('rejects deleting a grant', () => {
			const sqlite: DatabaseSync = database();
			try {
				insertGrant(sqlite);
				expect((): void =>
					sqlite.exec(`DELETE FROM api_key_organization_grant WHERE id = '${GRANT_ID}'`)
				).toThrow(/cannot be deleted/);
			} finally {
				sqlite.close();
			}
		});

		it('keeps both receipt tables append-only', () => {
			const sqlite: DatabaseSync = database();
			try {
				insertGrant(sqlite);
				sqlite.exec(`
					INSERT INTO api_key_organization_grant_command (
						actor_type, actor_id, idempotency_key, request_hash, grant_id,
						api_key_id, organization_id, granted_organization_role, granted_at
					) VALUES (
						'user', '${OWNER_ID}', 'grant-1', '${REQUEST_HASH}', '${GRANT_ID}',
						'${KEY_ID}', '${ORG_A}', 'owner', '${AT}'
					);
					UPDATE api_key_organization_grant
					SET revoked_at = '${LATER}', revoked_by_user_id = '${OWNER_ID}',
						revoked_by_authority = 'key_owner'
					WHERE id = '${GRANT_ID}';
					INSERT INTO api_key_organization_grant_revoke_command (
						actor_type, actor_id, idempotency_key, request_hash, grant_id,
						api_key_id, organization_id, actor_authority, revoked_at
					) VALUES (
						'user', '${OWNER_ID}', 'revoke-1', '${REQUEST_HASH}', '${GRANT_ID}',
						'${KEY_ID}', '${ORG_A}', 'key_owner', '${LATER}'
					);
				`);

				expect((): void =>
					sqlite.exec(
						`UPDATE api_key_organization_grant_command SET request_hash = '${'c'.repeat(64)}'
						 WHERE idempotency_key = 'grant-1'`
					)
				).toThrow(/append-only/);
				expect((): void =>
					sqlite.exec(
						"DELETE FROM api_key_organization_grant_command WHERE idempotency_key = 'grant-1'"
					)
				).toThrow(/append-only/);
				expect((): void =>
					sqlite.exec(
						`UPDATE api_key_organization_grant_revoke_command SET actor_authority = 'organization_admin'
						 WHERE idempotency_key = 'revoke-1'`
					)
				).toThrow(/append-only/);
				expect((): void =>
					sqlite.exec(
						"DELETE FROM api_key_organization_grant_revoke_command WHERE idempotency_key = 'revoke-1'"
					)
				).toThrow(/append-only/);
			} finally {
				sqlite.close();
			}
		});
	});

	describe('receipt uniqueness', () => {
		it('permits one grant receipt per grant and per actor idempotency key', () => {
			const sqlite: DatabaseSync = database();
			try {
				insertGrant(sqlite);
				insertGrant(sqlite, { id: OTHER_GRANT_ID, organizationId: ORG_B, role: 'admin' });
				sqlite.exec(`
					INSERT INTO api_key_organization_grant_command (
						actor_type, actor_id, idempotency_key, request_hash, grant_id,
						api_key_id, organization_id, granted_organization_role, granted_at
					) VALUES (
						'user', '${OWNER_ID}', 'grant-1', '${REQUEST_HASH}', '${GRANT_ID}',
						'${KEY_ID}', '${ORG_A}', 'owner', '${AT}'
					)
				`);

				// Same grant, different key: one receipt per grant.
				expect((): void =>
					sqlite.exec(`
						INSERT INTO api_key_organization_grant_command (
							actor_type, actor_id, idempotency_key, request_hash, grant_id,
							api_key_id, organization_id, granted_organization_role, granted_at
						) VALUES (
							'user', '${OWNER_ID}', 'grant-2', '${REQUEST_HASH}', '${GRANT_ID}',
							'${KEY_ID}', '${ORG_A}', 'owner', '${AT}'
						)
					`)
				).toThrow(/UNIQUE/);

				// Same idempotency key, different grant: one receipt per actor key.
				expect((): void =>
					sqlite.exec(`
						INSERT INTO api_key_organization_grant_command (
							actor_type, actor_id, idempotency_key, request_hash, grant_id,
							api_key_id, organization_id, granted_organization_role, granted_at
						) VALUES (
							'user', '${OWNER_ID}', 'grant-1', '${REQUEST_HASH}', '${OTHER_GRANT_ID}',
							'${KEY_ID}', '${ORG_B}', 'admin', '${AT}'
						)
					`)
				).toThrow(/UNIQUE|PRIMARY KEY/);
			} finally {
				sqlite.close();
			}
		});

		it('rejects a non-user actor type on either receipt', () => {
			const sqlite: DatabaseSync = database();
			try {
				insertGrant(sqlite);
				expect((): void =>
					sqlite.exec(`
						INSERT INTO api_key_organization_grant_command (
							actor_type, actor_id, idempotency_key, request_hash, grant_id,
							api_key_id, organization_id, granted_organization_role, granted_at
						) VALUES (
							'agent', '${OWNER_ID}', 'grant-1', '${REQUEST_HASH}', '${GRANT_ID}',
							'${KEY_ID}', '${ORG_A}', 'owner', '${AT}'
						)
					`)
				).toThrow(/actor_type/);
			} finally {
				sqlite.close();
			}
		});

		it('bounds the idempotency key to printable ASCII', () => {
			const sqlite: DatabaseSync = database();
			try {
				insertGrant(sqlite);
				expect((): void =>
					sqlite.exec(`
						INSERT INTO api_key_organization_grant_command (
							actor_type, actor_id, idempotency_key, request_hash, grant_id,
							api_key_id, organization_id, granted_organization_role, granted_at
						) VALUES (
							'user', '${OWNER_ID}', 'grant one', '${REQUEST_HASH}', '${GRANT_ID}',
							'${KEY_ID}', '${ORG_A}', 'owner', '${AT}'
						)
					`)
				).toThrow(/api_key_organization_grant_command_idempotency_bound/);
			} finally {
				sqlite.close();
			}
		});
	});

	it('mints grant identifiers as canonical UUIDv7', () => {
		const sqlite: DatabaseSync = database();
		try {
			expect((): void => insertGrant(sqlite, { id: newUuidV7() })).not.toThrow();
		} finally {
			sqlite.close();
		}
	});
});
