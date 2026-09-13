import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyD1MigrationsThrough } from './sqlite-d1-test-support';

const BEFORE_SCOPE_MIGRATION: string = 'migrations/d1/0011_delivery_outbox_leases.sql';
const SCOPE_MIGRATION: string = 'migrations/d1/0012_delivery_outbox_recipient_scope.sql';

function database(
	recipientId: '01930000-0000-7000-8000-00000000000a' | '01930000-0000-7000-8000-00000000000b'
): DatabaseSync {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1MigrationsThrough(sqlite, BEFORE_SCOPE_MIGRATION);
	sqlite.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('org-1','org-1','Workspace','2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			sent_commit_sha, created_at, updated_at
		) VALUES
			('01920000-0000-7000-8000-00000000000a','org-1','A','sent',1,'commit-a','commit-a','2026-09-11T00:00:00.000Z','2026-09-11T00:01:00.000Z'),
			('01920000-0000-7000-8000-00000000000b','org-1','B','sent',1,'commit-b','commit-b','2026-09-11T00:00:00.000Z','2026-09-11T00:01:00.000Z');
		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			capability_hash, capability_expires_at, created_at, updated_at
		) VALUES
			('01930000-0000-7000-8000-00000000000a','org-1','01920000-0000-7000-8000-00000000000a','a@example.com','A','signer','en',1,'pending','hash-a','2026-09-25T00:00:00.000Z','2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'),
			('01930000-0000-7000-8000-00000000000b','org-1','01920000-0000-7000-8000-00000000000b','b@example.com','B','signer','en',1,'pending','hash-b','2026-09-25T00:00:00.000Z','2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z');
		INSERT INTO delivery_outbox (
			id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
			reserved_capability_expires_at, sealed_capability, sealing_key_id,
			sealed_capability_sha256, available_at, attempts, created_at, updated_at,
			claim_token, retryable
		) VALUES (
			'01940000-0000-7000-8000-00000000000a','org-1','01920000-0000-7000-8000-00000000000a','${recipientId}','recipient_invitation','pending',
			'hash-a','2026-09-25T00:00:00.000Z','sealed-a','key-1','sealed-hash-a',
			'2026-09-11T00:01:00.000Z',0,'2026-09-11T00:01:00.000Z',
			'2026-09-11T00:01:00.000Z',NULL,1
		);
	`);
	return sqlite;
}

function seedAdditionalValidStates(sqlite: DatabaseSync): void {
	sqlite.exec(`
		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			capability_hash, capability_expires_at, created_at, updated_at
		) VALUES
			('01930000-0000-7000-8000-0000000000e1','org-1','01920000-0000-7000-8000-00000000000a','blocked@example.com','Blocked','signer','en',2,'pending','hash-blocked',NULL,'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'),
			('01930000-0000-7000-8000-0000000000e4','org-1','01920000-0000-7000-8000-00000000000a','processing@example.com','Processing','signer','en',3,'pending','hash-processing','2026-09-25T00:00:00.000Z','2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'),
			('01930000-0000-7000-8000-0000000000e3','org-1','01920000-0000-7000-8000-00000000000a','failed@example.com','Failed','signer','en',4,'pending','hash-failed','2026-09-25T00:00:00.000Z','2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'),
			('01930000-0000-7000-8000-0000000000e2','org-1','01920000-0000-7000-8000-00000000000a','delivered@example.com','Delivered','signer','en',5,'pending','hash-delivered','2026-09-25T00:00:00.000Z','2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z');
		INSERT INTO delivery_outbox (
			id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
			reserved_capability_expires_at, sealed_capability, sealing_key_id,
			sealed_capability_sha256, available_at, attempts, locked_at, delivered_at,
			provider_message_id, last_error, created_at, updated_at, claim_token, retryable
		) VALUES
			('01940000-0000-7000-8000-0000000000e1','org-1','01920000-0000-7000-8000-00000000000a','01930000-0000-7000-8000-0000000000e1','recipient_invitation','blocked','hash-blocked',NULL,'sealed-blocked','key-1','sealed-hash-blocked',NULL,0,NULL,NULL,NULL,NULL,'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z',NULL,1),
			('01940000-0000-7000-8000-0000000000e4','org-1','01920000-0000-7000-8000-00000000000a','01930000-0000-7000-8000-0000000000e4','recipient_invitation','processing','hash-processing','2026-09-25T00:00:00.000Z','sealed-processing','key-1','sealed-hash-processing','2026-09-11T00:01:00.000Z',1,'2026-09-11T00:02:00.000Z',NULL,NULL,NULL,'2026-09-11T00:01:00.000Z','2026-09-11T00:02:00.000Z','claim-token-0001',1),
			('01940000-0000-7000-8000-0000000000e3','org-1','01920000-0000-7000-8000-00000000000a','01930000-0000-7000-8000-0000000000e3','recipient_invitation','failed','hash-failed','2026-09-25T00:00:00.000Z','sealed-failed','key-1','sealed-hash-failed','2026-09-11T00:01:00.000Z',1,NULL,NULL,NULL,'transient','2026-09-11T00:01:00.000Z','2026-09-11T00:02:00.000Z',NULL,1),
			('01940000-0000-7000-8000-0000000000e2','org-1','01920000-0000-7000-8000-00000000000a','01930000-0000-7000-8000-0000000000e2','recipient_invitation','delivered','hash-delivered','2026-09-25T00:00:00.000Z',NULL,'key-1','sealed-hash-delivered','2026-09-11T00:01:00.000Z',1,NULL,'2026-09-11T00:03:00.000Z','provider-id',NULL,'2026-09-11T00:01:00.000Z','2026-09-11T00:03:00.000Z',NULL,0);
	`);
}

describe('D1 delivery outbox recipient-scope migration', () => {
	it('preserves valid rows and rejects same-tenant cross-envelope inserts and updates', () => {
		const sqlite: DatabaseSync = database('01930000-0000-7000-8000-00000000000a');
		try {
			seedAdditionalValidStates(sqlite);
			sqlite.exec(readFileSync(SCOPE_MIGRATION, 'utf8'));
			const statuses = sqlite
				.prepare(
					'SELECT status, COUNT(*) AS count FROM delivery_outbox GROUP BY status ORDER BY status'
				)
				.all();
			expect(statuses).toEqual([
				{ status: 'blocked', count: 1 },
				{ status: 'delivered', count: 1 },
				{ status: 'failed', count: 1 },
				{ status: 'pending', count: 1 },
				{ status: 'processing', count: 1 }
			]);
			expect((): void =>
				sqlite.exec(`INSERT INTO delivery_outbox (
					id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
					reserved_capability_expires_at, sealed_capability, sealing_key_id,
					sealed_capability_sha256, available_at, attempts, created_at, updated_at,
					claim_token, retryable
				) VALUES (
					'01940000-0000-7000-8000-00000000000b','org-1','01920000-0000-7000-8000-00000000000a','01930000-0000-7000-8000-00000000000b','recipient_invitation','pending',
					'hash-b','2026-09-25T00:00:00.000Z','sealed-b','key-1','sealed-hash-b',
					'2026-09-11T00:01:00.000Z',0,'2026-09-11T00:01:00.000Z',
					'2026-09-11T00:01:00.000Z',NULL,1
				)`)
			).toThrow(/invalid delivery recipient scope/);
			expect((): void =>
				sqlite.exec(
					"UPDATE delivery_outbox SET recipient_id='01930000-0000-7000-8000-00000000000b' WHERE id='01940000-0000-7000-8000-00000000000a'"
				)
			).toThrow(/invalid delivery recipient scope/);
			sqlite.exec(`
				INSERT INTO organization (id, d6e_organization_id, name, created_at)
				VALUES ('org-2','org-2','Other','2026-09-11T00:00:00.000Z');
				INSERT INTO envelope (
					id, organization_id, title, status, repository_generation, repository_head,
					sent_commit_sha, created_at, updated_at
				) VALUES (
					'01920000-0000-7000-8000-00000000000c','org-2','C','sent',1,'commit-c','commit-c',
					'2026-09-11T00:00:00.000Z','2026-09-11T00:01:00.000Z'
				);
				INSERT INTO recipient (
					id, organization_id, envelope_id, email, name, role, locale, routing_order,
					status, created_at, updated_at
				) VALUES (
					'01930000-0000-7000-8000-00000000000c','org-2','01920000-0000-7000-8000-00000000000c','c@example.com','C','signer','en',1,'pending',
					'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'
				);
			`);
			expect((): void =>
				sqlite.exec(`INSERT INTO delivery_outbox (
					id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
					reserved_capability_expires_at, sealed_capability, sealing_key_id,
					sealed_capability_sha256, available_at, attempts, created_at, updated_at,
					claim_token, retryable
				) VALUES (
					'01940000-0000-7000-8000-00000000000c','org-1','01920000-0000-7000-8000-00000000000a','01930000-0000-7000-8000-00000000000c','recipient_invitation','blocked',
					'hash-c',NULL,'sealed-c','key-1','sealed-hash-c',NULL,0,
					'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z',NULL,1
				)`)
			).toThrow(/invalid delivery recipient scope|FOREIGN KEY constraint failed/);
			const row = sqlite
				.prepare('SELECT envelope_id, recipient_id FROM delivery_outbox WHERE id = ?')
				.get('01940000-0000-7000-8000-00000000000a');
			expect(row).toEqual({
				envelope_id: '01920000-0000-7000-8000-00000000000a',
				recipient_id: '01930000-0000-7000-8000-00000000000a'
			});
		} finally {
			sqlite.close();
		}
	});

	it('fails closed and can be repaired and retried after a partial D1 migration', () => {
		const sqlite: DatabaseSync = database('01930000-0000-7000-8000-00000000000b');
		try {
			expect((): void => sqlite.exec(readFileSync(SCOPE_MIGRATION, 'utf8'))).toThrow(
				/invalid delivery recipient scope/
			);
			const failedRow = sqlite
				.prepare('SELECT envelope_id, recipient_id FROM delivery_outbox WHERE id = ?')
				.get('01940000-0000-7000-8000-00000000000a');
			expect(failedRow).toEqual({
				envelope_id: '01920000-0000-7000-8000-00000000000a',
				recipient_id: '01930000-0000-7000-8000-00000000000b'
			});
			const installedTriggers = sqlite
				.prepare(
					"SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'delivery_outbox_recipient_scope_%'"
				)
				.get() as { count: number };
			expect(installedTriggers.count).toBe(2);

			sqlite.exec(
				"UPDATE delivery_outbox SET recipient_id='01930000-0000-7000-8000-00000000000a' WHERE id='01940000-0000-7000-8000-00000000000a'"
			);
			expect((): void => sqlite.exec(readFileSync(SCOPE_MIGRATION, 'utf8'))).not.toThrow();
			const repairedRow = sqlite
				.prepare('SELECT envelope_id, recipient_id FROM delivery_outbox WHERE id = ?')
				.get('01940000-0000-7000-8000-00000000000a');
			expect(repairedRow).toEqual({
				envelope_id: '01920000-0000-7000-8000-00000000000a',
				recipient_id: '01930000-0000-7000-8000-00000000000a'
			});
		} finally {
			sqlite.close();
		}
	});
});
