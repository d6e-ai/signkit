import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUuidV7 } from '$lib/ids/uuid-v7';
import { PostgresCompletionDeliveryStore } from './postgres-completion-delivery-store';

const databaseUrl: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const liveDescribe = databaseUrl === undefined ? describe.skip : describe;
const at: string = '2026-09-12T00:00:00.000Z';

liveDescribe('PostgreSQL completion delivery waits for its PDF', () => {
	const schema: string = `signkit_pdf_wait_${newUuidV7().replaceAll('-', '')}`;
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

	it('keeps the grant and attempts unchanged while waiting, then claims after publication', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const envelopeId: string = newUuidV7();
		const recipientId: string = newUuidV7();
		const anchorId: string = newUuidV7();
		const publicationId: string = newUuidV7();
		await sql`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES ('pdf-wait-owner', 'owner', 'active', ${at}::timestamptz, ${at}::timestamptz)`;
		await sql`INSERT INTO envelope (id, created_by_user_id, title, status, repository_generation,
			repository_head, sent_commit_sha, created_at, updated_at)
			VALUES (${envelopeId}, 'pdf-wait-owner', 'Synthetic PDF wait fixture', 'completed', 1,
				'commit-1', 'commit-1', ${at}::timestamptz, ${at}::timestamptz)`;
		await sql`INSERT INTO recipient (id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at)
			VALUES (${recipientId}, ${envelopeId}, 'recipient@example.com', 'Recipient', 'signer', 'en', 1, 'completed', ${at}::timestamptz, ${at}::timestamptz)`;
		await sql`INSERT INTO audit_event (id, envelope_id, sequence, event_type, actor_type,
			actor_id, payload_json, previous_hash, event_hash, occurred_at)
			VALUES (${anchorId}, ${envelopeId}, 1, 'envelope.completed', 'system', NULL, '{}', NULL, ${'e'.repeat(64)}, ${at}::timestamptz)`;
		await sql`INSERT INTO audit_event (id, envelope_id, sequence, event_type, actor_type,
			actor_id, payload_json, previous_hash, event_hash, occurred_at)
			VALUES (${publicationId}, ${envelopeId}, 2, 'envelope.completion_artifact_published', 'system', NULL,
				'{}', ${'e'.repeat(64)}, ${'f'.repeat(64)}, ${at}::timestamptz)`;
		await sql`INSERT INTO completion_artifact (envelope_id, schema_version, manifest_sha256,
			json_object_key, json_sha256, markdown_object_key, markdown_sha256, sent_commit_sha,
			field_generation, anchor_audit_event_id, audit_head_sequence, audit_head_event_hash, published_at, audit_event_id)
			VALUES (${envelopeId}, 1, ${'a'.repeat(64)}, 'completion/example.json.gz', ${'b'.repeat(64)},
				'completion/example.md.gz', ${'c'.repeat(64)}, 'commit-1', 0, ${anchorId}, 2, ${'f'.repeat(64)}, ${at}::timestamptz, ${publicationId})`;
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
		for (let attempt: number = 0; attempt < 12; attempt += 1) {
			const claimedAt: string = new Date(
				new Date(at).valueOf() + attempt * 30 * 60 * 1000
			).toISOString();
			expect(
				await store.claimPendingDeliveries({
					claimToken: `waiting-claim-token-${attempt}`,
					claimedAt,
					staleBefore: new Date(new Date(claimedAt).valueOf() - 5 * 60 * 1000).toISOString(),
					limit: 5
				})
			).toEqual([]);
		}
		const rows = await sql<
			{
				status: string;
				attempts: number;
				access_revoked_at: Date | null;
				sealed_token: string | null;
			}[]
		>`
			SELECT status, attempts, access_revoked_at, sealed_token FROM completion_delivery_outbox WHERE envelope_id = ${envelopeId}`;
		expect(rows).toEqual([
			{
				status: 'pending',
				attempts: 0,
				access_revoked_at: null,
				sealed_token: 'synthetic-sealed-token'
			}
		]);
		await sql`INSERT INTO completion_artifact_pdf (envelope_id, pdf_object_key, pdf_sha256,
			pdf_byte_size, pdf_manifest_object_key, pdf_manifest_sha256, published_at)
			VALUES (${envelopeId}, 'completion/example.pdf', ${'a'.repeat(64)}, 128,
				'completion/pdf-manifest.json.gz', ${'b'.repeat(64)}, ${at}::timestamptz)`;
		const claimed = await store.claimPendingDeliveries({
			claimToken: 'opsfix-pdf-ready-claim',
			claimedAt: at,
			staleBefore: new Date(new Date(at).valueOf() - 5 * 60 * 1000).toISOString(),
			limit: 5
		});
		expect(claimed).toHaveLength(1);
		expect(claimed[0].attempts).toBe(1);
	});
});
