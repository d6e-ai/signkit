import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashAuditEventV3 } from '$lib/domain/audit';
import { PostgresOrphanReferenceStore } from '$lib/application/maintenance/orphan-collector';
import { RecipientSignedApplication } from '$lib/application/signing/recipient-signed';
import {
	AgedObjectStore,
	defineSignatureRetentionScenarios,
	retentionAsset,
	RETENTION_AGED_AT,
	RETENTION_CAPABILITY_EXPIRES_AT,
	RETENTION_ENVELOPE_ID,
	RETENTION_FIELD_GENERATION,
	RETENTION_FIELD_ID,
	RETENTION_NOW,
	RETENTION_OTHER_ENVELOPE_ID,
	RETENTION_OTHER_RECIPIENT_ID,
	RETENTION_SENT_AT,
	RETENTION_SIGNER_ID,
	RETENTION_VIEWED_AT,
	type RetentionAsset,
	type RetentionFieldType,
	type RetentionHarness
} from '$lib/application/maintenance/signature-asset-retention-test-support';
import type { SignatureAssetScope } from '$lib/ports/signature-asset-ledger';
import { issueRecipientCapability } from '$lib/security/recipient-capability';
import { PostgresRecipientSignStore } from './postgres-recipient-sign-store';
import { PostgresSignatureAssetLedger } from './postgres-signature-asset-ledger';

const DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const postgresDescribe = DATABASE_URL === undefined ? describe.skip : describe;

const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';

type Sql = ReturnType<typeof postgres>;

postgresDescribe('PostgreSQL signature asset retention', () => {
	const schema: string = `signkit_sig_retention_${randomUUID().replaceAll('-', '')}`;
	let admin: Sql | null = null;
	let sql: Sql | null = null;

	beforeAll(async () => {
		admin = postgres(DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		await admin.unsafe(`CREATE SCHEMA "${schema}"`);
		// A small multi-connection pool, so lock-level barriers can hold one
		// transaction open while real adapter code runs on another connection.
		sql = postgres(DATABASE_URL as string, {
			max: 4,
			onnotice: (): void => undefined,
			connection: { search_path: schema, application_name: schema }
		});
		const paths: string[] = readdirSync('migrations/postgres')
			.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
			.sort();
		await sql.begin(async (transaction) => {
			for (const path of paths) {
				await transaction.unsafe(readFileSync(`migrations/postgres/${path}`, 'utf8'));
			}
		});
	});

	beforeEach(async () => {
		if (sql === null) return;
		await sql`TRUNCATE signature_asset, recipient_signed_command, field_value, envelope_field,
			delivery_outbox, audit_event, recipient, envelope, instance_member CASCADE`;
	});

	afterAll(async () => {
		if (sql !== null) await sql.end({ timeout: 5 });
		if (admin === null) return;
		await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
		await admin.end({ timeout: 5 });
	});

	function db(): Sql {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		return sql;
	}

	async function seed(fieldType: RetentionFieldType): Promise<string> {
		const client: Sql = db();
		const capability = await issueRecipientCapability();
		const sentAuditHash: string = await hashAuditEventV3(
			{
				sequence: 1,
				eventType: 'envelope.sent',
				actorType: 'user',
				actorId: 'user-1',
				occurredAt: RETENTION_SENT_AT,
				payload: { sentCommitSha: COMMIT_SHA },
				previousHash: null
			},
			{ envelopeId: RETENTION_ENVELOPE_ID }
		);
		const viewedPayload = {
			recipientId: RETENTION_SIGNER_ID,
			role: 'signer',
			routingOrder: 1,
			sentCommitSha: COMMIT_SHA,
			viewedAt: RETENTION_VIEWED_AT
		};
		const viewedAuditHash: string = await hashAuditEventV3(
			{
				sequence: 2,
				eventType: 'recipient.viewed',
				actorType: 'recipient',
				actorId: RETENTION_SIGNER_ID,
				occurredAt: RETENTION_VIEWED_AT,
				payload: viewedPayload,
				previousHash: sentAuditHash
			},
			{ envelopeId: RETENTION_ENVELOPE_ID }
		);

		await client`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES ('user-1', 'owner', 'active', ${RETENTION_SENT_AT}, ${RETENTION_SENT_AT})`;
		for (const envelopeId of [RETENTION_ENVELOPE_ID, RETENTION_OTHER_ENVELOPE_ID]) {
			await client`INSERT INTO envelope (
					id, created_by_user_id, title, status, repository_generation, repository_head,
					repository_archive_key, repository_archive_sha256, sent_commit_sha,
					field_generation, created_at, updated_at
				) VALUES (${envelopeId}, 'user-1', 'Agreement', 'in_progress', 1, ${COMMIT_SHA},
					'archives/retention.git.gz', ${'a'.repeat(64)}, ${COMMIT_SHA},
					${RETENTION_FIELD_GENERATION}, ${RETENTION_SENT_AT}, ${RETENTION_VIEWED_AT})`;
		}
		await client`INSERT INTO recipient (
				id, envelope_id, email, name, role, locale, routing_order, status,
				capability_hash, capability_expires_at, created_at, updated_at
			) VALUES (${RETENTION_SIGNER_ID}, ${RETENTION_ENVELOPE_ID}, 'alice@example.test', 'Alice',
				'signer', 'en', 1, 'viewed', ${capability.tokenHash}, ${RETENTION_CAPABILITY_EXPIRES_AT},
				${RETENTION_SENT_AT}, ${RETENTION_VIEWED_AT})`;
		await client`INSERT INTO recipient (
				id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at
			) VALUES (${RETENTION_OTHER_RECIPIENT_ID}, ${RETENTION_OTHER_ENVELOPE_ID}, 'bob@example.test',
				'Bob', 'signer', 'en', 1, 'pending', ${RETENTION_SENT_AT}, ${RETENTION_SENT_AT})`;
		await client`INSERT INTO envelope_field (
				id, envelope_id, recipient_id, document_path, field_type, label,
				required, position, created_at, updated_at
			) VALUES (${RETENTION_FIELD_ID}, ${RETENTION_ENVELOPE_ID}, ${RETENTION_SIGNER_ID},
				'documents/agreement.md', ${fieldType}, ${fieldType === 'initials' ? 'Initials' : 'Signature'},
				true, 0, ${RETENTION_SENT_AT}, ${RETENTION_SENT_AT})`;
		await client`INSERT INTO delivery_outbox (
				id, envelope_id, recipient_id, kind, status, capability_hash,
				reserved_capability_expires_at, sealed_capability, sealing_key_id,
				sealed_capability_sha256, available_at, attempts, delivered_at,
				created_at, updated_at, retryable
			) VALUES ('01920019-0000-7000-8000-000000000020', ${RETENTION_ENVELOPE_ID},
				${RETENTION_SIGNER_ID}, 'recipient_invitation', 'delivered', ${capability.tokenHash},
				NULL, NULL, 'key-1', ${'c'.repeat(64)}, ${RETENTION_SENT_AT}, 1, ${RETENTION_SENT_AT},
				${RETENTION_SENT_AT}, ${RETENTION_SENT_AT}, false)`;
		await client`INSERT INTO audit_event (
				id, envelope_id, sequence, event_type, actor_type,
				actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
			) VALUES ('01920019-0000-7000-8000-000000000010', ${RETENTION_ENVELOPE_ID}, 1,
				'envelope.sent', 'user', 'user-1', ${JSON.stringify({ sentCommitSha: COMMIT_SHA })},
				NULL, ${sentAuditHash}, ${RETENTION_SENT_AT}, 3)`;
		await client`INSERT INTO audit_event (
				id, envelope_id, sequence, event_type, actor_type,
				actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
			) VALUES ('01920019-0000-7000-8000-000000000011', ${RETENTION_ENVELOPE_ID}, 2,
				'recipient.viewed', 'recipient', ${RETENTION_SIGNER_ID}, ${JSON.stringify(viewedPayload)},
				${sentAuditHash}, ${viewedAuditHash}, ${RETENTION_VIEWED_AT}, 3)`;
		return capability.token;
	}

	function harness(): RetentionHarness {
		const client: Sql = db();
		return {
			ledger: new PostgresSignatureAssetLedger(client),
			references: new PostgresOrphanReferenceStore(client),
			signStore: new PostgresRecipientSignStore(client),
			seed,
			publishedRows: async () => {
				const rows = await client<{ fieldValues: number; receipts: number }[]>`
					SELECT (SELECT count(*)::int FROM field_value) AS "fieldValues",
						(SELECT count(*)::int FROM recipient_signed_command) AS receipts`;
				return { fieldValues: rows[0].fieldValues, receipts: rows[0].receipts };
			},
			ledgerSnapshot: async (): Promise<string> =>
				JSON.stringify(
					await client`SELECT envelope_id, recipient_id, sha256, state, created_at::text,
						pending_touched_at::text, bound_at::text, retired_at::text
						FROM signature_asset ORDER BY envelope_id, recipient_id, sha256`
				),
			forceState: async (scope: SignatureAssetScope, state): Promise<void> => {
				const at: string = '2026-09-24T03:00:00.000Z';
				await client`
					UPDATE signature_asset
					SET state = ${state},
						pending_touched_at = ${state === 'pending' ? at : null},
						bound_at = ${state === 'bound' ? at : null},
						retired_at = ${state === 'retired' ? at : null}
					WHERE envelope_id = ${scope.envelopeId} AND recipient_id = ${scope.recipientId}
						AND sha256 = ${scope.sha256}`;
			}
		};
	}

	defineSignatureRetentionScenarios(harness);

	/** Resolves once some connection of this suite's pool is blocked on a row/index lock. */
	async function untilLockWait(): Promise<void> {
		if (admin === null) throw new Error('PostgreSQL unavailable');
		for (;;) {
			const waiting = await admin`
				SELECT 1 FROM pg_stat_activity
				WHERE application_name = ${schema} AND wait_event_type = 'Lock'`;
			if (waiting.length > 0) return;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}

	it('blocks publish on an in-flight legacy retirement and then fails closed without writes', async () => {
		const token: string = await seed('initials');
		const asset: RetentionAsset = retentionAsset();
		const objects = new AgedObjectStore();
		objects.seed(asset.key, asset.png, asset.scope.sha256);
		const retirer = await db().reserve();
		let committed: Promise<void> = Promise.resolve();

		try {
			const result = await new RecipientSignedApplication(
				{
					prepareSign: (key, at) => harness().signStore.prepareSign(key, at),
					publishSign: async (command) => {
						// The sweep's legacy tombstone insert holds the unique index
						// entry, uncommitted, while the real publish transaction runs.
						await retirer`BEGIN`;
						await retirer`
							INSERT INTO signature_asset (envelope_id, recipient_id, sha256, state, created_at, retired_at)
							VALUES (${asset.scope.envelopeId}, ${asset.scope.recipientId}, ${asset.scope.sha256},
								'retired', ${RETENTION_NOW.toISOString()}, ${RETENTION_NOW.toISOString()})`;
						committed = untilLockWait().then(async (): Promise<void> => {
							await retirer`COMMIT`;
						});
						return await harness().signStore.publishSign(command);
					}
				},
				(): Date => RETENTION_NOW,
				undefined,
				objects,
				harness().ledger
			).sign({
				token,
				expectedEnvelopeId: RETENTION_ENVELOPE_ID,
				expectedRecipientId: RETENTION_SIGNER_ID,
				expectedFieldGeneration: RETENTION_FIELD_GENERATION,
				idempotencyKey: 'sign-barrier',
				values: [{ fieldId: RETENTION_FIELD_ID, value: asset.ref }]
			});
			await committed;

			expect(result).toEqual({ outcome: 'signature_asset_expired' });
			expect(await harness().publishedRows()).toEqual({ fieldValues: 0, receipts: 0 });
		} finally {
			retirer.release();
		}
	});

	it.each(['pending', 'legacy'] as const)(
		'blocks retirement on an in-flight %s sign bind and then reports it bound',
		async (initial: 'pending' | 'legacy') => {
			await seed('signature');
			const asset: RetentionAsset = retentionAsset();
			const ledger = new PostgresSignatureAssetLedger(db());
			if (initial === 'pending') await ledger.registerPending(asset.scope, RETENTION_AGED_AT);
			const binder = await db().reserve();

			try {
				// The exact bind statement the recipient-signed transaction runs.
				await binder`BEGIN`;
				await binder`
					INSERT INTO signature_asset (envelope_id, recipient_id, sha256, state, created_at, bound_at)
					VALUES (${asset.scope.envelopeId}, ${asset.scope.recipientId}, ${asset.scope.sha256},
						'bound', ${RETENTION_NOW.toISOString()}, ${RETENTION_NOW.toISOString()})
					ON CONFLICT (envelope_id, recipient_id, sha256) DO UPDATE SET
						state = 'bound', bound_at = EXCLUDED.bound_at, pending_touched_at = NULL
					WHERE signature_asset.state = 'pending'`;
				const retirement = ledger.retireOrphan(
					asset.scope,
					RETENTION_NOW.toISOString(),
					'2026-09-23T02:00:00.000Z'
				);
				await untilLockWait();
				await binder`COMMIT`;

				expect(await retirement).toBe('bound');
			} finally {
				binder.release();
			}
		}
	);

	it('backfills legacy signature and initials references as bound during migration', async () => {
		if (admin === null) throw new Error('PostgreSQL unavailable');
		const legacySchema: string = `${schema}_legacy`;
		await admin.unsafe(`CREATE SCHEMA "${legacySchema}"`);
		const legacy: Sql = postgres(DATABASE_URL as string, {
			max: 1,
			onnotice: (): void => undefined,
			connection: { search_path: legacySchema }
		});
		try {
			const paths: string[] = readdirSync('migrations/postgres')
				.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
				.sort();
			const ledgerPath: string = '0050_signature_asset_ledger.sql';
			for (const path of paths) {
				if (path === ledgerPath) break;
				await legacy.unsafe(readFileSync(`migrations/postgres/${path}`, 'utf8'));
			}
			const previous: Sql | null = sql;
			sql = legacy;
			try {
				await seed('signature');
			} finally {
				sql = previous;
			}
			const initialsFieldId: string = '01920019-0000-7000-8000-00000000000b';
			await legacy`INSERT INTO envelope_field (
					id, envelope_id, recipient_id, document_path, field_type, label,
					required, position, created_at, updated_at
				) VALUES (${initialsFieldId}, ${RETENTION_ENVELOPE_ID}, ${RETENTION_SIGNER_ID},
					'documents/agreement.md', 'initials', 'Initials', true, 1,
					${RETENTION_SENT_AT}, ${RETENTION_SENT_AT})`;
			for (const [fieldId, fieldType, sha256] of [
				[RETENTION_FIELD_ID, 'signature', 'a'.repeat(64)],
				[initialsFieldId, 'initials', 'b'.repeat(64)]
			] as const) {
				await legacy`INSERT INTO field_value (
						field_id, envelope_id, recipient_id, field_type, value_json, value_sha256, created_at
					) VALUES (${fieldId}, ${RETENTION_ENVELOPE_ID}, ${RETENTION_SIGNER_ID}, ${fieldType},
						${JSON.stringify(`sig:sha256:${sha256}`)}, ${'c'.repeat(64)}, ${RETENTION_VIEWED_AT})`;
			}

			await legacy.unsafe(readFileSync(`migrations/postgres/${ledgerPath}`, 'utf8'));

			const rows = await legacy<{ sha256: string; state: string }[]>`
				SELECT sha256, state FROM signature_asset ORDER BY sha256`;
			expect(rows.map((row) => ({ ...row }))).toEqual([
				{ sha256: 'a'.repeat(64), state: 'bound' },
				{ sha256: 'b'.repeat(64), state: 'bound' }
			]);
		} finally {
			await legacy.end({ timeout: 5 });
			await admin.unsafe(`DROP SCHEMA "${legacySchema}" CASCADE`);
		}
	});
});
