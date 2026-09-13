import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { EnvelopeExpiryDrainService } from '$lib/application/delivery/envelope-expiry-service';
import { D1EnvelopeExpiryStore } from './d1-envelope-expiry-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const NOW: string = '2026-09-13T00:00:00.000Z';

function database(): { sqlite: DatabaseSync; d1: D1Database } {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	return { sqlite, d1: sqliteD1Database(sqlite) };
}

function seedEnvelope(
	sqlite: DatabaseSync,
	status: 'sent' | 'in_progress' = 'sent',
	generation: number = 2,
	repositoryHead: string | null = 'head-2',
	sentCommitSha: string | null = 'head-2'
): void {
	sqlite
		.prepare(
			`INSERT INTO organization (id, d6e_organization_id, name, created_at)
			 VALUES ('org-1', 'org-1', 'Workspace', '2026-09-11T00:00:00.000Z')`
		)
		.run();
	sqlite
		.prepare(
			`INSERT INTO envelope (
				id, organization_id, title, status, repository_generation, repository_head,
				sent_commit_sha, created_at, updated_at
			 ) VALUES (?, 'org-1', 'Agreement', ?, ?, ?, ?, '2026-09-11T00:00:00.000Z', '2026-09-11T01:00:00.000Z')`
		)
		.run(ENVELOPE_ID, status, generation, repositoryHead, sentCommitSha);
	sqlite
		.prepare(
			`INSERT INTO audit_event (
				id, organization_id, envelope_id, sequence, event_type, actor_type,
				actor_id, payload_json, previous_hash, event_hash, occurred_at
			 ) VALUES ('01960000-0000-7000-8000-0000000000a0', 'org-1', ?, 1, 'envelope.created', 'user',
				'user-1', '{}', 'genesis', 'head-hash', '2026-09-11T01:00:00.000Z')`
		)
		.run(ENVELOPE_ID);
}

function insertRecipient(
	sqlite: DatabaseSync,
	id: string,
	role: string,
	status: string,
	capabilityHash: string | null,
	capabilityExpiresAt: string | null
): void {
	sqlite
		.prepare(
			`INSERT INTO recipient (
				id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
				capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
			) VALUES (?, 'org-1', ?, ?, 'R', ?, 'en', 1, ?, ?, ?, NULL, '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z')`
		)
		.run(id, ENVELOPE_ID, `${id}@example.com`, role, status, capabilityHash, capabilityExpiresAt);
}

function insertDelivery(
	sqlite: DatabaseSync,
	id: string,
	recipientId: string,
	status: string,
	capabilityHash: string,
	reservedExpiresAt: string | null,
	sealedCapability: string | null
): void {
	sqlite
		.prepare(
			`INSERT INTO delivery_outbox (
				id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
				reserved_capability_expires_at, sealed_capability, sealing_key_id,
				sealed_capability_sha256, available_at, attempts, created_at, updated_at, retryable
			) VALUES (?, 'org-1', ?, ?, 'recipient_invitation', ?, ?, ?, ?, 'key', 'sha', '2026-09-11T00:00:00.000Z', 0,
				'2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z', 1)`
		)
		.run(id, ENVELOPE_ID, recipientId, status, capabilityHash, reservedExpiresAt, sealedCapability);
}

function service(d1: D1Database): EnvelopeExpiryDrainService {
	return new EnvelopeExpiryDrainService(
		new D1EnvelopeExpiryStore(d1),
		(): Date => new Date(NOW),
		(): string => '01970000-0000-7000-8000-000000000001'
	);
}

describe('D1 envelope expiry store integration', () => {
	it('expires an envelope whose sole actionable recipient has lapsed, scrubbing delivery and revoking capabilities', async () => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite);
			insertRecipient(
				sqlite,
				'01930000-0000-7000-8000-000000000001',
				'signer',
				'pending',
				'hash-1',
				'2026-09-01T00:00:00.000Z'
			);
			insertRecipient(
				sqlite,
				'01930000-0000-7000-8000-000000000002',
				'cc',
				'pending',
				'hash-2',
				'2026-09-01T00:00:00.000Z'
			);
			insertDelivery(
				sqlite,
				'01940000-0000-7000-8000-000000000001',
				'01930000-0000-7000-8000-000000000001',
				'pending',
				'hash-1',
				'2026-09-01T00:00:00.000Z',
				'sealed-1'
			);

			const result = await service(d1).drainExpiredEnvelopes();
			expect(result).toMatchObject({ discovered: 1, expired: 1, skipped: 0 });

			expect(sqlite.prepare('SELECT status FROM envelope').get()).toEqual({ status: 'expired' });
			const recipients = sqlite
				.prepare('SELECT id, capability_revoked_at FROM recipient ORDER BY id')
				.all() as { id: string; capability_revoked_at: string | null }[];
			expect(recipients.every((row) => row.capability_revoked_at === NOW)).toBe(true);
			const delivery = sqlite
				.prepare('SELECT status, sealed_capability, last_error FROM delivery_outbox')
				.get() as { status: string; sealed_capability: string | null; last_error: string };
			expect(delivery).toEqual({
				status: 'failed',
				sealed_capability: null,
				last_error: 'envelope_terminal'
			});
			const audit = sqlite
				.prepare(
					'SELECT event_type, actor_type, actor_id, sequence FROM audit_event ORDER BY sequence DESC LIMIT 1'
				)
				.get() as { event_type: string; actor_type: string; actor_id: string; sequence: number };
			expect(audit).toEqual({
				event_type: 'envelope.expired',
				actor_type: 'system',
				actor_id: 'envelope-expiry-drain',
				sequence: 2
			});
		} finally {
			sqlite.close();
		}
	});

	it('does not expire when an actionable recipient still has a live capability', async () => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite);
			insertRecipient(
				sqlite,
				'01930000-0000-7000-8000-000000000001',
				'signer',
				'pending',
				'hash-1',
				'2026-09-01T00:00:00.000Z'
			);
			insertRecipient(
				sqlite,
				'01930000-0000-7000-8000-000000000002',
				'approver',
				'pending',
				'hash-2',
				'2026-10-01T00:00:00.000Z'
			);

			const result = await service(d1).drainExpiredEnvelopes();
			expect(result).toEqual({ discovered: 0, expired: 0, skipped: 0, outcomes: [] });
			expect(sqlite.prepare('SELECT status FROM envelope').get()).toEqual({ status: 'sent' });
		} finally {
			sqlite.close();
		}
	});

	it('never expires an envelope whose actionable recipients are all still unreleased (blocked)', async () => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite);
			insertRecipient(
				sqlite,
				'01930000-0000-7000-8000-000000000001',
				'signer',
				'pending',
				'hash-1',
				null
			);

			const result = await service(d1).drainExpiredEnvelopes();
			expect(result).toEqual({ discovered: 0, expired: 0, skipped: 0, outcomes: [] });
		} finally {
			sqlite.close();
		}
	});

	it('is idempotent: a second drain run finds nothing left to expire', async () => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite);
			insertRecipient(
				sqlite,
				'01930000-0000-7000-8000-000000000001',
				'signer',
				'pending',
				'hash-1',
				'2026-09-01T00:00:00.000Z'
			);

			await expect(service(d1).drainExpiredEnvelopes()).resolves.toMatchObject({ expired: 1 });
			await expect(service(d1).drainExpiredEnvelopes()).resolves.toEqual({
				discovered: 0,
				expired: 0,
				skipped: 0,
				outcomes: []
			});
		} finally {
			sqlite.close();
		}
	});

	it('leaves in_progress envelopes eligible for expiry the same way as sent', async () => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite, 'in_progress', 4, 'head-4', 'head-4');
			insertRecipient(
				sqlite,
				'01930000-0000-7000-8000-000000000001',
				'approver',
				'viewed',
				'hash-1',
				'2026-09-01T00:00:00.000Z'
			);

			await expect(service(d1).drainExpiredEnvelopes()).resolves.toMatchObject({ expired: 1 });
			expect(sqlite.prepare('SELECT status FROM envelope').get()).toEqual({ status: 'expired' });
		} finally {
			sqlite.close();
		}
	});
});
