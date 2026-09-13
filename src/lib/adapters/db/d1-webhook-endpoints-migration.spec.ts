import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	applyD1MigrationInTransaction,
	applyD1Migrations,
	applyD1MigrationsThrough,
	d1MigrationPaths
} from './sqlite-d1-test-support';

const ORGANIZATION_ID: string = 'org-1';
const OTHER_ORGANIZATION_ID: string = 'org-2';
const ACTOR_ID: string = 'user-1';
const VALID_UUIDV7_1: string = '01900000-0000-7000-8000-000000000001';
const VALID_UUIDV7_2: string = '01900000-0000-7000-8000-000000000002';
const VALID_SHA256: string = 'a'.repeat(64);
const VALID_PLAINTEXT_SECRET: string = 'skwh1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const VALID_SEALED_SECRET: string =
	'skwhs1_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' + 'B'.repeat(50);
const VALID_PREFIX: string = 'skwh1_abcdefgh';
const NOW: string = '2026-09-13T00:00:00.000Z';

const OLD_0030_SQL: string = `
CREATE TABLE webhook_endpoint (
  id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  events_json TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  secret_prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_user_id TEXT,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id) REFERENCES organization(id),
  CONSTRAINT webhook_endpoint_id_uuidv7 CHECK (
    id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  CONSTRAINT webhook_endpoint_status_known CHECK (status IN ('active', 'revoked')),
  CONSTRAINT webhook_endpoint_url_https CHECK (
    length(url) BETWEEN 12 AND 2000
    AND url GLOB 'https://*'
  ),
  CONSTRAINT webhook_endpoint_secret_hash_sha256 CHECK (
    length(secret_hash) = 64 AND secret_hash GLOB '[0-9a-f]*'
  ),
  CONSTRAINT webhook_endpoint_terminal_exclusive CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_by_user_id IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL)
  )
);

CREATE INDEX webhook_endpoint_org_created
  ON webhook_endpoint(organization_id, created_at DESC, id DESC);

CREATE TABLE webhook_endpoint_command (
  organization_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, actor_id, idempotency_key),
  UNIQUE (organization_id, webhook_id, command_type),
  FOREIGN KEY (organization_id, webhook_id) REFERENCES webhook_endpoint(organization_id, id),
  CONSTRAINT webhook_endpoint_command_type_known CHECK (command_type IN ('create', 'revoke'))
);
`;

function setupDatabase(): DatabaseSync {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	sqlite.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${ORGANIZATION_ID}', '${ORGANIZATION_ID}', 'Org 1', '${NOW}');
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${OTHER_ORGANIZATION_ID}', '${OTHER_ORGANIZATION_ID}', 'Org 2', '${NOW}');
	`);
	return sqlite;
}

function insertEndpoint(
	sqlite: DatabaseSync,
	overrides: {
		id?: string;
		organizationId?: string;
		url?: string;
		status?: string;
		secretHash?: string;
		signingSecret?: string;
		secretPrefix?: string;
	} = {}
): void {
	sqlite
		.prepare(
			`INSERT INTO webhook_endpoint (
				id, organization_id, url, description, status, events_json,
				secret_hash, signing_secret, secret_prefix, created_at, created_by_user_id
			) VALUES (?, ?, ?, NULL, ?, '["envelope.completed"]', ?, ?, ?, ?, ?)`
		)
		.run(
			overrides.id ?? VALID_UUIDV7_1,
			overrides.organizationId ?? ORGANIZATION_ID,
			overrides.url ?? 'https://hooks.example.com/signkit',
			overrides.status ?? 'active',
			overrides.secretHash ?? VALID_SHA256,
			overrides.signingSecret ?? VALID_PLAINTEXT_SECRET,
			overrides.secretPrefix ?? VALID_PREFIX,
			NOW,
			ACTOR_ID
		);
}

function insertCommand(
	sqlite: DatabaseSync,
	overrides: {
		organizationId?: string;
		actorId?: string;
		idempotencyKey?: string;
		commandType?: string;
		requestHash?: string;
		webhookId?: string;
	} = {}
): void {
	sqlite
		.prepare(
			`INSERT INTO webhook_endpoint_command (
				organization_id, actor_id, idempotency_key, command_type, request_hash, webhook_id, occurred_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			overrides.organizationId ?? ORGANIZATION_ID,
			overrides.actorId ?? ACTOR_ID,
			overrides.idempotencyKey ?? 'idemp-1',
			overrides.commandType ?? 'create',
			overrides.requestHash ?? VALID_SHA256,
			overrides.webhookId ?? VALID_UUIDV7_1,
			NOW
		);
}

function setupUpgradedDatabase(options: { seedRows?: boolean } = {}): DatabaseSync {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1MigrationsThrough(sqlite, 'migrations/d1/0025_envelope_field_geometry.sql');
	sqlite.exec(OLD_0030_SQL);

	const paths = d1MigrationPaths();
	const from31 = paths.slice(
		paths.indexOf('migrations/d1/0031_webhook_outbox.sql'),
		paths.indexOf('migrations/d1/0040_webhook_outbox_retryable.sql') + 1
	);
	for (const path of from31) {
		sqlite.exec(readFileSync(path, 'utf8'));
	}

	sqlite.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${ORGANIZATION_ID}', '${ORGANIZATION_ID}', 'Org 1', '${NOW}');
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${OTHER_ORGANIZATION_ID}', '${OTHER_ORGANIZATION_ID}', 'Org 2', '${NOW}');
	`);

	if (options.seedRows) {
		insertEndpoint(sqlite, { id: VALID_UUIDV7_1 });
		insertCommand(sqlite, { webhookId: VALID_UUIDV7_1 });
		const auditId = '01900000-0000-7000-8000-000000000088';
		sqlite.exec(`
			INSERT INTO envelope (id, organization_id, title, status, repository_generation, created_at, updated_at)
			VALUES ('01900000-0000-7000-8000-000000000099', '${ORGANIZATION_ID}', 'Env', 'draft', 0, '${NOW}', '${NOW}');
			INSERT INTO audit_event (id, organization_id, envelope_id, event_type, sequence, actor_type, actor_id, occurred_at, payload_json, hash_version, previous_hash, event_hash)
			VALUES ('${auditId}', '${ORGANIZATION_ID}', '01900000-0000-7000-8000-000000000099', 'envelope.completed', 1, 'user', '${ACTOR_ID}', '${NOW}', '{}', 2, '${'0'.repeat(64)}', '${'1'.repeat(64)}');
			INSERT INTO webhook_delivery_log (id, organization_id, endpoint_id, audit_event_id, event_type, status, attempt, http_status, occurred_at)
			VALUES ('log-1', '${ORGANIZATION_ID}', '${VALID_UUIDV7_1}', '${auditId}', 'envelope.completed', 'delivered', 1, 200, '${NOW}');
		`);
	}

	applyD1MigrationInTransaction(sqlite, 'migrations/d1/0041_webhook_endpoint_parity_upgrade.sql');

	return sqlite;
}

describe('D1 webhook endpoints schema and migration parity', () => {
	it('places webhook migrations in canonical order', () => {
		const paths = d1MigrationPaths();
		expect(paths).toContain('migrations/d1/0030_webhook_endpoints.sql');
		const index0030 = paths.indexOf('migrations/d1/0030_webhook_endpoints.sql');
		const index0031 = paths.indexOf('migrations/d1/0031_webhook_outbox.sql');
		const index0039 = paths.indexOf('migrations/d1/0039_webhook_signing_secret_seal.sql');
		const index0040 = paths.indexOf('migrations/d1/0040_webhook_outbox_retryable.sql');
		const index0041 = paths.indexOf('migrations/d1/0041_webhook_endpoint_parity_upgrade.sql');
		expect(index0030).toBeLessThan(index0031);
		expect(index0031).toBeLessThan(index0039);
		expect(index0039).toBeLessThan(index0040);
		expect(index0040).toBeLessThan(index0041);
	});

	describe('fresh full-chain schema', () => {
		describe('signing_secret bounds', () => {
			it('accepts plaintext skwh1_ (~49 chars) and sealed skwhs1_ (~110 chars) secrets', () => {
				const sqlite = setupDatabase();
				expect(() =>
					insertEndpoint(sqlite, { id: VALID_UUIDV7_1, signingSecret: VALID_PLAINTEXT_SECRET })
				).not.toThrow();
				expect(() =>
					insertEndpoint(sqlite, { id: VALID_UUIDV7_2, signingSecret: VALID_SEALED_SECRET })
				).not.toThrow();
			});

			it('rejects secrets shorter than 20 characters', () => {
				const sqlite = setupDatabase();
				expect(() => insertEndpoint(sqlite, { signingSecret: 'short_secret' })).toThrow(
					/CHECK constraint failed/
				);
			});

			it('rejects secrets longer than 200 characters', () => {
				const sqlite = setupDatabase();
				expect(() => insertEndpoint(sqlite, { signingSecret: 's'.repeat(201) })).toThrow(
					/CHECK constraint failed/
				);
			});
		});

		describe('secret_prefix bounds', () => {
			it('accepts prefix between 1 and 32 characters', () => {
				const sqlite = setupDatabase();
				expect(() => insertEndpoint(sqlite, { secretPrefix: 's' })).not.toThrow();
				expect(() =>
					insertEndpoint(sqlite, { id: VALID_UUIDV7_2, secretPrefix: 'p'.repeat(32) })
				).not.toThrow();
			});

			it('rejects empty secret_prefix', () => {
				const sqlite = setupDatabase();
				expect(() => insertEndpoint(sqlite, { secretPrefix: '' })).toThrow(
					/CHECK constraint failed/
				);
			});

			it('rejects secret_prefix longer than 32 characters', () => {
				const sqlite = setupDatabase();
				expect(() => insertEndpoint(sqlite, { secretPrefix: 'p'.repeat(33) })).toThrow(
					/CHECK constraint failed/
				);
			});
		});

		describe('secret_hash format', () => {
			it('accepts lowercase 64-hex SHA-256 hash', () => {
				const sqlite = setupDatabase();
				expect(() =>
					insertEndpoint(sqlite, { secretHash: '0123456789abcdef'.repeat(4) })
				).not.toThrow();
			});

			it('rejects hashes with non-hex or uppercase characters (including weak-GLOB regression)', () => {
				const sqlite = setupDatabase();
				expect(() =>
					insertEndpoint(sqlite, { id: VALID_UUIDV7_1, secretHash: '0' + 'z'.repeat(63) })
				).toThrow(/CHECK constraint failed/);
				expect(() =>
					insertEndpoint(sqlite, { id: VALID_UUIDV7_1, secretHash: 'A'.repeat(64) })
				).toThrow(/CHECK constraint failed/);
				expect(() =>
					insertEndpoint(sqlite, { id: VALID_UUIDV7_1, secretHash: 'g'.repeat(64) })
				).toThrow(/CHECK constraint failed/);
			});

			it('rejects hashes with length != 64', () => {
				const sqlite = setupDatabase();
				expect(() =>
					insertEndpoint(sqlite, { id: VALID_UUIDV7_1, secretHash: 'a'.repeat(63) })
				).toThrow(/CHECK constraint failed/);
				expect(() =>
					insertEndpoint(sqlite, { id: VALID_UUIDV7_1, secretHash: 'a'.repeat(65) })
				).toThrow(/CHECK constraint failed/);
			});
		});

		describe('webhook_endpoint_command request_hash format', () => {
			it('accepts 64-hex SHA-256 request hash', () => {
				const sqlite = setupDatabase();
				insertEndpoint(sqlite);
				expect(() =>
					insertCommand(sqlite, { requestHash: '0123456789abcdef'.repeat(4) })
				).not.toThrow();
			});

			it('rejects request_hash with non-hex, uppercase, or invalid length', () => {
				const sqlite = setupDatabase();
				insertEndpoint(sqlite);
				expect(() => insertCommand(sqlite, { requestHash: '0' + 'z'.repeat(63) })).toThrow(
					/CHECK constraint failed/
				);
				expect(() => insertCommand(sqlite, { requestHash: 'A'.repeat(64) })).toThrow(
					/CHECK constraint failed/
				);
				expect(() => insertCommand(sqlite, { requestHash: 'a'.repeat(63) })).toThrow(
					/CHECK constraint failed/
				);
			});
		});

		describe('webhook_endpoint_active_cap_guard trigger', () => {
			it('allows up to 20 active endpoints and rejects the 21st with the abort message', () => {
				const sqlite = setupDatabase();
				for (let i = 0; i < 20; i++) {
					const hex = i.toString(16).padStart(4, '0');
					const id = `01900000-0000-7000-8000-00000000${hex}`;
					insertEndpoint(sqlite, { id });
				}
				const count = sqlite
					.prepare(
						'SELECT COUNT(*) AS n FROM webhook_endpoint WHERE organization_id = ? AND status = ?'
					)
					.get(ORGANIZATION_ID, 'active') as { n: number };
				expect(count.n).toBe(20);

				const id21 = '01900000-0000-7000-8000-000000000021';
				expect(() => insertEndpoint(sqlite, { id: id21 })).toThrow(
					/organization active webhook endpoint limit exceeded/
				);
			});

			it('allows inserting revoked endpoints beyond the 20 active limit', () => {
				const sqlite = setupDatabase();
				for (let i = 0; i < 20; i++) {
					const hex = i.toString(16).padStart(4, '0');
					insertEndpoint(sqlite, { id: `01900000-0000-7000-8000-00000000${hex}` });
				}
				const revokedId = '01900000-0000-7000-8000-000000000099';
				expect(() =>
					sqlite
						.prepare(
							`INSERT INTO webhook_endpoint (
								id, organization_id, url, description, status, events_json,
								secret_hash, signing_secret, secret_prefix, created_at, created_by_user_id,
								revoked_at, revoked_by_user_id
							) VALUES (?, ?, 'https://hooks.example.com/signkit', NULL, 'revoked', '["envelope.completed"]',
								?, ?, ?, ?, ?, ?, ?)`
						)
						.run(
							revokedId,
							ORGANIZATION_ID,
							VALID_SHA256,
							VALID_PLAINTEXT_SECRET,
							VALID_PREFIX,
							NOW,
							ACTOR_ID,
							NOW,
							ACTOR_ID
						)
				).not.toThrow();
			});

			it('enforces the cap independently per organization', () => {
				const sqlite = setupDatabase();
				for (let i = 0; i < 20; i++) {
					const hex = i.toString(16).padStart(4, '0');
					insertEndpoint(sqlite, {
						id: `01900000-0000-7000-8000-00000000${hex}`,
						organizationId: ORGANIZATION_ID
					});
				}
				const otherId = '01900000-0000-7000-8000-000000010001';
				expect(() =>
					insertEndpoint(sqlite, { id: otherId, organizationId: OTHER_ORGANIZATION_ID })
				).not.toThrow();
			});

			it('prevents updating a revoked endpoint to active if 20 active endpoints exist', () => {
				const sqlite = setupDatabase();
				for (let i = 0; i < 19; i++) {
					const hex = i.toString(16).padStart(4, '0');
					insertEndpoint(sqlite, { id: `01900000-0000-7000-8000-00000000${hex}` });
				}
				const revokedId = '01900000-0000-7000-8000-000000000099';
				sqlite
					.prepare(
						`INSERT INTO webhook_endpoint (
							id, organization_id, url, description, status, events_json,
							secret_hash, signing_secret, secret_prefix, created_at, created_by_user_id,
							revoked_at, revoked_by_user_id
						) VALUES (?, ?, 'https://hooks.example.com/signkit', NULL, 'revoked', '["envelope.completed"]',
							?, ?, ?, ?, ?, ?, ?)`
					)
					.run(
						revokedId,
						ORGANIZATION_ID,
						VALID_SHA256,
						VALID_PLAINTEXT_SECRET,
						VALID_PREFIX,
						NOW,
						ACTOR_ID,
						NOW,
						ACTOR_ID
					);
				insertEndpoint(sqlite, { id: '01900000-0000-7000-8000-000000000020' });

				expect(() =>
					sqlite
						.prepare(
							`UPDATE webhook_endpoint SET status = 'active', revoked_at = NULL, revoked_by_user_id = NULL
							 WHERE organization_id = ? AND id = ?`
						)
						.run(ORGANIZATION_ID, revokedId)
				).toThrow(/organization active webhook endpoint limit exceeded/);
			});
		});
	});

	describe('upgrade from old 0030 state', () => {
		it('preserves existing rows, foreign keys, and indexes when upgrading', () => {
			const sqlite = setupUpgradedDatabase({ seedRows: true });
			try {
				const endpoint = sqlite
					.prepare('SELECT id, status, secret_prefix FROM webhook_endpoint WHERE id = ?')
					.get(VALID_UUIDV7_1) as { id: string; status: string; secret_prefix: string };
				expect(endpoint).toEqual({
					id: VALID_UUIDV7_1,
					status: 'active',
					secret_prefix: VALID_PREFIX
				});

				const command = sqlite
					.prepare(
						'SELECT command_type, request_hash FROM webhook_endpoint_command WHERE webhook_id = ?'
					)
					.get(VALID_UUIDV7_1) as { command_type: string; request_hash: string };
				expect(command).toEqual({
					command_type: 'create',
					request_hash: VALID_SHA256
				});

				const outbox = sqlite
					.prepare(
						'SELECT endpoint_id, status, retryable FROM webhook_outbox WHERE endpoint_id = ?'
					)
					.get(VALID_UUIDV7_1) as { endpoint_id: string; status: string; retryable: number };
				expect(outbox).toEqual({
					endpoint_id: VALID_UUIDV7_1,
					status: 'pending',
					retryable: 1
				});

				const log = sqlite
					.prepare('SELECT endpoint_id, status FROM webhook_delivery_log WHERE id = ?')
					.get('log-1') as { endpoint_id: string; status: string };
				expect(log).toEqual({
					endpoint_id: VALID_UUIDV7_1,
					status: 'delivered'
				});

				const fkViolations = sqlite.prepare('PRAGMA foreign_key_check').all();
				expect(fkViolations).toEqual([]);
			} finally {
				sqlite.close();
			}
		});

		it('enforces signing_secret length bounds after upgrade', () => {
			const sqlite = setupUpgradedDatabase();
			try {
				expect(() =>
					insertEndpoint(sqlite, { id: VALID_UUIDV7_1, signingSecret: VALID_SEALED_SECRET })
				).not.toThrow();
				expect(() =>
					insertEndpoint(sqlite, { id: VALID_UUIDV7_2, signingSecret: 'short_secret' })
				).toThrow(/CHECK constraint failed/);
				expect(() =>
					insertEndpoint(sqlite, { id: VALID_UUIDV7_2, signingSecret: 's'.repeat(201) })
				).toThrow(/CHECK constraint failed/);
			} finally {
				sqlite.close();
			}
		});

		it('enforces secret_prefix length bounds after upgrade', () => {
			const sqlite = setupUpgradedDatabase();
			try {
				expect(() =>
					insertEndpoint(sqlite, { id: VALID_UUIDV7_1, secretPrefix: 'p'.repeat(32) })
				).not.toThrow();
				expect(() => insertEndpoint(sqlite, { id: VALID_UUIDV7_2, secretPrefix: '' })).toThrow(
					/CHECK constraint failed/
				);
				expect(() =>
					insertEndpoint(sqlite, { id: VALID_UUIDV7_2, secretPrefix: 'p'.repeat(33) })
				).toThrow(/CHECK constraint failed/);
			} finally {
				sqlite.close();
			}
		});

		it('enforces secret_hash strict hex and length after upgrade', () => {
			const sqlite = setupUpgradedDatabase();
			try {
				expect(() =>
					insertEndpoint(sqlite, { id: VALID_UUIDV7_1, secretHash: '0' + 'z'.repeat(63) })
				).toThrow(/CHECK constraint failed/);
				expect(() =>
					insertEndpoint(sqlite, { id: VALID_UUIDV7_1, secretHash: 'A'.repeat(64) })
				).toThrow(/CHECK constraint failed/);
				expect(() =>
					insertEndpoint(sqlite, { id: VALID_UUIDV7_1, secretHash: 'a'.repeat(63) })
				).toThrow(/CHECK constraint failed/);
			} finally {
				sqlite.close();
			}
		});

		it('enforces webhook_endpoint_command request_hash strict hex after upgrade', () => {
			const sqlite = setupUpgradedDatabase();
			try {
				insertEndpoint(sqlite);
				expect(() =>
					insertCommand(sqlite, { requestHash: '0123456789abcdef'.repeat(4) })
				).not.toThrow();
				expect(() => insertCommand(sqlite, { requestHash: '0' + 'z'.repeat(63) })).toThrow(
					/CHECK constraint failed/
				);
				expect(() => insertCommand(sqlite, { requestHash: 'A'.repeat(64) })).toThrow(
					/CHECK constraint failed/
				);
			} finally {
				sqlite.close();
			}
		});

		it('enforces active endpoint cap (20) on insert and update after upgrade', () => {
			const sqlite = setupUpgradedDatabase();
			try {
				for (let i = 0; i < 20; i++) {
					const hex = i.toString(16).padStart(4, '0');
					insertEndpoint(sqlite, { id: `01900000-0000-7000-8000-00000000${hex}` });
				}
				const id21 = '01900000-0000-7000-8000-000000000021';
				expect(() => insertEndpoint(sqlite, { id: id21 })).toThrow(
					/organization active webhook endpoint limit exceeded/
				);

				const revokedId = '01900000-0000-7000-8000-000000000099';
				sqlite
					.prepare(
						`INSERT INTO webhook_endpoint (
							id, organization_id, url, description, status, events_json,
							secret_hash, signing_secret, secret_prefix, created_at, created_by_user_id,
							revoked_at, revoked_by_user_id
						) VALUES (?, ?, 'https://hooks.example.com/signkit', NULL, 'revoked', '["envelope.completed"]',
							?, ?, ?, ?, ?, ?, ?)`
					)
					.run(
						revokedId,
						ORGANIZATION_ID,
						VALID_SHA256,
						VALID_PLAINTEXT_SECRET,
						VALID_PREFIX,
						NOW,
						ACTOR_ID,
						NOW,
						ACTOR_ID
					);

				expect(() =>
					sqlite
						.prepare(
							`UPDATE webhook_endpoint SET status = 'active', revoked_at = NULL, revoked_by_user_id = NULL
							 WHERE organization_id = ? AND id = ?`
						)
						.run(ORGANIZATION_ID, revokedId)
				).toThrow(/organization active webhook endpoint limit exceeded/);
			} finally {
				sqlite.close();
			}
		});

		it('rejects upgrading a database with pre-existing invalid webhook_endpoint rows', () => {
			const sqlite: DatabaseSync = new DatabaseSync(':memory:');
			try {
				applyD1MigrationsThrough(sqlite, 'migrations/d1/0025_envelope_field_geometry.sql');
				sqlite.exec(OLD_0030_SQL);
				const paths = d1MigrationPaths();
				const from31 = paths.slice(
					paths.indexOf('migrations/d1/0031_webhook_outbox.sql'),
					paths.indexOf('migrations/d1/0040_webhook_outbox_retryable.sql') + 1
				);
				for (const path of from31) {
					sqlite.exec(readFileSync(path, 'utf8'));
				}
				sqlite.exec(`
					INSERT INTO organization (id, d6e_organization_id, name, created_at)
					VALUES ('${ORGANIZATION_ID}', '${ORGANIZATION_ID}', 'Org 1', '${NOW}');
				`);
				// Insert invalid row permitted by old 0030: weak secret_hash with 'z'
				sqlite
					.prepare(
						`INSERT INTO webhook_endpoint (
							id, organization_id, url, description, status, events_json,
							secret_hash, signing_secret, secret_prefix, created_at, created_by_user_id
						) VALUES (?, ?, 'https://hooks.example.com/signkit', NULL, 'active', '["envelope.completed"]',
							?, ?, 'prefix', ?, ?)`
					)
					.run(
						VALID_UUIDV7_1,
						ORGANIZATION_ID,
						'0' + 'z'.repeat(63),
						VALID_PLAINTEXT_SECRET,
						NOW,
						ACTOR_ID
					);

				expect(() =>
					applyD1MigrationInTransaction(
						sqlite,
						'migrations/d1/0041_webhook_endpoint_parity_upgrade.sql'
					)
				).toThrow(/malformed JSON/);
			} finally {
				sqlite.close();
			}
		});

		it('rejects upgrading a database with an organization that already exceeds 20 active endpoints', () => {
			const sqlite: DatabaseSync = new DatabaseSync(':memory:');
			try {
				applyD1MigrationsThrough(sqlite, 'migrations/d1/0025_envelope_field_geometry.sql');
				sqlite.exec(OLD_0030_SQL);
				const paths = d1MigrationPaths();
				const from31 = paths.slice(
					paths.indexOf('migrations/d1/0031_webhook_outbox.sql'),
					paths.indexOf('migrations/d1/0040_webhook_outbox_retryable.sql') + 1
				);
				for (const path of from31) {
					sqlite.exec(readFileSync(path, 'utf8'));
				}
				sqlite.exec(`
					INSERT INTO organization (id, d6e_organization_id, name, created_at)
					VALUES ('${ORGANIZATION_ID}', '${ORGANIZATION_ID}', 'Org 1', '${NOW}');
				`);
				// Insert 21 active endpoints permitted by old 0030 (no cap guard)
				for (let i = 0; i < 21; i++) {
					const hex = i.toString(16).padStart(4, '0');
					sqlite
						.prepare(
							`INSERT INTO webhook_endpoint (
								id, organization_id, url, description, status, events_json,
								secret_hash, signing_secret, secret_prefix, created_at, created_by_user_id
							) VALUES (?, ?, 'https://hooks.example.com/signkit', NULL, 'active', '["envelope.completed"]',
								?, ?, 'prefix', ?, ?)`
						)
						.run(
							`01900000-0000-7000-8000-00000000${hex}`,
							ORGANIZATION_ID,
							VALID_SHA256,
							VALID_PLAINTEXT_SECRET,
							NOW,
							ACTOR_ID
						);
				}

				expect(() =>
					applyD1MigrationInTransaction(
						sqlite,
						'migrations/d1/0041_webhook_endpoint_parity_upgrade.sql'
					)
				).toThrow(/malformed JSON/);
			} finally {
				sqlite.close();
			}
		});
	});
});
