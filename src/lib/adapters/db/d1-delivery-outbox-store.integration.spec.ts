import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1DeliveryOutboxStore } from './d1-delivery-outbox-store';
import { sqliteD1Database } from './sqlite-d1-test-support';

const MIGRATIONS: readonly string[] = [
	'migrations/d1/0001_core.sql',
	'migrations/d1/0002_envelope_commands.sql',
	'migrations/d1/0003_draft_revisions.sql',
	'migrations/d1/0004_envelope_ready.sql',
	'migrations/d1/0005_envelope_send.sql',
	'migrations/d1/0006_recipient_viewed.sql',
	'migrations/d1/0007_recipient_declined.sql',
	'migrations/d1/0008_recipient_approved.sql',
	'migrations/d1/0009_field_placement.sql',
	'migrations/d1/0010_recipient_signed.sql',
	'migrations/d1/0011_delivery_outbox_leases.sql',
	'migrations/d1/0012_delivery_outbox_recipient_scope.sql'
];
const CLAIMED_AT: string = '2026-09-12T00:00:00.000Z';
const STALE_BEFORE: string = '2026-09-11T23:55:00.000Z';

function fixture(): { database: D1Database; sqlite: DatabaseSync } {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	for (const path of MIGRATIONS) sqlite.exec(readFileSync(path, 'utf8'));
	sqlite.exec(`
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
			provider_message_id, last_error, created_at, updated_at, claim_token, retryable
		) VALUES (
			'delivery-1','org-1','env-1','recipient-1','recipient_invitation','pending',
			'capability-hash','2026-09-25T00:00:00.000Z','skdc1_ciphertext','key-1',
			'sealed-hash','2026-09-11T00:01:00.000Z',0,NULL,NULL,NULL,NULL,
			'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z',NULL,1
		);
	`);
	return {
		database: sqliteD1Database(sqlite),
		sqlite
	};
}

function claim(store: D1DeliveryOutboxStore, claimToken: string) {
	return store.claimPendingInvitations({
		claimToken,
		claimedAt: CLAIMED_AT,
		staleBefore: STALE_BEFORE,
		limit: 25
	});
}

describe('D1DeliveryOutboxStore SQLite integration', () => {
	it('claims one active lease and prevents a concurrent current lease claim', async () => {
		const { database, sqlite } = fixture();
		try {
			const store = new D1DeliveryOutboxStore(database);
			const first = await claim(store, 'claim-token-0001');
			const second = await claim(store, 'claim-token-0002');
			const row = sqlite
				.prepare('SELECT status, claim_token, attempts, locked_at FROM delivery_outbox')
				.get() as Record<string, unknown>;

			expect(first).toHaveLength(1);
			expect(first[0]).toMatchObject({ attempts: 1, lockedAt: CLAIMED_AT });
			expect(second).toEqual([]);
			expect(row).toEqual({
				status: 'processing',
				claim_token: 'claim-token-0001',
				attempts: 1,
				locked_at: CLAIMED_AT
			});
		} finally {
			sqlite.close();
		}
	});

	it('reclaims a stale lease and rejects completion by the old claimant', async () => {
		const { database, sqlite } = fixture();
		try {
			const store = new D1DeliveryOutboxStore(database);
			await claim(store, 'claim-token-0001');
			sqlite.exec(
				"UPDATE delivery_outbox SET locked_at='2026-09-11T23:54:59.000Z' WHERE id='delivery-1'"
			);
			const reclaimed = await claim(store, 'claim-token-0002');
			const stale = await store.completeInvitationDelivery({
				organizationId: 'org-1',
				deliveryId: 'delivery-1',
				claimToken: 'claim-token-0001',
				deliveredAt: CLAIMED_AT,
				providerMessageId: 'provider-old'
			});
			const completed = await store.completeInvitationDelivery({
				organizationId: 'org-1',
				deliveryId: 'delivery-1',
				claimToken: 'claim-token-0002',
				deliveredAt: CLAIMED_AT,
				providerMessageId: 'provider-current'
			});
			const row = sqlite
				.prepare(
					'SELECT status, sealed_capability, provider_message_id, retryable FROM delivery_outbox'
				)
				.get() as Record<string, unknown>;

			expect(reclaimed[0]).toMatchObject({ attempts: 2 });
			expect(stale).toEqual({ outcome: 'stale' });
			expect(completed).toEqual({ outcome: 'completed' });
			expect(row).toEqual({
				status: 'delivered',
				sealed_capability: null,
				provider_message_id: 'provider-current',
				retryable: 0
			});
		} finally {
			sqlite.close();
		}
	});

	it('does not claim an expired capability and permanently scrubs its sealed token', async () => {
		const { database, sqlite } = fixture();
		try {
			sqlite.exec(
				"UPDATE recipient SET capability_expires_at='2026-09-11T23:59:59.000Z' WHERE id='recipient-1'; UPDATE delivery_outbox SET reserved_capability_expires_at='2026-09-11T23:59:59.000Z' WHERE id='delivery-1'"
			);
			await expect(claim(new D1DeliveryOutboxStore(database), 'claim-token-0001')).resolves.toEqual(
				[]
			);
			const row = sqlite
				.prepare(
					'SELECT status, retryable, sealed_capability, claim_token, locked_at, last_error FROM delivery_outbox'
				)
				.get() as Record<string, unknown>;
			expect(row).toEqual({
				status: 'failed',
				retryable: 0,
				sealed_capability: null,
				claim_token: null,
				locked_at: null,
				last_error: 'delivery_not_eligible'
			});
		} finally {
			sqlite.close();
		}
	});

	it('does not claim a legacy prefill invitation and permanently scrubs its sealed token', async () => {
		const { database, sqlite } = fixture();
		try {
			sqlite.exec("UPDATE recipient SET role='prefill' WHERE id='recipient-1'");
			await expect(claim(new D1DeliveryOutboxStore(database), 'claim-token-0001')).resolves.toEqual(
				[]
			);
			const row = sqlite
				.prepare(
					'SELECT status, retryable, sealed_capability, claim_token, locked_at, last_error FROM delivery_outbox'
				)
				.get() as Record<string, unknown>;
			expect(row).toEqual({
				status: 'failed',
				retryable: 0,
				sealed_capability: null,
				claim_token: null,
				locked_at: null,
				last_error: 'delivery_not_eligible'
			});
		} finally {
			sqlite.close();
		}
	});

	it('scrubs a stale processing delivery after the recipient has viewed it', async () => {
		const { database, sqlite } = fixture();
		try {
			const store = new D1DeliveryOutboxStore(database);
			await claim(store, 'claim-token-0001');
			sqlite.exec(`
				UPDATE delivery_outbox
				SET locked_at='2026-09-11T23:54:59.000Z'
				WHERE id='delivery-1';
				UPDATE recipient
				SET status='viewed', updated_at='2026-09-11T23:59:00.000Z'
				WHERE id='recipient-1';
			`);

			await expect(claim(store, 'claim-token-0002')).resolves.toEqual([]);
			const row = sqlite
				.prepare(
					'SELECT status, retryable, sealed_capability, claim_token, locked_at, last_error FROM delivery_outbox'
				)
				.get() as Record<string, unknown>;
			expect(row).toEqual({
				status: 'failed',
				retryable: 0,
				sealed_capability: null,
				claim_token: null,
				locked_at: null,
				last_error: 'delivery_not_eligible'
			});
		} finally {
			sqlite.close();
		}
	});
});
