import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { hashAuditEventV3, sha256TextHex } from '$lib/domain/audit';
import type {
	ApproveCommandKey,
	ApprovePreparation,
	PublishRecipientApprovedCommand
} from '$lib/ports/recipient-approve-store';
import { D1RecipientApproveStore } from './d1-recipient-approve-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ENVELOPE_ID: string = '01920003-0000-7000-8000-000000000001';
const APPROVER_ID: string = '01920003-0000-7000-8000-000000000002';
const SIGNER_ID: string = '01920003-0000-7000-8000-000000000003';
const SENT_AUDIT_ID: string = '01920003-0000-7000-8000-000000000010';
const VIEWED_AUDIT_ID: string = '01920003-0000-7000-8000-000000000011';
const APPROVED_AUDIT_ID: string = '01920003-0000-7000-8000-000000000012';
const COMPLETED_AUDIT_ID: string = '01920003-0000-7000-8000-000000000013';
const OUTBOX_ONE_ID: string = '01920003-0000-7000-8000-000000000020';
const OUTBOX_TWO_ID: string = '01920003-0000-7000-8000-000000000021';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const CAPABILITY_APPROVER_HASH: string = '1'.repeat(64);
const CAPABILITY_SIGNER_HASH: string = '2'.repeat(64);
const SENT_AT: string = '2026-09-24T00:00:00.000Z';
const VIEWED_AT: string = '2026-09-24T01:00:00.000Z';
const APPROVED_AT: string = '2026-09-24T02:00:00.000Z';
const CAPABILITY_EXPIRES_AT: string = '2026-10-08T00:00:00.000Z';
const NEXT_CAPABILITY_EXPIRES_AT: string = '2026-10-08T02:00:00.000Z';

interface Fixture {
	sqlite: DatabaseSync;
	store: D1RecipientApproveStore;
	viewedAuditHash: string;
}

/**
 * Seeds a sent envelope whose approver has already viewed, so the approve
 * command is the next durable write. `withSigner` adds a blocked routing
 * group 2 so the release branch of the publish trigger is exercised too.
 */
async function fixture(withSigner: boolean = false): Promise<Fixture> {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	const store = new D1RecipientApproveStore(sqliteD1Database(sqlite));

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
	const viewedPayload = {
		recipientId: APPROVER_ID,
		role: 'approver',
		routingOrder: 1,
		sentCommitSha: COMMIT_SHA,
		viewedAt: VIEWED_AT
	};
	const viewedAuditHash: string = await hashAuditEventV3(
		{
			sequence: 2,
			eventType: 'recipient.viewed',
			actorType: 'recipient',
			actorId: APPROVER_ID,
			occurredAt: VIEWED_AT,
			payload: viewedPayload,
			previousHash: sentAuditHash
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
			) VALUES (?, 'user-1', 'Agreement', 'in_progress', 1, ?, 'archives/integration.git.gz', ?, ?, 1, ?, ?)`
		)
		.run(ENVELOPE_ID, COMMIT_SHA, 'a'.repeat(64), COMMIT_SHA, SENT_AT, VIEWED_AT);
	sqlite
		.prepare(
			`INSERT INTO recipient (
				id, envelope_id, email, name, role, locale, routing_order, status,
				capability_hash, capability_expires_at, created_at, updated_at
			) VALUES (?, ?, 'alice@example.test', 'Alice', 'approver', 'en', 1, 'viewed', ?, ?, ?, ?)`
		)
		.run(
			APPROVER_ID,
			ENVELOPE_ID,
			CAPABILITY_APPROVER_HASH,
			CAPABILITY_EXPIRES_AT,
			SENT_AT,
			VIEWED_AT
		);
	// A delivered invitation with no sealed capability left behind: the shape
	// the completion projection check requires for a terminal replay.
	sqlite
		.prepare(
			`INSERT INTO delivery_outbox (
				id, envelope_id, recipient_id, kind, status, capability_hash,
				reserved_capability_expires_at, sealed_capability, sealing_key_id,
				sealed_capability_sha256, available_at, attempts, delivered_at,
				created_at, updated_at, retryable
			) VALUES (?, ?, ?, 'recipient_invitation', 'delivered', ?, NULL, NULL, 'key-1', ?, ?, 1, ?, ?, ?, 0)`
		)
		.run(
			OUTBOX_ONE_ID,
			ENVELOPE_ID,
			APPROVER_ID,
			CAPABILITY_APPROVER_HASH,
			'c'.repeat(64),
			SENT_AT,
			SENT_AT,
			SENT_AT,
			SENT_AT
		);

	if (withSigner) {
		sqlite
			.prepare(
				`INSERT INTO recipient (
					id, envelope_id, email, name, role, locale, routing_order, status,
					capability_hash, capability_expires_at, created_at, updated_at
				) VALUES (?, ?, 'bob@example.test', 'Bob', 'signer', 'ja', 2, 'pending', ?, NULL, ?, ?)`
			)
			.run(SIGNER_ID, ENVELOPE_ID, CAPABILITY_SIGNER_HASH, SENT_AT, SENT_AT);
		sqlite
			.prepare(
				`INSERT INTO delivery_outbox (
					id, envelope_id, recipient_id, kind, status, capability_hash,
					reserved_capability_expires_at, sealed_capability, sealing_key_id,
					sealed_capability_sha256, available_at, attempts,
					created_at, updated_at, retryable
				) VALUES (?, ?, ?, 'recipient_invitation', 'blocked', ?, NULL, 'sealed-blob-2', 'key-1', ?, NULL, 0, ?, ?, 1)`
			)
			.run(
				OUTBOX_TWO_ID,
				ENVELOPE_ID,
				SIGNER_ID,
				CAPABILITY_SIGNER_HASH,
				'd'.repeat(64),
				SENT_AT,
				SENT_AT
			);
	}

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
	sqlite
		.prepare(
			`INSERT INTO audit_event (
				id, envelope_id, sequence, event_type, actor_type,
				actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
			) VALUES (?, ?, 2, 'recipient.viewed', 'recipient', ?, ?, ?, ?, ?, 3)`
		)
		.run(
			VIEWED_AUDIT_ID,
			ENVELOPE_ID,
			APPROVER_ID,
			JSON.stringify(viewedPayload),
			sentAuditHash,
			viewedAuditHash,
			VIEWED_AT
		);

	return { sqlite, store, viewedAuditHash };
}

async function requestFingerprint(): Promise<string> {
	return await sha256TextHex(
		JSON.stringify({
			envelopeId: ENVELOPE_ID,
			recipientId: APPROVER_ID,
			capabilityHash: CAPABILITY_APPROVER_HASH
		})
	);
}

async function approveKey(idempotencyKey: string): Promise<ApproveCommandKey> {
	return {
		capabilityHash: CAPABILITY_APPROVER_HASH,
		expectedEnvelopeId: ENVELOPE_ID,
		expectedRecipientId: APPROVER_ID,
		idempotencyKey,
		requestFingerprint: await requestFingerprint()
	};
}

/** Mirrors the audit payloads and chained hashes RecipientApprovedApplication emits. */
async function approveCommand(
	key: ApproveCommandKey,
	preparation: Extract<ApprovePreparation, { outcome: 'ready' }>,
	release: boolean
): Promise<PublishRecipientApprovedCommand> {
	const payload = {
		recipientId: key.expectedRecipientId,
		role: 'approver',
		routingOrder: preparation.routingOrder,
		sentCommitSha: preparation.sentCommitSha,
		approvedAt: APPROVED_AT
	};
	const auditEventHash: string = await hashAuditEventV3(
		{
			sequence: preparation.auditHead.sequence + 1,
			eventType: 'recipient.approved',
			actorType: 'recipient',
			actorId: key.expectedRecipientId,
			occurredAt: APPROVED_AT,
			payload,
			previousHash: preparation.auditHead.eventHash
		},
		{ envelopeId: ENVELOPE_ID }
	);
	const completedPayload = { sentCommitSha: preparation.sentCommitSha, completedAt: APPROVED_AT };
	const completedAuditEventHash: string = await hashAuditEventV3(
		{
			sequence: preparation.auditHead.sequence + 2,
			eventType: 'envelope.completed',
			actorType: 'recipient',
			actorId: key.expectedRecipientId,
			occurredAt: APPROVED_AT,
			payload: completedPayload,
			previousHash: auditEventHash
		},
		{ envelopeId: ENVELOPE_ID }
	);
	return {
		...key,
		recipientRole: 'approver',
		routingOrder: preparation.routingOrder,
		expectedSentCommitSha: preparation.sentCommitSha,
		updatedAt: APPROVED_AT,
		nextRoutingOrder: release ? preparation.routing.nextRoutingOrder : null,
		nextCapabilityExpiresAt: release ? NEXT_CAPABILITY_EXPIRES_AT : null,
		releasedDeliveryCount: release ? preparation.routing.nextGroupCount : 0,
		expectedAuditSequence: preparation.auditHead.sequence,
		previousAuditHash: preparation.auditHead.eventHash,
		auditEventId: APPROVED_AUDIT_ID,
		auditEventHash,
		auditPayloadJson: JSON.stringify(payload),
		completedAuditEventId: release ? null : COMPLETED_AUDIT_ID,
		completedAuditEventHash: release ? null : completedAuditEventHash,
		completedAuditPayloadJson: release ? null : JSON.stringify(completedPayload)
	};
}

function auditTrail(sqlite: DatabaseSync): { sequence: number; event_type: string }[] {
	return (
		sqlite
			.prepare(
				'SELECT sequence, event_type FROM audit_event WHERE envelope_id = ? ORDER BY sequence'
			)
			.all(ENVELOPE_ID) as { sequence: number; event_type: string }[]
	).map((row: { sequence: number; event_type: string }) => ({ ...row }));
}

describe('D1RecipientApproveStore integration', () => {
	it('accepts publication, writes the recipient/audit columns to their own slots, and completes the envelope', async () => {
		const { sqlite, store, viewedAuditHash } = await fixture();
		const key: ApproveCommandKey = await approveKey('approved-idempotency-1');

		const preparation: ApprovePreparation = await store.prepareApproved(key, APPROVED_AT);
		expect(preparation.outcome).toBe('ready');
		if (preparation.outcome !== 'ready') return;
		expect(preparation.auditHead).toStrictEqual({ sequence: 2, eventHash: viewedAuditHash });
		expect(preparation.routing).toStrictEqual({
			currentGroupOutstanding: 0,
			remainingActionableOutstanding: 0,
			nextRoutingOrder: null,
			nextGroupCount: 0
		});

		const command: PublishRecipientApprovedCommand = await approveCommand(key, preparation, false);
		const published = await store.publishApproved(command);
		expect(published.outcome).toBe('published');
		if (published.outcome !== 'published') return;
		expect(published.result).toStrictEqual({
			envelopeId: ENVELOPE_ID,
			recipientId: APPROVER_ID,
			recipientRole: 'approver',
			routingOrder: 1,
			sentCommitSha: COMMIT_SHA,
			envelopeStatus: 'completed',
			approvedAt: APPROVED_AT,
			auditEventId: APPROVED_AUDIT_ID,
			completedAuditEventId: COMPLETED_AUDIT_ID,
			nextRoutingOrder: null
		});

		// The literal actor_type and the bound actor_id must occupy their own
		// columns: a leftover extra placeholder before the literal shifts every
		// bound value one column to the right and the CHECK constraints reject
		// the whole insert.
		const commandRow = sqlite
			.prepare(
				`SELECT actor_type, actor_id, recipient_role, routing_order, request_hash,
					audit_sequence, next_routing_order, next_capability_expires_at,
					released_delivery_count, completed_audit_event_id
				 FROM recipient_approved_command WHERE recipient_id = ?`
			)
			.get(APPROVER_ID) as Record<string, unknown>;
		expect({ ...commandRow }).toStrictEqual({
			actor_type: 'recipient',
			actor_id: APPROVER_ID,
			recipient_role: 'approver',
			routing_order: 1,
			request_hash: command.requestFingerprint,
			audit_sequence: 3,
			next_routing_order: null,
			next_capability_expires_at: null,
			released_delivery_count: 0,
			completed_audit_event_id: COMPLETED_AUDIT_ID
		});

		const recipientRow = sqlite
			.prepare('SELECT status, capability_revoked_at FROM recipient WHERE id = ?')
			.get(APPROVER_ID) as { status: string; capability_revoked_at: string };
		expect({ ...recipientRow }).toStrictEqual({
			status: 'completed',
			capability_revoked_at: APPROVED_AT
		});

		const envelopeRow = sqlite
			.prepare('SELECT status, updated_at FROM envelope WHERE id = ?')
			.get(ENVELOPE_ID) as { status: string; updated_at: string };
		expect({ ...envelopeRow }).toStrictEqual({ status: 'completed', updated_at: APPROVED_AT });

		expect(auditTrail(sqlite)).toStrictEqual([
			{ sequence: 1, event_type: 'envelope.sent' },
			{ sequence: 2, event_type: 'recipient.viewed' },
			{ sequence: 3, event_type: 'recipient.approved' },
			{ sequence: 4, event_type: 'envelope.completed' }
		]);
		const completedRow = sqlite
			.prepare(
				'SELECT previous_hash, event_hash, actor_id, occurred_at FROM audit_event WHERE id = ?'
			)
			.get(COMPLETED_AUDIT_ID) as Record<string, unknown>;
		expect({ ...completedRow }).toStrictEqual({
			previous_hash: command.auditEventHash,
			event_hash: command.completedAuditEventHash,
			actor_id: APPROVER_ID,
			occurred_at: APPROVED_AT
		});
	});

	it('replays a completed approval without duplicating the command or audit trail', async () => {
		const { sqlite, store } = await fixture();
		const key: ApproveCommandKey = await approveKey('approved-idempotency-1');

		const preparation: ApprovePreparation = await store.prepareApproved(key, APPROVED_AT);
		expect(preparation.outcome).toBe('ready');
		if (preparation.outcome !== 'ready') return;
		const command: PublishRecipientApprovedCommand = await approveCommand(key, preparation, false);
		expect((await store.publishApproved(command)).outcome).toBe('published');

		const replayPreparation: ApprovePreparation = await store.prepareApproved(
			key,
			'2026-09-24T03:00:00.000Z'
		);
		expect(replayPreparation.outcome).toBe('replayed');
		if (replayPreparation.outcome !== 'replayed') return;
		expect(replayPreparation.result.envelopeStatus).toBe('completed');

		const republished = await store.publishApproved(command);
		expect(republished.outcome).toBe('replayed');
		if (republished.outcome !== 'replayed') return;
		expect(republished.result.auditEventId).toBe(APPROVED_AUDIT_ID);
		expect(republished.result.completedAuditEventId).toBe(COMPLETED_AUDIT_ID);

		expect(auditTrail(sqlite).length).toBe(4);
		const approvedCommandCount = sqlite
			.prepare('SELECT count(*) AS count FROM recipient_approved_command')
			.get() as { count: number };
		expect(Number(approvedCommandCount.count)).toBe(1);
	});

	it('releases the next routing group and its blocked delivery instead of completing when a signer remains', async () => {
		const { sqlite, store } = await fixture(true);
		const key: ApproveCommandKey = await approveKey('approved-idempotency-1');

		const preparation: ApprovePreparation = await store.prepareApproved(key, APPROVED_AT);
		expect(preparation.outcome).toBe('ready');
		if (preparation.outcome !== 'ready') return;
		expect(preparation.routing).toStrictEqual({
			currentGroupOutstanding: 0,
			remainingActionableOutstanding: 1,
			nextRoutingOrder: 2,
			nextGroupCount: 1
		});

		const command: PublishRecipientApprovedCommand = await approveCommand(key, preparation, true);
		const published = await store.publishApproved(command);
		expect(published.outcome).toBe('published');
		if (published.outcome !== 'published') return;
		expect(published.result.envelopeStatus).toBe('in_progress');
		expect(published.result.nextRoutingOrder).toBe(2);
		expect(published.result.completedAuditEventId).toBeNull();

		expect(auditTrail(sqlite)).toStrictEqual([
			{ sequence: 1, event_type: 'envelope.sent' },
			{ sequence: 2, event_type: 'recipient.viewed' },
			{ sequence: 3, event_type: 'recipient.approved' }
		]);

		const envelopeRow = sqlite
			.prepare('SELECT status FROM envelope WHERE id = ?')
			.get(ENVELOPE_ID) as { status: string };
		expect(envelopeRow.status).toBe('in_progress');

		const nextRecipient = sqlite
			.prepare('SELECT status, capability_expires_at FROM recipient WHERE id = ?')
			.get(SIGNER_ID) as { status: string; capability_expires_at: string };
		expect({ ...nextRecipient }).toStrictEqual({
			status: 'pending',
			capability_expires_at: NEXT_CAPABILITY_EXPIRES_AT
		});

		const nextOutbox = sqlite
			.prepare(
				'SELECT status, available_at, reserved_capability_expires_at FROM delivery_outbox WHERE id = ?'
			)
			.get(OUTBOX_TWO_ID) as Record<string, unknown>;
		expect({ ...nextOutbox }).toStrictEqual({
			status: 'pending',
			available_at: APPROVED_AT,
			reserved_capability_expires_at: NEXT_CAPABILITY_EXPIRES_AT
		});

		// The non-terminal path replays from the same durable receipt.
		const replayed = await store.publishApproved(command);
		expect(replayed.outcome).toBe('replayed');
		if (replayed.outcome !== 'replayed') return;
		expect(replayed.result.nextRoutingOrder).toBe(2);
		expect(auditTrail(sqlite).length).toBe(3);
	});
});
