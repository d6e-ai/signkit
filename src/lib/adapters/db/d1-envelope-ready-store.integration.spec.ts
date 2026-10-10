import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';
import {
	EnvelopeReadyApplication,
	type ReadyRecipientInput
} from '$lib/application/envelopes/ready';
import { hashAuditEventV3, hashStoredAuditEvent } from '$lib/domain/audit';
import type {
	PublishReadyEnvelopeCommand,
	PublishReadyEnvelopeResult
} from '$lib/ports/envelope-ready-store';
import { D1EnvelopeReadyStore } from './d1-envelope-ready-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ENVELOPE_ID: string = '01910000-0000-7000-8000-000000000001';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const GENESIS_OCCURRED_AT: string = '2026-09-11T00:00:00.000Z';
const USER_ACTOR: EnvelopeRequestActor = {
	id: 'user-1',
	createdByUserId: 'user-1'
};
const AGENT_ACTOR: EnvelopeRequestActor = {
	id: '01910000-0000-7000-8000-000000000099',
	createdByUserId: 'user-1',
	actorType: 'agent'
};

interface Fixture {
	sqlite: DatabaseSync;
	database: D1Database;
	store: D1EnvelopeReadyStore;
	application: EnvelopeReadyApplication;
	genesisHash: string;
}

async function fixture(
	status: 'draft' | 'ready' | 'sent' | 'voided' = 'draft',
	generation: number = 1,
	repositoryHead: string | null = COMMIT_SHA
): Promise<Fixture> {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	const database = sqliteD1Database(sqlite);
	const store = new D1EnvelopeReadyStore(database);
	const application = new EnvelopeReadyApplication(store);

	const genesisHash: string = await hashAuditEventV3(
		{
			sequence: 1,
			eventType: 'envelope.created',
			actorType: 'user',
			actorId: USER_ACTOR.id,
			occurredAt: GENESIS_OCCURRED_AT,
			payload: {},
			previousHash: null
		},
		{ envelopeId: ENVELOPE_ID }
	);

	sqlite
		.prepare(
			`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			 VALUES ('user-1', 'owner', 'active', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z')`
		)
		.run();
	sqlite
		.prepare(
			`INSERT INTO envelope (
				id, created_by_user_id, title, status, repository_generation, repository_head,
				repository_archive_key, repository_archive_sha256, created_at, updated_at
			) VALUES (
				?, 'user-1', 'Agreement', ?, ?, ?,
				'archives/integration.git.gz', ?,
				'2026-09-11T00:00:00.000Z', '2026-09-11T00:01:00.000Z'
			)`
		)
		.run(ENVELOPE_ID, status, generation, repositoryHead, 'a'.repeat(64));
	sqlite
		.prepare(
			`INSERT INTO audit_event (
				id, envelope_id, sequence, event_type, actor_type,
				actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
			) VALUES (
				'01910000-0000-7000-8000-000000000010', ?, 1, 'envelope.created', 'user',
				'user-1', '{}', NULL, ?, '2026-09-11T00:00:00.000Z', 3
			)`
		)
		.run(ENVELOPE_ID, genesisHash);

	return { sqlite, database, store, application, genesisHash };
}

const FIVE_RECIPIENTS: readonly ReadyRecipientInput[] = [
	{
		email: 'alice@example.com',
		name: 'Alice',
		role: 'signer',
		locale: 'en',
		routingOrder: 1
	},
	{
		email: 'bob@example.com',
		name: 'Bob',
		role: 'approver',
		locale: 'ja',
		routingOrder: 1
	},
	{
		email: 'charlie@example.com',
		name: 'Charlie',
		role: 'viewer',
		locale: 'en',
		routingOrder: 2
	},
	{
		email: 'dave@example.com',
		name: 'Dave',
		role: 'signer',
		locale: 'ja',
		routingOrder: 2
	},
	{
		email: 'eve@example.com',
		name: 'Eve',
		role: 'cc',
		locale: 'en',
		routingOrder: 2
	}
];

describe('D1EnvelopeReadyStore SQLite integration', () => {
	it('atomically transitions draft to ready with full recipient projection, command, and audit event', async () => {
		const { sqlite, application, genesisHash } = await fixture();
		try {
			const result = await application.ready(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'ready-full-1',
				expectedGeneration: 1,
				recipients: FIVE_RECIPIENTS
			});

			expect(result).toMatchObject({
				outcome: 'published',
				result: {
					envelopeId: ENVELOPE_ID,
					status: 'ready',
					generation: 1,
					commitSha: COMMIT_SHA,
					recipients: expect.arrayContaining([
						expect.objectContaining({ email: 'alice@example.com', role: 'signer' }),
						expect.objectContaining({ email: 'bob@example.com', role: 'approver' }),
						expect.objectContaining({ email: 'charlie@example.com', role: 'viewer' }),
						expect.objectContaining({ email: 'dave@example.com', role: 'signer' }),
						expect.objectContaining({ email: 'eve@example.com', role: 'cc' })
					])
				}
			});
			if (result.outcome !== 'published') throw new Error('Expected ready publication');

			const envelope = sqlite
				.prepare('SELECT status, repository_generation, updated_at FROM envelope WHERE id = ?')
				.get(ENVELOPE_ID) as { status: string; repository_generation: number; updated_at: string };
			expect(envelope).toEqual({
				status: 'ready',
				repository_generation: 1,
				updated_at: result.result.updatedAt
			});

			const command = sqlite
				.prepare(
					`SELECT envelope_id, actor_type, actor_id, idempotency_key, expected_generation,
						commit_sha, recipient_count, updated_at, audit_sequence, previous_audit_hash
					 FROM envelope_ready_command WHERE envelope_id = ?`
				)
				.get(ENVELOPE_ID) as Record<string, unknown>;
			expect(command).toEqual({
				envelope_id: ENVELOPE_ID,
				actor_type: 'user',
				actor_id: USER_ACTOR.id,
				idempotency_key: 'ready-full-1',
				expected_generation: 1,
				commit_sha: COMMIT_SHA,
				recipient_count: 5,
				updated_at: result.result.updatedAt,
				audit_sequence: 2,
				previous_audit_hash: genesisHash
			});

			const recipientRows = sqlite
				.prepare(
					`SELECT id, envelope_id, email, name, role, locale, routing_order, status,
						capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
					 FROM recipient WHERE envelope_id = ? ORDER BY email`
				)
				.all(ENVELOPE_ID) as Record<string, unknown>[];
			expect(recipientRows).toHaveLength(5);
			for (const row of recipientRows) {
				expect(row.envelope_id).toBe(ENVELOPE_ID);
				expect(row.status).toBe('pending');
				expect(row.capability_hash).toBeNull();
				expect(row.capability_expires_at).toBeNull();
				expect(row.capability_revoked_at).toBeNull();
				expect(row.created_at).toBe(result.result.updatedAt);
				expect(row.updated_at).toBe(result.result.updatedAt);
				expect(typeof row.id).toBe('string');
				expect((row.id as string).length).toBe(36);
			}

			const auditRows = sqlite
				.prepare(
					`SELECT id, sequence, event_type, actor_type, actor_id, payload_json,
						previous_hash, event_hash, occurred_at, hash_version
					 FROM audit_event WHERE envelope_id = ? ORDER BY sequence`
				)
				.all(ENVELOPE_ID) as {
				id: string;
				sequence: number;
				event_type: string;
				actor_type: string;
				actor_id: string;
				payload_json: string;
				previous_hash: string | null;
				event_hash: string;
				occurred_at: string;
				hash_version: number;
			}[];
			expect(auditRows).toHaveLength(2);
			const readyEvent = auditRows[1];
			expect(readyEvent).toMatchObject({
				id: result.result.auditEventId,
				sequence: 2,
				event_type: 'envelope.ready',
				actor_type: 'user',
				actor_id: USER_ACTOR.id,
				previous_hash: genesisHash,
				occurred_at: result.result.updatedAt,
				hash_version: 3
			});

			const verifiedHash = await hashStoredAuditEvent(
				{
					hashVersion: readyEvent.hash_version,
					sequence: readyEvent.sequence,
					eventType: readyEvent.event_type,
					actorType: readyEvent.actor_type,
					actorId: readyEvent.actor_id,
					occurredAt: readyEvent.occurred_at,
					payload: JSON.parse(readyEvent.payload_json) as unknown,
					previousHash: readyEvent.previous_hash
				},
				{ envelopeId: ENVELOPE_ID }
			);
			expect(verifiedHash).toBe(readyEvent.event_hash);
		} finally {
			sqlite.close();
		}
	});

	it('idempotently replays on identical input and returns identical published ready envelope', async () => {
		const { sqlite, application } = await fixture();
		try {
			const input = {
				idempotencyKey: 'ready-replay-1',
				expectedGeneration: 1,
				recipients: FIVE_RECIPIENTS
			};
			const first = await application.ready(USER_ACTOR, ENVELOPE_ID, input);
			expect(first.outcome).toBe('published');

			const replay = await application.ready(USER_ACTOR, ENVELOPE_ID, input);
			expect(replay).toEqual({
				outcome: 'replayed',
				result: (first as { outcome: 'published'; result: unknown }).result
			});

			const counts = sqlite
				.prepare(
					`SELECT
						(SELECT COUNT(*) FROM envelope WHERE id = ? AND status = 'ready') AS ready_envelopes,
						(SELECT COUNT(*) FROM envelope_ready_command WHERE envelope_id = ?) AS commands,
						(SELECT COUNT(*) FROM recipient WHERE envelope_id = ?) AS recipients,
						(SELECT COUNT(*) FROM audit_event WHERE envelope_id = ?) AS audit_events`
				)
				.get(ENVELOPE_ID, ENVELOPE_ID, ENVELOPE_ID, ENVELOPE_ID) as Record<string, number>;
			expect(counts).toEqual({
				ready_envelopes: 1,
				commands: 1,
				recipients: 5,
				audit_events: 2
			});
		} finally {
			sqlite.close();
		}
	});

	it('rejects idempotency key reuse with mismatched generation or recipients', async () => {
		const { sqlite, application } = await fixture();
		try {
			const input = {
				idempotencyKey: 'ready-conflict-1',
				expectedGeneration: 1,
				recipients: FIVE_RECIPIENTS
			};
			const first = await application.ready(USER_ACTOR, ENVELOPE_ID, input);
			expect(first.outcome).toBe('published');

			const mismatchedGeneration = await application.ready(USER_ACTOR, ENVELOPE_ID, {
				...input,
				expectedGeneration: 2
			});
			expect(mismatchedGeneration).toEqual({ outcome: 'idempotency_conflict' });

			const mismatchedRecipients = await application.ready(USER_ACTOR, ENVELOPE_ID, {
				...input,
				recipients: FIVE_RECIPIENTS.slice(0, 4)
			});
			expect(mismatchedRecipients).toEqual({ outcome: 'idempotency_conflict' });
		} finally {
			sqlite.close();
		}
	});

	it('atomically rolls back the entire batch if recipient insertion fails on unique constraint', async () => {
		const { sqlite, store, genesisHash } = await fixture();
		try {
			const now = new Date().toISOString();
			const invalidCommand: PublishReadyEnvelopeCommand = {
				envelopeId: ENVELOPE_ID,
				actorType: 'user',
				actorId: USER_ACTOR.id,
				idempotencyKey: 'ready-fail-unique',
				requestFingerprint: 'a'.repeat(64),
				expectedGeneration: 1,
				expectedCommitSha: COMMIT_SHA,
				recipients: [
					{
						id: '01910000-0000-7000-8000-000000000021',
						envelopeId: ENVELOPE_ID,
						email: 'duplicate@example.com',
						name: 'First',
						role: 'signer',
						locale: 'en',
						routingOrder: 1,
						status: 'pending'
					},
					{
						id: '01910000-0000-7000-8000-000000000022',
						envelopeId: ENVELOPE_ID,
						email: 'duplicate@example.com',
						name: 'Second',
						role: 'approver',
						locale: 'ja',
						routingOrder: 2,
						status: 'pending'
					}
				],
				updatedAt: now,
				expectedAuditSequence: 1,
				previousAuditHash: genesisHash,
				auditEventId: '01910000-0000-7000-8000-000000000030',
				auditEventHash: 'b'.repeat(64),
				auditPayloadJson: '{}'
			};

			await expect(store.publishReady(invalidCommand)).rejects.toThrow(
				/UNIQUE constraint failed: recipient\.envelope_id, recipient\.email/
			);

			const envelope = sqlite
				.prepare('SELECT status, updated_at FROM envelope WHERE id = ?')
				.get(ENVELOPE_ID) as { status: string; updated_at: string };
			expect(envelope.status).toBe('draft');

			const commandCount = sqlite
				.prepare('SELECT COUNT(*) AS count FROM envelope_ready_command WHERE envelope_id = ?')
				.get(ENVELOPE_ID) as { count: number };
			expect(commandCount.count).toBe(0);

			const recipientCount = sqlite
				.prepare('SELECT COUNT(*) AS count FROM recipient WHERE envelope_id = ?')
				.get(ENVELOPE_ID) as { count: number };
			expect(recipientCount.count).toBe(0);

			const auditCount = sqlite
				.prepare('SELECT COUNT(*) AS count FROM audit_event WHERE envelope_id = ?')
				.get(ENVELOPE_ID) as { count: number };
			expect(auditCount.count).toBe(1);
		} finally {
			sqlite.close();
		}
	});

	it('atomically rolls back the entire batch if a recipient violates the UUIDv7 check constraint', async () => {
		const { sqlite, store, genesisHash } = await fixture();
		try {
			const now = new Date().toISOString();
			const invalidCommand: PublishReadyEnvelopeCommand = {
				envelopeId: ENVELOPE_ID,
				actorType: 'user',
				actorId: USER_ACTOR.id,
				idempotencyKey: 'ready-fail-uuid',
				requestFingerprint: 'a'.repeat(64),
				expectedGeneration: 1,
				expectedCommitSha: COMMIT_SHA,
				recipients: [
					{
						id: 'not-a-valid-uuidv7',
						envelopeId: ENVELOPE_ID,
						email: 'valid@example.com',
						name: 'Invalid UUID',
						role: 'signer',
						locale: 'en',
						routingOrder: 1,
						status: 'pending'
					}
				],
				updatedAt: now,
				expectedAuditSequence: 1,
				previousAuditHash: genesisHash,
				auditEventId: '01910000-0000-7000-8000-000000000031',
				auditEventHash: 'b'.repeat(64),
				auditPayloadJson: '{}'
			};

			await expect(store.publishReady(invalidCommand)).rejects.toThrow(
				/CHECK constraint failed: recipient_id_uuidv7/
			);

			const envelope = sqlite
				.prepare('SELECT status FROM envelope WHERE id = ?')
				.get(ENVELOPE_ID) as { status: string };
			expect(envelope.status).toBe('draft');

			const commandCount = sqlite
				.prepare('SELECT COUNT(*) AS count FROM envelope_ready_command WHERE envelope_id = ?')
				.get(ENVELOPE_ID) as { count: number };
			expect(commandCount.count).toBe(0);

			const recipientCount = sqlite
				.prepare('SELECT COUNT(*) AS count FROM recipient WHERE envelope_id = ?')
				.get(ENVELOPE_ID) as { count: number };
			expect(recipientCount.count).toBe(0);

			const auditCount = sqlite
				.prepare('SELECT COUNT(*) AS count FROM audit_event WHERE envelope_id = ?')
				.get(ENVELOPE_ID) as { count: number };
			expect(auditCount.count).toBe(1);
		} finally {
			sqlite.close();
		}
	});

	it('atomically replaces pre-existing draft recipients upon becoming ready', async () => {
		const { sqlite, application } = await fixture();
		try {
			sqlite
				.prepare(
					`INSERT INTO recipient (
						id, envelope_id, email, name, role, locale, routing_order,
						status, created_at, updated_at
					) VALUES
					('01910000-0000-7000-8000-0000000000a1', ?, 'old1@example.com', 'Old 1', 'signer', 'en', 1, 'pending', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'),
					('01910000-0000-7000-8000-0000000000a2', ?, 'old2@example.com', 'Old 2', 'approver', 'ja', 2, 'pending', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z')`
				)
				.run(ENVELOPE_ID, ENVELOPE_ID);

			const initialRecipients = sqlite
				.prepare('SELECT COUNT(*) AS count FROM recipient WHERE envelope_id = ?')
				.get(ENVELOPE_ID) as { count: number };
			expect(initialRecipients.count).toBe(2);

			const result = await application.ready(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'ready-replace-1',
				expectedGeneration: 1,
				recipients: FIVE_RECIPIENTS
			});
			expect(result.outcome).toBe('published');

			const finalRecipients = sqlite
				.prepare('SELECT email FROM recipient WHERE envelope_id = ? ORDER BY email')
				.all(ENVELOPE_ID) as { email: string }[];
			expect(finalRecipients.map((r) => r.email)).toEqual([
				'alice@example.com',
				'bob@example.com',
				'charlie@example.com',
				'dave@example.com',
				'eve@example.com'
			]);
		} finally {
			sqlite.close();
		}
	});

	it('rejects publication when CAS conditions fail (immutable, generation_conflict, audit_conflict, not_found, empty_draft)', async () => {
		const missingEnvelopeFixture = await fixture();
		try {
			const missing = await missingEnvelopeFixture.application.ready(
				USER_ACTOR,
				'01910000-0000-7000-8000-000000000999',
				{
					idempotencyKey: 'ready-cas-missing',
					expectedGeneration: 1,
					recipients: FIVE_RECIPIENTS
				}
			);
			expect(missing).toEqual({ outcome: 'not_found' });
		} finally {
			missingEnvelopeFixture.sqlite.close();
		}

		const sentFixture = await fixture('sent', 1);
		try {
			const immutable = await sentFixture.application.ready(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'ready-cas-immutable',
				expectedGeneration: 1,
				recipients: FIVE_RECIPIENTS
			});
			expect(immutable).toEqual({ outcome: 'immutable' });
		} finally {
			sentFixture.sqlite.close();
		}

		const genFixture = await fixture('draft', 2);
		try {
			const genConflict = await genFixture.application.ready(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'ready-cas-gen',
				expectedGeneration: 1,
				recipients: FIVE_RECIPIENTS
			});
			expect(genConflict).toEqual({ outcome: 'generation_conflict' });
		} finally {
			genFixture.sqlite.close();
		}

		const emptyDraftFixture = await fixture('draft', 1, null);
		try {
			const empty = await emptyDraftFixture.application.ready(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'ready-cas-empty',
				expectedGeneration: 1,
				recipients: FIVE_RECIPIENTS
			});
			expect(empty).toEqual({ outcome: 'empty_draft' });
		} finally {
			emptyDraftFixture.sqlite.close();
		}

		const auditConflictFixture = await fixture();
		try {
			const now = new Date().toISOString();
			const conflictCommand: PublishReadyEnvelopeCommand = {
				envelopeId: ENVELOPE_ID,
				actorType: 'user',
				actorId: USER_ACTOR.id,
				idempotencyKey: 'ready-cas-audit',
				requestFingerprint: 'a'.repeat(64),
				expectedGeneration: 1,
				expectedCommitSha: COMMIT_SHA,
				recipients: [
					{
						id: '01910000-0000-7000-8000-000000000051',
						envelopeId: ENVELOPE_ID,
						email: 'test@example.com',
						name: 'Test',
						role: 'signer',
						locale: 'en',
						routingOrder: 1,
						status: 'pending'
					}
				],
				updatedAt: now,
				expectedAuditSequence: 99,
				previousAuditHash: 'wrong-hash',
				auditEventId: '01910000-0000-7000-8000-000000000052',
				auditEventHash: 'b'.repeat(64),
				auditPayloadJson: '{}'
			};
			const result: PublishReadyEnvelopeResult =
				await auditConflictFixture.store.publishReady(conflictCommand);
			expect(result).toEqual({ outcome: 'audit_conflict' });
		} finally {
			auditConflictFixture.sqlite.close();
		}
	});

	it('fails closed with integrity_error when stored receipt or audit evidence is corrupted', async () => {
		const { sqlite, store, application } = await fixture();
		try {
			const published = await application.ready(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'ready-tamper-1',
				expectedGeneration: 1,
				recipients: FIVE_RECIPIENTS
			});
			expect(published.outcome).toBe('published');

			sqlite
				.prepare(
					`UPDATE envelope_ready_command
					 SET recipients_json = ? WHERE envelope_id = ?`
				)
				.run(
					JSON.stringify([
						{
							id: '01910000-0000-7000-8000-000000000001',
							envelopeId: ENVELOPE_ID,
							email: 'tampered@example.com',
							name: 'Tampered',
							role: 'signer',
							locale: 'en',
							routingOrder: 1,
							status: 'pending'
						}
					]),
					ENVELOPE_ID
				);

			const tamperedResult = await application.ready(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'ready-tamper-1',
				expectedGeneration: 1,
				recipients: FIVE_RECIPIENTS
			});
			expect(tamperedResult).toEqual({ outcome: 'integrity_error' });

			const storedCommand = sqlite
				.prepare('SELECT request_hash FROM envelope_ready_command WHERE envelope_id = ?')
				.get(ENVELOPE_ID) as { request_hash: string };

			sqlite.prepare("DELETE FROM audit_event WHERE event_type = 'envelope.ready'").run();
			const missingEvidenceResult = await store.prepareReady(
				{
					envelopeId: ENVELOPE_ID,
					actorType: 'user',
					actorId: USER_ACTOR.id,
					idempotencyKey: 'ready-tamper-1',
					requestFingerprint: storedCommand.request_hash
				},
				1
			);
			expect(missingEvidenceResult).toEqual({ outcome: 'integrity_error' });
		} finally {
			sqlite.close();
		}
	});

	it('supports agent actor type for API-key invocations', async () => {
		const { sqlite, application } = await fixture();
		try {
			const input = {
				idempotencyKey: 'ready-agent-1',
				expectedGeneration: 1,
				recipients: FIVE_RECIPIENTS
			};
			const published = await application.ready(AGENT_ACTOR, ENVELOPE_ID, input);
			expect(published).toMatchObject({
				outcome: 'published',
				result: { envelopeId: ENVELOPE_ID, status: 'ready' }
			});

			const command = sqlite
				.prepare('SELECT actor_type, actor_id FROM envelope_ready_command WHERE envelope_id = ?')
				.get(ENVELOPE_ID) as { actor_type: string; actor_id: string };
			expect(command).toEqual({ actor_type: 'agent', actor_id: AGENT_ACTOR.id });

			const audit = sqlite
				.prepare(
					"SELECT actor_type, actor_id FROM audit_event WHERE envelope_id = ? AND event_type = 'envelope.ready'"
				)
				.get(ENVELOPE_ID) as { actor_type: string; actor_id: string };
			expect(audit).toEqual({ actor_type: 'agent', actor_id: AGENT_ACTOR.id });

			const replay = await application.ready(AGENT_ACTOR, ENVELOPE_ID, input);
			expect(replay).toEqual({
				outcome: 'replayed',
				result: (published as { outcome: 'published'; result: unknown }).result
			});
		} finally {
			sqlite.close();
		}
	});
});
