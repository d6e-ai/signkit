import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';
import { EnvelopeAuthoringFieldsRead } from '$lib/application/envelopes/fields';
import { EnvelopeReadyApplication } from '$lib/application/envelopes/ready';
import { EnvelopeReopenApplication } from '$lib/application/envelopes/reopen';
import { hashAuditEventV3 } from '$lib/domain/audit';
import { fingerprintReopenRequest, reopenAuditPayloadJson } from '$lib/domain/commands/reopen';
import { AuthoringFieldsIntegrityError } from '$lib/ports/envelope-field-store';
import type { PublishReopenedEnvelopeCommand } from '$lib/ports/envelope-reopen-store';
import { PostgresEnvelopeFieldStore } from './postgres-envelope-field-store';
import { PostgresEnvelopeReadyStore } from './postgres-envelope-ready-store';
import { PostgresEnvelopeReopenStore } from './postgres-envelope-reopen-store';
import { PostgresEnvelopeSendStore } from './postgres-envelope-send-store';

const TEST_DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const postgresDescribe = TEST_DATABASE_URL === undefined ? describe.skip : describe;
const USER_ID: string = 'user-1';
const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const SEND_ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000002';
const SECOND_REOPEN_ID: string = '01900000-0000-7000-8000-000000000003';
const REJECT_ID: string = '01900000-0000-7000-8000-000000000004';
const CORRUPT_ID: string = '01900000-0000-7000-8000-000000000005';
const REPLAY_ID: string = '01900000-0000-7000-8000-000000000006';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const FIELD_ID: string = '01900000-0000-7000-8000-000000000031';
const DOCUMENT_ID: string = '01900000-0000-7000-8000-000000000021';
const GENESIS_OCCURRED_AT: string = '2026-09-11T00:00:00.000Z';
const USER_ACTOR: EnvelopeRequestActor = { id: USER_ID, createdByUserId: USER_ID };
const MIGRATION_PATHS: readonly string[] = readdirSync('migrations/postgres')
	.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
	.sort()
	.map((name: string): string => `migrations/postgres/${name}`);

let sql: ReturnType<typeof postgres> | null = null;
const schemaName: string = `signkit_reopen_${process.pid}_${randomUUID().replaceAll('-', '')}`;

postgresDescribe('PostgresEnvelopeReopenStore PG18 integration', () => {
	beforeAll(async () => {
		sql = postgres(TEST_DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
		await sql.unsafe(`SET search_path TO "${schemaName}"`);
		for (const path of MIGRATION_PATHS) await sql.unsafe(readFileSync(path, 'utf8'));
		const genesisHash: string = await hashAuditEventV3(
			{
				sequence: 1,
				eventType: 'envelope.created',
				actorType: 'user',
				actorId: USER_ID,
				occurredAt: GENESIS_OCCURRED_AT,
				payload: {},
				previousHash: null
			},
			{ envelopeId: ENVELOPE_ID }
		);
		const sendGenesisHash: string = await hashAuditEventV3(
			{
				sequence: 1,
				eventType: 'envelope.created',
				actorType: 'user',
				actorId: USER_ID,
				occurredAt: GENESIS_OCCURRED_AT,
				payload: {},
				previousHash: null
			},
			{ envelopeId: SEND_ENVELOPE_ID }
		);
		await sql`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES (${USER_ID}, 'owner', 'active', ${GENESIS_OCCURRED_AT}, ${GENESIS_OCCURRED_AT})`;
		await sql`INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, repository_head,
			repository_archive_key, repository_archive_sha256, created_at, updated_at
		) VALUES (
			${ENVELOPE_ID}, ${USER_ID}, 'Agreement', 'draft', 1, ${COMMIT_SHA},
			'archives/integration.git.gz', ${'a'.repeat(64)},
			${GENESIS_OCCURRED_AT}, '2026-09-11T00:01:00.000Z'
		)`;
		await sql`INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, repository_head,
			repository_archive_key, repository_archive_sha256, created_at, updated_at
		) VALUES (
			${SEND_ENVELOPE_ID}, ${USER_ID}, 'Agreement', 'draft', 1, ${COMMIT_SHA},
			'archives/integration.git.gz', ${'a'.repeat(64)},
			${GENESIS_OCCURRED_AT}, '2026-09-11T00:01:00.000Z'
		)`;
		await sql`INSERT INTO audit_event (
			id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at, hash_version
		) VALUES (
			'01900000-0000-7000-8000-000000000010', ${ENVELOPE_ID}, 1, 'envelope.created', 'user',
			${USER_ID}, '{}', NULL, ${genesisHash}, ${GENESIS_OCCURRED_AT}, 3
		)`;
		await sql`INSERT INTO audit_event (
			id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at, hash_version
		) VALUES (
			'01900000-0000-7000-8000-000000000011', ${SEND_ENVELOPE_ID}, 1, 'envelope.created', 'user',
			${USER_ID}, '{}', NULL, ${sendGenesisHash}, ${GENESIS_OCCURRED_AT}, 3
		)`;
		const extraEnvelopes: readonly { id: string; auditId: string }[] = [
			{ id: SECOND_REOPEN_ID, auditId: '01900000-0000-7000-8000-000000000012' },
			{ id: REJECT_ID, auditId: '01900000-0000-7000-8000-000000000013' },
			{ id: CORRUPT_ID, auditId: '01900000-0000-7000-8000-000000000014' },
			{ id: REPLAY_ID, auditId: '01900000-0000-7000-8000-000000000015' }
		];
		for (const extra of extraEnvelopes) {
			const extraHash: string = await hashAuditEventV3(
				{
					sequence: 1,
					eventType: 'envelope.created',
					actorType: 'user',
					actorId: USER_ID,
					occurredAt: GENESIS_OCCURRED_AT,
					payload: {},
					previousHash: null
				},
				{ envelopeId: extra.id }
			);
			await sql`INSERT INTO envelope (
				id, created_by_user_id, title, status, repository_generation, repository_head,
				repository_archive_key, repository_archive_sha256, created_at, updated_at
			) VALUES (
				${extra.id}, ${USER_ID}, 'Agreement', 'draft', 1, ${COMMIT_SHA},
				'archives/integration.git.gz', ${'a'.repeat(64)},
				${GENESIS_OCCURRED_AT}, '2026-09-11T00:01:00.000Z'
			)`;
			await sql`INSERT INTO audit_event (
				id, envelope_id, sequence, event_type, actor_type, actor_id,
				payload_json, previous_hash, event_hash, occurred_at, hash_version
			) VALUES (
				${extra.auditId}, ${extra.id}, 1, 'envelope.created', 'user',
				${USER_ID}, '{}', NULL, ${extraHash}, ${GENESIS_OCCURRED_AT}, 3
			)`;
		}
	});

	afterAll(async () => {
		if (sql === null) return;
		await sql.unsafe('SET search_path TO public');
		await sql.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
		await sql.end({ timeout: 5 });
		sql = null;
	});

	it('applies the reopen forward migration and returns ready to draft without resetting field_generation', async () => {
		const client: ReturnType<typeof postgres> = sql as ReturnType<typeof postgres>;
		const ready = new EnvelopeReadyApplication(new PostgresEnvelopeReadyStore(client));
		const reopen = new EnvelopeReopenApplication(new PostgresEnvelopeReopenStore(client));
		const fields = new EnvelopeAuthoringFieldsRead(new PostgresEnvelopeFieldStore(client));
		const prepared = await ready.ready(USER_ACTOR, ENVELOPE_ID, {
			idempotencyKey: 'ready-pg-1',
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
		if (prepared.outcome !== 'published') throw new Error(prepared.outcome);
		await client`INSERT INTO envelope_field (
			id, envelope_id, recipient_id, document_id, document_path, field_type,
			label, required, position, page, x, y, width, height, created_at, updated_at
		) VALUES (
			${FIELD_ID}, ${ENVELOPE_ID}, ${prepared.result.recipients[0].id}, ${DOCUMENT_ID}, NULL,
			'signature', 'Sign here', true, 0, 1, 0.1, 0.2, 0.25, 0.05,
			'2026-09-11T00:02:00.000Z', '2026-09-11T00:02:00.000Z'
		)`;
		const authoringBefore = await fields.readAuthoringFields(ENVELOPE_ID);
		expect(authoringBefore?.fields[0]?.label).toBe('Sign here');

		const result = await reopen.reopen(USER_ACTOR, ENVELOPE_ID, {
			idempotencyKey: 'reopen-pg-1',
			expectedGeneration: 1,
			expectedFieldGeneration: 0,
			expectedReadyAuditEventId: prepared.result.auditEventId
		});
		expect(result).toMatchObject({
			outcome: 'published',
			result: { status: 'draft', generation: 1, fieldGeneration: 1 }
		});
		const rows = await client<
			{ status: string; fieldGeneration: number; repositoryHead: string }[]
		>`SELECT status, field_generation AS "fieldGeneration", repository_head AS "repositoryHead"
			FROM envelope WHERE id = ${ENVELOPE_ID}`;
		expect(rows[0]).toMatchObject({
			status: 'draft',
			fieldGeneration: 1,
			repositoryHead: COMMIT_SHA
		});
		const remaining = await client<{ n: number }[]>`
			SELECT COUNT(*)::int AS n FROM envelope_field WHERE envelope_id = ${ENVELOPE_ID}`;
		expect(remaining[0]?.n).toBe(0);
		const recipients = await client<{ email: string }[]>`
			SELECT email FROM recipient WHERE envelope_id = ${ENVELOPE_ID}`;
		expect(recipients.map((row) => row.email)).toEqual(['alice@example.com']);
		const authoringAfter = await fields.readAuthoringFields(ENVELOPE_ID);
		expect(authoringAfter).toMatchObject({ fieldGeneration: 1, fields: [] });
		const replay = await reopen.reopen(USER_ACTOR, ENVELOPE_ID, {
			idempotencyKey: 'reopen-pg-1',
			expectedGeneration: 1,
			expectedFieldGeneration: 0,
			expectedReadyAuditEventId: prepared.result.auditEventId
		});
		expect(replay.outcome).toBe('replayed');
	});

	it('rejects a send that still names a ready event superseded by reopen and a later ready', async () => {
		const client: ReturnType<typeof postgres> = sql as ReturnType<typeof postgres>;
		const ready = new EnvelopeReadyApplication(new PostgresEnvelopeReadyStore(client));
		const reopen = new EnvelopeReopenApplication(new PostgresEnvelopeReopenStore(client));
		const sendStore = new PostgresEnvelopeSendStore(client);
		const first = await ready.ready(USER_ACTOR, SEND_ENVELOPE_ID, {
			idempotencyKey: 'ready-pg-stale-send',
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
		if (first.outcome !== 'published') throw new Error(first.outcome);
		const reopened = await reopen.reopen(USER_ACTOR, SEND_ENVELOPE_ID, {
			idempotencyKey: 'reopen-pg-stale-send',
			expectedGeneration: 1,
			expectedFieldGeneration: 0,
			expectedReadyAuditEventId: first.result.auditEventId
		});
		expect(reopened.outcome).toBe('published');
		const second = await ready.ready(USER_ACTOR, SEND_ENVELOPE_ID, {
			idempotencyKey: 'ready-pg-latest',
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
		const stale = await sendStore.prepareSend(
			{
				envelopeId: SEND_ENVELOPE_ID,
				actorType: 'user',
				actorId: USER_ID,
				idempotencyKey: 'send-pg-stale',
				requestFingerprint: 'send-pg-stale'
			},
			1,
			first.result.auditEventId
		);
		expect(stale.outcome).toBe('audit_conflict');
		const current = await sendStore.prepareSend(
			{
				envelopeId: SEND_ENVELOPE_ID,
				actorType: 'user',
				actorId: USER_ID,
				idempotencyKey: 'send-pg-current',
				requestFingerprint: 'send-pg-current'
			},
			1,
			second.result.auditEventId
		);
		expect(current.outcome).toBe('ready');
	});

	it('increments field_generation across a second reopen after re-ready', async () => {
		const client: ReturnType<typeof postgres> = sql as ReturnType<typeof postgres>;
		const ready = new EnvelopeReadyApplication(new PostgresEnvelopeReadyStore(client));
		const reopen = new EnvelopeReopenApplication(new PostgresEnvelopeReopenStore(client));
		const first = await ready.ready(USER_ACTOR, SECOND_REOPEN_ID, {
			idempotencyKey: 'ready-second-1',
			expectedGeneration: 1,
			recipients: [
				{ email: 'alice@example.com', name: 'Alice', role: 'signer', locale: 'en', routingOrder: 1 }
			]
		});
		if (first.outcome !== 'published') throw new Error(first.outcome);
		expect(
			await reopen.reopen(USER_ACTOR, SECOND_REOPEN_ID, {
				idempotencyKey: 'reopen-second-1',
				expectedGeneration: 1,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: first.result.auditEventId
			})
		).toMatchObject({ outcome: 'published', result: { fieldGeneration: 1 } });
		const secondReady = await ready.ready(USER_ACTOR, SECOND_REOPEN_ID, {
			idempotencyKey: 'ready-second-2',
			expectedGeneration: 1,
			recipients: [
				{ email: 'alice@example.com', name: 'Alice', role: 'signer', locale: 'en', routingOrder: 1 }
			]
		});
		if (secondReady.outcome !== 'published') throw new Error(secondReady.outcome);
		expect(
			await reopen.reopen(USER_ACTOR, SECOND_REOPEN_ID, {
				idempotencyKey: 'reopen-second-stale-gen',
				expectedGeneration: 2,
				expectedFieldGeneration: 1,
				expectedReadyAuditEventId: secondReady.result.auditEventId
			})
		).toEqual({ outcome: 'generation_conflict' });
		expect(
			await reopen.reopen(USER_ACTOR, SECOND_REOPEN_ID, {
				idempotencyKey: 'reopen-second-stale-fg',
				expectedGeneration: 1,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: secondReady.result.auditEventId
			})
		).toEqual({ outcome: 'field_generation_conflict' });
		expect(
			await reopen.reopen(USER_ACTOR, SECOND_REOPEN_ID, {
				idempotencyKey: 'reopen-second-2',
				expectedGeneration: 1,
				expectedFieldGeneration: 1,
				expectedReadyAuditEventId: secondReady.result.auditEventId
			})
		).toMatchObject({ outcome: 'published', result: { fieldGeneration: 2 } });
	});

	it('rejects sent and voided envelopes and rolls a colliding publish back', async () => {
		const client: ReturnType<typeof postgres> = sql as ReturnType<typeof postgres>;
		const ready = new EnvelopeReadyApplication(new PostgresEnvelopeReadyStore(client));
		const reopen = new EnvelopeReopenApplication(new PostgresEnvelopeReopenStore(client));
		const store = new PostgresEnvelopeReopenStore(client);
		const prepared = await ready.ready(USER_ACTOR, REJECT_ID, {
			idempotencyKey: 'ready-reject',
			expectedGeneration: 1,
			recipients: [
				{ email: 'alice@example.com', name: 'Alice', role: 'signer', locale: 'en', routingOrder: 1 }
			]
		});
		if (prepared.outcome !== 'published') throw new Error(prepared.outcome);
		await client`INSERT INTO envelope_field (
			id, envelope_id, recipient_id, document_id, document_path, field_type,
			label, required, position, page, x, y, width, height, created_at, updated_at
		) VALUES (
			'01900000-0000-7000-8000-000000000032', ${REJECT_ID}, ${prepared.result.recipients[0].id},
			${DOCUMENT_ID}, NULL, 'signature', 'Sign here', true, 0, 1, 0.1, 0.2, 0.25, 0.05,
			'2026-09-11T00:02:00.000Z', '2026-09-11T00:02:00.000Z'
		)`;
		await client`UPDATE envelope SET status = 'sent', sent_commit_sha = ${COMMIT_SHA} WHERE id = ${REJECT_ID}`;
		expect(
			await reopen.reopen(USER_ACTOR, REJECT_ID, {
				idempotencyKey: 'reopen-sent',
				expectedGeneration: 1,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: prepared.result.auditEventId
			})
		).toEqual({ outcome: 'not_ready' });
		await client`UPDATE envelope SET status = 'voided', sent_commit_sha = NULL WHERE id = ${REJECT_ID}`;
		expect(
			await reopen.reopen(USER_ACTOR, REJECT_ID, {
				idempotencyKey: 'reopen-voided',
				expectedGeneration: 1,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: prepared.result.auditEventId
			})
		).toEqual({ outcome: 'not_ready' });
		await client`UPDATE envelope SET status = 'ready' WHERE id = ${REJECT_ID}`;
		const head = await client<{ sequence: number; eventHash: string }[]>`
			SELECT sequence, event_hash AS "eventHash"
			FROM audit_event WHERE envelope_id = ${REJECT_ID}
			ORDER BY sequence DESC LIMIT 1`;
		if (head[0] === undefined) throw new Error('missing audit head');
		const colliding: PublishReopenedEnvelopeCommand = await collidingReopenCommand(
			REJECT_ID,
			prepared.result.auditEventId,
			head[0],
			'01900000-0000-7000-8000-000000000013'
		);
		await expect(store.publishReopen(colliding)).rejects.toThrow();
		const rows = await client<{ status: string; fieldGeneration: number; fields: number }[]>`
			SELECT e.status, e.field_generation AS "fieldGeneration",
				(SELECT COUNT(*)::int FROM envelope_field f WHERE f.envelope_id = e.id) AS fields
			FROM envelope e WHERE e.id = ${REJECT_ID}`;
		expect(rows[0]).toMatchObject({ status: 'ready', fieldGeneration: 0, fields: 1 });
		const reopened = await client<{ n: number }[]>`
			SELECT COUNT(*)::int AS n FROM audit_event
			WHERE envelope_id = ${REJECT_ID} AND event_type = 'envelope.reopened'`;
		expect(reopened[0]?.n).toBe(0);
		const commands = await client<{ n: number }[]>`
			SELECT COUNT(*)::int AS n FROM envelope_reopen_command WHERE envelope_id = ${REJECT_ID}`;
		expect(commands[0]?.n).toBe(0);
	});

	it('fails closed on replay corruption, fingerprint mismatch, and cross-envelope key reuse', async () => {
		const client: ReturnType<typeof postgres> = sql as ReturnType<typeof postgres>;
		const ready = new EnvelopeReadyApplication(new PostgresEnvelopeReadyStore(client));
		const reopen = new EnvelopeReopenApplication(new PostgresEnvelopeReopenStore(client));
		const prepared = await ready.ready(USER_ACTOR, REPLAY_ID, {
			idempotencyKey: 'ready-replay',
			expectedGeneration: 1,
			recipients: [
				{ email: 'alice@example.com', name: 'Alice', role: 'signer', locale: 'en', routingOrder: 1 }
			]
		});
		if (prepared.outcome !== 'published') throw new Error(prepared.outcome);
		const published = await reopen.reopen(USER_ACTOR, REPLAY_ID, {
			idempotencyKey: 'reopen-replay',
			expectedGeneration: 1,
			expectedFieldGeneration: 0,
			expectedReadyAuditEventId: prepared.result.auditEventId
		});
		if (published.outcome !== 'published') throw new Error(published.outcome);
		expect(
			await reopen.reopen(USER_ACTOR, REPLAY_ID, {
				idempotencyKey: 'reopen-replay',
				expectedGeneration: 2,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: prepared.result.auditEventId
			})
		).toEqual({ outcome: 'idempotency_conflict' });
		await client`UPDATE envelope_reopen_command SET audit_payload_json = '{}'
			WHERE envelope_id = ${REPLAY_ID}`;
		expect(
			await reopen.reopen(USER_ACTOR, REPLAY_ID, {
				idempotencyKey: 'reopen-replay',
				expectedGeneration: 1,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: prepared.result.auditEventId
			})
		).toEqual({ outcome: 'integrity_error' });
		expect(
			await reopen.reopen(USER_ACTOR, '01900000-0000-7000-8000-000000000099', {
				idempotencyKey: 'reopen-replay',
				expectedGeneration: 1,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: prepared.result.auditEventId
			})
		).toEqual({ outcome: 'idempotency_conflict' });
	});

	it('rejects a corrupt authoring snapshot instead of omitting the bad row', async () => {
		const client: ReturnType<typeof postgres> = sql as ReturnType<typeof postgres>;
		const ready = new EnvelopeReadyApplication(new PostgresEnvelopeReadyStore(client));
		const fields = new EnvelopeAuthoringFieldsRead(new PostgresEnvelopeFieldStore(client));
		const prepared = await ready.ready(USER_ACTOR, CORRUPT_ID, {
			idempotencyKey: 'ready-corrupt',
			expectedGeneration: 1,
			recipients: [
				{ email: 'alice@example.com', name: 'Alice', role: 'signer', locale: 'en', routingOrder: 1 }
			]
		});
		if (prepared.outcome !== 'published') throw new Error(prepared.outcome);
		await client`INSERT INTO envelope_field (
			id, envelope_id, recipient_id, document_id, document_path, field_type,
			label, required, position, page, x, y, width, height, created_at, updated_at
		) VALUES (
			'01900000-0000-7000-8000-000000000033', ${CORRUPT_ID}, ${prepared.result.recipients[0].id},
			${DOCUMENT_ID}, NULL, 'signature', 'Sign here', true, 0, 1, 0.1, 0.2, 0.25, 0.05,
			'2026-09-11T00:02:00.000Z', '2026-09-11T00:02:00.000Z'
		)`;
		await client`UPDATE envelope_field SET label = '' WHERE envelope_id = ${CORRUPT_ID}`;
		await expect(fields.readAuthoringFields(CORRUPT_ID)).rejects.toBeInstanceOf(
			AuthoringFieldsIntegrityError
		);
	});
});

async function collidingReopenCommand(
	envelopeId: string,
	readyAuditEventId: string,
	auditHead: { sequence: number; eventHash: string },
	auditEventId: string
): Promise<PublishReopenedEnvelopeCommand> {
	const requestFingerprint: string = await fingerprintReopenRequest({
		expectedGeneration: 1,
		expectedFieldGeneration: 0,
		expectedReadyAuditEventId: readyAuditEventId
	});
	const auditPayloadJson: string = reopenAuditPayloadJson({
		commitSha: COMMIT_SHA,
		generation: 1,
		fieldGeneration: 1,
		readyAuditEventId
	});
	return {
		envelopeId,
		actorType: 'user',
		actorId: USER_ID,
		idempotencyKey: 'reopen-collide',
		requestFingerprint,
		expectedGeneration: 1,
		expectedFieldGeneration: 0,
		expectedReadyAuditEventId: readyAuditEventId,
		expectedCommitSha: COMMIT_SHA,
		updatedAt: '2026-09-11T00:03:00.000Z',
		expectedAuditSequence: Number(auditHead.sequence),
		previousAuditHash: String(auditHead.eventHash),
		auditEventId,
		auditEventHash: 'e'.repeat(64),
		auditPayloadJson
	};
}
