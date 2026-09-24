import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { hashAuditEventV3, sha256TextHex } from '$lib/domain/audit';
import {
	canonicalRecipientSignFingerprint,
	type PublishRecipientSignedCommand,
	type SignLookupKey,
	type SignPreparation,
	type SignedFieldValue
} from '$lib/ports/recipient-sign-store';
import { D1RecipientSignStore } from './d1-recipient-sign-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ENVELOPE_ID: string = '01920001-0000-7000-8000-000000000001';
const SIGNER_ONE_ID: string = '01920001-0000-7000-8000-000000000002';
const SIGNER_TWO_ID: string = '01920001-0000-7000-8000-000000000003';
const SIGNATURE_FIELD_ID: string = '01920001-0000-7000-8000-00000000000a';
const TEXT_FIELD_ID: string = '01920001-0000-7000-8000-00000000000b';
const SENT_AUDIT_ID: string = '01920001-0000-7000-8000-000000000010';
const VIEWED_AUDIT_ID: string = '01920001-0000-7000-8000-000000000011';
const SIGNED_AUDIT_ID: string = '01920001-0000-7000-8000-000000000012';
const COMPLETED_AUDIT_ID: string = '01920001-0000-7000-8000-000000000013';
const OUTBOX_ONE_ID: string = '01920001-0000-7000-8000-000000000020';
const OUTBOX_TWO_ID: string = '01920001-0000-7000-8000-000000000021';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const CAPABILITY_ONE_HASH: string = '1'.repeat(64);
const CAPABILITY_TWO_HASH: string = '2'.repeat(64);
const SENT_AT: string = '2026-09-24T00:00:00.000Z';
const VIEWED_AT: string = '2026-09-24T01:00:00.000Z';
const SIGNED_AT: string = '2026-09-24T02:00:00.000Z';
const CAPABILITY_EXPIRES_AT: string = '2026-10-08T00:00:00.000Z';
const NEXT_CAPABILITY_EXPIRES_AT: string = '2026-10-08T02:00:00.000Z';
const FIELD_GENERATION: number = 1;

interface Fixture {
	sqlite: DatabaseSync;
	store: D1RecipientSignStore;
	viewedAuditHash: string;
}

/**
 * Seeds a sent envelope whose first signer has already viewed, so the signing
 * command is the next durable write. `withSecondSigner` adds a blocked routing
 * group 2 so the release branch of the publish trigger is exercised too.
 */
async function fixture(withSecondSigner: boolean = false): Promise<Fixture> {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	const store = new D1RecipientSignStore(sqliteD1Database(sqlite));

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
		recipientId: SIGNER_ONE_ID,
		role: 'signer',
		routingOrder: 1,
		sentCommitSha: COMMIT_SHA,
		viewedAt: VIEWED_AT
	};
	const viewedAuditHash: string = await hashAuditEventV3(
		{
			sequence: 2,
			eventType: 'recipient.viewed',
			actorType: 'recipient',
			actorId: SIGNER_ONE_ID,
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
			) VALUES (?, 'user-1', 'Agreement', 'in_progress', 1, ?, 'archives/integration.git.gz', ?, ?, ?, ?, ?)`
		)
		.run(ENVELOPE_ID, COMMIT_SHA, 'a'.repeat(64), COMMIT_SHA, FIELD_GENERATION, SENT_AT, VIEWED_AT);
	sqlite
		.prepare(
			`INSERT INTO recipient (
				id, envelope_id, email, name, role, locale, routing_order, status,
				capability_hash, capability_expires_at, created_at, updated_at
			) VALUES (?, ?, 'alice@example.test', 'Alice', 'signer', 'en', 1, 'viewed', ?, ?, ?, ?)`
		)
		.run(
			SIGNER_ONE_ID,
			ENVELOPE_ID,
			CAPABILITY_ONE_HASH,
			CAPABILITY_EXPIRES_AT,
			SENT_AT,
			VIEWED_AT
		);
	for (const [id, fieldType, label, position] of [
		[SIGNATURE_FIELD_ID, 'signature', 'Signature', 0],
		[TEXT_FIELD_ID, 'text', 'Full name', 1]
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO envelope_field (
					id, envelope_id, recipient_id, document_path, field_type, label,
					required, position, created_at, updated_at
				) VALUES (?, ?, ?, 'documents/agreement.md', ?, ?, 1, ?, ?, ?)`
			)
			.run(id, ENVELOPE_ID, SIGNER_ONE_ID, fieldType, label, position, SENT_AT, SENT_AT);
	}
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
			SIGNER_ONE_ID,
			CAPABILITY_ONE_HASH,
			'c'.repeat(64),
			SENT_AT,
			SENT_AT,
			SENT_AT,
			SENT_AT
		);

	if (withSecondSigner) {
		sqlite
			.prepare(
				`INSERT INTO recipient (
					id, envelope_id, email, name, role, locale, routing_order, status,
					capability_hash, capability_expires_at, created_at, updated_at
				) VALUES (?, ?, 'bob@example.test', 'Bob', 'signer', 'ja', 2, 'pending', ?, NULL, ?, ?)`
			)
			.run(SIGNER_TWO_ID, ENVELOPE_ID, CAPABILITY_TWO_HASH, SENT_AT, SENT_AT);
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
				SIGNER_TWO_ID,
				CAPABILITY_TWO_HASH,
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
			SIGNER_ONE_ID,
			JSON.stringify(viewedPayload),
			sentAuditHash,
			viewedAuditHash,
			VIEWED_AT
		);

	return { sqlite, store, viewedAuditHash };
}

const SIGNATURE_VALUE: string = 'data:image/png;base64,QUJD';
const TEXT_VALUE: string = 'Alice Example';

/** Field values in field-id order, matching the canonical fingerprint order. */
async function signedFieldValues(): Promise<readonly SignedFieldValue[]> {
	return await Promise.all(
		(
			[
				[SIGNATURE_FIELD_ID, 'signature', SIGNATURE_VALUE],
				[TEXT_FIELD_ID, 'text', TEXT_VALUE]
			] as const
		).map(async ([fieldId, fieldType, value]): Promise<SignedFieldValue> => {
			const valueJson: string = JSON.stringify(value);
			return {
				fieldId,
				fieldType,
				valueJson,
				valueSha256: await sha256TextHex(valueJson)
			};
		})
	);
}

async function signKey(idempotencyKey: string): Promise<SignLookupKey> {
	return {
		capabilityHash: CAPABILITY_ONE_HASH,
		expectedEnvelopeId: ENVELOPE_ID,
		expectedRecipientId: SIGNER_ONE_ID,
		idempotencyKey,
		expectedFieldGeneration: FIELD_GENERATION
	};
}

async function requestFingerprint(): Promise<string> {
	return await sha256TextHex(
		canonicalRecipientSignFingerprint({
			envelopeId: ENVELOPE_ID,
			recipientId: SIGNER_ONE_ID,
			capabilityHash: CAPABILITY_ONE_HASH,
			expectedFieldGeneration: FIELD_GENERATION,
			values: [
				{ fieldId: SIGNATURE_FIELD_ID, value: SIGNATURE_VALUE },
				{ fieldId: TEXT_FIELD_ID, value: TEXT_VALUE }
			]
		})
	);
}

/** Mirrors the audit payloads and chained hashes RecipientSignedApplication emits. */
async function signCommand(
	key: SignLookupKey,
	preparation: Extract<SignPreparation, { outcome: 'ready' }>,
	fieldValues: readonly SignedFieldValue[],
	release: boolean
): Promise<PublishRecipientSignedCommand> {
	const payload = {
		recipientId: key.expectedRecipientId,
		role: 'signer',
		routingOrder: preparation.routingOrder,
		sentCommitSha: preparation.sentCommitSha,
		fields: fieldValues.map((field: SignedFieldValue) => ({
			id: field.fieldId,
			fieldType: field.fieldType,
			valueSha256: field.valueSha256
		})),
		signedAt: SIGNED_AT
	};
	const auditEventHash: string = await hashAuditEventV3(
		{
			sequence: preparation.auditHead.sequence + 1,
			eventType: 'recipient.signed',
			actorType: 'recipient',
			actorId: key.expectedRecipientId,
			occurredAt: SIGNED_AT,
			payload,
			previousHash: preparation.auditHead.eventHash
		},
		{ envelopeId: ENVELOPE_ID }
	);
	const completedPayload = { sentCommitSha: preparation.sentCommitSha, completedAt: SIGNED_AT };
	const completedAuditEventHash: string = await hashAuditEventV3(
		{
			sequence: preparation.auditHead.sequence + 2,
			eventType: 'envelope.completed',
			actorType: 'recipient',
			actorId: key.expectedRecipientId,
			occurredAt: SIGNED_AT,
			payload: completedPayload,
			previousHash: auditEventHash
		},
		{ envelopeId: ENVELOPE_ID }
	);
	return {
		...key,
		requestFingerprint: await requestFingerprint(),
		recipientRole: 'signer',
		routingOrder: preparation.routingOrder,
		expectedSentCommitSha: preparation.sentCommitSha,
		fieldValues,
		updatedAt: SIGNED_AT,
		nextRoutingOrder: release ? preparation.routing.nextRoutingOrder : null,
		nextCapabilityExpiresAt: release ? NEXT_CAPABILITY_EXPIRES_AT : null,
		releasedDeliveryCount: release ? preparation.routing.nextGroupCount : 0,
		expectedAuditSequence: preparation.auditHead.sequence,
		previousAuditHash: preparation.auditHead.eventHash,
		auditEventId: SIGNED_AUDIT_ID,
		auditEventHash,
		auditPayloadJson: JSON.stringify(payload),
		completedAuditEventId: release ? null : COMPLETED_AUDIT_ID,
		completedAuditEventHash: release ? null : completedAuditEventHash,
		completedAuditPayloadJson: release ? null : JSON.stringify(completedPayload)
	};
}

function fieldValueRows(sqlite: DatabaseSync): Record<string, unknown>[] {
	return (
		sqlite
			.prepare(
				`SELECT field_id, envelope_id, recipient_id, field_type, value_json, value_sha256, created_at
				 FROM field_value ORDER BY field_id`
			)
			.all() as Record<string, unknown>[]
	).map((row: Record<string, unknown>): Record<string, unknown> => ({ ...row }));
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

describe('D1RecipientSignStore integration', () => {
	it('persists field values and completes the envelope on the last signature', async () => {
		const { sqlite, store, viewedAuditHash } = await fixture();
		const key: SignLookupKey = await signKey('signed-idempotency-1');

		const preparation: SignPreparation = await store.prepareSign(key, SIGNED_AT);
		expect(preparation.outcome).toBe('ready');
		if (preparation.outcome !== 'ready') return;
		expect(preparation.auditHead).toStrictEqual({ sequence: 2, eventHash: viewedAuditHash });
		expect(preparation.fieldGeneration).toBe(FIELD_GENERATION);
		expect(preparation.routing).toStrictEqual({
			currentGroupOutstanding: 0,
			remainingActionableOutstanding: 0,
			nextRoutingOrder: null,
			nextGroupCount: 0
		});
		expect(preparation.fields).toStrictEqual([
			{ id: SIGNATURE_FIELD_ID, fieldType: 'signature', required: true },
			{ id: TEXT_FIELD_ID, fieldType: 'text', required: true }
		]);

		const fieldValues: readonly SignedFieldValue[] = await signedFieldValues();
		const command: PublishRecipientSignedCommand = await signCommand(
			key,
			preparation,
			fieldValues,
			false
		);
		const published = await store.publishSign(command);
		expect(published.outcome).toBe('published');
		if (published.outcome !== 'published') return;
		expect(published.result).toStrictEqual({
			envelopeId: ENVELOPE_ID,
			recipientId: SIGNER_ONE_ID,
			recipientRole: 'signer',
			routingOrder: 1,
			sentCommitSha: COMMIT_SHA,
			envelopeStatus: 'completed',
			signedAt: SIGNED_AT,
			auditEventId: SIGNED_AUDIT_ID,
			completedAuditEventId: COMPLETED_AUDIT_ID,
			nextRoutingOrder: null
		});

		// Every declared value must land in its own field_value row; the released
		// INSERT bound seven values into eight placeholders and never ran.
		expect(fieldValueRows(sqlite)).toStrictEqual([
			{
				field_id: SIGNATURE_FIELD_ID,
				envelope_id: ENVELOPE_ID,
				recipient_id: SIGNER_ONE_ID,
				field_type: 'signature',
				value_json: JSON.stringify(SIGNATURE_VALUE),
				value_sha256: fieldValues[0].valueSha256,
				created_at: SIGNED_AT
			},
			{
				field_id: TEXT_FIELD_ID,
				envelope_id: ENVELOPE_ID,
				recipient_id: SIGNER_ONE_ID,
				field_type: 'text',
				value_json: JSON.stringify(TEXT_VALUE),
				value_sha256: fieldValues[1].valueSha256,
				created_at: SIGNED_AT
			}
		]);

		// The literal actor_type and the bound actor_id must occupy their own
		// columns, as with the viewed command.
		const commandRow = sqlite
			.prepare(
				`SELECT actor_type, actor_id, recipient_role, routing_order, request_hash, field_count,
					expected_field_generation, audit_sequence, next_routing_order,
					next_capability_expires_at, released_delivery_count, completed_audit_event_id
				 FROM recipient_signed_command WHERE recipient_id = ?`
			)
			.get(SIGNER_ONE_ID) as Record<string, unknown>;
		expect({ ...commandRow }).toStrictEqual({
			actor_type: 'recipient',
			actor_id: SIGNER_ONE_ID,
			recipient_role: 'signer',
			routing_order: 1,
			request_hash: command.requestFingerprint,
			field_count: 2,
			expected_field_generation: FIELD_GENERATION,
			audit_sequence: 3,
			next_routing_order: null,
			next_capability_expires_at: null,
			released_delivery_count: 0,
			completed_audit_event_id: COMPLETED_AUDIT_ID
		});

		const recipientRow = sqlite
			.prepare('SELECT status, capability_revoked_at FROM recipient WHERE id = ?')
			.get(SIGNER_ONE_ID) as { status: string; capability_revoked_at: string };
		expect({ ...recipientRow }).toStrictEqual({
			status: 'completed',
			capability_revoked_at: SIGNED_AT
		});

		const envelopeRow = sqlite
			.prepare('SELECT status, updated_at FROM envelope WHERE id = ?')
			.get(ENVELOPE_ID) as { status: string; updated_at: string };
		expect({ ...envelopeRow }).toStrictEqual({ status: 'completed', updated_at: SIGNED_AT });

		expect(auditTrail(sqlite)).toStrictEqual([
			{ sequence: 1, event_type: 'envelope.sent' },
			{ sequence: 2, event_type: 'recipient.viewed' },
			{ sequence: 3, event_type: 'recipient.signed' },
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
			actor_id: SIGNER_ONE_ID,
			occurred_at: SIGNED_AT
		});
	});

	it('replays a completed signature without duplicating values or audit events', async () => {
		const { sqlite, store } = await fixture();
		const key: SignLookupKey = await signKey('signed-idempotency-1');

		const preparation: SignPreparation = await store.prepareSign(key, SIGNED_AT);
		expect(preparation.outcome).toBe('ready');
		if (preparation.outcome !== 'ready') return;
		const command: PublishRecipientSignedCommand = await signCommand(
			key,
			preparation,
			await signedFieldValues(),
			false
		);
		expect((await store.publishSign(command)).outcome).toBe('published');

		// Replay is proven from the stored field values and audit evidence, so
		// the reconstructed fingerprint has to match the original request.
		const replayPreparation: SignPreparation = await store.prepareSign(
			key,
			'2026-09-24T03:00:00.000Z'
		);
		expect(replayPreparation.outcome).toBe('existing');
		if (replayPreparation.outcome !== 'existing') return;
		expect(replayPreparation.reconstructedFingerprint).toBe(command.requestFingerprint);
		expect(replayPreparation.result.envelopeStatus).toBe('completed');
		expect(replayPreparation.storedFields.map((field) => field.id)).toStrictEqual([
			SIGNATURE_FIELD_ID,
			TEXT_FIELD_ID
		]);

		const republished = await store.publishSign(command);
		expect(republished.outcome).toBe('replayed');
		if (republished.outcome !== 'replayed') return;
		expect(republished.result.auditEventId).toBe(SIGNED_AUDIT_ID);
		expect(republished.result.completedAuditEventId).toBe(COMPLETED_AUDIT_ID);

		expect(fieldValueRows(sqlite).length).toBe(2);
		expect(auditTrail(sqlite).length).toBe(4);
		const signedCommandCount = sqlite
			.prepare('SELECT count(*) AS count FROM recipient_signed_command')
			.get() as { count: number };
		expect(Number(signedCommandCount.count)).toBe(1);
	});

	it('releases the next routing group instead of completing when signers remain', async () => {
		const { sqlite, store } = await fixture(true);
		const key: SignLookupKey = await signKey('signed-idempotency-1');

		const preparation: SignPreparation = await store.prepareSign(key, SIGNED_AT);
		expect(preparation.outcome).toBe('ready');
		if (preparation.outcome !== 'ready') return;
		expect(preparation.routing).toStrictEqual({
			currentGroupOutstanding: 0,
			remainingActionableOutstanding: 1,
			nextRoutingOrder: 2,
			nextGroupCount: 1
		});

		const command: PublishRecipientSignedCommand = await signCommand(
			key,
			preparation,
			await signedFieldValues(),
			true
		);
		const published = await store.publishSign(command);
		expect(published.outcome).toBe('published');
		if (published.outcome !== 'published') return;
		expect(published.result.envelopeStatus).toBe('in_progress');
		expect(published.result.nextRoutingOrder).toBe(2);
		expect(published.result.completedAuditEventId).toBeNull();

		expect(fieldValueRows(sqlite).length).toBe(2);
		expect(auditTrail(sqlite)).toStrictEqual([
			{ sequence: 1, event_type: 'envelope.sent' },
			{ sequence: 2, event_type: 'recipient.viewed' },
			{ sequence: 3, event_type: 'recipient.signed' }
		]);

		const envelopeRow = sqlite
			.prepare('SELECT status FROM envelope WHERE id = ?')
			.get(ENVELOPE_ID) as { status: string };
		expect(envelopeRow.status).toBe('in_progress');

		const nextRecipient = sqlite
			.prepare('SELECT status, capability_expires_at FROM recipient WHERE id = ?')
			.get(SIGNER_TWO_ID) as { status: string; capability_expires_at: string };
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
			available_at: SIGNED_AT,
			reserved_capability_expires_at: NEXT_CAPABILITY_EXPIRES_AT
		});

		// The non-terminal path replays from the same durable receipt.
		const replayed = await store.publishSign(command);
		expect(replayed.outcome).toBe('replayed');
		if (replayed.outcome !== 'replayed') return;
		expect(replayed.result.nextRoutingOrder).toBe(2);
		expect(fieldValueRows(sqlite).length).toBe(2);
		expect(auditTrail(sqlite).length).toBe(3);
	});
});
