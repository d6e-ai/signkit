import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { RecipientDeclinedApplication } from '$lib/application/signing/recipient-declined';
import { hashRecipientCapability } from '$lib/security/recipient-capability';
import { D1RecipientDeclineStore } from './d1-recipient-decline-store';
import { sqliteD1Database } from './sqlite-d1-test-support';

const MIGRATIONS: readonly string[] = readdirSync('migrations/d1')
	.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
	.sort()
	.map((name: string): string => `migrations/d1/${name}`);
const TOKEN: string = `skr1_${'A'.repeat(43)}`;
const DECLINED_AT: string = '2026-09-12T00:03:00.000Z';

async function fixture(): Promise<{ database: D1Database; sqlite: DatabaseSync }> {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	for (const path of MIGRATIONS) sqlite.exec(readFileSync(path, 'utf8'));
	const capabilityHash: string = await hashRecipientCapability(TOKEN);
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('user-1', 'owner', 'active', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
		INSERT INTO envelope (id, created_by_user_id, title, status, repository_generation, repository_head, sent_commit_sha, created_at, updated_at) VALUES ('01920000-0000-7000-8000-000000000001', 'user-1', 'Agreement', 'sent', 1, 'commit-1', 'commit-1', '2026-09-12T00:00:00.000Z', '2026-09-12T00:01:00.000Z');
		INSERT INTO audit_event (id, envelope_id, sequence, event_type, actor_type, actor_id, payload_json, previous_hash, event_hash, occurred_at) VALUES ('01960000-0000-7000-8000-0000000000a1', '01920000-0000-7000-8000-000000000001', 1, 'envelope.sent', 'user', 'user-1', '{}', 'genesis', 'sent-hash', '2026-09-12T00:01:00.000Z');
		INSERT INTO recipient (id, envelope_id, email, name, role, locale, routing_order, status, capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at) VALUES
			('01930000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000001', 'actor@example.com', 'Actor', 'signer', 'en', 1, 'pending', '${capabilityHash}', '2026-09-30T00:00:00.000Z', NULL, '2026-09-12T00:01:00.000Z', '2026-09-12T00:01:00.000Z'),
			('01930000-0000-7000-8000-000000000002', '01920000-0000-7000-8000-000000000001', 'sibling@example.com', 'Sibling', 'signer', 'en', 2, 'pending', 'sibling-capability', NULL, NULL, '2026-09-12T00:01:00.000Z', '2026-09-12T00:01:00.000Z'),
			('01930000-0000-7000-8000-000000000003', '01920000-0000-7000-8000-000000000001', 'completed@example.com', 'Completed', 'approver', 'en', 1, 'completed', 'completed-capability', '2026-09-30T00:00:00.000Z', '${DECLINED_AT}', '2026-09-12T00:01:00.000Z', '${DECLINED_AT}');
		INSERT INTO delivery_outbox (id, envelope_id, recipient_id, kind, status, capability_hash, reserved_capability_expires_at, sealed_capability, sealing_key_id, sealed_capability_sha256, available_at, attempts, created_at, updated_at, claim_token, retryable) VALUES
			('01940000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000001', '01930000-0000-7000-8000-000000000001', 'recipient_invitation', 'pending', '${capabilityHash}', '2026-09-30T00:00:00.000Z', 'sealed-actor', 'key-1', 'hash-1', '2026-09-12T00:01:00.000Z', 0, '2026-09-12T00:01:00.000Z', '2026-09-12T00:01:00.000Z', NULL, 1),
			('01940000-0000-7000-8000-000000000002', '01920000-0000-7000-8000-000000000001', '01930000-0000-7000-8000-000000000002', 'recipient_invitation', 'blocked', 'sibling-capability', NULL, 'sealed-sibling', 'key-1', 'hash-2', NULL, 0, '2026-09-12T00:01:00.000Z', '2026-09-12T00:01:00.000Z', NULL, 1);
	`);
	return { database: sqliteD1Database(sqlite), sqlite };
}

function decline(database: D1Database) {
	return new RecipientDeclinedApplication(
		new D1RecipientDeclineStore(database),
		() => new Date(DECLINED_AT)
	).decline({
		token: TOKEN,
		expectedEnvelopeId: '01920000-0000-7000-8000-000000000001',
		expectedRecipientId: '01930000-0000-7000-8000-000000000001',
		idempotencyKey: 'decline-terminal-cleanup'
	});
}

describe('D1 terminal delivery cleanup integration', () => {
	it('atomically scrubs pending and blocked invitations and records revocation evidence', async () => {
		const { database, sqlite } = await fixture();
		try {
			await expect(decline(database)).resolves.toMatchObject({ outcome: 'published' });
			await expect(decline(database)).resolves.toMatchObject({ outcome: 'replayed' });
			const deliveries = sqlite
				.prepare(
					`SELECT recipient_id, status, retryable, sealed_capability, last_error
					 FROM delivery_outbox ORDER BY recipient_id`
				)
				.all() as Record<string, unknown>[];
			expect(deliveries).toEqual([
				{
					recipient_id: '01930000-0000-7000-8000-000000000001',
					status: 'failed',
					retryable: 0,
					sealed_capability: null,
					last_error: 'envelope_terminal'
				},
				{
					recipient_id: '01930000-0000-7000-8000-000000000002',
					status: 'failed',
					retryable: 0,
					sealed_capability: null,
					last_error: 'envelope_terminal'
				}
			]);
			const sibling = sqlite
				.prepare(
					"SELECT status, capability_revoked_at FROM recipient WHERE id='01930000-0000-7000-8000-000000000002'"
				)
				.get() as Record<string, unknown>;
			expect(sibling).toEqual({ status: 'pending', capability_revoked_at: DECLINED_AT });
			const command = sqlite
				.prepare(
					`SELECT revocation_evidence_version, revoked_recipient_ids_json,
						revoked_recipient_count, audit_payload_json
					 FROM recipient_declined_command`
				)
				.get() as Record<string, unknown>;
			expect(command).toMatchObject({
				revocation_evidence_version: 2,
				revoked_recipient_ids_json: '["01930000-0000-7000-8000-000000000002"]',
				revoked_recipient_count: 1
			});
			expect(JSON.parse(command.audit_payload_json as string)).toMatchObject({
				revokedCapabilities: {
					reason: 'envelope_declined',
					recipientIds: ['01930000-0000-7000-8000-000000000002']
				}
			});
		} finally {
			sqlite.close();
		}
	});

	it('fences an active delivery lease without partial writes and succeeds after lease release', async () => {
		const { database, sqlite } = await fixture();
		try {
			sqlite.exec(`UPDATE delivery_outbox
				SET status='processing', claim_token='claim-token-0001',
					locked_at='2026-09-12T00:02:00.000Z'
				WHERE id='01940000-0000-7000-8000-000000000001'`);
			await expect(decline(database)).resolves.toEqual({ outcome: 'delivery_in_flight' });
			expect(
				sqlite
					.prepare("SELECT status FROM envelope WHERE id='01920000-0000-7000-8000-000000000001'")
					.get()
			).toEqual({
				status: 'sent'
			});
			expect(
				sqlite.prepare('SELECT count(*) AS count FROM recipient_declined_command').get()
			).toEqual({ count: 0 });
			expect(sqlite.prepare('SELECT count(*) AS count FROM audit_event').get()).toEqual({
				count: 1
			});

			sqlite.exec(`UPDATE delivery_outbox
				SET status='pending', claim_token=NULL, locked_at=NULL
				WHERE id='01940000-0000-7000-8000-000000000001'`);
			await expect(decline(database)).resolves.toMatchObject({ outcome: 'published' });
		} finally {
			sqlite.close();
		}
	});
});
