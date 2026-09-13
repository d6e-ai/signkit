import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyD1Migrations, d1MigrationPaths } from './sqlite-d1-test-support';

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

describe('D1 webhook endpoints schema and migration parity', () => {
	it('places webhook migrations in canonical order', () => {
		const paths = d1MigrationPaths();
		expect(paths).toContain('migrations/d1/0030_webhook_endpoints.sql');
		const index0030 = paths.indexOf('migrations/d1/0030_webhook_endpoints.sql');
		const index0031 = paths.indexOf('migrations/d1/0031_webhook_outbox.sql');
		const index0039 = paths.indexOf('migrations/d1/0039_webhook_signing_secret_seal.sql');
		const index0040 = paths.indexOf('migrations/d1/0040_webhook_outbox_retryable.sql');
		expect(index0030).toBeLessThan(index0031);
		expect(index0031).toBeLessThan(index0039);
		expect(index0039).toBeLessThan(index0040);
	});

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
			expect(() => insertEndpoint(sqlite, { secretPrefix: '' })).toThrow(/CHECK constraint failed/);
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
			// Regression: old GLOB '[0-9a-f]*' allowed non-hex after the first character
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
			// Other organization can still insert active endpoints
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
			// Insert 1 revoked endpoint
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
			// Now insert the 20th active endpoint
			insertEndpoint(sqlite, { id: '01900000-0000-7000-8000-000000000020' });

			// Trying to update the revoked endpoint back to active must be rejected by cap guard
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
