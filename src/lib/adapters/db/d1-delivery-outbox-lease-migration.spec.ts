import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const baseMigrationPaths: readonly string[] = [
	'migrations/d1/0001_core.sql',
	'migrations/d1/0002_envelope_commands.sql',
	'migrations/d1/0003_draft_revisions.sql',
	'migrations/d1/0004_envelope_ready.sql',
	'migrations/d1/0005_envelope_send.sql',
	'migrations/d1/0006_recipient_viewed.sql',
	'migrations/d1/0007_recipient_declined.sql',
	'migrations/d1/0008_recipient_approved.sql',
	'migrations/d1/0009_field_placement.sql',
	'migrations/d1/0010_recipient_signed.sql'
];
const leaseMigrationPath: string = 'migrations/d1/0011_delivery_outbox_leases.sql';

function database(applyLeaseMigration = true): DatabaseSync {
	const db: DatabaseSync = new DatabaseSync(':memory:');
	for (const path of baseMigrationPaths) db.exec(readFileSync(path, 'utf8'));
	db.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('org-1','org-1','Workspace','2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			sent_commit_sha, created_at, updated_at
		) VALUES (
			'env-1','org-1','Agreement','sent',1,'commit-1','commit-1',
			'2026-09-11T00:00:00.000Z','2026-09-11T00:01:00.000Z'
		);
		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
		) VALUES (
			'recipient-1','org-1','env-1','recipient@example.com','Recipient','signer','en',1,
			'pending','capability-hash','2026-09-25T00:00:00.000Z',NULL,
			'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'
		);
		INSERT INTO delivery_outbox (
			id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
			reserved_capability_expires_at, sealed_capability, sealing_key_id,
			sealed_capability_sha256, available_at, attempts, locked_at, delivered_at,
			provider_message_id, last_error, created_at, updated_at
		) VALUES (
			'delivery-1','org-1','env-1','recipient-1','recipient_invitation','pending',
			'capability-hash','2026-09-25T00:00:00.000Z','sealed-capability','key-1',
			'sealed-hash','2026-09-11T00:01:00.000Z',0,NULL,NULL,NULL,NULL,
			'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'
		);
	`);
	if (applyLeaseMigration) db.exec(readFileSync(leaseMigrationPath, 'utf8'));
	return db;
}

describe('D1 delivery outbox lease migration', () => {
	it('enforces claim and terminal invariants on newly inserted rows', () => {
		const db: DatabaseSync = database();
		try {
			db.exec(`
				INSERT INTO recipient (
					id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
					capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
				) VALUES
					('recipient-2','org-1','env-1','two@example.com','Two','signer','en',1,'pending',
					 'capability-hash-2','2026-09-25T00:00:00.000Z',NULL,
					 '2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'),
					('recipient-3','org-1','env-1','three@example.com','Three','signer','en',1,'pending',
					 'capability-hash-3','2026-09-25T00:00:00.000Z',NULL,
					 '2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z');
			`);
			expect((): void =>
				db.exec(`INSERT INTO delivery_outbox (
					id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
					reserved_capability_expires_at, sealed_capability, sealing_key_id,
					sealed_capability_sha256, available_at, attempts, locked_at, delivered_at,
					provider_message_id, last_error, created_at, updated_at, claim_token, retryable
				) VALUES (
					'delivery-2','org-1','env-1','recipient-2','recipient_invitation','processing',
					'capability-hash-2','2026-09-25T00:00:00.000Z','sealed-2','key-1','hash-2',
					'2026-09-11T00:01:00.000Z',1,NULL,NULL,NULL,NULL,
					'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z',NULL,1
				)`)
			).toThrow(/invalid delivery claim state/);
			expect((): void =>
				db.exec(`INSERT INTO delivery_outbox (
					id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
					reserved_capability_expires_at, sealed_capability, sealing_key_id,
					sealed_capability_sha256, available_at, attempts, locked_at, delivered_at,
					provider_message_id, last_error, created_at, updated_at, claim_token, retryable
				) VALUES (
					'delivery-3','org-1','env-1','recipient-3','recipient_invitation','delivered',
					'capability-hash-3','2026-09-25T00:00:00.000Z','sealed-3','key-1','hash-3',
					'2026-09-11T00:01:00.000Z',1,NULL,'2026-09-11T00:02:00.000Z','provider-3',NULL,
					'2026-09-11T00:01:00.000Z','2026-09-11T00:02:00.000Z',NULL,0
				)`)
			).toThrow(/invalid delivery terminal state/);
		} finally {
			db.close();
		}
	});

	it('requires a bounded claim token and lock timestamp while processing', () => {
		const db: DatabaseSync = database();
		try {
			expect((): void =>
				db.exec("UPDATE delivery_outbox SET status='processing' WHERE id='delivery-1'")
			).toThrow(/invalid delivery claim state/);
			db.exec(`UPDATE delivery_outbox
				SET status='processing', claim_token='claim-token-0001',
					locked_at='2026-09-11T00:02:00.000Z', updated_at='2026-09-11T00:02:00.000Z'
				WHERE id='delivery-1'`);
			const row = db
				.prepare('SELECT status, claim_token, locked_at FROM delivery_outbox WHERE id = ?')
				.get('delivery-1') as {
				status: string;
				claim_token: string;
				locked_at: string;
			};
			expect(row).toEqual({
				status: 'processing',
				claim_token: 'claim-token-0001',
				locked_at: '2026-09-11T00:02:00.000Z'
			});
		} finally {
			db.close();
		}
	});

	it('requires claim state to be cleared and ciphertext scrubbed on delivery', () => {
		const db: DatabaseSync = database();
		try {
			db.exec(`UPDATE delivery_outbox
				SET status='processing', claim_token='claim-token-0001',
					locked_at='2026-09-11T00:02:00.000Z'
				WHERE id='delivery-1'`);
			expect((): void =>
				db.exec(`UPDATE delivery_outbox
					SET status='delivered', claim_token=NULL, locked_at=NULL, retryable=0
					WHERE id='delivery-1'`)
			).toThrow(/invalid delivery terminal state/);
			db.exec(`UPDATE delivery_outbox
				SET status='delivered', claim_token=NULL, locked_at=NULL, retryable=0,
					sealed_capability=NULL, delivered_at='2026-09-11T00:03:00.000Z'
				WHERE id='delivery-1'`);
			const row = db
				.prepare(
					'SELECT status, sealed_capability, claim_token, locked_at, retryable FROM delivery_outbox WHERE id = ?'
				)
				.get('delivery-1') as {
				status: string;
				sealed_capability: string | null;
				claim_token: string | null;
				locked_at: string | null;
				retryable: number;
			};
			expect(row).toEqual({
				status: 'delivered',
				sealed_capability: null,
				claim_token: null,
				locked_at: null,
				retryable: 0
			});
		} finally {
			db.close();
		}
	});

	it('requires ciphertext scrubbing for a nonretryable failure', () => {
		const db: DatabaseSync = database();
		try {
			db.exec(`UPDATE delivery_outbox
				SET status='processing', claim_token='claim-token-0001',
					locked_at='2026-09-11T00:02:00.000Z'
				WHERE id='delivery-1'`);
			expect((): void =>
				db.exec(`UPDATE delivery_outbox
					SET status='failed', claim_token=NULL, locked_at=NULL, retryable=0
					WHERE id='delivery-1'`)
			).toThrow(/invalid delivery terminal state/);
			db.exec(`UPDATE delivery_outbox
				SET status='failed', claim_token=NULL, locked_at=NULL, retryable=0,
					sealed_capability=NULL, last_error='recipient_rejected'
				WHERE id='delivery-1'`);
			const row = db
				.prepare('SELECT status, sealed_capability, retryable FROM delivery_outbox WHERE id = ?')
				.get('delivery-1') as {
				status: string;
				sealed_capability: string | null;
				retryable: number;
			};
			expect(row).toEqual({ status: 'failed', sealed_capability: null, retryable: 0 });
		} finally {
			db.close();
		}
	});

	it('recovers a pre-migration processing row as a retryable failure', () => {
		const db: DatabaseSync = database(false);
		try {
			db.exec(`UPDATE delivery_outbox
				SET status='processing', locked_at='2026-09-11T00:02:00.000Z'
				WHERE id='delivery-1'`);
			db.exec(readFileSync(leaseMigrationPath, 'utf8'));
			const row = db
				.prepare(
					'SELECT status, available_at, locked_at, claim_token, retryable, last_error FROM delivery_outbox WHERE id = ?'
				)
				.get('delivery-1') as {
				status: string;
				available_at: string;
				locked_at: string | null;
				claim_token: string | null;
				retryable: number;
				last_error: string;
			};
			expect(row).toEqual({
				status: 'failed',
				available_at: '2026-09-11T00:01:00.000Z',
				locked_at: null,
				claim_token: null,
				retryable: 1,
				last_error: 'worker_restarted'
			});
		} finally {
			db.close();
		}
	});
});
