import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { FakeSentDocumentPdf } from '$lib/application/documents/sent-document-pdf-test-support';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';
import { EnvelopeReadyApplication } from '$lib/application/envelopes/ready';
import { EnvelopeReopenApplication } from '$lib/application/envelopes/reopen';
import { EnvelopeSendApplication } from '$lib/application/envelopes/send';
import { EnvelopeAuthoringFieldsRead } from '$lib/application/envelopes/fields';
import { hashAuditEventV3 } from '$lib/domain/audit';
import { fingerprintReopenRequest, reopenAuditPayloadJson } from '$lib/domain/commands/reopen';
import { AuthoringFieldsIntegrityError } from '$lib/ports/envelope-field-store';
import type { PublishReopenedEnvelopeCommand } from '$lib/ports/envelope-reopen-store';
import { AesGcmRecipientCapabilitySealer } from '$lib/security/delivery-capability';
import { D1EnvelopeFieldStore } from './d1-envelope-field-store';
import { D1EnvelopeReadyStore } from './d1-envelope-ready-store';
import { D1EnvelopeReopenStore } from './d1-envelope-reopen-store';
import { D1EnvelopeSendStore } from './d1-envelope-send-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ENVELOPE_ID: string = '01910000-0000-7000-8000-000000000001';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const GENESIS_OCCURRED_AT: string = '2026-09-11T00:00:00.000Z';
const FIELD_ID: string = '01910000-0000-7000-8000-000000000031';
const DOCUMENT_ID: string = '01910000-0000-7000-8000-000000000021';
const USER_ACTOR: EnvelopeRequestActor = {
	id: 'user-1',
	createdByUserId: 'user-1'
};

interface Fixture {
	sqlite: DatabaseSync;
	database: D1Database;
	ready: EnvelopeReadyApplication;
	reopen: EnvelopeReopenApplication;
	fields: EnvelopeAuthoringFieldsRead;
}

async function fixture(): Promise<Fixture> {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	const database = sqliteD1Database(sqlite);
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
				?, 'user-1', 'Agreement', 'draft', 1, ?,
				'archives/integration.git.gz', ?,
				'2026-09-11T00:00:00.000Z', '2026-09-11T00:01:00.000Z'
			)`
		)
		.run(ENVELOPE_ID, COMMIT_SHA, 'a'.repeat(64));
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
	return {
		sqlite,
		database,
		ready: new EnvelopeReadyApplication(new D1EnvelopeReadyStore(database)),
		reopen: new EnvelopeReopenApplication(new D1EnvelopeReopenStore(database)),
		fields: new EnvelopeAuthoringFieldsRead(new D1EnvelopeFieldStore(database))
	};
}

async function readyEnvelope(
	application: EnvelopeReadyApplication
): Promise<{ readyAuditEventId: string; recipientId: string }> {
	const result = await application.ready(USER_ACTOR, ENVELOPE_ID, {
		idempotencyKey: 'ready-1',
		expectedGeneration: 1,
		recipients: [
			{
				email: 'alice@example.com',
				name: 'Alice',
				role: 'signer',
				locale: 'en',
				routingOrder: 1
			}
		]
	});
	if (result.outcome !== 'published') throw new Error(`ready failed: ${result.outcome}`);
	return {
		readyAuditEventId: result.result.auditEventId,
		recipientId: result.result.recipients[0].id
	};
}

function insertField(sqlite: DatabaseSync, recipientId: string): void {
	sqlite
		.prepare(
			`INSERT INTO envelope_field (
				id, envelope_id, recipient_id, document_id, document_path, field_type,
				label, required, position, page, x, y, width, height, created_at, updated_at
			) VALUES (?, ?, ?, ?, NULL, 'signature', 'Sign here', 1, 0, 1, 0.1, 0.2, 0.25, 0.05, ?, ?)`
		)
		.run(
			FIELD_ID,
			ENVELOPE_ID,
			recipientId,
			DOCUMENT_ID,
			'2026-09-11T00:02:00.000Z',
			'2026-09-11T00:02:00.000Z'
		);
}

describe('D1EnvelopeReopenStore SQLite integration', () => {
	it('returns a ready envelope to draft, keeps recipients, deletes fields, and increments field_generation', async () => {
		const { sqlite, ready, reopen, fields } = await fixture();
		try {
			const { readyAuditEventId, recipientId } = await readyEnvelope(ready);
			insertField(sqlite, recipientId);
			const before = sqlite
				.prepare(
					'SELECT status, field_generation, repository_generation, repository_head FROM envelope WHERE id = ?'
				)
				.get(ENVELOPE_ID) as {
				status: string;
				field_generation: number;
				repository_generation: number;
				repository_head: string;
			};
			expect(before.status).toBe('ready');
			expect(before.field_generation).toBe(0);

			const authoringBefore = await fields.readAuthoringFields(ENVELOPE_ID);
			expect(authoringBefore?.fields).toEqual([
				expect.objectContaining({ id: FIELD_ID, label: 'Sign here', documentId: DOCUMENT_ID })
			]);

			const result = await reopen.reopen(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'reopen-1',
				expectedGeneration: 1,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: readyAuditEventId
			});
			expect(result).toMatchObject({
				outcome: 'published',
				result: { envelopeId: ENVELOPE_ID, status: 'draft', generation: 1, fieldGeneration: 1 }
			});

			const after = sqlite
				.prepare(
					'SELECT status, field_generation, repository_generation, repository_head, sent_commit_sha FROM envelope WHERE id = ?'
				)
				.get(ENVELOPE_ID) as {
				status: string;
				field_generation: number;
				repository_generation: number;
				repository_head: string;
				sent_commit_sha: string | null;
			};
			expect(after).toMatchObject({
				status: 'draft',
				field_generation: 1,
				repository_generation: 1,
				repository_head: COMMIT_SHA,
				sent_commit_sha: null
			});
			const recipients = sqlite
				.prepare('SELECT id, email FROM recipient WHERE envelope_id = ?')
				.all(ENVELOPE_ID) as { id: string; email: string }[];
			expect(recipients).toEqual([{ id: recipientId, email: 'alice@example.com' }]);
			expect(
				sqlite
					.prepare('SELECT COUNT(*) AS n FROM envelope_field WHERE envelope_id = ?')
					.get(ENVELOPE_ID)
			).toEqual({ n: 0 });
			const authoringAfter = await fields.readAuthoringFields(ENVELOPE_ID);
			expect(authoringAfter).toMatchObject({
				generation: 1,
				fieldGeneration: 1,
				commitSha: COMMIT_SHA,
				fields: []
			});
			const replay = await reopen.reopen(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'reopen-1',
				expectedGeneration: 1,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: readyAuditEventId
			});
			expect(replay.outcome).toBe('replayed');
		} finally {
			sqlite.close();
		}
	});

	it('fails closed when the durable reopen receipt is missing its audit evidence', async () => {
		const { sqlite, ready, reopen } = await fixture();
		try {
			const { readyAuditEventId } = await readyEnvelope(ready);
			const published = await reopen.reopen(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'reopen-evidence',
				expectedGeneration: 1,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: readyAuditEventId
			});
			if (published.outcome !== 'published') throw new Error(published.outcome);
			sqlite.prepare("DELETE FROM audit_event WHERE event_type = 'envelope.reopened'").run();
			const replay = await reopen.reopen(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'reopen-evidence',
				expectedGeneration: 1,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: readyAuditEventId
			});
			expect(replay).toEqual({ outcome: 'integrity_error' });
		} finally {
			sqlite.close();
		}
	});

	it('rejects send that still names a ready event superseded by reopen and a later ready', async () => {
		const { sqlite, database, ready, reopen } = await fixture();
		try {
			const first = await readyEnvelope(ready);
			const reopened = await reopen.reopen(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'reopen-stale-send',
				expectedGeneration: 1,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: first.readyAuditEventId
			});
			expect(reopened.outcome).toBe('published');
			const second = await ready.ready(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'ready-2',
				expectedGeneration: 1,
				recipients: [
					{
						email: 'alice@example.com',
						name: 'Alice',
						role: 'signer',
						locale: 'en',
						routingOrder: 1
					}
				]
			});
			if (second.outcome !== 'published') throw new Error(second.outcome);
			const sendStore = new D1EnvelopeSendStore(database);
			const send = new EnvelopeSendApplication(
				sendStore,
				new AesGcmRecipientCapabilitySealer('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
				new FakeSentDocumentPdf()
			);
			const stale = await send.send(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'send-stale',
				expectedGeneration: 1,
				expectedReadyAuditEventId: first.readyAuditEventId
			});
			expect(stale.outcome).toBe('audit_conflict');
			const current = await sendStore.prepareSend(
				{
					envelopeId: ENVELOPE_ID,
					actorType: 'user',
					actorId: USER_ACTOR.id,
					idempotencyKey: 'send-current',
					requestFingerprint: 'send-current'
				},
				1,
				second.result.auditEventId
			);
			expect(current.outcome).toBe('ready');
		} finally {
			sqlite.close();
		}
	});

	it('increments field_generation across a second reopen after re-ready', async () => {
		const { sqlite, database, ready, reopen } = await fixture();
		try {
			const first = await readyEnvelope(ready);
			const firstReopen = await reopen.reopen(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'reopen-first',
				expectedGeneration: 1,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: first.readyAuditEventId
			});
			expect(firstReopen).toMatchObject({ outcome: 'published', result: { fieldGeneration: 1 } });
			const secondReady = await ready.ready(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'ready-2',
				expectedGeneration: 1,
				recipients: [
					{
						email: 'alice@example.com',
						name: 'Alice',
						role: 'signer',
						locale: 'en',
						routingOrder: 1
					}
				]
			});
			if (secondReady.outcome !== 'published') throw new Error(secondReady.outcome);
			expect(
				await reopen.reopen(USER_ACTOR, ENVELOPE_ID, {
					idempotencyKey: 'reopen-stale-gen',
					expectedGeneration: 2,
					expectedFieldGeneration: 1,
					expectedReadyAuditEventId: secondReady.result.auditEventId
				})
			).toEqual({ outcome: 'generation_conflict' });
			const staleFieldGen = await reopen.reopen(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'reopen-stale-fg',
				expectedGeneration: 1,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: secondReady.result.auditEventId
			});
			expect(staleFieldGen.outcome).toBe('field_generation_conflict');
			const store = new D1EnvelopeReopenStore(database);
			const staleHead = await staleReopenCommand(
				secondReady.result.auditEventId,
				1,
				'not-the-head'
			);
			expect(await store.publishReopen(staleHead)).toEqual({ outcome: 'audit_conflict' });
			expect(
				sqlite
					.prepare('SELECT status, field_generation FROM envelope WHERE id = ?')
					.get(ENVELOPE_ID)
			).toEqual({ status: 'ready', field_generation: 1 });
			expect(sqlite.prepare('SELECT COUNT(*) AS n FROM envelope_reopen_command').get()).toEqual({
				n: 1
			});
			const secondReopen = await reopen.reopen(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'reopen-second',
				expectedGeneration: 1,
				expectedFieldGeneration: 1,
				expectedReadyAuditEventId: secondReady.result.auditEventId
			});
			expect(secondReopen).toMatchObject({
				outcome: 'published',
				result: { fieldGeneration: 2 }
			});
			const head = sqlite
				.prepare(
					'SELECT sequence FROM audit_event WHERE envelope_id = ? ORDER BY sequence DESC LIMIT 1'
				)
				.get(ENVELOPE_ID) as { sequence: number };
			expect(head.sequence).toBeGreaterThan(4);
		} finally {
			sqlite.close();
		}
	});

	it('rejects sent and voided envelopes and rolls a failed publish back', async () => {
		const { sqlite, database, ready, reopen } = await fixture();
		try {
			const { readyAuditEventId, recipientId } = await readyEnvelope(ready);
			insertField(sqlite, recipientId);
			sqlite
				.prepare("UPDATE envelope SET status = 'sent', sent_commit_sha = ? WHERE id = ?")
				.run(COMMIT_SHA, ENVELOPE_ID);
			expect(
				await reopen.reopen(USER_ACTOR, ENVELOPE_ID, {
					idempotencyKey: 'reopen-sent',
					expectedGeneration: 1,
					expectedFieldGeneration: 0,
					expectedReadyAuditEventId: readyAuditEventId
				})
			).toEqual({ outcome: 'not_ready' });
			sqlite
				.prepare("UPDATE envelope SET status = 'voided', sent_commit_sha = NULL WHERE id = ?")
				.run(ENVELOPE_ID);
			expect(
				await reopen.reopen(USER_ACTOR, ENVELOPE_ID, {
					idempotencyKey: 'reopen-voided',
					expectedGeneration: 1,
					expectedFieldGeneration: 0,
					expectedReadyAuditEventId: readyAuditEventId
				})
			).toEqual({ outcome: 'not_ready' });
			sqlite.prepare("UPDATE envelope SET status = 'ready' WHERE id = ?").run(ENVELOPE_ID);
			const store = new D1EnvelopeReopenStore(database);
			const stale = await staleReopenCommand(readyAuditEventId, 0, 'wrong-hash');
			const rolled = await store.publishReopen(stale);
			expect(rolled.outcome).toBe('audit_conflict');
			expect(
				sqlite
					.prepare('SELECT status, field_generation FROM envelope WHERE id = ?')
					.get(ENVELOPE_ID)
			).toEqual({ status: 'ready', field_generation: 0 });
			expect(
				sqlite
					.prepare('SELECT COUNT(*) AS n FROM envelope_field WHERE envelope_id = ?')
					.get(ENVELOPE_ID)
			).toEqual({ n: 1 });
			expect(
				sqlite
					.prepare("SELECT COUNT(*) AS n FROM audit_event WHERE event_type = 'envelope.reopened'")
					.get()
			).toEqual({ n: 0 });
			expect(sqlite.prepare('SELECT COUNT(*) AS n FROM envelope_reopen_command').get()).toEqual({
				n: 0
			});
		} finally {
			sqlite.close();
		}
	});

	it('fails closed on replay corruption, fingerprint mismatch, and cross-envelope key reuse', async () => {
		const { sqlite, ready, reopen } = await fixture();
		try {
			const { readyAuditEventId } = await readyEnvelope(ready);
			const published = await reopen.reopen(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'reopen-replay',
				expectedGeneration: 1,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: readyAuditEventId
			});
			if (published.outcome !== 'published') throw new Error(published.outcome);
			const fingerprintConflict = await reopen.reopen(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'reopen-replay',
				expectedGeneration: 2,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: readyAuditEventId
			});
			expect(fingerprintConflict.outcome).toBe('idempotency_conflict');
			sqlite.prepare('UPDATE envelope_reopen_command SET audit_payload_json = ?').run('{}');
			const payloadCorrupt = await reopen.reopen(USER_ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'reopen-replay',
				expectedGeneration: 1,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: readyAuditEventId
			});
			expect(payloadCorrupt.outcome).toBe('integrity_error');
			const otherId: string = '01910000-0000-7000-8000-000000000099';
			expect(
				await reopen.reopen(USER_ACTOR, otherId, {
					idempotencyKey: 'reopen-replay',
					expectedGeneration: 1,
					expectedFieldGeneration: 0,
					expectedReadyAuditEventId: readyAuditEventId
				})
			).toEqual({ outcome: 'idempotency_conflict' });
		} finally {
			sqlite.close();
		}
	});

	it('rejects a corrupt authoring snapshot instead of omitting the bad row', async () => {
		const { sqlite, ready, fields } = await fixture();
		try {
			const { recipientId } = await readyEnvelope(ready);
			insertField(sqlite, recipientId);
			sqlite.prepare('UPDATE envelope_field SET x = NULL WHERE id = ?').run(FIELD_ID);
			await expect(fields.readAuthoringFields(ENVELOPE_ID)).rejects.toBeInstanceOf(
				AuthoringFieldsIntegrityError
			);
			sqlite.prepare('UPDATE envelope_field SET x = 0.1, label = ? WHERE id = ?').run('', FIELD_ID);
			await expect(fields.readAuthoringFields(ENVELOPE_ID)).rejects.toBeInstanceOf(
				AuthoringFieldsIntegrityError
			);
		} finally {
			sqlite.close();
		}
	});
});

async function staleReopenCommand(
	readyAuditEventId: string,
	expectedFieldGeneration: number,
	previousAuditHash: string
): Promise<PublishReopenedEnvelopeCommand> {
	const requestFingerprint: string = await fingerprintReopenRequest({
		expectedGeneration: 1,
		expectedFieldGeneration,
		expectedReadyAuditEventId: readyAuditEventId
	});
	const auditPayloadJson: string = reopenAuditPayloadJson({
		commitSha: COMMIT_SHA,
		generation: 1,
		fieldGeneration: expectedFieldGeneration + 1,
		readyAuditEventId
	});
	const auditEventHash: string = await hashAuditEventV3(
		{
			sequence: 99,
			eventType: 'envelope.reopened',
			actorType: 'user',
			actorId: USER_ACTOR.id,
			occurredAt: '2026-09-11T00:03:00.000Z',
			payload: JSON.parse(auditPayloadJson) as unknown,
			previousHash: previousAuditHash
		},
		{ envelopeId: ENVELOPE_ID }
	);
	return {
		envelopeId: ENVELOPE_ID,
		actorType: 'user',
		actorId: USER_ACTOR.id,
		idempotencyKey: 'reopen-rollback',
		requestFingerprint,
		expectedGeneration: 1,
		expectedFieldGeneration,
		expectedReadyAuditEventId: readyAuditEventId,
		expectedCommitSha: COMMIT_SHA,
		updatedAt: '2026-09-11T00:03:00.000Z',
		expectedAuditSequence: 98,
		previousAuditHash,
		auditEventId: '01910000-0000-7000-8000-0000000000aa',
		auditEventHash,
		auditPayloadJson
	};
}
