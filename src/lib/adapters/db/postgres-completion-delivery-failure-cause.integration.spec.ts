import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUuidV7 } from '$lib/ids/uuid-v7';
import { PostgresCompletionDeliveryStore } from './postgres-completion-delivery-store';

const databaseUrl: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const liveDescribe = databaseUrl === undefined ? describe.skip : describe;
const at: string = '2026-09-12T00:00:00.000Z';

liveDescribe('PostgreSQL completion delivery terminal cleanup failure_cause_code', () => {
	const schema: string = `signkit_failure_cause_${newUuidV7().replaceAll('-', '')}`;
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

	async function seedCompletedEnvelope(): Promise<{ envelopeId: string; recipientId: string }> {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const envelopeId: string = newUuidV7();
		const recipientId: string = newUuidV7();
		const anchorId: string = newUuidV7();
		const ownerId: string = `failure-cause-owner-${newUuidV7()}`;
		await sql`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES (${ownerId}, 'owner', 'active', ${at}::timestamptz, ${at}::timestamptz)`;
		await sql`INSERT INTO envelope (id, created_by_user_id, title, status, repository_generation,
			repository_head, sent_commit_sha, created_at, updated_at)
			VALUES (${envelopeId}, ${ownerId}, 'Synthetic failure cause fixture', 'completed', 1,
				'commit-1', 'commit-1', ${at}::timestamptz, ${at}::timestamptz)`;
		await sql`INSERT INTO recipient (id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at)
			VALUES (${recipientId}, ${envelopeId}, 'recipient@example.com', 'Recipient', 'signer', 'en', 1, 'completed', ${at}::timestamptz, ${at}::timestamptz)`;
		await sql`INSERT INTO audit_event (id, envelope_id, sequence, event_type, actor_type,
			actor_id, payload_json, previous_hash, event_hash, occurred_at)
			VALUES (${anchorId}, ${envelopeId}, 1, 'envelope.completed', 'system', NULL, '{}', NULL, ${'e'.repeat(64)}, ${at}::timestamptz)`;
		await sql`INSERT INTO completion_artifact (envelope_id, schema_version, manifest_sha256,
			json_object_key, json_sha256, markdown_object_key, markdown_sha256, sent_commit_sha,
			field_generation, anchor_audit_event_id, audit_head_sequence, audit_head_event_hash, published_at, audit_event_id)
			VALUES (${envelopeId}, 1, ${'a'.repeat(64)}, 'completion/example.json.gz', ${'b'.repeat(64)},
				'completion/example.md.gz', ${'c'.repeat(64)}, 'commit-1', 0, ${anchorId}, 1, ${'e'.repeat(64)}, ${at}::timestamptz, ${newUuidV7()})`;
		return { envelopeId, recipientId };
	}

	it('records a known failure_cause_code for a delivery the sweep newly terminates, never a silent NULL', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const { envelopeId, recipientId } = await seedCompletedEnvelope();
		const store = new PostgresCompletionDeliveryStore(sql);
		await store.enrollDeliveries([
			{
				id: newUuidV7(),
				envelopeId,
				recipientId,
				tokenHash: 'd'.repeat(64),
				accessExpiresAt: '2026-10-12T00:00:00.000Z',
				sealedToken: 'synthetic-sealed-token',
				sealingKeyId: 'test-key',
				sealedTokenSha256: 'e'.repeat(64),
				availableAt: at,
				createdAt: at
			}
		]);
		// The recipient becoming `prefill` after enrollment is what the
		// terminal cleanup sweep inside the next claim call must newly
		// terminate -- the delivery was eligible when it was created.
		await sql`UPDATE recipient SET role = 'prefill' WHERE id = ${recipientId}`;

		const claimed = await store.claimPendingDeliveries({
			claimToken: 'claim-token-failure-cause',
			claimedAt: at,
			staleBefore: '2026-09-11T23:55:00.000Z',
			limit: 5
		});
		expect(claimed).toEqual([]);

		const rows = await sql<
			{
				status: string;
				retryable: boolean;
				sealedToken: string | null;
				lastError: string | null;
				failureCauseCode: string | null;
			}[]
		>`SELECT status, retryable, sealed_token AS "sealedToken", last_error AS "lastError",
			failure_cause_code AS "failureCauseCode"
			FROM completion_delivery_outbox WHERE envelope_id = ${envelopeId} AND recipient_id = ${recipientId}`;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe('failed');
		expect(rows[0]?.retryable).toBe(false);
		expect(rows[0]?.sealedToken).toBeNull();
		expect(rows[0]?.lastError).toBe('delivery_not_eligible');
		expect(rows[0]?.failureCauseCode).toBe('delivery_not_eligible');
	});

	it('bounds failure_cause_code to the sanitized shape at the database layer, mirroring sanitizeCompletionDeliveryErrorCode', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const { envelopeId, recipientId } = await seedCompletedEnvelope();

		const insert = (failureCauseCode: string | null): Promise<unknown> => {
			if (sql === null) throw new Error('PostgreSQL unavailable');
			return sql`INSERT INTO completion_delivery_outbox (
				id, envelope_id, recipient_id, status, token_hash, access_expires_at,
				access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
				available_at, attempts, locked_at, claim_token, delivered_at,
				provider_message_id, last_error, retryable, created_at, updated_at,
				generation, predecessor_delivery_id, failure_cause_code
			) VALUES (
				${newUuidV7()}, ${envelopeId}, ${recipientId}, 'failed', ${newUuidV7()}, ${at}::timestamptz,
				${at}::timestamptz, NULL, 'test-key', ${newUuidV7()},
				${at}::timestamptz, 10, NULL, NULL, NULL, NULL, 'delivery_attempts_exhausted',
				false, ${at}::timestamptz, ${at}::timestamptz, 0, NULL, ${failureCauseCode}
			)`;
		};

		await expect(insert(null)).resolves.toBeDefined();
		await sql`DELETE FROM completion_delivery_outbox WHERE envelope_id = ${envelopeId}`;
		await expect(insert('mail_delivery_failed')).resolves.toBeDefined();
		await sql`DELETE FROM completion_delivery_outbox WHERE envelope_id = ${envelopeId}`;
		await expect(insert('Not-Lowercase')).rejects.toThrow();
		await expect(insert(`skca1_${'x'.repeat(10)}`)).rejects.toThrow();
	});
});
