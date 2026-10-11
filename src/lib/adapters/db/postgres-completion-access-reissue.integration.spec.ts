import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUuidV7 } from '$lib/ids/uuid-v7';
import { PostgresCompletionAccessReissueStore } from './postgres-completion-access-reissue';
import type {
	ExpectedPredecessorGeneration,
	PublishCompletionAccessReissueCommand,
	ReissueCommandKey
} from '$lib/ports/completion-access-reissue';

const databaseUrl: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const liveDescribe = databaseUrl === undefined ? describe.skip : describe;
const AT: string = '2026-09-11T00:00:00.000Z';
const JSON_SHA256: string = 'j'.repeat(64);
const MARKDOWN_SHA256: string = 'd'.repeat(64);
const PDF_SHA256: string = 'a'.repeat(64);
const FAILED_AT: string = '2026-09-13T12:00:00.000Z';

liveDescribe('PostgresCompletionAccessReissueStore integration', () => {
	const schema: string = `signkit_access_reissue_${newUuidV7().replaceAll('-', '')}`;
	let sql: ReturnType<typeof postgres> | null = null;

	beforeAll(async () => {
		sql = postgres(databaseUrl as string, { max: 1, onnotice: (): void => undefined });
		await sql.unsafe(`CREATE SCHEMA "${schema}"`);
		await sql.unsafe(`SET search_path TO "${schema}"`);
		for (const file of readdirSync('migrations/postgres')
			.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
			.sort()) {
			await sql.unsafe(readFileSync(`migrations/postgres/${file}`, 'utf8'));
		}
	});

	afterAll(async () => {
		if (sql === null) return;
		try {
			await sql.unsafe('SET search_path TO public');
			await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
		} finally {
			await sql.end({ timeout: 5 });
		}
	});

	async function seedCompletedEnvelope(): Promise<{
		envelopeId: string;
		signerId: string;
		approverId: string;
		predecessorId: string;
		approverDeliveryId: string;
	}> {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const envelopeId: string = newUuidV7();
		const signerId: string = newUuidV7();
		const approverId: string = newUuidV7();
		const anchorId: string = newUuidV7();
		const predecessorId: string = newUuidV7();
		const approverDeliveryId: string = newUuidV7();
		const ownerId: string = `access-reissue-owner-${newUuidV7()}`;
		await sql`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES (${ownerId}, 'owner', 'active', ${AT}::timestamptz, ${AT}::timestamptz)`;
		await sql`INSERT INTO envelope (id, created_by_user_id, title, status, repository_generation,
			repository_head, sent_commit_sha, created_at, updated_at)
			VALUES (${envelopeId}, ${ownerId}, 'Synthetic completion access fixture', 'completed', 1,
				'commit-1', 'commit-1', ${AT}::timestamptz, ${AT}::timestamptz)`;
		await sql`INSERT INTO recipient (id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at)
			VALUES
				(${signerId}, ${envelopeId}, 'signer@example.com', 'Signer', 'signer', 'en', 1, 'completed', ${AT}::timestamptz, ${AT}::timestamptz),
				(${approverId}, ${envelopeId}, 'approver@example.com', 'Approver', 'approver', 'en', 2, 'completed', ${AT}::timestamptz, ${AT}::timestamptz)`;
		await sql`INSERT INTO audit_event (id, envelope_id, sequence, event_type, actor_type,
			actor_id, payload_json, previous_hash, event_hash, occurred_at)
			VALUES (${anchorId}, ${envelopeId}, 1, 'envelope.completed', 'system', NULL, '{}', NULL, ${'e'.repeat(64)}, ${AT}::timestamptz)`;
		await sql`INSERT INTO completion_artifact (envelope_id, schema_version, manifest_sha256,
			json_object_key, json_sha256, markdown_object_key, markdown_sha256, sent_commit_sha,
			field_generation, anchor_audit_event_id, audit_head_sequence, audit_head_event_hash, published_at, audit_event_id)
			VALUES (${envelopeId}, 1, ${'m'.repeat(64)}, 'completion/example.json.gz', ${JSON_SHA256},
				'completion/example.md.gz', ${MARKDOWN_SHA256}, 'commit-1', 0, ${anchorId}, 1, ${'e'.repeat(64)}, ${AT}::timestamptz, ${newUuidV7()})`;
		await sql`INSERT INTO completion_artifact_pdf (envelope_id, pdf_object_key, pdf_sha256, pdf_byte_size,
			pdf_manifest_object_key, pdf_manifest_sha256, published_at)
			VALUES (${envelopeId}, 'completion/example.pdf', ${PDF_SHA256}, 128, 'completion/pdf-manifest.json.gz', ${'b'.repeat(64)}, ${AT}::timestamptz)`;
		const predecessorTokenHash: string = newUuidV7().replaceAll('-', '').padEnd(64, '1');
		const approverTokenHash: string = newUuidV7().replaceAll('-', '').padEnd(64, '3');
		await sql`INSERT INTO completion_delivery_outbox (
			id, envelope_id, recipient_id, status, token_hash, access_expires_at,
			access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
			available_at, attempts, locked_at, claim_token, delivered_at,
			provider_message_id, last_error, retryable, created_at, updated_at
		) VALUES (
			${predecessorId}, ${envelopeId}, ${signerId}, 'failed', ${predecessorTokenHash},
			'2026-09-12T00:00:00.000Z'::timestamptz, ${FAILED_AT}::timestamptz, NULL, 'key-1', ${'2'.repeat(64)},
			${AT}::timestamptz, 10, NULL, NULL, NULL, NULL, 'completion_delivery_attempts_exhausted',
			false, ${AT}::timestamptz, ${FAILED_AT}::timestamptz
		)`;
		await sql`INSERT INTO completion_delivery_outbox (
			id, envelope_id, recipient_id, status, token_hash, access_expires_at,
			access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
			available_at, attempts, locked_at, claim_token, delivered_at,
			provider_message_id, last_error, retryable, created_at, updated_at
		) VALUES (
			${approverDeliveryId}, ${envelopeId}, ${approverId}, 'pending', ${approverTokenHash},
			'2026-09-12T00:00:00.000Z'::timestamptz, NULL, 'sealed-blob', 'key-1', ${'4'.repeat(64)},
			${AT}::timestamptz, 0, NULL, NULL, NULL, NULL, NULL,
			true, ${AT}::timestamptz, ${AT}::timestamptz
		)`;
		return { envelopeId, signerId, approverId, predecessorId, approverDeliveryId };
	}

	function expected(): ExpectedPredecessorGeneration {
		return {
			expectedAttempts: 10,
			expectedFailedAt: FAILED_AT,
			expectedErrorCode: 'completion_delivery_attempts_exhausted'
		};
	}

	it('publishes a successor chain, locks envelope-first, and leaves the predecessor byte-identical', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const { envelopeId, signerId, predecessorId } = await seedCompletedEnvelope();
		const store = new PostgresCompletionAccessReissueStore(sql);

		const key: ReissueCommandKey = {
			envelopeId,
			recipientId: signerId,
			predecessorDeliveryId: predecessorId,
			actorType: 'user',
			actorId: newUuidV7(),
			idempotencyKey: 'idemp-pg-1',
			requestHash: 'hash-pg-1'
		};
		const prep = await store.prepareReissue(key, expected());
		expect(prep.outcome).toBe('ready');
		if (prep.outcome !== 'ready') return;
		expect(prep.predecessorGeneration).toBe(0);

		const newDeliveryId: string = newUuidV7();
		const command: PublishCompletionAccessReissueCommand = {
			...key,
			...expected(),
			newDeliveryId,
			newTokenHash: 'f'.repeat(64),
			newAccessExpiresAt: '2026-10-11T12:00:00.000Z',
			sealedToken: 'skcd1_new-sealed-blob',
			sealingKeyId: 'key-1',
			sealedTokenSha256: '7'.repeat(64),
			reissuedAt: '2026-09-13T12:00:00.000Z',
			expectedAuditSequence: prep.auditHead!.sequence,
			previousAuditHash: prep.auditHead!.eventHash,
			auditEventId: newUuidV7(),
			auditEventHash: '9'.repeat(64),
			auditPayloadJson: JSON.stringify({ recipientId: signerId }),
			expectedJsonSha256: JSON_SHA256,
			expectedMarkdownSha256: MARKDOWN_SHA256,
			expectedPdfSha256: PDF_SHA256
		};
		const published = await store.publishReissue(command);
		expect(published.outcome).toBe('published');
		if (published.outcome !== 'published') return;
		expect(published.result?.generation).toBe(1);

		const predecessorRows = await sql<
			{ status: string; attempts: number; last_error: string; sealed_token: string | null }[]
		>`SELECT status, attempts, last_error, sealed_token FROM completion_delivery_outbox WHERE id = ${predecessorId}`;
		expect(predecessorRows[0].status).toBe('failed');
		expect(predecessorRows[0].attempts).toBe(10);
		expect(predecessorRows[0].last_error).toBe('completion_delivery_attempts_exhausted');
		expect(predecessorRows[0].sealed_token).toBeNull();

		const successorRows = await sql<
			{ generation: number; predecessor_delivery_id: string; status: string }[]
		>`SELECT generation, predecessor_delivery_id, status FROM completion_delivery_outbox WHERE id = ${newDeliveryId}`;
		expect(successorRows[0].generation).toBe(1);
		expect(successorRows[0].predecessor_delivery_id).toBe(predecessorId);
		expect(successorRows[0].status).toBe('pending');

		const replay = await store.prepareReissue(key, expected());
		expect(replay.outcome).toBe('replayed');
		if (replay.outcome !== 'replayed') return;
		expect(replay.result?.deliveryId).toBe(newDeliveryId);
	});

	it.each([
		['mail_recipient_rejected', 1],
		['delivery_not_eligible', 0]
	] as const)(
		'reissues terminal %s without requiring retry exhaustion',
		async (errorCode, attempts) => {
			if (sql === null) throw new Error('PostgreSQL unavailable');
			const { envelopeId, signerId, predecessorId } = await seedCompletedEnvelope();
			await sql`UPDATE completion_delivery_outbox SET attempts = ${attempts},
			last_error = ${errorCode}, failure_cause_code = ${errorCode} WHERE id = ${predecessorId}`;
			const before =
				await sql`SELECT * FROM completion_delivery_outbox WHERE id = ${predecessorId}`;
			const store = new PostgresCompletionAccessReissueStore(sql);
			const key: ReissueCommandKey = {
				envelopeId,
				recipientId: signerId,
				predecessorDeliveryId: predecessorId,
				actorType: 'user',
				actorId: newUuidV7(),
				idempotencyKey: newUuidV7(),
				requestHash: 'terminal-policy'
			};
			const observed = { ...expected(), expectedAttempts: attempts, expectedErrorCode: errorCode };
			const prep = await store.prepareReissue(key, observed);
			expect(prep.outcome).toBe('ready');
			if (prep.outcome !== 'ready') return;
			const command: PublishCompletionAccessReissueCommand = {
				...key,
				...observed,
				newDeliveryId: newUuidV7(),
				newTokenHash: newUuidV7().replaceAll('-', '').repeat(2),
				newAccessExpiresAt: '2026-10-13T12:00:00.000Z',
				sealedToken: 'skcd1_new-sealed-blob',
				sealingKeyId: 'key-1',
				sealedTokenSha256: '7'.repeat(64),
				reissuedAt: FAILED_AT,
				expectedAuditSequence: prep.auditHead!.sequence,
				previousAuditHash: prep.auditHead!.eventHash,
				auditEventId: newUuidV7(),
				auditEventHash: '9'.repeat(64),
				auditPayloadJson: JSON.stringify({ recipientId: signerId }),
				expectedJsonSha256: JSON_SHA256,
				expectedMarkdownSha256: MARKDOWN_SHA256,
				expectedPdfSha256: PDF_SHA256
			};
			expect((await store.publishReissue(command)).outcome).toBe('published');
			expect(
				await sql`SELECT * FROM completion_delivery_outbox WHERE id = ${predecessorId}`
			).toEqual(before);
		}
	);

	it('rejects publication when the completion PDF digest no longer matches at write time', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const { envelopeId, approverId, approverDeliveryId } = await seedCompletedEnvelope();
		// Mark the approver's delivery as its own exhausted generation for this test.
		await sql`UPDATE completion_delivery_outbox
			SET status = 'failed', retryable = false, access_revoked_at = ${FAILED_AT}::timestamptz,
				sealed_token = NULL, attempts = 10, last_error = 'completion_delivery_attempts_exhausted',
				updated_at = ${FAILED_AT}::timestamptz
			WHERE id = ${approverDeliveryId}`;
		const store = new PostgresCompletionAccessReissueStore(sql);

		const key: ReissueCommandKey = {
			envelopeId,
			recipientId: approverId,
			predecessorDeliveryId: approverDeliveryId,
			actorType: 'user',
			actorId: newUuidV7(),
			idempotencyKey: 'idemp-pg-2',
			requestHash: 'hash-pg-2'
		};
		const prep = await store.prepareReissue(key, expected());
		expect(prep.outcome).toBe('ready');
		if (prep.outcome !== 'ready') return;

		const command: PublishCompletionAccessReissueCommand = {
			...key,
			...expected(),
			newDeliveryId: newUuidV7(),
			newTokenHash: 'f'.repeat(64),
			newAccessExpiresAt: '2026-10-11T12:00:00.000Z',
			sealedToken: 'skcd1_new-sealed-blob',
			sealingKeyId: 'key-1',
			sealedTokenSha256: '7'.repeat(64),
			reissuedAt: '2026-09-13T12:00:00.000Z',
			expectedAuditSequence: prep.auditHead!.sequence,
			previousAuditHash: prep.auditHead!.eventHash,
			auditEventId: newUuidV7(),
			auditEventHash: '9'.repeat(64),
			auditPayloadJson: JSON.stringify({ recipientId: approverId }),
			expectedJsonSha256: JSON_SHA256,
			expectedMarkdownSha256: MARKDOWN_SHA256,
			expectedPdfSha256: 'f'.repeat(64)
		};
		const published = await store.publishReissue(command);
		expect(published.outcome).toBe('integrity_error');

		const rows = await sql<
			{ n: string }[]
		>`SELECT COUNT(*)::text AS n FROM completion_delivery_outbox
			WHERE recipient_id = ${approverId}`;
		expect(rows[0].n).toBe('1');
	});

	it('rejects a stale generation once the predecessor already has a successor', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const { envelopeId, signerId, predecessorId } = await seedCompletedEnvelope();
		const store = new PostgresCompletionAccessReissueStore(sql);
		const key: ReissueCommandKey = {
			envelopeId,
			recipientId: signerId,
			predecessorDeliveryId: predecessorId,
			actorType: 'user',
			actorId: newUuidV7(),
			idempotencyKey: 'idemp-pg-3',
			requestHash: 'hash-pg-3'
		};
		const prep = await store.prepareReissue(key, expected());
		if (prep.outcome !== 'ready') throw new Error('expected ready');
		await store.publishReissue({
			...key,
			...expected(),
			newDeliveryId: newUuidV7(),
			newTokenHash: newUuidV7().replaceAll('-', '').padEnd(64, '8'),
			newAccessExpiresAt: '2026-10-11T12:00:00.000Z',
			sealedToken: 'skcd1_new-sealed-blob',
			sealingKeyId: 'key-1',
			sealedTokenSha256: '7'.repeat(64),
			reissuedAt: '2026-09-13T12:00:00.000Z',
			expectedAuditSequence: prep.auditHead!.sequence,
			previousAuditHash: prep.auditHead!.eventHash,
			auditEventId: newUuidV7(),
			auditEventHash: '9'.repeat(64),
			auditPayloadJson: '{}',
			expectedJsonSha256: JSON_SHA256,
			expectedMarkdownSha256: MARKDOWN_SHA256,
			expectedPdfSha256: PDF_SHA256
		});

		const staleKey: ReissueCommandKey = {
			...key,
			idempotencyKey: 'idemp-pg-4',
			requestHash: 'hash-pg-4'
		};
		const stale = await store.prepareReissue(staleKey, expected());
		expect(stale.outcome).toBe('stale_generation');
	});

	it('aborts the whole write when a concurrent audit event moved the head before publish, without partial rows', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const { envelopeId, signerId, predecessorId } = await seedCompletedEnvelope();
		const store = new PostgresCompletionAccessReissueStore(sql);
		const key: ReissueCommandKey = {
			envelopeId,
			recipientId: signerId,
			predecessorDeliveryId: predecessorId,
			actorType: 'user',
			actorId: newUuidV7(),
			idempotencyKey: 'idemp-pg-5',
			requestHash: 'hash-pg-5'
		};
		const prep = await store.prepareReissue(key, expected());
		if (prep.outcome !== 'ready') throw new Error('expected ready');
		const staleAuditHead = {
			sequence: prep.auditHead!.sequence,
			eventHash: prep.auditHead!.eventHash
		};

		// A concurrent, unrelated audit event lands on this envelope between this
		// process's prepare read and its publish write.
		const racingEventId: string = newUuidV7();
		await sql`INSERT INTO audit_event (id, envelope_id, sequence, event_type, actor_type,
			actor_id, payload_json, previous_hash, event_hash, occurred_at)
			VALUES (${racingEventId}, ${envelopeId}, 2, 'envelope.voided', 'user', ${newUuidV7()}, '{}',
				${staleAuditHead.eventHash}, ${'c'.repeat(64)}, '2026-09-13T11:59:00.000Z'::timestamptz)`;

		const newDeliveryId: string = newUuidV7();
		const published = await store.publishReissue({
			...key,
			...expected(),
			newDeliveryId,
			newTokenHash: newUuidV7().replaceAll('-', '').padEnd(64, '9'),
			newAccessExpiresAt: '2026-10-11T12:00:00.000Z',
			sealedToken: 'skcd1_new-sealed-blob',
			sealingKeyId: 'key-1',
			sealedTokenSha256: '7'.repeat(64),
			reissuedAt: '2026-09-13T12:00:00.000Z',
			expectedAuditSequence: staleAuditHead.sequence,
			previousAuditHash: staleAuditHead.eventHash,
			auditEventId: newUuidV7(),
			auditEventHash: '9'.repeat(64),
			auditPayloadJson: '{}',
			expectedJsonSha256: JSON_SHA256,
			expectedMarkdownSha256: MARKDOWN_SHA256,
			expectedPdfSha256: PDF_SHA256
		});
		expect(published.outcome).toBe('integrity_error');

		const outboxRows = await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n
			FROM completion_delivery_outbox WHERE recipient_id = ${signerId}`;
		expect(outboxRows[0].n).toBe('1');
		const auditRows = await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n
			FROM audit_event WHERE envelope_id = ${envelopeId}`;
		expect(auditRows[0].n).toBe('2');
		const commandRows = await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n
			FROM completion_access_reissue_command WHERE idempotency_key = 'idemp-pg-5'`;
		expect(commandRows[0].n).toBe('0');

		const retried = await store.publishReissue({
			...key,
			...expected(),
			newDeliveryId,
			newTokenHash: newUuidV7().replaceAll('-', '').padEnd(64, '9'),
			newAccessExpiresAt: '2026-10-11T12:00:00.000Z',
			sealedToken: 'skcd1_new-sealed-blob',
			sealingKeyId: 'key-1',
			sealedTokenSha256: '7'.repeat(64),
			reissuedAt: '2026-09-13T12:00:00.000Z',
			expectedAuditSequence: 2,
			previousAuditHash: 'c'.repeat(64),
			auditEventId: newUuidV7(),
			auditEventHash: '8'.repeat(64),
			auditPayloadJson: '{}',
			expectedJsonSha256: JSON_SHA256,
			expectedMarkdownSha256: MARKDOWN_SHA256,
			expectedPdfSha256: PDF_SHA256
		});
		expect(retried.outcome).toBe('published');
	});

	it('continues replaying the original receipt after the successor is resealed under a rotated key and later scrubbed', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const { envelopeId, signerId, predecessorId } = await seedCompletedEnvelope();
		const store = new PostgresCompletionAccessReissueStore(sql);
		const key: ReissueCommandKey = {
			envelopeId,
			recipientId: signerId,
			predecessorDeliveryId: predecessorId,
			actorType: 'user',
			actorId: newUuidV7(),
			idempotencyKey: 'idemp-pg-6',
			requestHash: 'hash-pg-6'
		};
		const prep = await store.prepareReissue(key, expected());
		if (prep.outcome !== 'ready') throw new Error('expected ready');
		const newDeliveryId: string = newUuidV7();
		const published = await store.publishReissue({
			...key,
			...expected(),
			newDeliveryId,
			newTokenHash: newUuidV7().replaceAll('-', '').padEnd(64, '7'),
			newAccessExpiresAt: '2026-10-11T12:00:00.000Z',
			sealedToken: 'skcd1_new-sealed-blob',
			sealingKeyId: 'key-1',
			sealedTokenSha256: '7'.repeat(64),
			reissuedAt: '2026-09-13T12:00:00.000Z',
			expectedAuditSequence: prep.auditHead!.sequence,
			previousAuditHash: prep.auditHead!.eventHash,
			auditEventId: newUuidV7(),
			auditEventHash: '9'.repeat(64),
			auditPayloadJson: '{}',
			expectedJsonSha256: JSON_SHA256,
			expectedMarkdownSha256: MARKDOWN_SHA256,
			expectedPdfSha256: PDF_SHA256
		});
		expect(published.outcome).toBe('published');

		await sql`UPDATE completion_delivery_outbox
			SET sealed_token = 'skcd1_resealed-under-key-2', sealing_key_id = 'key-2',
				sealed_token_sha256 = ${'d'.repeat(64)}
			WHERE id = ${newDeliveryId}`;
		const replayAfterReseal = await store.prepareReissue(key, expected());
		expect(replayAfterReseal.outcome).toBe('replayed');
		if (replayAfterReseal.outcome !== 'replayed') return;
		expect(replayAfterReseal.result?.deliveryId).toBe(newDeliveryId);

		await sql`UPDATE completion_delivery_outbox
			SET status = 'failed', retryable = false, access_revoked_at = '2026-10-13T00:00:00.000Z'::timestamptz,
				sealed_token = NULL, attempts = 10, last_error = 'completion_delivery_attempts_exhausted'
			WHERE id = ${newDeliveryId}`;
		const replayAfterScrub = await store.prepareReissue(key, expected());
		expect(replayAfterScrub.outcome).toBe('replayed');
		if (replayAfterScrub.outcome !== 'replayed') return;
		expect(replayAfterScrub.result?.deliveryId).toBe(newDeliveryId);
		expect(replayAfterScrub.result?.generation).toBe(1);
	});
});
