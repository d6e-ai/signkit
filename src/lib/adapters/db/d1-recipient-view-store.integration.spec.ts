import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { hashAuditEventV3, sha256TextHex } from '$lib/domain/audit';
import type {
	PublishRecipientViewedCommand,
	ViewedCommandKey,
	ViewedPreparation
} from '$lib/ports/recipient-view-store';
import { D1RecipientViewStore } from './d1-recipient-view-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ENVELOPE_ID: string = '01920000-0000-7000-8000-000000000001';
const RECIPIENT_ID: string = '01920000-0000-7000-8000-000000000002';
const SENT_AUDIT_ID: string = '01920000-0000-7000-8000-000000000010';
const VIEWED_AUDIT_ID: string = '01920000-0000-7000-8000-000000000011';
const SECOND_VIEWED_AUDIT_ID: string = '01920000-0000-7000-8000-000000000012';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const CAPABILITY_HASH: string = '1'.repeat(64);
const SENT_AT: string = '2026-09-24T00:00:00.000Z';
const VIEWED_AT: string = '2026-09-24T01:00:00.000Z';
const CAPABILITY_EXPIRES_AT: string = '2026-10-08T00:00:00.000Z';

interface Fixture {
	sqlite: DatabaseSync;
	store: D1RecipientViewStore;
	sentAuditHash: string;
}

async function fixture(): Promise<Fixture> {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	const store = new D1RecipientViewStore(sqliteD1Database(sqlite));

	const sentAuditHash: string = await hashAuditEventV3(
		{
			sequence: 1,
			eventType: 'envelope.sent',
			actorType: 'user',
			actorId: 'user-1',
			occurredAt: SENT_AT,
			payload: { sentCommitSha: COMMIT_SHA },
			previousHash: null
		},
		{ envelopeId: ENVELOPE_ID }
	);

	sqlite
		.prepare(
			`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			 VALUES ('user-1', 'owner', 'active', ?, ?)`
		)
		.run(SENT_AT, SENT_AT);
	sqlite
		.prepare(
			`INSERT INTO envelope (
				id, created_by_user_id, title, status, repository_generation, repository_head,
				repository_archive_key, repository_archive_sha256, sent_commit_sha,
				field_generation, created_at, updated_at
			) VALUES (?, 'user-1', 'Agreement', 'sent', 1, ?, 'archives/integration.git.gz', ?, ?, 1, ?, ?)`
		)
		.run(ENVELOPE_ID, COMMIT_SHA, 'a'.repeat(64), COMMIT_SHA, SENT_AT, SENT_AT);
	sqlite
		.prepare(
			`INSERT INTO recipient (
				id, envelope_id, email, name, role, locale, routing_order, status,
				capability_hash, capability_expires_at, created_at, updated_at
			) VALUES (?, ?, 'signer@example.test', 'Signer Person', 'signer', 'en', 1, 'pending', ?, ?, ?, ?)`
		)
		.run(RECIPIENT_ID, ENVELOPE_ID, CAPABILITY_HASH, CAPABILITY_EXPIRES_AT, SENT_AT, SENT_AT);
	sqlite
		.prepare(
			`INSERT INTO audit_event (
				id, envelope_id, sequence, event_type, actor_type,
				actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
			) VALUES (?, ?, 1, 'envelope.sent', 'user', 'user-1', ?, NULL, ?, ?, 3)`
		)
		.run(
			SENT_AUDIT_ID,
			ENVELOPE_ID,
			JSON.stringify({ sentCommitSha: COMMIT_SHA }),
			sentAuditHash,
			SENT_AT
		);

	return { sqlite, store, sentAuditHash };
}

/** Mirrors the fingerprint RecipientViewedApplication derives for the store. */
async function viewedKey(idempotencyKey: string): Promise<ViewedCommandKey> {
	return {
		envelopeId: ENVELOPE_ID,
		recipientId: RECIPIENT_ID,
		capabilityHash: CAPABILITY_HASH,
		idempotencyKey,
		requestFingerprint: await sha256TextHex(
			JSON.stringify({
				envelopeId: ENVELOPE_ID,
				recipientId: RECIPIENT_ID,
				capabilityHash: CAPABILITY_HASH
			})
		)
	};
}

/** Mirrors the audit payload and chained hash the application publishes. */
async function viewedCommand(
	key: ViewedCommandKey,
	preparation: Extract<ViewedPreparation, { outcome: 'ready' }>,
	auditEventId: string,
	viewedAt: string = VIEWED_AT
): Promise<PublishRecipientViewedCommand> {
	const payload = {
		recipientId: key.recipientId,
		role: preparation.recipientRole,
		routingOrder: preparation.routingOrder,
		sentCommitSha: preparation.sentCommitSha,
		viewedAt
	};
	const auditPayloadJson: string = JSON.stringify(payload);
	const auditEventHash: string = await hashAuditEventV3(
		{
			sequence: preparation.auditHead.sequence + 1,
			eventType: 'recipient.viewed',
			actorType: 'recipient',
			actorId: key.recipientId,
			occurredAt: viewedAt,
			payload,
			previousHash: preparation.auditHead.eventHash
		},
		{ envelopeId: key.envelopeId }
	);
	return {
		...key,
		recipientRole: preparation.recipientRole,
		routingOrder: preparation.routingOrder,
		expectedSentCommitSha: preparation.sentCommitSha,
		updatedAt: viewedAt,
		expectedAuditSequence: preparation.auditHead.sequence,
		previousAuditHash: preparation.auditHead.eventHash,
		auditEventId,
		auditEventHash,
		auditPayloadJson
	};
}

function countOf(sqlite: DatabaseSync, sql: string, ...bindings: string[]): number {
	const row = sqlite.prepare(sql).get(...bindings) as { count: number };
	return Number(row.count);
}

describe('D1RecipientViewStore integration', () => {
	it('publishes a viewed command with recipient, envelope, and audit effects', async () => {
		const { sqlite, store, sentAuditHash } = await fixture();
		const key: ViewedCommandKey = await viewedKey('viewed-idempotency-1');

		const preparation: ViewedPreparation = await store.prepareViewed(key, VIEWED_AT);
		expect(preparation.outcome).toBe('ready');
		if (preparation.outcome !== 'ready') return;
		expect(preparation.recipientRole).toBe('signer');
		expect(preparation.routingOrder).toBe(1);
		expect(preparation.sentCommitSha).toBe(COMMIT_SHA);
		expect(preparation.envelopeStatus).toBe('sent');
		expect(preparation.auditHead).toStrictEqual({ sequence: 1, eventHash: sentAuditHash });

		const command: PublishRecipientViewedCommand = await viewedCommand(
			key,
			preparation,
			VIEWED_AUDIT_ID
		);
		const published = await store.publishViewed(command);
		expect(published.outcome).toBe('published');
		if (published.outcome !== 'published') return;
		expect(published.result).toStrictEqual({
			envelopeId: ENVELOPE_ID,
			recipientId: RECIPIENT_ID,
			recipientRole: 'signer',
			routingOrder: 1,
			sentCommitSha: COMMIT_SHA,
			envelopeStatus: 'in_progress',
			viewedAt: VIEWED_AT,
			auditEventId: VIEWED_AUDIT_ID
		});

		// The literal actor_type and the bound actor_id must land in their own
		// columns; a shifted VALUES list is what broke the live INSERT.
		const commandRow = sqlite
			.prepare(
				`SELECT envelope_id, recipient_id, recipient_role, routing_order, actor_type, actor_id,
					idempotency_key, request_hash, capability_hash, sent_commit_sha, updated_at,
					audit_event_id, audit_sequence, previous_audit_hash, audit_event_hash, audit_payload_json
				 FROM recipient_viewed_command WHERE recipient_id = ?`
			)
			.get(RECIPIENT_ID) as Record<string, unknown>;
		expect({ ...commandRow }).toStrictEqual({
			envelope_id: ENVELOPE_ID,
			recipient_id: RECIPIENT_ID,
			recipient_role: 'signer',
			routing_order: 1,
			actor_type: 'recipient',
			actor_id: RECIPIENT_ID,
			idempotency_key: 'viewed-idempotency-1',
			request_hash: key.requestFingerprint,
			capability_hash: CAPABILITY_HASH,
			sent_commit_sha: COMMIT_SHA,
			updated_at: VIEWED_AT,
			audit_event_id: VIEWED_AUDIT_ID,
			audit_sequence: 2,
			previous_audit_hash: sentAuditHash,
			audit_event_hash: command.auditEventHash,
			audit_payload_json: command.auditPayloadJson
		});

		const recipientRow = sqlite
			.prepare('SELECT status, updated_at FROM recipient WHERE id = ?')
			.get(RECIPIENT_ID) as { status: string; updated_at: string };
		expect({ ...recipientRow }).toStrictEqual({ status: 'viewed', updated_at: VIEWED_AT });

		const envelopeRow = sqlite
			.prepare('SELECT status, updated_at FROM envelope WHERE id = ?')
			.get(ENVELOPE_ID) as { status: string; updated_at: string };
		expect({ ...envelopeRow }).toStrictEqual({ status: 'in_progress', updated_at: VIEWED_AT });

		const auditRow = sqlite
			.prepare(
				`SELECT sequence, event_type, actor_type, actor_id, payload_json,
					previous_hash, event_hash, occurred_at, hash_version
				 FROM audit_event WHERE id = ?`
			)
			.get(VIEWED_AUDIT_ID) as Record<string, unknown>;
		expect({ ...auditRow }).toStrictEqual({
			sequence: 2,
			event_type: 'recipient.viewed',
			actor_type: 'recipient',
			actor_id: RECIPIENT_ID,
			payload_json: command.auditPayloadJson,
			previous_hash: sentAuditHash,
			event_hash: command.auditEventHash,
			occurred_at: VIEWED_AT,
			hash_version: 3
		});
	});

	it('replays the same idempotency key without appending a second audit event', async () => {
		const { sqlite, store } = await fixture();
		const key: ViewedCommandKey = await viewedKey('viewed-idempotency-1');

		const preparation: ViewedPreparation = await store.prepareViewed(key, VIEWED_AT);
		expect(preparation.outcome).toBe('ready');
		if (preparation.outcome !== 'ready') return;
		const command: PublishRecipientViewedCommand = await viewedCommand(
			key,
			preparation,
			VIEWED_AUDIT_ID
		);
		expect((await store.publishViewed(command)).outcome).toBe('published');

		const replayPreparation: ViewedPreparation = await store.prepareViewed(
			key,
			'2026-09-24T02:00:00.000Z'
		);
		expect(replayPreparation.outcome).toBe('replayed');
		if (replayPreparation.outcome !== 'replayed') return;
		expect(replayPreparation.result.viewedAt).toBe(VIEWED_AT);
		expect(replayPreparation.result.auditEventId).toBe(VIEWED_AUDIT_ID);

		// A retried publish (the unique-constraint path) must resolve to the
		// stored receipt instead of surfacing the insert failure.
		const republished = await store.publishViewed(command);
		expect(republished.outcome).toBe('replayed');
		if (republished.outcome !== 'replayed') return;
		expect(republished.result.auditEventId).toBe(VIEWED_AUDIT_ID);

		expect(
			countOf(
				sqlite,
				'SELECT count(*) AS count FROM recipient_viewed_command WHERE recipient_id = ?',
				RECIPIENT_ID
			)
		).toBe(1);
		expect(
			countOf(
				sqlite,
				'SELECT count(*) AS count FROM audit_event WHERE envelope_id = ?',
				ENVELOPE_ID
			)
		).toBe(2);
		const envelopeRow = sqlite
			.prepare('SELECT status FROM envelope WHERE id = ?')
			.get(ENVELOPE_ID) as { status: string };
		expect(envelopeRow.status).toBe('in_progress');
	});

	it('replays a retry that arrives under a fresh idempotency key', async () => {
		const { sqlite, store } = await fixture();
		const key: ViewedCommandKey = await viewedKey('viewed-idempotency-1');

		const preparation: ViewedPreparation = await store.prepareViewed(key, VIEWED_AT);
		expect(preparation.outcome).toBe('ready');
		if (preparation.outcome !== 'ready') return;
		expect(
			(await store.publishViewed(await viewedCommand(key, preparation, VIEWED_AUDIT_ID))).outcome
		).toBe('published');

		const retryKey: ViewedCommandKey = await viewedKey('viewed-idempotency-2');
		const retryPreparation: ViewedPreparation = await store.prepareViewed(
			retryKey,
			'2026-09-24T02:00:00.000Z'
		);
		expect(retryPreparation.outcome).toBe('replayed');
		if (retryPreparation.outcome !== 'replayed') return;
		expect(retryPreparation.result.auditEventId).toBe(VIEWED_AUDIT_ID);
		expect(retryPreparation.result.viewedAt).toBe(VIEWED_AT);

		// Publishing the retry anyway must not double-write the viewed record.
		const retryCommand: PublishRecipientViewedCommand = {
			...(await viewedCommand(retryKey, preparation, SECOND_VIEWED_AUDIT_ID)),
			updatedAt: VIEWED_AT
		};
		expect((await store.publishViewed(retryCommand)).outcome).toBe('replayed');
		expect(
			countOf(
				sqlite,
				'SELECT count(*) AS count FROM recipient_viewed_command WHERE recipient_id = ?',
				RECIPIENT_ID
			)
		).toBe(1);
		expect(
			countOf(
				sqlite,
				'SELECT count(*) AS count FROM audit_event WHERE envelope_id = ?',
				ENVELOPE_ID
			)
		).toBe(2);
	});
});
