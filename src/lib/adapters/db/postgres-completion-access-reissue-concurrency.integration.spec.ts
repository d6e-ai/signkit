import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAuditEventRecord } from '$lib/application/completion-artifacts/audit-event-integrity';
import { CURRENT_AUDIT_HASH_VERSION, hashAuditEventV3 } from '$lib/domain/audit';
import { newUuidV7 } from '$lib/ids/uuid-v7';
import type {
	ExpectedPredecessorGeneration,
	PublishCompletionAccessReissueCommand,
	PublishCompletionAccessReissueOutcome,
	ReissueAuditHead,
	ReissueCommandKey
} from '$lib/ports/completion-access-reissue';
import { PostgresCompletionAccessReissueStore } from './postgres-completion-access-reissue';

type Sql = ReturnType<typeof postgres>;

const databaseUrl: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const liveDescribe = databaseUrl === undefined ? describe.skip : describe;
const AT: string = '2026-09-11T00:00:00.000Z';
const FAILED_AT: string = '2026-09-13T12:00:00.000Z';
const REISSUED_AT: string = '2026-09-14T12:00:00.000Z';
const JSON_SHA256: string = 'j'.repeat(64);
const MARKDOWN_SHA256: string = 'd'.repeat(64);
const PDF_SHA256: string = 'a'.repeat(64);
const ANCHOR_HEAD: ReissueAuditHead = { sequence: 1, eventHash: 'e'.repeat(64) };
const EVENT_TYPE: string = 'recipient.completion_access_reissued';
const INJECTED_FAILURE: string = 'injected completion access reissue failure';
// Advisory locks are database-wide, so the gate key is per run, not per schema.
const GATE_KEY: number = 1 + Math.floor(Math.random() * 2_000_000_000);
const LOCK_WAIT_TIMEOUT_MS: number = 15_000;

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function deferred(): Deferred {
	let resolve: () => void = (): void => undefined;
	const promise: Promise<void> = new Promise<void>((done: () => void): void => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Attaches a handler immediately so a rejection while the test is still interleaving is never unhandled. */
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
	return promise.then(
		(value: T): Settled<T> => ({ ok: true, value }),
		(error: unknown): Settled<T> => ({ ok: false, error })
	);
}

liveDescribe('PostgresCompletionAccessReissueStore publish concurrency', () => {
	const schema: string = `signkit_access_reissue_race_${newUuidV7().replaceAll('-', '')}`;
	let admin: Sql | null = null;
	const clients: Sql[] = [];

	function connect(): Sql {
		const client: Sql = postgres(databaseUrl as string, {
			max: 1,
			onnotice: (): void => undefined,
			connection: { search_path: schema }
		});
		clients.push(client);
		return client;
	}

	function db(): Sql {
		if (admin === null) throw new Error('PostgreSQL unavailable');
		return admin;
	}

	beforeAll(async () => {
		admin = postgres(databaseUrl as string, { max: 1, onnotice: (): void => undefined });
		await admin.unsafe(`CREATE SCHEMA "${schema}"`);
		await admin.unsafe(`SET search_path TO "${schema}"`);
		for (const file of readdirSync('migrations/postgres')
			.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
			.sort()) {
			await admin.unsafe(readFileSync(`migrations/postgres/${file}`, 'utf8'));
		}
		// Test-schema-only fault injection: a receipt insert whose idempotency
		// key starts with `inject-` waits on the run's advisory gate (while the
		// publishing transaction still holds the envelope lock), then fails with
		// an error the store has no reason to recognize.
		await admin.unsafe(`
			CREATE FUNCTION reissue_race_injected_failure() RETURNS trigger
			LANGUAGE plpgsql AS $$
			BEGIN
				IF NEW.idempotency_key LIKE 'inject-%' THEN
					PERFORM pg_advisory_xact_lock(${GATE_KEY}::bigint);
					RAISE EXCEPTION '${INJECTED_FAILURE}';
				END IF;
				RETURN NEW;
			END;
			$$;
			CREATE TRIGGER reissue_race_injected_failure
			BEFORE INSERT ON completion_access_reissue_command
			FOR EACH ROW EXECUTE FUNCTION reissue_race_injected_failure();`);
	});

	afterAll(async () => {
		for (const client of clients) await client.end({ timeout: 5 });
		if (admin === null) return;
		try {
			await admin.unsafe('SET search_path TO public');
			await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
		} finally {
			await admin.end({ timeout: 5 });
		}
	});

	async function backendPid(client: Sql): Promise<number> {
		const rows = await client<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
		return rows[0].pid;
	}

	/** Polls until `pid` is waiting on a heavyweight lock held by `blockerPid` (or by anyone, when null). */
	async function waitForLockWait(pid: number, blockerPid: number | null): Promise<void> {
		const deadline: number = Date.now() + LOCK_WAIT_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const rows = await db()<{ blockers: number[] }[]>`
				SELECT pg_blocking_pids(${pid}::int) AS blockers`;
			const blockers: number[] = rows[0]?.blockers ?? [];
			if (blockerPid === null ? blockers.length > 0 : blockers.includes(blockerPid)) return;
			await new Promise<void>((done: () => void): void => {
				setTimeout(done, 10);
			});
		}
		throw new Error(`Backend ${pid} never waited on ${blockerPid ?? 'any'} lock holder`);
	}

	async function seedCompletedEnvelope(): Promise<{
		envelopeId: string;
		signerId: string;
		predecessorId: string;
	}> {
		const sql: Sql = db();
		const envelopeId: string = newUuidV7();
		const signerId: string = newUuidV7();
		const anchorId: string = newUuidV7();
		const predecessorId: string = newUuidV7();
		const ownerId: string = `access-reissue-race-owner-${newUuidV7()}`;
		await sql`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES (${ownerId}, 'owner', 'active', ${AT}::timestamptz, ${AT}::timestamptz)`;
		await sql`INSERT INTO envelope (id, created_by_user_id, title, status, repository_generation,
			repository_head, sent_commit_sha, created_at, updated_at)
			VALUES (${envelopeId}, ${ownerId}, 'Synthetic completion access race fixture', 'completed', 1,
				'commit-1', 'commit-1', ${AT}::timestamptz, ${AT}::timestamptz)`;
		await sql`INSERT INTO recipient (id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at)
			VALUES (${signerId}, ${envelopeId}, 'signer@example.com', 'Signer', 'signer', 'en', 1, 'completed', ${AT}::timestamptz, ${AT}::timestamptz)`;
		await sql`INSERT INTO audit_event (id, envelope_id, sequence, event_type, actor_type,
			actor_id, payload_json, previous_hash, event_hash, occurred_at)
			VALUES (${anchorId}, ${envelopeId}, ${ANCHOR_HEAD.sequence}, 'envelope.completed', 'recipient',
				${signerId}, '{}', NULL, ${ANCHOR_HEAD.eventHash}, ${AT}::timestamptz)`;
		await sql`INSERT INTO completion_artifact (envelope_id, schema_version, manifest_sha256,
			json_object_key, json_sha256, markdown_object_key, markdown_sha256, sent_commit_sha,
			field_generation, anchor_audit_event_id, audit_head_sequence, audit_head_event_hash, published_at, audit_event_id)
			VALUES (${envelopeId}, 1, ${'m'.repeat(64)}, 'completion/example.json.gz', ${JSON_SHA256},
				'completion/example.md.gz', ${MARKDOWN_SHA256}, 'commit-1', 0, ${anchorId}, 1, ${ANCHOR_HEAD.eventHash}, ${AT}::timestamptz, ${newUuidV7()})`;
		await sql`INSERT INTO completion_artifact_pdf (envelope_id, pdf_object_key, pdf_sha256, pdf_byte_size,
			pdf_manifest_object_key, pdf_manifest_sha256, published_at)
			VALUES (${envelopeId}, 'completion/example.pdf', ${PDF_SHA256}, 128, 'completion/pdf-manifest.json.gz', ${'b'.repeat(64)}, ${AT}::timestamptz)`;
		await sql`INSERT INTO completion_delivery_outbox (
			id, envelope_id, recipient_id, status, token_hash, access_expires_at,
			access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
			available_at, attempts, locked_at, claim_token, delivered_at,
			provider_message_id, last_error, retryable, created_at, updated_at
		) VALUES (
			${predecessorId}, ${envelopeId}, ${signerId}, 'failed', ${uniqueTokenHash()},
			'2026-09-12T00:00:00.000Z'::timestamptz, ${FAILED_AT}::timestamptz, NULL, 'key-1', ${'2'.repeat(64)},
			${AT}::timestamptz, 10, NULL, NULL, NULL, NULL, 'completion_delivery_attempts_exhausted',
			false, ${AT}::timestamptz, ${FAILED_AT}::timestamptz
		)`;
		return { envelopeId, signerId, predecessorId };
	}

	function uniqueTokenHash(): string {
		return newUuidV7().replaceAll('-', '').padEnd(64, '8');
	}

	function expected(): ExpectedPredecessorGeneration {
		return {
			expectedAttempts: 10,
			expectedFailedAt: FAILED_AT,
			expectedErrorCode: 'completion_delivery_attempts_exhausted'
		};
	}

	function keyFor(
		fixture: { envelopeId: string; signerId: string; predecessorId: string },
		idempotencyKey: string,
		actorId: string = 'race-operator'
	): ReissueCommandKey {
		return {
			envelopeId: fixture.envelopeId,
			recipientId: fixture.signerId,
			predecessorDeliveryId: fixture.predecessorId,
			actorType: 'user',
			actorId,
			idempotencyKey,
			requestHash: `request-${idempotencyKey}`
		};
	}

	/** Mirrors the service: fresh delivery/audit ids and a real v3 hash per call, so duplicates differ in everything but key and body. */
	async function buildCommand(
		key: ReissueCommandKey,
		head: ReissueAuditHead = ANCHOR_HEAD
	): Promise<PublishCompletionAccessReissueCommand> {
		const newDeliveryId: string = newUuidV7();
		const auditPayloadJson: string = JSON.stringify({
			recipientId: key.recipientId,
			predecessorDeliveryId: key.predecessorDeliveryId,
			deliveryId: newDeliveryId,
			reissuedAt: REISSUED_AT
		});
		const auditEventHash: string = await hashAuditEventV3(
			{
				sequence: head.sequence + 1,
				eventType: EVENT_TYPE,
				actorType: key.actorType,
				actorId: key.actorId,
				occurredAt: REISSUED_AT,
				payload: JSON.parse(auditPayloadJson) as unknown,
				previousHash: head.eventHash
			},
			{ envelopeId: key.envelopeId }
		);
		return {
			...key,
			...expected(),
			newDeliveryId,
			newTokenHash: uniqueTokenHash(),
			newAccessExpiresAt: '2026-10-14T12:00:00.000Z',
			sealedToken: `skcd1_sealed-${newDeliveryId}`,
			sealingKeyId: 'key-1',
			sealedTokenSha256: '7'.repeat(64),
			reissuedAt: REISSUED_AT,
			expectedAuditSequence: head.sequence,
			previousAuditHash: head.eventHash,
			auditEventId: newUuidV7(),
			auditEventHash,
			auditPayloadJson,
			expectedJsonSha256: JSON_SHA256,
			expectedMarkdownSha256: MARKDOWN_SHA256,
			expectedPdfSha256: PDF_SHA256
		};
	}

	async function countReissueRows(
		fixture: { envelopeId: string; predecessorId: string },
		idempotencyKey: string
	): Promise<{ successors: number; commands: number; audits: number; head: number }> {
		const rows = await db()<
			{ successors: number; commands: number; audits: number; head: number }[]
		>`
			SELECT
				(SELECT COUNT(*)::int FROM completion_delivery_outbox
					WHERE predecessor_delivery_id = ${fixture.predecessorId}) AS successors,
				(SELECT COUNT(*)::int FROM completion_access_reissue_command
					WHERE idempotency_key = ${idempotencyKey}) AS commands,
				(SELECT COUNT(*)::int FROM audit_event
					WHERE envelope_id = ${fixture.envelopeId} AND event_type = ${EVENT_TYPE}) AS audits,
				(SELECT MAX(sequence)::int FROM audit_event
					WHERE envelope_id = ${fixture.envelopeId}) AS head`;
		return rows[0];
	}

	/**
	 * Holds the envelope row lock from a third connection, queues `first`
	 * then `second` publishReissue calls behind it (each proven to be waiting
	 * on a lock before the next step), then releases the lock.
	 */
	async function raceBehindEnvelopeLock(
		envelopeId: string,
		firstCommand: PublishCompletionAccessReissueCommand,
		secondCommand: PublishCompletionAccessReissueCommand
	): Promise<PublishCompletionAccessReissueOutcome[]> {
		const blocker: Sql = connect();
		const first: Sql = connect();
		const second: Sql = connect();
		const blockerPid: number = await backendPid(blocker);
		const firstPid: number = await backendPid(first);
		const secondPid: number = await backendPid(second);

		const locked: Deferred = deferred();
		const release: Deferred = deferred();
		const holding: Promise<Settled<unknown>> = settle(
			blocker.begin(async (transaction): Promise<void> => {
				await transaction`SELECT id FROM envelope WHERE id = ${envelopeId} FOR UPDATE`;
				locked.resolve();
				await release.promise;
			})
		);
		await locked.promise;

		const firstCall: Promise<Settled<PublishCompletionAccessReissueOutcome>> = settle(
			new PostgresCompletionAccessReissueStore(first).publishReissue(firstCommand)
		);
		await waitForLockWait(firstPid, blockerPid);
		const secondCall: Promise<Settled<PublishCompletionAccessReissueOutcome>> = settle(
			new PostgresCompletionAccessReissueStore(second).publishReissue(secondCommand)
		);
		await waitForLockWait(secondPid, null);

		release.resolve();
		expect((await holding).ok).toBe(true);
		const settled: Settled<PublishCompletionAccessReissueOutcome>[] = await Promise.all([
			firstCall,
			secondCall
		]);
		return settled.map((result: Settled<PublishCompletionAccessReissueOutcome>) => {
			if (!result.ok) throw result.error;
			return result.value;
		});
	}

	it('replays a same-key duplicate that queued on the envelope lock behind the winning publish', async () => {
		const fixture = await seedCompletedEnvelope();
		const key: ReissueCommandKey = keyFor(fixture, 'race-same-key');
		const outcomes: PublishCompletionAccessReissueOutcome[] = await raceBehindEnvelopeLock(
			fixture.envelopeId,
			await buildCommand(key),
			await buildCommand(key)
		);

		const published = outcomes.filter(
			(outcome: PublishCompletionAccessReissueOutcome): boolean => outcome.outcome === 'published'
		);
		const replayed = outcomes.filter(
			(outcome: PublishCompletionAccessReissueOutcome): boolean => outcome.outcome === 'replayed'
		);
		expect(published).toHaveLength(1);
		expect(replayed).toHaveLength(1);
		expect(replayed[0].result).toEqual(published[0].result);
		expect(published[0].result?.generation).toBe(1);
		expect(await countReissueRows(fixture, key.idempotencyKey)).toEqual({
			successors: 1,
			commands: 1,
			audits: 1,
			head: 2
		});
	});

	it('keeps a different-key duplicate queued on the same lock a stale generation', async () => {
		const fixture = await seedCompletedEnvelope();
		const keyA: ReissueCommandKey = keyFor(fixture, 'race-key-a');
		const keyB: ReissueCommandKey = keyFor(fixture, 'race-key-b');
		const outcomes: PublishCompletionAccessReissueOutcome[] = await raceBehindEnvelopeLock(
			fixture.envelopeId,
			await buildCommand(keyA),
			await buildCommand(keyB)
		);

		expect(
			outcomes.map((outcome: PublishCompletionAccessReissueOutcome) => outcome.outcome)
		).toEqual(expect.arrayContaining(['published', 'stale_generation']));
		const counts = await countReissueRows(fixture, 'race-key-a');
		const countsB = await countReissueRows(fixture, 'race-key-b');
		expect(counts.successors).toBe(1);
		expect(counts.audits).toBe(1);
		expect(counts.head).toBe(2);
		expect(counts.commands + countsB.commands).toBe(1);
	});

	it('replays the immutable receipt after the successor token is resealed and scrubbed', async () => {
		const fixture = await seedCompletedEnvelope();
		const key: ReissueCommandKey = keyFor(fixture, 'race-scrub');
		const store = new PostgresCompletionAccessReissueStore(connect());
		const published: PublishCompletionAccessReissueOutcome = await store.publishReissue(
			await buildCommand(key)
		);
		expect(published.outcome).toBe('published');
		const deliveryId: string = published.result?.deliveryId ?? '';

		await db()`UPDATE completion_delivery_outbox
			SET sealed_token = 'skcd1_resealed-blob', sealing_key_id = 'key-2',
				sealed_token_sha256 = ${'6'.repeat(64)}, updated_at = now()
			WHERE id = ${deliveryId}`;
		const afterReseal: PublishCompletionAccessReissueOutcome = await store.publishReissue(
			await buildCommand(key)
		);
		expect(afterReseal).toEqual({ outcome: 'replayed', result: published.result });

		await db()`UPDATE completion_delivery_outbox
			SET status = 'delivered', retryable = false, sealed_token = NULL,
				delivered_at = now(), updated_at = now()
			WHERE id = ${deliveryId}`;
		const afterScrub: PublishCompletionAccessReissueOutcome = await store.publishReissue(
			await buildCommand(key)
		);
		expect(afterScrub).toEqual({ outcome: 'replayed', result: published.result });
		await expect(store.prepareReissue(key, expected())).resolves.toEqual({
			outcome: 'replayed',
			result: published.result
		});

		const conflicting: ReissueCommandKey = { ...key, requestHash: 'request-different-body' };
		await expect(store.publishReissue(await buildCommand(conflicting))).resolves.toEqual({
			outcome: 'idempotency_conflict'
		});
		expect(await countReissueRows(fixture, key.idempotencyKey)).toEqual({
			successors: 1,
			commands: 1,
			audits: 1,
			head: 2
		});
	});

	it('propagates an unrecognized failure, rolled back, while the audit head is unchanged', async () => {
		const fixture = await seedCompletedEnvelope();
		const key: ReissueCommandKey = keyFor(fixture, 'inject-unexpected');
		const store = new PostgresCompletionAccessReissueStore(connect());

		await expect(store.publishReissue(await buildCommand(key))).rejects.toThrow(INJECTED_FAILURE);
		expect(await countReissueRows(fixture, key.idempotencyKey)).toEqual({
			successors: 0,
			commands: 0,
			audits: 0,
			head: 1
		});
	});

	it('classifies a failure after a concurrent audit writer took the head as a retryable integrity error', async () => {
		const fixture = await seedCompletedEnvelope();
		const key: ReissueCommandKey = keyFor(fixture, 'inject-head-moved');
		const gate: Sql = connect();
		const writer: Sql = connect();
		const publisher: Sql = connect();
		const gatePid: number = await backendPid(gate);
		const writerPid: number = await backendPid(writer);
		const publisherPid: number = await backendPid(publisher);
		const command: PublishCompletionAccessReissueCommand = await buildCommand(key);
		const concurrentEventId: string = newUuidV7();
		const concurrentHead: ReissueAuditHead = { sequence: 2, eventHash: 'c'.repeat(64) };

		// 1. The publisher holds the envelope lock and parks inside its receipt insert.
		await gate`SELECT pg_advisory_lock(${GATE_KEY}::bigint)`;
		const publishing: Promise<Settled<PublishCompletionAccessReissueOutcome>> = settle(
			new PostgresCompletionAccessReissueStore(publisher).publishReissue(command)
		);
		await waitForLockWait(publisherPid, gatePid);

		// 2. Another audit writer (no envelope FOR UPDATE) appends the next
		// sequence; its foreign-key check queues on the publisher's lock.
		const inserted: Deferred = deferred();
		const commit: Deferred = deferred();
		const writing: Promise<Settled<unknown>> = settle(
			writer.begin(async (transaction): Promise<void> => {
				await transaction`INSERT INTO audit_event (id, envelope_id, sequence, event_type, actor_type,
					actor_id, payload_json, previous_hash, event_hash, occurred_at)
					VALUES (${concurrentEventId}, ${fixture.envelopeId}, ${concurrentHead.sequence},
						'recipient.capability_reissued', 'user', 'other-operator', '{}',
						${ANCHOR_HEAD.eventHash}, ${concurrentHead.eventHash}, ${REISSUED_AT}::timestamptz)`;
				inserted.resolve();
				await commit.promise;
			})
		);
		await waitForLockWait(writerPid, publisherPid);

		// 3. The publisher fails and rolls back; the writer gets the envelope,
		// and the publisher's failure classification queues behind the writer.
		await gate`SELECT pg_advisory_unlock(${GATE_KEY}::bigint)`;
		await inserted.promise;
		await waitForLockWait(publisherPid, writerPid);

		// 4. Only once the head change is committed does the classification read it.
		commit.resolve();
		expect((await writing).ok).toBe(true);
		expect(await publishing).toEqual({ ok: true, value: { outcome: 'integrity_error' } });

		expect(await countReissueRows(fixture, key.idempotencyKey)).toEqual({
			successors: 0,
			commands: 0,
			audits: 0,
			head: 2
		});
		const rolledBack = await db()<{ n: number }[]>`
			SELECT COUNT(*)::int AS n FROM completion_delivery_outbox WHERE id = ${command.newDeliveryId}`;
		expect(rolledBack[0].n).toBe(0);

		// Retryable: re-prepared from the new head, the same request publishes.
		const store = new PostgresCompletionAccessReissueStore(publisher);
		const prepared = await store.prepareReissue(
			{ ...key, idempotencyKey: 'race-retry' },
			expected()
		);
		expect(prepared).toEqual({
			outcome: 'ready',
			predecessorGeneration: 0,
			auditHead: concurrentHead
		});
		const retried: PublishCompletionAccessReissueOutcome = await store.publishReissue(
			await buildCommand({ ...key, idempotencyKey: 'race-retry' }, concurrentHead)
		);
		expect(retried.outcome).toBe('published');
		expect(await countReissueRows(fixture, 'race-retry')).toEqual({
			successors: 1,
			commands: 1,
			audits: 1,
			head: 3
		});
	});

	it('fans a published reissue out only to subscribed webhooks with a verifiable audit record', async () => {
		const fixture = await seedCompletedEnvelope();
		const subscribedId: string = newUuidV7();
		const unsubscribedId: string = newUuidV7();
		for (const [endpointId, events] of [
			[subscribedId, [EVENT_TYPE]],
			[unsubscribedId, ['envelope.completed']]
		] as const) {
			await db()`INSERT INTO webhook_endpoint (id, url, description, status, events_json,
				secret_hash, signing_secret, secret_prefix, created_at, created_by_user_id)
				VALUES (${endpointId}, 'https://hooks.example.com/signkit', NULL, 'active',
					${JSON.stringify(events)}, ${'f'.repeat(64)}, ${`skwh1_${'x'.repeat(43)}`},
					'skwh1_xxxxxxxx', ${AT}::timestamptz, 'webhook-owner')`;
		}
		const key: ReissueCommandKey = { ...keyFor(fixture, 'race-webhook'), actorType: 'agent' };
		const command: PublishCompletionAccessReissueCommand = await buildCommand(key);
		const store = new PostgresCompletionAccessReissueStore(connect());
		expect((await store.publishReissue(command)).outcome).toBe('published');

		const outbox = await db()<{ endpointId: string; eventType: string }[]>`
			SELECT endpoint_id AS "endpointId", event_type AS "eventType"
			FROM webhook_outbox WHERE audit_event_id = ${command.auditEventId}`;
		expect(outbox).toEqual([{ endpointId: subscribedId, eventType: EVENT_TYPE }]);

		const stored = await db()<
			{
				id: string;
				sequence: number;
				eventType: string;
				actorType: string;
				actorId: string | null;
				payloadJson: string;
				previousHash: string | null;
				eventHash: string;
				occurredAt: Date;
			}[]
		>`
			SELECT id, sequence::int AS sequence, event_type AS "eventType", actor_type AS "actorType",
				actor_id AS "actorId", payload_json AS "payloadJson", previous_hash AS "previousHash",
				event_hash AS "eventHash", occurred_at AS "occurredAt"
			FROM audit_event WHERE id = ${command.auditEventId}`;
		const record = {
			...stored[0],
			occurredAt: stored[0].occurredAt.toISOString(),
			hashVersion: CURRENT_AUDIT_HASH_VERSION
		};
		await expect(
			verifyAuditEventRecord(record, { envelopeId: fixture.envelopeId })
		).resolves.toEqual(JSON.parse(command.auditPayloadJson));
		await expect(
			verifyAuditEventRecord({ ...record, actorType: 'system' }, { envelopeId: fixture.envelopeId })
		).rejects.toThrow('Completion audit event has an unexpected actor type');
	});
});
