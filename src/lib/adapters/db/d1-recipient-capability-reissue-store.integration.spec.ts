import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1RecipientCapabilityReissueStore } from './d1-recipient-capability-reissue-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';
import type {
	PublishReissueCommand,
	ReissueCommandKey
} from '$lib/ports/recipient-capability-reissue-store';

const ORG_ID = 'org-1';
const ENV_ID = '01900000-0000-7000-8000-000000000001';
const REC_ID = '01900000-0000-7000-8000-000000000002';
const USER_ID = '01900000-0000-7000-8000-000000000003';
const CAP_HASH_1 = '1'.repeat(64);
const CAP_HASH_2 = '2'.repeat(64);
const AUDIT_HASH_1 = 'a'.repeat(64);
const AUDIT_HASH_2 = 'b'.repeat(64);

function setupDb(): { sqlite: DatabaseSync; store: D1RecipientCapabilityReissueStore } {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	const d1 = sqliteD1Database(sqlite);
	const store = new D1RecipientCapabilityReissueStore(d1);
	return { sqlite, store };
}

function seedBaseline(sqlite: DatabaseSync, outboxStatus: string = 'pending'): void {
	const isProcessing: boolean = outboxStatus === 'processing';
	const isDelivered: boolean = outboxStatus === 'delivered';
	const sealedCapability: string = isDelivered ? 'NULL' : "'sealed-blob-1'";
	const retryable: number = isDelivered ? 0 : 1;
	const claimToken: string = isProcessing ? "'claim-token-0001'" : 'NULL';
	const lockedAt: string = isProcessing ? "'2026-09-13T11:59:00.000Z'" : 'NULL';
	const deliveredAt: string = isDelivered ? "'2026-09-11T00:01:00.000Z'" : 'NULL';
	const attempts: number = isProcessing ? 1 : isDelivered ? 1 : 0;
	sqlite.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${ORG_ID}', '${ORG_ID}', 'Workspace', '2026-09-11T00:00:00.000Z');

		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation,
			created_at, updated_at
		) VALUES (
			'${ENV_ID}', '${ORG_ID}', 'Agreement', 'sent', 1,
			'2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
		);

		INSERT INTO recipient (
			id, organization_id, envelope_id, role, routing_order, name, email, locale,
			status, capability_hash, capability_expires_at, created_at, updated_at
		) VALUES (
			'${REC_ID}', '${ORG_ID}', '${ENV_ID}', 'signer', 1, 'Signer Person', 'signer@example.test', 'en',
			'pending', '${CAP_HASH_1}', '2026-09-25T00:00:00.000Z', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
		);

		INSERT INTO delivery_outbox (
			id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
			reserved_capability_expires_at, sealed_capability, sealing_key_id,
			sealed_capability_sha256, available_at, attempts, locked_at, delivered_at,
			created_at, updated_at, claim_token, retryable
		) VALUES (
			'01900000-0000-7000-8000-000000000010', '${ORG_ID}', '${ENV_ID}', '${REC_ID}',
			'recipient_invitation', '${outboxStatus}', '${CAP_HASH_1}', '2026-09-25T00:00:00.000Z',
			${sealedCapability}, 'key-1', '${'c'.repeat(64)}', '2026-09-11T00:00:00.000Z', ${attempts},
			${lockedAt}, ${deliveredAt}, '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z',
			${claimToken}, ${retryable}
		);

		INSERT INTO recipient_capability_issuance (
			organization_id, envelope_id, recipient_id, capability_hash, predecessor_capability_hash, issued_at
		) VALUES (
			'${ORG_ID}', '${ENV_ID}', '${REC_ID}', '${CAP_HASH_1}', NULL, '2026-09-11T00:00:00.000Z'
		);

		INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'01900000-0000-7000-8000-000000000020', '${ORG_ID}', '${ENV_ID}', 1,
			'envelope.sent', 'user', '${USER_ID}', '{}', '${'0'.repeat(64)}', '${AUDIT_HASH_1}',
			'2026-09-11T00:00:00.000Z'
		);
	`);
}

describe('D1RecipientCapabilityReissueStore Integration', () => {
	it('prepares and publishes a reissue command atomically', async () => {
		const { sqlite, store } = setupDb();
		seedBaseline(sqlite);

		const key: ReissueCommandKey = {
			organizationId: ORG_ID,
			envelopeId: ENV_ID,
			recipientId: REC_ID,
			actorType: 'user',
			actorId: USER_ID,
			idempotencyKey: 'reissue-idemp-1',
			requestHash: 'req-hash-1'
		};

		const prep = await store.prepareReissue(key, '2026-09-13T12:00:00.000Z');
		expect(prep.outcome).toBe('ready');
		if (prep.outcome !== 'ready') return;

		expect(prep.auditHead.sequence).toBe(1);
		expect(prep.auditHead.eventHash).toBe(AUDIT_HASH_1);
		expect(prep.previousCapabilityHash).toBe(CAP_HASH_1);
		expect(prep.recipientStatus).toBe('pending');
		expect(prep.envelopeStatus).toBe('sent');

		const command: PublishReissueCommand = {
			...key,
			previousCapabilityHash: prep.previousCapabilityHash,
			newCapabilityHash: CAP_HASH_2,
			reservedCapabilityExpiresAt: '2026-09-27T12:00:00.000Z',
			sealedCapability: 'sealed-blob-2',
			sealingKeyId: 'key-1',
			sealedCapabilitySha256: 'd'.repeat(64),
			outboxId: '01900000-0000-7000-8000-000000000099',
			reason: 'operator_request',
			updatedAt: '2026-09-13T12:00:00.000Z',
			expectedAuditSequence: prep.auditHead.sequence,
			previousAuditHash: prep.auditHead.eventHash,
			auditEventId: '01900000-0000-7000-8000-000000000088',
			auditEventHash: AUDIT_HASH_2,
			auditPayloadJson: JSON.stringify({ recipientId: REC_ID, reason: 'operator_request' })
		};

		const pub = await store.publishReissue(command);
		expect(pub.outcome).toBe('published');
		if (pub.outcome !== 'published') return;

		expect(pub.result.envelopeId).toBe(ENV_ID);
		expect(pub.result.recipientId).toBe(REC_ID);
		expect(pub.result.newCapabilityHash).toBe(CAP_HASH_2);
		expect(pub.result.outboxId).toBe('01900000-0000-7000-8000-000000000099');
		expect(pub.result.auditEventId).toBe('01900000-0000-7000-8000-000000000088');

		// Verify database side effects:
		// 1. Recipient capability hash updated
		const recRow = sqlite
			.prepare('SELECT capability_hash, capability_expires_at FROM recipient WHERE id = ?')
			.get(REC_ID) as { capability_hash: string; capability_expires_at: string };
		expect(recRow.capability_hash).toBe(CAP_HASH_2);
		expect(recRow.capability_expires_at).toBe('2026-09-27T12:00:00.000Z');

		// 2. Old pending/failed outbox row is marked failed with capability_superseded
		const oldOutbox = sqlite
			.prepare(
				'SELECT status, last_error, retryable, sealed_capability FROM delivery_outbox WHERE id = ?'
			)
			.get('01900000-0000-7000-8000-000000000010') as {
			status: string;
			last_error: string | null;
			retryable: number;
			sealed_capability: string | null;
		};
		expect(oldOutbox.status).toBe('failed');
		expect(oldOutbox.last_error).toBe('capability_superseded');
		expect(oldOutbox.retryable).toBe(0);
		expect(oldOutbox.sealed_capability).toBeNull();

		// 3. New outbox row created with pending status
		const newOutbox = sqlite
			.prepare('SELECT status, sealed_capability FROM delivery_outbox WHERE id = ?')
			.get('01900000-0000-7000-8000-000000000099') as { status: string; sealed_capability: string };
		expect(newOutbox.status).toBe('pending');
		expect(newOutbox.sealed_capability).toBe('sealed-blob-2');

		// 4. Recipient capability issuance recorded
		const issuance = sqlite
			.prepare(
				'SELECT capability_hash, predecessor_capability_hash, superseded_at FROM recipient_capability_issuance WHERE recipient_id = ?'
			)
			.all(REC_ID) as {
			capability_hash: string;
			predecessor_capability_hash: string | null;
			superseded_at: string | null;
		}[];
		expect(issuance.length).toBe(2);
		const initialIssuance = issuance.find((row) => row.capability_hash === CAP_HASH_1);
		const reissuedIssuance = issuance.find((row) => row.capability_hash === CAP_HASH_2);
		expect(initialIssuance?.predecessor_capability_hash).toBeNull();
		expect(initialIssuance?.superseded_at).toBe('2026-09-13T12:00:00.000Z');
		expect(reissuedIssuance?.predecessor_capability_hash).toBe(CAP_HASH_1);
		expect(reissuedIssuance?.superseded_at).toBeNull();

		// 5. Audit event appended
		const auditRow = sqlite
			.prepare('SELECT sequence, event_type FROM audit_event WHERE id = ?')
			.get('01900000-0000-7000-8000-000000000088') as { sequence: number; event_type: string };
		expect(auditRow.sequence).toBe(2);
		expect(auditRow.event_type).toBe('recipient.capability_reissued');

		// 6. Replay works for both prepare and publish
		const prepReplay = await store.prepareReissue(key, '2026-09-13T12:01:00.000Z');
		expect(prepReplay.outcome).toBe('replayed');

		const pubReplay = await store.publishReissue(command);
		expect(pubReplay.outcome).toBe('replayed');
	});

	it('rejects prepare when delivery is currently in flight (processing)', async () => {
		const { sqlite, store } = setupDb();
		seedBaseline(sqlite, 'processing');

		const key: ReissueCommandKey = {
			organizationId: ORG_ID,
			envelopeId: ENV_ID,
			recipientId: REC_ID,
			actorType: 'user',
			actorId: USER_ID,
			idempotencyKey: 'reissue-inflight',
			requestHash: 'req-hash-1'
		};

		const prep = await store.prepareReissue(key, '2026-09-13T12:00:00.000Z');
		expect(prep.outcome).toBe('delivery_in_flight');
	});

	it('rejects prepare when envelope is in terminal status', async () => {
		const { sqlite, store } = setupDb();
		seedBaseline(sqlite);
		sqlite.exec(`UPDATE envelope SET status = 'voided' WHERE id = '${ENV_ID}'`);

		const key: ReissueCommandKey = {
			organizationId: ORG_ID,
			envelopeId: ENV_ID,
			recipientId: REC_ID,
			actorType: 'user',
			actorId: USER_ID,
			idempotencyKey: 'reissue-voided',
			requestHash: 'req-hash-1'
		};

		const prep = await store.prepareReissue(key, '2026-09-13T12:00:00.000Z');
		expect(prep).toEqual({ outcome: 'not_eligible', reason: 'envelope_terminal' });
	});

	it('rejects prepare when recipient is in terminal status', async () => {
		const { sqlite, store } = setupDb();
		seedBaseline(sqlite);
		sqlite.exec(`UPDATE recipient SET status = 'completed' WHERE id = '${REC_ID}'`);

		const key: ReissueCommandKey = {
			organizationId: ORG_ID,
			envelopeId: ENV_ID,
			recipientId: REC_ID,
			actorType: 'user',
			actorId: USER_ID,
			idempotencyKey: 'reissue-completed-rec',
			requestHash: 'req-hash-1'
		};

		const prep = await store.prepareReissue(key, '2026-09-13T12:00:00.000Z');
		expect(prep).toEqual({ outcome: 'not_eligible', reason: 'recipient_terminal' });
	});
});
