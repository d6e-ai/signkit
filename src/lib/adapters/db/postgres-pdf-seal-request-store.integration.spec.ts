import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresPdfSealRequestStore } from './postgres-pdf-seal-request-store';
import type { RequestPdfSealCommand } from '$lib/ports/pdf-seal-request-store';

const DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const postgresDescribe = DATABASE_URL === undefined ? describe.skip : describe;
const SCHEMA: string = `signkit_pdf_seal_request_${randomUUID().replaceAll('-', '')}`;
const ENVELOPE_ID: string = '019a0000-0000-7000-8000-000000000301';
let sql: ReturnType<typeof postgres> | null = null;

const command: RequestPdfSealCommand = {
	actor: { type: 'agent', id: 'api-key-1' },
	idempotencyKey: 'request-1',
	requestHash: 'a'.repeat(64),
	envelopeId: ENVELOPE_ID,
	jobId: '019a0000-0000-7000-8000-000000000302',
	operationId: '019a0000-0000-7000-8000-000000000303',
	validationId: '019a0000-0000-7000-8000-000000000304',
	requestedProfile: 'pades-b-t',
	signerCertificateSha256: 'b'.repeat(64),
	sealPolicyId: 'seal-policy-v1',
	validationPolicyId: 'validation-policy-v1',
	tsaPolicyId: 'tsa-policy-v1',
	tsaTrustBundleSha256: 'c'.repeat(64),
	requestedAt: '2026-09-23T00:04:00.000Z'
};

postgresDescribe('PostgresPdfSealRequestStore integration', () => {
	beforeAll(async () => {
		sql = postgres(DATABASE_URL as string, { max: 2, onnotice: (): void => undefined });
		await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
		await sql.unsafe(`SET search_path TO "${SCHEMA}"`);
		await sql.unsafe(`SET TIME ZONE 'UTC'`);
		const migrations: readonly string[] = readdirSync('migrations/postgres')
			.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
			.sort();
		for (const migration of migrations) {
			await sql.unsafe(readFileSync(`migrations/postgres/${migration}`, 'utf8'));
		}
		await sql.unsafe(`
			INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES ('user-1', 'owner', 'active', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
			INSERT INTO envelope (
				id, created_by_user_id, title, status, repository_generation, repository_head,
				sent_commit_sha, created_at, updated_at
			) VALUES (
				'${ENVELOPE_ID}', 'user-1', 'Agreement', 'completed', 1, 'commit-1',
				'commit-1', '2026-09-23T00:00:00.000Z', '2026-09-23T00:01:00.000Z'
			);
			INSERT INTO audit_event (
				id, envelope_id, sequence, event_type, actor_type, actor_id, payload_json,
				previous_hash, event_hash, occurred_at
			) VALUES (
				'019a0000-0000-7000-8000-000000000311', '${ENVELOPE_ID}', 1,
				'envelope.completed', 'system', 'system', '{}', '${'0'.repeat(64)}', '${'d'.repeat(64)}',
				'2026-09-23T00:01:00.000Z'
			);
			INSERT INTO completion_artifact (
				envelope_id, schema_version, manifest_sha256, json_object_key, json_sha256,
				markdown_object_key, markdown_sha256, sent_commit_sha, field_generation,
				anchor_audit_event_id, audit_head_sequence, audit_head_event_hash,
				published_at, audit_event_id
			) VALUES (
				'${ENVELOPE_ID}', 1, '${'e'.repeat(64)}', 'artifact.json.gz', '${'f'.repeat(64)}',
				'artifact.md.gz', '${'1'.repeat(64)}', 'commit-1', 0,
				'019a0000-0000-7000-8000-000000000311', 1, '${'d'.repeat(64)}',
				'2026-09-23T00:02:00.000Z', '019a0000-0000-7000-8000-000000000312'
			);
			INSERT INTO completion_artifact_pdf (
				envelope_id, pdf_object_key, pdf_sha256, pdf_manifest_object_key,
				pdf_manifest_sha256, pdf_byte_size, published_at
			) VALUES (
				'${ENVELOPE_ID}', 'completion-artifacts/source.pdf', '${'2'.repeat(64)}',
				'manifest.json.gz', '${'3'.repeat(64)}', 1024, '2026-09-23T00:03:00.000Z'
			);
		`);
	});

	afterAll(async () => {
		if (sql === null) return;
		await sql.unsafe('SET search_path TO public');
		await sql.unsafe(`DROP SCHEMA "${SCHEMA}" CASCADE`);
		await sql.end({ timeout: 5 });
		sql = null;
	});

	it('creates one atomic request/job, replays its receipt, and exposes safe status', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const store = new PostgresPdfSealRequestStore(sql);
		await expect(store.request(command)).resolves.toMatchObject({
			outcome: 'requested',
			job: { jobId: command.jobId }
		});
		await expect(
			store.request({
				...command,
				jobId: '019a0000-0000-7000-8000-000000000392',
				operationId: '019a0000-0000-7000-8000-000000000393',
				validationId: '019a0000-0000-7000-8000-000000000394'
			})
		).resolves.toMatchObject({ outcome: 'replayed', job: { jobId: command.jobId } });
		await expect(store.request({ ...command, requestHash: '4'.repeat(64) })).resolves.toEqual({
			outcome: 'idempotency_conflict'
		});
		await expect(store.findStatus(ENVELOPE_ID)).resolves.toMatchObject({
			status: 'pending',
			attempts: 0,
			job: { jobId: command.jobId, requestedProfile: 'pades-b-t' }
		});
		const counts = await sql<{ commands: number; jobs: number }[]>`
			SELECT
				(SELECT count(*)::int FROM pdf_seal_request_command) AS commands,
				(SELECT count(*)::int FROM pdf_seal_job) AS jobs`;
		expect(counts).toEqual([{ commands: 1, jobs: 1 }]);
	});

	it('rejects update/delete of request receipts', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		await expect(
			sql`UPDATE pdf_seal_request_command SET request_hash = ${'5'.repeat(64)}`
		).rejects.toThrow(/immutable/);
		await expect(sql`DELETE FROM pdf_seal_request_command`).rejects.toThrow(/immutable/);
	});
});
