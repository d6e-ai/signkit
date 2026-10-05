import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { PublishReadyEnvelopeCommand } from '$lib/ports/envelope-ready-store';
import { D1EnvelopeReadyStore } from './d1-envelope-ready-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ENVELOPE_ID: string = '01910000-0000-7000-8000-000000000001';
const RECIPIENT_ID: string = '01910000-0000-7000-8000-000000000002';
const READY_AUDIT_ID: string = '01910000-0000-7000-8000-000000000003';
const ACTOR_ID: string = 'user-1';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const PREVIOUS_AUDIT_HASH: string = 'b'.repeat(64);
const UPDATED_AT: string = '2026-09-11T00:02:00.000Z';

function fixture(): { sqlite: DatabaseSync; store: D1EnvelopeReadyStore } {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${ACTOR_ID}', 'owner', 'active', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, repository_head,
			repository_archive_key, repository_archive_sha256, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}', '${ACTOR_ID}', 'Agreement', 'draft', 1, '${COMMIT_SHA}',
			'archives/integration.git.gz', '${'a'.repeat(64)}',
			'2026-09-11T00:00:00.000Z', '${UPDATED_AT}'
		);
		INSERT INTO audit_event (
			id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES
			('01910000-0000-7000-8000-000000000010', '${ENVELOPE_ID}', 1,
			 'envelope.created', 'user', '${ACTOR_ID}', '{}', NULL, '${'a'.repeat(64)}',
			 '2026-09-11T00:00:00.000Z'),
			('01910000-0000-7000-8000-000000000011', '${ENVELOPE_ID}', 2,
			 'draft.revision_created', 'user', '${ACTOR_ID}', '{}', '${'a'.repeat(64)}',
			 '${PREVIOUS_AUDIT_HASH}', '2026-09-11T00:01:00.000Z');
	`);
	return { sqlite, store: new D1EnvelopeReadyStore(sqliteD1Database(sqlite)) };
}

describe('D1EnvelopeReadyStore SQLite integration', () => {
	it('publishes a ready command and persists recipients against the migrated schema', async () => {
		const { sqlite, store } = fixture();
		const command: PublishReadyEnvelopeCommand = {
			envelopeId: ENVELOPE_ID,
			actorType: 'user',
			actorId: ACTOR_ID,
			idempotencyKey: 'ready-integration',
			requestFingerprint: 'c'.repeat(64),
			expectedGeneration: 1,
			expectedCommitSha: COMMIT_SHA,
			recipients: [
				{
					id: RECIPIENT_ID,
					envelopeId: ENVELOPE_ID,
					email: 'a@example.com',
					name: 'Alice',
					role: 'signer',
					locale: 'en',
					routingOrder: 1,
					status: 'pending'
				}
			],
			updatedAt: UPDATED_AT,
			expectedAuditSequence: 2,
			previousAuditHash: PREVIOUS_AUDIT_HASH,
			auditEventId: READY_AUDIT_ID,
			auditEventHash: 'd'.repeat(64),
			auditPayloadJson: '{"generation":1}'
		};

		try {
			await expect(store.publishReady(command)).resolves.toMatchObject({
				outcome: 'published',
				result: { envelopeId: ENVELOPE_ID, status: 'ready' }
			});
			expect(
				sqlite
					.prepare(
						`SELECT email, name, capability_hash, capability_expires_at,
						 capability_revoked_at, created_at, updated_at
						 FROM recipient WHERE id = ?`
					)
					.get(RECIPIENT_ID)
			).toEqual({
				email: 'a@example.com',
				name: 'Alice',
				capability_hash: null,
				capability_expires_at: null,
				capability_revoked_at: null,
				created_at: UPDATED_AT,
				updated_at: UPDATED_AT
			});
			expect(
				sqlite
					.prepare(
						`SELECT status,
						 (SELECT COUNT(*) FROM audit_event WHERE event_type = 'envelope.ready') AS ready_events
						 FROM envelope WHERE id = ?`
					)
					.get(ENVELOPE_ID)
			).toEqual({ status: 'ready', ready_events: 1 });
		} finally {
			sqlite.close();
		}
	});
});
