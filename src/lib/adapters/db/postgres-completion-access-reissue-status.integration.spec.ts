import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUuidV7 } from '$lib/ids/uuid-v7';
import { PostgresCompletionAccessReissueStore } from './postgres-completion-access-reissue';

const databaseUrl: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const liveDescribe = databaseUrl === undefined ? describe.skip : describe;
const AT: string = '2026-09-11T00:00:00.000Z';

liveDescribe('PostgresCompletionAccessReissueStore.listCurrentDeliveries integration', () => {
	const schema: string = `signkit_access_reissue_status_${newUuidV7().replaceAll('-', '')}`;
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

	async function seedEnvelope(): Promise<string> {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const envelopeId: string = newUuidV7();
		const ownerId: string = `status-owner-${newUuidV7()}`;
		await sql`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES (${ownerId}, 'owner', 'active', ${AT}::timestamptz, ${AT}::timestamptz)`;
		await sql`INSERT INTO envelope (id, created_by_user_id, title, status, repository_generation,
			repository_head, sent_commit_sha, created_at, updated_at)
			VALUES (${envelopeId}, ${ownerId}, 'Synthetic status fixture', 'completed', 1,
				'commit-1', 'commit-1', ${AT}::timestamptz, ${AT}::timestamptz)`;
		return envelopeId;
	}

	it('returns null for an envelope that does not exist, never conflating it with an empty listing', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const store = new PostgresCompletionAccessReissueStore(sql);
		expect(await store.listCurrentDeliveries(newUuidV7())).toBeNull();
	});

	it('returns an empty array for an existing envelope with no completion deliveries yet', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const envelopeId: string = await seedEnvelope();
		const store = new PostgresCompletionAccessReissueStore(sql);
		expect(await store.listCurrentDeliveries(envelopeId)).toEqual([]);
	});

	it('surfaces failureCauseCode on a current generation, and null on a historical one, without inferring either', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const envelopeId: string = await seedEnvelope();
		const signerId: string = newUuidV7();
		const approverId: string = newUuidV7();
		await sql`INSERT INTO recipient (id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at)
			VALUES
				(${signerId}, ${envelopeId}, 'signer@example.com', 'Signer', 'signer', 'en', 1, 'completed', ${AT}::timestamptz, ${AT}::timestamptz),
				(${approverId}, ${envelopeId}, 'approver@example.com', 'Approver', 'approver', 'en', 2, 'completed', ${AT}::timestamptz, ${AT}::timestamptz)`;
		const anchorId: string = newUuidV7();
		await sql`INSERT INTO audit_event (id, envelope_id, sequence, event_type, actor_type,
			actor_id, payload_json, previous_hash, event_hash, occurred_at)
			VALUES (${anchorId}, ${envelopeId}, 1, 'envelope.completed', 'system', NULL, '{}', NULL, ${'e'.repeat(64)}, ${AT}::timestamptz)`;
		await sql`INSERT INTO completion_artifact (envelope_id, schema_version, manifest_sha256,
			json_object_key, json_sha256, markdown_object_key, markdown_sha256, sent_commit_sha,
			field_generation, anchor_audit_event_id, audit_head_sequence, audit_head_event_hash, published_at, audit_event_id)
			VALUES (${envelopeId}, 1, ${'m'.repeat(64)}, 'completion/example.json.gz', ${'j'.repeat(64)},
				'completion/example.md.gz', ${'d'.repeat(64)}, 'commit-1', 0, ${anchorId}, 1, ${'e'.repeat(64)}, ${AT}::timestamptz, ${newUuidV7()})`;
		// `signerId`'s generation was terminated by a known cause after this
		// column existed; `approverId`'s predates the column entirely.
		await sql`INSERT INTO completion_delivery_outbox (
			id, envelope_id, recipient_id, status, token_hash, access_expires_at,
			access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
			available_at, attempts, locked_at, claim_token, delivered_at,
			provider_message_id, last_error, retryable, created_at, updated_at, failure_cause_code
		) VALUES (
			${newUuidV7()}, ${envelopeId}, ${signerId}, 'failed', ${newUuidV7()}, ${AT}::timestamptz,
			${AT}::timestamptz, NULL, 'key-1', ${newUuidV7()},
			${AT}::timestamptz, 10, NULL, NULL, NULL, NULL, 'delivery_attempts_exhausted',
			false, ${AT}::timestamptz, ${AT}::timestamptz, 'mail_delivery_failed'
		)`;
		await sql`INSERT INTO completion_delivery_outbox (
			id, envelope_id, recipient_id, status, token_hash, access_expires_at,
			access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
			available_at, attempts, locked_at, claim_token, delivered_at,
			provider_message_id, last_error, retryable, created_at, updated_at, failure_cause_code
		) VALUES (
			${newUuidV7()}, ${envelopeId}, ${approverId}, 'failed', ${newUuidV7()}, ${AT}::timestamptz,
			${AT}::timestamptz, NULL, 'key-1', ${newUuidV7()},
			${AT}::timestamptz, 10, NULL, NULL, NULL, NULL, 'delivery_attempts_exhausted',
			false, ${AT}::timestamptz, ${AT}::timestamptz, NULL
		)`;

		const store = new PostgresCompletionAccessReissueStore(sql);
		const rows = await store.listCurrentDeliveries(envelopeId);
		expect(rows).not.toBeNull();
		const byRecipient = new Map((rows ?? []).map((row) => [row.recipientId, row]));
		expect(byRecipient.get(signerId)?.failureCauseCode).toBe('mail_delivery_failed');
		expect(byRecipient.get(approverId)?.failureCauseCode).toBeNull();
	});
});
