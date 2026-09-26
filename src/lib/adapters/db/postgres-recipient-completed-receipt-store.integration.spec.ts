import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashAuditEventV3 } from '$lib/domain/audit';
import { RecipientApprovedApplication } from '$lib/application/signing/recipient-approved';
import { RecipientCompletedReceiptApplication } from '$lib/application/signing/recipient-completed-receipt';
import { RecipientDeclinedReceiptApplication } from '$lib/application/signing/recipient-declined-receipt';
import { RecipientSignedApplication } from '$lib/application/signing/recipient-signed';
import { issueRecipientCapability } from '$lib/security/recipient-capability';
import { PostgresRecipientApproveStore } from './postgres-recipient-approve-store';
import { PostgresRecipientCompletedReceiptStore } from './postgres-recipient-completed-receipt-store';
import { PostgresRecipientDeclinedReceiptStore } from './postgres-recipient-declined-receipt-store';
import { PostgresRecipientSignStore } from './postgres-recipient-sign-store';

const DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const postgresDescribe = DATABASE_URL === undefined ? describe.skip : describe;

const ENVELOPE_ID: string = '01920004-0000-7000-8000-000000000001';
const ACTOR_ID: string = '01920004-0000-7000-8000-000000000002';
const SECOND_ID: string = '01920004-0000-7000-8000-000000000003';
const SIGNATURE_FIELD_ID: string = '01920004-0000-7000-8000-00000000000a';
const TEXT_FIELD_ID: string = '01920004-0000-7000-8000-00000000000b';
const SENT_AUDIT_ID: string = '01920004-0000-7000-8000-000000000010';
const VIEWED_AUDIT_ID: string = '01920004-0000-7000-8000-000000000011';
const OUTBOX_ONE_ID: string = '01920004-0000-7000-8000-000000000020';
const OUTBOX_TWO_ID: string = '01920004-0000-7000-8000-000000000021';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const SENT_AT: string = '2026-09-24T00:00:00.000Z';
const VIEWED_AT: string = '2026-09-24T01:00:00.000Z';
const COMPLETED_AT: string = '2026-09-24T02:00:00.000Z';
const EXPIRES_AT: string = '2026-10-24T02:00:00.000Z';
const JUST_BEFORE_EXPIRY: Date = new Date('2026-10-24T01:59:59.999Z');
const SOON_AFTER: Date = new Date('2026-09-25T00:00:00.000Z');
const CAPABILITY_EXPIRES_AT: string = '2026-10-08T00:00:00.000Z';
const FIELD_GENERATION: number = 1;

interface Seeded {
	token: string;
	capabilityHash: string;
	idempotencyKey: string;
}

postgresDescribe('PostgreSQL completed-action receipt evidence integration', () => {
	const schema = `signkit_completed_receipt_${randomUUID().replaceAll('-', '')}`;
	let sql: ReturnType<typeof postgres> | null = null;

	beforeAll(async () => {
		sql = postgres(DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		await sql.unsafe(`CREATE SCHEMA "${schema}"`);
		await sql.unsafe(`SET search_path TO "${schema}"`);
		const paths = readdirSync('migrations/postgres')
			.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
			.sort();
		for (const path of paths) {
			await sql.unsafe(readFileSync(`migrations/postgres/${path}`, 'utf8'));
		}
	});

	beforeEach(async () => {
		if (sql === null) return;
		await sql`TRUNCATE recipient_signed_command, recipient_approved_command, field_value,
			envelope_field, delivery_outbox, audit_event, recipient, envelope, instance_member CASCADE`;
	});

	afterAll(async () => {
		if (sql === null) return;
		await sql.unsafe('SET search_path TO public');
		await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
		await sql.end({ timeout: 5 });
	});

	/**
	 * Seeds the same sent envelope the D1 integration test uses and completes the
	 * group-1 actor's action through the real application and PostgreSQL store,
	 * so both dialects are proven from evidence their own publish path wrote.
	 */
	async function seed(options: {
		action: 'signed' | 'approved';
		withSecondRecipient?: boolean;
	}): Promise<Seeded> {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const db: ReturnType<typeof postgres> = sql;
		const role: 'signer' | 'approver' = options.action === 'signed' ? 'signer' : 'approver';
		const withSecondRecipient: boolean = options.withSecondRecipient ?? false;
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

		await db`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES ('user-1', 'owner', 'active', ${SENT_AT}, ${SENT_AT})`;
		await db`INSERT INTO envelope (
				id, created_by_user_id, title, status, repository_generation, repository_head,
				repository_archive_key, repository_archive_sha256, sent_commit_sha,
				field_generation, created_at, updated_at
			) VALUES (${ENVELOPE_ID}, 'user-1', 'Agreement', 'in_progress', 1, ${COMMIT_SHA},
				'archives/receipt.git.gz', ${'a'.repeat(64)}, ${COMMIT_SHA}, ${FIELD_GENERATION},
				${SENT_AT}, ${VIEWED_AT})`;
		await db`INSERT INTO recipient (
				id, envelope_id, email, name, role, locale, routing_order, status,
				capability_hash, capability_expires_at, created_at, updated_at
			) VALUES (${ACTOR_ID}, ${ENVELOPE_ID}, 'alice@example.test', 'Alice', ${role}, 'ja', 1,
				'viewed', ${capability.tokenHash}, ${CAPABILITY_EXPIRES_AT}, ${SENT_AT}, ${VIEWED_AT})`;
		await db`INSERT INTO delivery_outbox (
				id, envelope_id, recipient_id, kind, status, capability_hash,
				reserved_capability_expires_at, sealed_capability, sealing_key_id,
				sealed_capability_sha256, available_at, attempts, delivered_at,
				created_at, updated_at, retryable
			) VALUES (${OUTBOX_ONE_ID}, ${ENVELOPE_ID}, ${ACTOR_ID}, 'recipient_invitation', 'delivered',
				${capability.tokenHash}, NULL, NULL, 'key-1', ${'c'.repeat(64)}, ${SENT_AT}, 1,
				${SENT_AT}, ${SENT_AT}, ${SENT_AT}, false)`;

		if (options.action === 'signed') {
			for (const [id, fieldType, label, position] of [
				[SIGNATURE_FIELD_ID, 'signature', 'Signature', 0],
				[TEXT_FIELD_ID, 'text', 'Full name', 1]
			] as const) {
				await db`INSERT INTO envelope_field (
						id, envelope_id, recipient_id, document_path, field_type, label,
						required, position, created_at, updated_at
					) VALUES (${id}, ${ENVELOPE_ID}, ${ACTOR_ID}, 'documents/agreement.md', ${fieldType},
						${label}, true, ${position}, ${SENT_AT}, ${SENT_AT})`;
			}
		}

		if (withSecondRecipient) {
			await db`INSERT INTO recipient (
					id, envelope_id, email, name, role, locale, routing_order, status,
					capability_hash, capability_expires_at, created_at, updated_at
				) VALUES (${SECOND_ID}, ${ENVELOPE_ID}, 'bob@example.test', 'Bob', 'signer', 'en', 2,
					'pending', ${secondCapability.tokenHash}, NULL, ${SENT_AT}, ${SENT_AT})`;
			await db`INSERT INTO delivery_outbox (
					id, envelope_id, recipient_id, kind, status, capability_hash,
					reserved_capability_expires_at, sealed_capability, sealing_key_id,
					sealed_capability_sha256, available_at, attempts,
					created_at, updated_at, retryable
				) VALUES (${OUTBOX_TWO_ID}, ${ENVELOPE_ID}, ${SECOND_ID}, 'recipient_invitation',
					'blocked', ${secondCapability.tokenHash}, NULL, 'sealed-blob-2', 'key-1',
					${'d'.repeat(64)}, NULL, 0, ${SENT_AT}, ${SENT_AT}, true)`;
		}

		await db`INSERT INTO audit_event (
				id, envelope_id, sequence, event_type, actor_type,
				actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
			) VALUES (${SENT_AUDIT_ID}, ${ENVELOPE_ID}, 1, 'envelope.sent', 'user', 'user-1',
				${JSON.stringify({ sentCommitSha: COMMIT_SHA })}, NULL, ${sentAuditHash}, ${SENT_AT}, 3)`;
		await db`INSERT INTO audit_event (
				id, envelope_id, sequence, event_type, actor_type,
				actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
			) VALUES (${VIEWED_AUDIT_ID}, ${ENVELOPE_ID}, 2, 'recipient.viewed', 'recipient', ${ACTOR_ID},
				${JSON.stringify(viewedPayload)}, ${sentAuditHash}, ${viewedAuditHash}, ${VIEWED_AT}, 3)`;

		const now = (): Date => new Date(COMPLETED_AT);
		const idempotencyKey: string = `${options.action}-command-1`;
		if (options.action === 'signed') {
			const published = await new RecipientSignedApplication(
				new PostgresRecipientSignStore(db),
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
			if (published.outcome !== 'published') throw new Error(`Seed sign: ${published.outcome}`);
		} else {
			const published = await new RecipientApprovedApplication(
				new PostgresRecipientApproveStore(db),
				now
			).approve({
				token: capability.token,
				expectedEnvelopeId: ENVELOPE_ID,
				expectedRecipientId: ACTOR_ID,
				idempotencyKey
			});
			if (published.outcome !== 'published') throw new Error(`Seed approve: ${published.outcome}`);
		}

		return { token: capability.token, capabilityHash: capability.tokenHash, idempotencyKey };
	}

	function application(): RecipientCompletedReceiptApplication {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		return new RecipientCompletedReceiptApplication(
			new PostgresRecipientCompletedReceiptStore(sql)
		);
	}

	it('recovers and exact-resolves a signer receipt that also completed the envelope', async () => {
		const { token, idempotencyKey } = await seed({ action: 'signed' });
		const recovered = await application().recoverByToken(token, JUST_BEFORE_EXPIRY);

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
			application().resolveLocator(
				recovered?.locator as NonNullable<typeof recovered>['locator'],
				SOON_AFTER
			)
		).resolves.toEqual(recovered);
	});

	it('reports an approver receipt as in_progress while a later group is outstanding', async () => {
		const { token } = await seed({ action: 'approved', withSecondRecipient: true });

		expect((await application().recoverByToken(token, SOON_AFTER))?.receipt).toEqual({
			envelopeId: ENVELOPE_ID,
			recipientId: ACTOR_ID,
			recipientStatus: 'completed',
			action: 'approved',
			completedAt: COMPLETED_AT,
			envelopeStatus: 'in_progress',
			envelopeCompletedByThisAction: false,
			locale: 'ja'
		});
	});

	it('reports envelope completion by a later recipient without crediting this action', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const { token } = await seed({ action: 'approved', withSecondRecipient: true });
		await sql`UPDATE envelope SET status='completed' WHERE id=${ENVELOPE_ID}`;

		expect((await application().recoverByToken(token, SOON_AFTER))?.receipt).toMatchObject({
			action: 'approved',
			envelopeStatus: 'completed',
			envelopeCompletedByThisAction: false
		});
	});

	it('expires a receipt exactly 30 days after the action', async () => {
		const { token } = await seed({ action: 'signed' });

		await expect(application().recoverByToken(token, JUST_BEFORE_EXPIRY)).resolves.not.toBeNull();
		await expect(application().recoverByToken(token, new Date(EXPIRES_AT))).resolves.toBeNull();
	});

	it.each([
		['the recipient status', `UPDATE recipient SET status='viewed'`],
		['the recipient role', `UPDATE recipient SET role='approver'`],
		['the capability revocation', 'UPDATE recipient SET capability_revoked_at=NULL'],
		['the envelope commit pin', `UPDATE envelope SET repository_head='deadbeef'`],
		['the envelope status by voiding', `UPDATE envelope SET status='voided'`],
		['the command audit payload', `UPDATE recipient_signed_command SET audit_payload_json='{}'`],
		['the durable field digests', `UPDATE field_value SET value_sha256='${'f'.repeat(64)}'`],
		['this action’s audit event', `UPDATE audit_event SET event_hash='tampered' WHERE sequence=3`],
		['the audit predecessor', `UPDATE audit_event SET event_hash='tampered' WHERE sequence=2`],
		[
			'the chained completion event',
			`UPDATE audit_event SET event_hash='tampered' WHERE sequence=4`
		],
		['the completion evidence by deletion', 'DELETE FROM audit_event WHERE sequence=4']
	])('fails closed when %s is no longer intact', async (_name, mutation) => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const { token } = await seed({ action: 'signed' });
		await sql.unsafe(mutation);

		await expect(application().recoverByToken(token, SOON_AFTER)).resolves.toBeNull();
	});

	it('returns no row for any stale or cross-action locator identity', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const { capabilityHash, idempotencyKey } = await seed({ action: 'signed' });
		const store = new PostgresRecipientCompletedReceiptStore(sql);
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
			{ ...identity, action: 'approved' as const }
		]) {
			await expect(store.findByIdentity(changed)).resolves.toBeNull();
		}
	});

	it('does not let a completed action satisfy the declined receipt path', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const { token } = await seed({ action: 'signed' });

		await expect(
			new RecipientDeclinedReceiptApplication(
				new PostgresRecipientDeclinedReceiptStore(sql)
			).recoverByToken(token, SOON_AFTER)
		).resolves.toBeNull();
	});

	it('fails closed for a capability that was never used', async () => {
		await seed({ action: 'signed' });
		const unused = await issueRecipientCapability();

		await expect(application().recoverByToken(unused.token, SOON_AFTER)).resolves.toBeNull();
	});
});
