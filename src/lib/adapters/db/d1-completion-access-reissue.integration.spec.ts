import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1CompletionAccessReissueStore } from './d1-completion-access-reissue';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';
import type {
	ExpectedPredecessorGeneration,
	PublishCompletionAccessReissueCommand,
	ReissueCommandKey
} from '$lib/ports/completion-access-reissue';

// Node:sqlite emulates D1's SQL dialect and trigger semantics for this test;
// it never runs inside actual Cloudflare workerd. The parent integration
// suite verifies the migration against real workerd separately.

const ENVELOPE_ID: string = '01970000-0000-7000-8000-000000000001';
const SIGNER_ID: string = '01970000-0000-7000-8000-000000000002';
const APPROVER_ID: string = '01970000-0000-7000-8000-000000000003';
const VIEWER_ID: string = '01970000-0000-7000-8000-000000000004';
const PREDECESSOR_ID: string = '01970000-0000-7000-8000-000000000010';
const APPROVER_DELIVERY_ID: string = '01970000-0000-7000-8000-000000000011';
const VIEWER_DELIVERY_ID: string = '01970000-0000-7000-8000-000000000012';
const USER_ID: string = '01970000-0000-7000-8000-000000000099';
const JSON_SHA256: string = 'j'.repeat(64);
const MARKDOWN_SHA256: string = 'd'.repeat(64);
const PDF_SHA256: string = 'a'.repeat(64);
const FAILED_AT: string = '2026-09-13T12:00:00.000Z';

function createFixture(): { database: D1Database; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	return { database: sqliteD1Database(sqlite), sqlite };
}

function seedCompletedEnvelope(sqlite: DatabaseSync): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('user-1', 'owner', 'active', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z');

		INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, repository_head,
			sent_commit_sha, repository_archive_key, repository_archive_sha256, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}', 'user-1', 'Completed Agreement', 'completed', 1, 'commit-1',
			'commit-1', 'archive-key', '${'c'.repeat(64)}', '2026-09-11T00:00:00.000Z', '2026-09-11T00:02:00.000Z'
		);

		INSERT INTO recipient (
			id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES
			('${SIGNER_ID}', '${ENVELOPE_ID}', 'signer@example.com', 'Signer', 'signer', 'en', 1, 'completed', '2026-09-11T00:01:00.000Z', '2026-09-11T00:02:00.000Z'),
			('${APPROVER_ID}', '${ENVELOPE_ID}', 'approver@example.com', 'Approver', 'approver', 'en', 2, 'completed', '2026-09-11T00:01:00.000Z', '2026-09-11T00:02:00.000Z'),
			('${VIEWER_ID}', '${ENVELOPE_ID}', 'viewer@example.com', 'Viewer', 'viewer', 'en', 3, 'completed', '2026-09-11T00:01:00.000Z', '2026-09-11T00:02:00.000Z');

		INSERT INTO audit_event (
			id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'01970000-0000-7000-8000-000000000020', '${ENVELOPE_ID}', 1, 'envelope.completed', 'system', 'system',
			'{}', '${'0'.repeat(64)}', '${'e'.repeat(64)}', '2026-09-11T00:02:00.000Z'
		);

		INSERT INTO completion_artifact (
			envelope_id, schema_version, manifest_sha256,
			json_object_key, json_sha256, markdown_object_key, markdown_sha256,
			sent_commit_sha, field_generation, anchor_audit_event_id,
			audit_head_sequence, audit_head_event_hash, published_at, audit_event_id
		) VALUES (
			'${ENVELOPE_ID}', 1, '${'m'.repeat(64)}',
			'completion-artifacts/v1/envelopes/${ENVELOPE_ID}/sha256/${JSON_SHA256}.json.gz', '${JSON_SHA256}',
			'completion-artifacts/v1/envelopes/${ENVELOPE_ID}/sha256/${MARKDOWN_SHA256}.md.gz', '${MARKDOWN_SHA256}',
			'commit-1', 0, '01970000-0000-7000-8000-000000000020', 1, '${'e'.repeat(64)}', '2026-09-11T00:03:00.000Z', '01970000-0000-7000-8000-000000000021'
		);
		INSERT INTO completion_artifact_pdf (
			envelope_id, pdf_object_key, pdf_sha256, pdf_byte_size,
			pdf_manifest_object_key, pdf_manifest_sha256, published_at
		) VALUES (
			'${ENVELOPE_ID}', 'completion-artifacts/v1/envelopes/${ENVELOPE_ID}/sha256/${PDF_SHA256}.pdf', '${PDF_SHA256}', 128,
			'completion/pdf-manifest.json.gz', '${'b'.repeat(64)}', '2026-09-11T00:03:00.000Z'
		);

		INSERT INTO completion_delivery_outbox (
			id, envelope_id, recipient_id, status, token_hash, access_expires_at,
			access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
			available_at, attempts, locked_at, claim_token, delivered_at,
			provider_message_id, last_error, retryable, created_at, updated_at,
			generation, predecessor_delivery_id, failure_cause_code
		) VALUES (
			'${PREDECESSOR_ID}', '${ENVELOPE_ID}', '${SIGNER_ID}', 'failed', '${'1'.repeat(64)}',
			'2026-09-12T00:00:00.000Z', '${FAILED_AT}', NULL, 'key-1', '${'2'.repeat(64)}',
			'2026-09-11T00:04:00.000Z', 10, NULL, NULL, NULL, NULL, 'completion_delivery_attempts_exhausted',
			0, '2026-09-11T00:04:00.000Z', '${FAILED_AT}', 0, NULL, NULL
		);

		INSERT INTO completion_delivery_outbox (
			id, envelope_id, recipient_id, status, token_hash, access_expires_at,
			access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
			available_at, attempts, locked_at, claim_token, delivered_at,
			provider_message_id, last_error, retryable, created_at, updated_at,
			generation, predecessor_delivery_id, failure_cause_code
		) VALUES (
			'${APPROVER_DELIVERY_ID}', '${ENVELOPE_ID}', '${APPROVER_ID}', 'pending', '${'3'.repeat(64)}',
			'2026-09-12T00:00:00.000Z', NULL, 'sealed-blob', 'key-1', '${'4'.repeat(64)}',
			'2026-09-11T00:04:00.000Z', 0, NULL, NULL, NULL, NULL, NULL,
			1, '2026-09-11T00:04:00.000Z', '2026-09-11T00:04:00.000Z', 0, NULL, NULL
		);

		INSERT INTO completion_delivery_outbox (
			id, envelope_id, recipient_id, status, token_hash, access_expires_at,
			access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
			available_at, attempts, locked_at, claim_token, delivered_at,
			provider_message_id, last_error, retryable, created_at, updated_at,
			generation, predecessor_delivery_id, failure_cause_code
		) VALUES (
			'${VIEWER_DELIVERY_ID}', '${ENVELOPE_ID}', '${VIEWER_ID}', 'failed', '${'5'.repeat(64)}',
			'2026-09-12T00:00:00.000Z', '${FAILED_AT}', NULL, 'key-1', '${'6'.repeat(64)}',
			'2026-09-11T00:04:00.000Z', 10, NULL, NULL, NULL, NULL, 'completion_delivery_attempts_exhausted',
			0, '2026-09-11T00:04:00.000Z', '${FAILED_AT}', 0, NULL, NULL
		);
	`);
}

function expected(): ExpectedPredecessorGeneration {
	return {
		expectedAttempts: 10,
		expectedFailedAt: FAILED_AT,
		expectedErrorCode: 'completion_delivery_attempts_exhausted'
	};
}

function keyFor(
	idempotencyKey: string,
	requestHash: string,
	predecessorDeliveryId: string = PREDECESSOR_ID,
	recipientId: string = SIGNER_ID
): ReissueCommandKey {
	return {
		envelopeId: ENVELOPE_ID,
		recipientId,
		predecessorDeliveryId,
		actorType: 'user',
		actorId: USER_ID,
		idempotencyKey,
		requestHash
	};
}

function commandFor(
	key: ReissueCommandKey,
	newDeliveryId: string,
	overrides: Partial<PublishCompletionAccessReissueCommand> = {}
): PublishCompletionAccessReissueCommand {
	return {
		...key,
		...expected(),
		newDeliveryId,
		newTokenHash: 'f'.repeat(64),
		newAccessExpiresAt: '2026-10-11T12:00:00.000Z',
		sealedToken: 'skcd1_new-sealed-blob',
		sealingKeyId: 'key-1',
		sealedTokenSha256: '7'.repeat(64),
		reissuedAt: '2026-09-13T12:00:00.000Z',
		expectedAuditSequence: 1,
		previousAuditHash: 'e'.repeat(64),
		auditEventId: '01970000-0000-7000-8000-000000000030',
		auditEventHash: '9'.repeat(64),
		auditPayloadJson: JSON.stringify({ recipientId: key.recipientId }),
		expectedJsonSha256: JSON_SHA256,
		expectedMarkdownSha256: MARKDOWN_SHA256,
		expectedPdfSha256: PDF_SHA256,
		...overrides
	};
}

describe('D1CompletionAccessReissueStore integration', () => {
	it('publishes a successor chain, scrubs the receipt token, and leaves the predecessor byte-identical', async () => {
		const { database, sqlite } = createFixture();
		seedCompletedEnvelope(sqlite);
		const store = new D1CompletionAccessReissueStore(database);

		const key = keyFor('idemp-1', 'hash-1');
		const prep = await store.prepareReissue(key, expected());
		expect(prep.outcome).toBe('ready');
		if (prep.outcome !== 'ready') return;
		expect(prep.predecessorGeneration).toBe(0);
		expect(prep.auditHead?.sequence).toBe(1);

		const newDeliveryId = '01970000-0000-7000-8000-000000000040';
		const command = commandFor(key, newDeliveryId, {
			expectedAuditSequence: prep.auditHead!.sequence,
			previousAuditHash: prep.auditHead!.eventHash
		});
		const published = await store.publishReissue(command);
		expect(published.outcome).toBe('published');
		if (published.outcome !== 'published') return;
		expect(published.result?.generation).toBe(1);
		expect(published.result?.deliveryId).toBe(newDeliveryId);

		const predecessor = sqlite
			.prepare(
				'SELECT status, attempts, last_error, access_revoked_at, sealed_token, updated_at FROM completion_delivery_outbox WHERE id = ?'
			)
			.get(PREDECESSOR_ID) as Record<string, unknown>;
		expect(predecessor.status).toBe('failed');
		expect(predecessor.attempts).toBe(10);
		expect(predecessor.last_error).toBe('completion_delivery_attempts_exhausted');
		expect(predecessor.access_revoked_at).toBe(FAILED_AT);
		expect(predecessor.sealed_token).toBeNull();
		expect(predecessor.updated_at).toBe(FAILED_AT);

		const successor = sqlite
			.prepare(
				'SELECT generation, predecessor_delivery_id, status, sealed_token FROM completion_delivery_outbox WHERE id = ?'
			)
			.get(newDeliveryId) as Record<string, unknown>;
		expect(successor.generation).toBe(1);
		expect(successor.predecessor_delivery_id).toBe(PREDECESSOR_ID);
		expect(successor.status).toBe('pending');
		expect(successor.sealed_token).toBe('skcd1_new-sealed-blob');

		const commandRow = sqlite
			.prepare(
				'SELECT sealed_token FROM completion_access_reissue_command WHERE new_delivery_id = ?'
			)
			.get(newDeliveryId) as Record<string, unknown>;
		expect(commandRow.sealed_token).toBeNull();

		const auditRow = sqlite
			.prepare(
				'SELECT event_type, sequence FROM audit_event WHERE envelope_id = ? ORDER BY sequence DESC LIMIT 1'
			)
			.get(ENVELOPE_ID) as Record<string, unknown>;
		expect(auditRow.event_type).toBe('recipient.completion_access_reissued');
		expect(auditRow.sequence).toBe(2);

		// Replay: same actor + idempotency key + request hash -> safe replay, no new row.
		const replayedPrep = await store.prepareReissue(key, expected());
		expect(replayedPrep.outcome).toBe('replayed');
		if (replayedPrep.outcome !== 'replayed') return;
		expect(replayedPrep.result?.deliveryId).toBe(newDeliveryId);

		const totalRows = sqlite
			.prepare('SELECT COUNT(*) AS n FROM completion_delivery_outbox WHERE recipient_id = ?')
			.get(SIGNER_ID) as { n: number };
		expect(totalRows.n).toBe(2);
	});

	it('rejects a changed-body replay on the same idempotency key', async () => {
		const { database, sqlite } = createFixture();
		seedCompletedEnvelope(sqlite);
		const store = new D1CompletionAccessReissueStore(database);

		const key = keyFor('idemp-2', 'hash-a');
		const prep = await store.prepareReissue(key, expected());
		expect(prep.outcome).toBe('ready');
		if (prep.outcome !== 'ready') return;
		const command = commandFor(key, '01970000-0000-7000-8000-000000000041', {
			expectedAuditSequence: prep.auditHead!.sequence,
			previousAuditHash: prep.auditHead!.eventHash
		});
		const published = await store.publishReissue(command);
		expect(published.outcome).toBe('published');

		const changedKey = keyFor('idemp-2', 'hash-b');
		const conflict = await store.prepareReissue(changedKey, expected());
		expect(conflict.outcome).toBe('idempotency_conflict');
	});

	it('rejects a stale generation once the predecessor already has a successor', async () => {
		const { database, sqlite } = createFixture();
		seedCompletedEnvelope(sqlite);
		const store = new D1CompletionAccessReissueStore(database);

		const key = keyFor('idemp-3', 'hash-c');
		const prep = await store.prepareReissue(key, expected());
		expect(prep.outcome).toBe('ready');
		if (prep.outcome !== 'ready') return;
		const command = commandFor(key, '01970000-0000-7000-8000-000000000042', {
			expectedAuditSequence: prep.auditHead!.sequence,
			previousAuditHash: prep.auditHead!.eventHash
		});
		await store.publishReissue(command);

		const staleKey = keyFor('idemp-4', 'hash-d');
		const stale = await store.prepareReissue(staleKey, expected());
		expect(stale.outcome).toBe('stale_generation');
	});

	it('rejects a predecessor that has not yet exhausted', async () => {
		const { database, sqlite } = createFixture();
		seedCompletedEnvelope(sqlite);
		const store = new D1CompletionAccessReissueStore(database);

		const key = keyFor('idemp-5', 'hash-e', APPROVER_DELIVERY_ID, APPROVER_ID);
		const prep = await store.prepareReissue(key, {
			expectedAttempts: 0,
			expectedFailedAt: '2026-09-11T00:04:00.000Z',
			expectedErrorCode: 'completion_delivery_attempts_exhausted'
		});
		expect(prep.outcome).toBe('not_eligible');
		if (prep.outcome !== 'not_eligible') return;
		expect(prep.notEligibleReason).toBe('predecessor_not_exhausted');
	});

	it('reports not_found for an unknown predecessor delivery', async () => {
		const { database, sqlite } = createFixture();
		seedCompletedEnvelope(sqlite);
		const store = new D1CompletionAccessReissueStore(database);

		const key = keyFor('idemp-6', 'hash-f', '01970000-0000-7000-8000-000000000099');
		const prep = await store.prepareReissue(key, expected());
		expect(prep.outcome).toBe('not_found');
	});

	it('rejects publication when the completion PDF digest no longer matches at write time', async () => {
		const { database, sqlite } = createFixture();
		seedCompletedEnvelope(sqlite);
		const store = new D1CompletionAccessReissueStore(database);

		const key = keyFor('idemp-7', 'hash-g', VIEWER_DELIVERY_ID, VIEWER_ID);
		const prep = await store.prepareReissue(key, expected());
		expect(prep.outcome).toBe('ready');
		if (prep.outcome !== 'ready') return;
		const command = commandFor(key, '01970000-0000-7000-8000-000000000043', {
			expectedAuditSequence: prep.auditHead!.sequence,
			previousAuditHash: prep.auditHead!.eventHash,
			expectedPdfSha256: 'f'.repeat(64)
		});
		const published = await store.publishReissue(command);
		expect(published.outcome).toBe('integrity_error');

		const rows = sqlite
			.prepare('SELECT COUNT(*) AS n FROM completion_delivery_outbox WHERE recipient_id = ?')
			.get(VIEWER_ID) as { n: number };
		expect(rows.n).toBe(1);
	});

	it('aborts and rolls back the whole write when a concurrent audit event moved the head before publish', async () => {
		const { database, sqlite } = createFixture();
		seedCompletedEnvelope(sqlite);
		const store = new D1CompletionAccessReissueStore(database);

		const key = keyFor('idemp-8', 'hash-h');
		const prep = await store.prepareReissue(key, expected());
		expect(prep.outcome).toBe('ready');
		if (prep.outcome !== 'ready') return;
		const staleAuditHead = {
			sequence: prep.auditHead!.sequence,
			eventHash: prep.auditHead!.eventHash
		};

		// A concurrent, unrelated audit event lands on this envelope between this
		// process's prepare read and its publish write.
		sqlite.exec(`
			INSERT INTO audit_event (
				id, envelope_id, sequence, event_type, actor_type, actor_id,
				payload_json, previous_hash, event_hash, occurred_at
			) VALUES (
				'01970000-0000-7000-8000-000000000029', '${ENVELOPE_ID}', 2, 'envelope.voided', 'user', '${USER_ID}',
				'{}', '${staleAuditHead.eventHash}', '${'c'.repeat(64)}', '2026-09-13T11:59:00.000Z'
			);
		`);

		const command = commandFor(key, '01970000-0000-7000-8000-000000000044', {
			expectedAuditSequence: staleAuditHead.sequence,
			previousAuditHash: staleAuditHead.eventHash
		});
		const published = await store.publishReissue(command);
		expect(published.outcome).toBe('integrity_error');

		const outboxRows = sqlite
			.prepare('SELECT COUNT(*) AS n FROM completion_delivery_outbox WHERE recipient_id = ?')
			.get(SIGNER_ID) as { n: number };
		expect(outboxRows.n).toBe(1);
		const auditRows = sqlite
			.prepare('SELECT COUNT(*) AS n FROM audit_event WHERE envelope_id = ?')
			.get(ENVELOPE_ID) as { n: number };
		expect(auditRows.n).toBe(2);
		const commandRows = sqlite
			.prepare(
				'SELECT COUNT(*) AS n FROM completion_access_reissue_command WHERE idempotency_key = ?'
			)
			.get('idemp-8') as { n: number };
		expect(commandRows.n).toBe(0);

		// The now-current audit head accepts a fresh publish of the same command key.
		const retried = await store.publishReissue(
			commandFor(key, '01970000-0000-7000-8000-000000000044', {
				expectedAuditSequence: 2,
				previousAuditHash: 'c'.repeat(64)
			})
		);
		expect(retried.outcome).toBe('published');
	});

	it('continues replaying the original receipt after the successor is resealed under a rotated key and later scrubbed', async () => {
		const { database, sqlite } = createFixture();
		seedCompletedEnvelope(sqlite);
		const store = new D1CompletionAccessReissueStore(database);

		const key = keyFor('idemp-9', 'hash-i');
		const prep = await store.prepareReissue(key, expected());
		expect(prep.outcome).toBe('ready');
		if (prep.outcome !== 'ready') return;
		const newDeliveryId = '01970000-0000-7000-8000-000000000045';
		const published = await store.publishReissue(
			commandFor(key, newDeliveryId, {
				expectedAuditSequence: prep.auditHead!.sequence,
				previousAuditHash: prep.auditHead!.eventHash
			})
		);
		expect(published.outcome).toBe('published');

		// Simulate the bounded reseal sweep rotating the successor's ciphertext
		// under a newer key, independent of this command's own receipt row.
		sqlite.exec(`
			UPDATE completion_delivery_outbox
			SET sealed_token = 'skcd1_resealed-under-key-2', sealing_key_id = 'key-2',
				sealed_token_sha256 = '${'d'.repeat(64)}'
			WHERE id = '${newDeliveryId}';
		`);
		const replayAfterReseal = await store.prepareReissue(key, expected());
		expect(replayAfterReseal.outcome).toBe('replayed');
		if (replayAfterReseal.outcome !== 'replayed') return;
		expect(replayAfterReseal.result?.deliveryId).toBe(newDeliveryId);

		// Simulate the successor itself later exhausting and being scrubbed.
		sqlite.exec(`
			UPDATE completion_delivery_outbox
			SET status = 'failed', retryable = 0, access_revoked_at = '2026-10-13T00:00:00.000Z',
				sealed_token = NULL, attempts = 10, last_error = 'completion_delivery_attempts_exhausted'
			WHERE id = '${newDeliveryId}';
		`);
		const replayAfterScrub = await store.prepareReissue(key, expected());
		expect(replayAfterScrub.outcome).toBe('replayed');
		if (replayAfterScrub.outcome !== 'replayed') return;
		expect(replayAfterScrub.result?.deliveryId).toBe(newDeliveryId);
		expect(replayAfterScrub.result?.generation).toBe(1);
		expect(replayAfterScrub.result?.accessExpiresAt).toBe(published.result?.accessExpiresAt);
	});
});
