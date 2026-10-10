import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { hashAuditEventV3 } from '$lib/domain/audit';
import { RecipientApprovedApplication } from '$lib/application/signing/recipient-approved';
import { RecipientCompletedReceiptApplication } from '$lib/application/signing/recipient-completed-receipt';
import { RecipientDeclinedReceiptApplication } from '$lib/application/signing/recipient-declined-receipt';
import { RecipientSignedApplication } from '$lib/application/signing/recipient-signed';
import { issueRecipientCapability } from '$lib/security/recipient-capability';
import { D1RecipientApproveStore } from './d1-recipient-approve-store';
import { D1RecipientCompletedReceiptStore } from './d1-recipient-completed-receipt-store';
import { D1RecipientDeclinedReceiptStore } from './d1-recipient-declined-receipt-store';
import { D1RecipientSignStore } from './d1-recipient-sign-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ENVELOPE_ID: string = '01920002-0000-7000-8000-000000000001';
const ACTOR_ID: string = '01920002-0000-7000-8000-000000000002';
const SECOND_ID: string = '01920002-0000-7000-8000-000000000003';
const SIGNATURE_FIELD_ID: string = '01920002-0000-7000-8000-00000000000a';
const TEXT_FIELD_ID: string = '01920002-0000-7000-8000-00000000000b';
const SENT_AUDIT_ID: string = '01920002-0000-7000-8000-000000000010';
const VIEWED_AUDIT_ID: string = '01920002-0000-7000-8000-000000000011';
const OUTBOX_ONE_ID: string = '01920002-0000-7000-8000-000000000020';
const OUTBOX_TWO_ID: string = '01920002-0000-7000-8000-000000000021';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const SENT_AT: string = '2026-09-24T00:00:00.000Z';
const VIEWED_AT: string = '2026-09-24T01:00:00.000Z';
const COMPLETED_AT: string = '2026-09-24T02:00:00.000Z';
const EXPIRES_AT: string = '2026-10-24T02:00:00.000Z';
const JUST_BEFORE_EXPIRY: Date = new Date('2026-10-24T01:59:59.999Z');
const SOON_AFTER: Date = new Date('2026-09-25T00:00:00.000Z');
const CAPABILITY_EXPIRES_AT: string = '2026-10-08T00:00:00.000Z';
const FIELD_GENERATION: number = 1;

interface Fixture {
	sqlite: DatabaseSync;
	database: D1Database;
	token: string;
	capabilityHash: string;
	idempotencyKey: string;
}

interface FixtureOptions {
	action: 'signed' | 'approved';
	/** Adds an outstanding group-2 signer so the envelope stays `in_progress`. */
	withSecondRecipient?: boolean;
}

/**
 * Seeds a sent envelope whose group-1 actor has already viewed, then completes
 * that actor's action through the real application and D1 store, so the receipt
 * is proven from evidence the production publish path actually wrote.
 */
async function fixture(options: FixtureOptions): Promise<Fixture> {
	const role: 'signer' | 'approver' = options.action === 'signed' ? 'signer' : 'approver';
	const withSecondRecipient: boolean = options.withSecondRecipient ?? false;
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	const database: D1Database = sqliteD1Database(sqlite);
	const capability = await issueRecipientCapability();
	const secondCapability = await issueRecipientCapability();

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
		recipientId: ACTOR_ID,
		role,
		routingOrder: 1,
		sentCommitSha: COMMIT_SHA,
		viewedAt: VIEWED_AT
	};
	const viewedAuditHash: string = await hashAuditEventV3(
		{
			sequence: 2,
			eventType: 'recipient.viewed',
			actorType: 'recipient',
			actorId: ACTOR_ID,
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
			) VALUES (?, 'user-1', 'Agreement', 'in_progress', 1, ?, 'archives/receipt.git.gz', ?, ?, ?, ?, ?)`
		)
		.run(ENVELOPE_ID, COMMIT_SHA, 'a'.repeat(64), COMMIT_SHA, FIELD_GENERATION, SENT_AT, VIEWED_AT);
	sqlite
		.prepare(
			`INSERT INTO recipient (
				id, envelope_id, email, name, role, locale, routing_order, status,
				capability_hash, capability_expires_at, created_at, updated_at
			) VALUES (?, ?, 'alice@example.test', 'Alice', ?, 'ja', 1, 'viewed', ?, ?, ?, ?)`
		)
		.run(
			ACTOR_ID,
			ENVELOPE_ID,
			role,
			capability.tokenHash,
			CAPABILITY_EXPIRES_AT,
			SENT_AT,
			VIEWED_AT
		);
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
			ACTOR_ID,
			capability.tokenHash,
			'c'.repeat(64),
			SENT_AT,
			SENT_AT,
			SENT_AT,
			SENT_AT
		);

	if (options.action === 'signed') {
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
				.run(id, ENVELOPE_ID, ACTOR_ID, fieldType, label, position, SENT_AT, SENT_AT);
		}
	}

	if (withSecondRecipient) {
		sqlite
			.prepare(
				`INSERT INTO recipient (
					id, envelope_id, email, name, role, locale, routing_order, status,
					capability_hash, capability_expires_at, created_at, updated_at
				) VALUES (?, ?, 'bob@example.test', 'Bob', 'signer', 'en', 2, 'pending', ?, NULL, ?, ?)`
			)
			.run(SECOND_ID, ENVELOPE_ID, secondCapability.tokenHash, SENT_AT, SENT_AT);
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
				SECOND_ID,
				secondCapability.tokenHash,
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
			ACTOR_ID,
			JSON.stringify(viewedPayload),
			sentAuditHash,
			viewedAuditHash,
			VIEWED_AT
		);

	const now = (): Date => new Date(COMPLETED_AT);
	const idempotencyKey: string = `${options.action}-command-1`;
	if (options.action === 'signed') {
		const published = await new RecipientSignedApplication(
			new D1RecipientSignStore(database),
			now
		).sign({
			token: capability.token,
			expectedEnvelopeId: ENVELOPE_ID,
			expectedRecipientId: ACTOR_ID,
			expectedFieldGeneration: FIELD_GENERATION,
			idempotencyKey,
			values: [
				{ fieldId: SIGNATURE_FIELD_ID, value: 'Alice Example' },
				{ fieldId: TEXT_FIELD_ID, value: 'Alice Example' }
			]
		});
		if (published.outcome !== 'published') throw new Error(`Fixture sign: ${published.outcome}`);
	} else {
		const published = await new RecipientApprovedApplication(
			new D1RecipientApproveStore(database),
			now
		).approve({
			token: capability.token,
			expectedEnvelopeId: ENVELOPE_ID,
			expectedRecipientId: ACTOR_ID,
			idempotencyKey
		});
		if (published.outcome !== 'published') throw new Error(`Fixture approve: ${published.outcome}`);
	}

	return {
		sqlite,
		database,
		token: capability.token,
		capabilityHash: capability.tokenHash,
		idempotencyKey
	};
}

function application(database: D1Database): RecipientCompletedReceiptApplication {
	return new RecipientCompletedReceiptApplication(new D1RecipientCompletedReceiptStore(database));
}

describe('D1 completed-action receipt evidence integration', () => {
	it('recovers and exact-resolves a signer receipt that also completed the envelope', async () => {
		const { sqlite, database, token, idempotencyKey } = await fixture({ action: 'signed' });
		try {
			const recovered = await application(database).recoverByToken(token, JUST_BEFORE_EXPIRY);

			expect(recovered).toEqual({
				receipt: {
					envelopeId: ENVELOPE_ID,
					recipientId: ACTOR_ID,
					recipientStatus: 'completed',
					action: 'signed',
					completedAt: COMPLETED_AT,
					envelopeStatus: 'completed',
					envelopeCompletedByThisAction: true,
					locale: 'ja'
				},
				locator: expect.objectContaining({
					idempotencyKey,
					action: 'signed',
					completedAt: COMPLETED_AT,
					expiresAt: EXPIRES_AT
				})
			});
			await expect(
				application(database).resolveLocator(
					recovered?.locator as NonNullable<typeof recovered>['locator'],
					SOON_AFTER
				)
			).resolves.toEqual(recovered);
		} finally {
			sqlite.close();
		}
	});

	it('reports an approver receipt as in_progress while a later group is outstanding', async () => {
		const { sqlite, database, token } = await fixture({
			action: 'approved',
			withSecondRecipient: true
		});
		try {
			const recovered = await application(database).recoverByToken(token, SOON_AFTER);

			expect(recovered?.receipt).toEqual({
				envelopeId: ENVELOPE_ID,
				recipientId: ACTOR_ID,
				recipientStatus: 'completed',
				action: 'approved',
				completedAt: COMPLETED_AT,
				envelopeStatus: 'in_progress',
				envelopeCompletedByThisAction: false,
				locale: 'ja'
			});
		} finally {
			sqlite.close();
		}
	});

	it('reports envelope completion by a later recipient without crediting this action', async () => {
		const { sqlite, database, token } = await fixture({
			action: 'approved',
			withSecondRecipient: true
		});
		try {
			// The later signer finishes; only the whole-envelope status moves.
			sqlite.exec(`UPDATE envelope SET status='completed' WHERE id='${ENVELOPE_ID}'`);
			const recovered = await application(database).recoverByToken(token, SOON_AFTER);

			expect(recovered?.receipt).toMatchObject({
				action: 'approved',
				envelopeStatus: 'completed',
				envelopeCompletedByThisAction: false
			});
		} finally {
			sqlite.close();
		}
	});

	it('expires a receipt exactly 30 days after the action, like a declined receipt', async () => {
		const { sqlite, database, token } = await fixture({ action: 'signed' });
		try {
			await expect(
				application(database).recoverByToken(token, JUST_BEFORE_EXPIRY)
			).resolves.not.toBeNull();
			await expect(
				application(database).recoverByToken(token, new Date(EXPIRES_AT))
			).resolves.toBeNull();
		} finally {
			sqlite.close();
		}
	});

	it.each([
		['the recipient status', "UPDATE recipient SET status='viewed'"],
		['the recipient role', "UPDATE recipient SET role='approver'"],
		['the recipient capability hash', `UPDATE recipient SET capability_hash='${'e'.repeat(64)}'`],
		['the capability revocation', 'UPDATE recipient SET capability_revoked_at=NULL'],
		[
			'the revocation timestamp',
			"UPDATE recipient SET capability_revoked_at='2026-09-24T02:00:01.000Z'"
		],
		['the envelope commit pin', "UPDATE envelope SET repository_head='deadbeef'"],
		['the envelope status by voiding', "UPDATE envelope SET status='voided'"],
		['the envelope status by expiry', "UPDATE envelope SET status='expired'"],
		[
			'the command timestamp',
			"UPDATE recipient_signed_command SET updated_at='2026-09-24T03:00:00.000Z'"
		],
		['the command routing order', 'UPDATE recipient_signed_command SET routing_order=2'],
		['the command audit payload', "UPDATE recipient_signed_command SET audit_payload_json='{}'"],
		['the command audit hash', "UPDATE recipient_signed_command SET audit_event_hash='tampered'"],
		[
			'the command field digests',
			`UPDATE recipient_signed_command SET field_values_json='[{"id":"${SIGNATURE_FIELD_ID}","fieldType":"signature","valueSha256":"${'f'.repeat(64)}"}]', field_count=1`
		],
		['the durable field digests', `UPDATE field_value SET value_sha256='${'f'.repeat(64)}'`],
		[
			'the durable field type',
			"UPDATE field_value SET field_type='text' WHERE field_type='signature'"
		],
		['the field declaration', `DELETE FROM field_value WHERE field_id='${TEXT_FIELD_ID}'`],
		['this action’s audit event', "UPDATE audit_event SET event_hash='tampered' WHERE sequence=3"],
		['the audit predecessor', "UPDATE audit_event SET event_hash='tampered' WHERE sequence=2"],
		[
			'the chained completion event',
			"UPDATE audit_event SET event_hash='tampered' WHERE sequence=4"
		],
		['the chained completion payload', "UPDATE audit_event SET payload_json='{}' WHERE sequence=4"],
		['the completion evidence by deletion', 'DELETE FROM audit_event WHERE sequence=4']
	])('fails closed when %s is no longer intact', async (_name, mutation) => {
		const { sqlite, database, token } = await fixture({ action: 'signed' });
		try {
			sqlite.exec(mutation);
			await expect(application(database).recoverByToken(token, SOON_AFTER)).resolves.toBeNull();
		} finally {
			sqlite.close();
		}
	});

	it('fails closed when a completion is claimed without the envelope reaching completed', async () => {
		const { sqlite, database, token } = await fixture({ action: 'signed' });
		try {
			sqlite.exec(`UPDATE envelope SET status='in_progress' WHERE id='${ENVELOPE_ID}'`);
			await expect(application(database).recoverByToken(token, SOON_AFTER)).resolves.toBeNull();
		} finally {
			sqlite.close();
		}
	});

	it('keeps the routing/completion column pairings unwritable in the first place', async () => {
		const { sqlite, database, token } = await fixture({
			action: 'approved',
			withSecondRecipient: true
		});
		try {
			// The table CHECK constraints reject the rewrite outright, so the
			// prover's own pairing checks are exercised in
			// recipient-completed-receipt-evidence.spec.ts instead.
			expect(() =>
				sqlite.exec('UPDATE recipient_approved_command SET released_delivery_count=0')
			).toThrow(/CHECK constraint failed/);
			await expect(application(database).recoverByToken(token, SOON_AFTER)).resolves.not.toBeNull();
		} finally {
			sqlite.close();
		}
	});

	it('returns no row for any stale or cross-action locator identity', async () => {
		const { sqlite, database, capabilityHash, idempotencyKey } = await fixture({
			action: 'signed'
		});
		try {
			const store = new D1RecipientCompletedReceiptStore(database);
			const identity = {
				envelopeId: ENVELOPE_ID,
				recipientId: ACTOR_ID,
				idempotencyKey,
				capabilityHash,
				action: 'signed' as const
			};

			await expect(store.findByIdentity(identity)).resolves.not.toBeNull();
			for (const changed of [
				{ ...identity, envelopeId: 'other' },
				{ ...identity, recipientId: 'other' },
				{ ...identity, idempotencyKey: 'other' },
				{ ...identity, capabilityHash: 'd'.repeat(64) },
				// The approver table holds no row for this signer, so the action is
				// not a free-floating label on otherwise valid evidence.
				{ ...identity, action: 'approved' as const }
			]) {
				await expect(store.findByIdentity(changed)).resolves.toBeNull();
			}
		} finally {
			sqlite.close();
		}
	});

	it('does not let a completed action satisfy the declined receipt path', async () => {
		const { sqlite, database, token } = await fixture({ action: 'signed' });
		try {
			await expect(
				new RecipientDeclinedReceiptApplication(
					new D1RecipientDeclinedReceiptStore(database)
				).recoverByToken(token, SOON_AFTER)
			).resolves.toBeNull();
		} finally {
			sqlite.close();
		}
	});

	it('fails closed for a capability that was never used', async () => {
		const { sqlite, database } = await fixture({ action: 'signed' });
		try {
			const unused = await issueRecipientCapability();
			await expect(
				application(database).recoverByToken(unused.token, SOON_AFTER)
			).resolves.toBeNull();
		} finally {
			sqlite.close();
		}
	});
});
