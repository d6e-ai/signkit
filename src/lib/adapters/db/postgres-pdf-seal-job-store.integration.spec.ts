import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresPdfSealJobStore } from './postgres-pdf-seal-job-store';
import type { ClaimedPdfSealJob, EnqueuePdfSealJobCommand } from '$lib/ports/pdf-seal-job-store';

const DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const postgresDescribe = DATABASE_URL === undefined ? describe.skip : describe;
const SCHEMA: string = `signkit_pdf_seal_${randomUUID().replaceAll('-', '')}`;
const ENVELOPE_ID: string = '019a0000-0000-7000-8000-000000000101';
const SOURCE_KEY: string = 'completion-artifacts/postgres-source.pdf';
const SOURCE_SHA: string = 'a'.repeat(64);
let sql: ReturnType<typeof postgres> | null = null;

const command: EnqueuePdfSealJobCommand = {
	jobId: '019a0000-0000-7000-8000-000000000102',
	envelopeId: ENVELOPE_ID,
	operationId: '019a0000-0000-7000-8000-000000000103',
	validationId: '019a0000-0000-7000-8000-000000000104',
	sourceObjectKey: SOURCE_KEY,
	sourceSha256: SOURCE_SHA,
	sourceByteSize: 1024,
	requestedProfile: 'pades-b-b',
	signerCertificateSha256: 'b'.repeat(64),
	sealPolicyId: 'seal-policy-v1',
	validationPolicyId: 'validation-policy-v1',
	tsaPolicyId: null,
	tsaTrustBundleSha256: null,
	createdAt: '2026-09-23T00:04:00.000Z'
};

postgresDescribe('PostgresPdfSealJobStore integration', () => {
	beforeAll(async () => {
		sql = postgres(DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
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
				'019a0000-0000-7000-8000-000000000111', '${ENVELOPE_ID}', 1,
				'envelope.completed', 'system', 'system', '{}', '${'0'.repeat(64)}', '${'e'.repeat(64)}',
				'2026-09-23T00:01:00.000Z'
			);
			INSERT INTO completion_artifact (
				envelope_id, schema_version, manifest_sha256, json_object_key, json_sha256,
				markdown_object_key, markdown_sha256, sent_commit_sha, field_generation,
				anchor_audit_event_id, audit_head_sequence, audit_head_event_hash,
				published_at, audit_event_id
			) VALUES (
				'${ENVELOPE_ID}', 1, '${'c'.repeat(64)}', 'artifact.json.gz', '${'d'.repeat(64)}',
				'artifact.md.gz', '${'f'.repeat(64)}', 'commit-1', 0,
				'019a0000-0000-7000-8000-000000000111', 1, '${'e'.repeat(64)}',
				'2026-09-23T00:02:00.000Z', '019a0000-0000-7000-8000-000000000112'
			);
			INSERT INTO completion_artifact_pdf (
				envelope_id, pdf_object_key, pdf_sha256, pdf_manifest_object_key,
				pdf_manifest_sha256, published_at
			) VALUES (
				'${ENVELOPE_ID}', '${SOURCE_KEY}', '${SOURCE_SHA}', 'manifest.json.gz',
				'${'9'.repeat(64)}', '2026-09-23T00:03:00.000Z'
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

	it('persists CAS checkpoints and immutable attempts transactionally', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const store = new PostgresPdfSealJobStore(sql);
		await expect(store.enqueue(command)).resolves.toMatchObject({ outcome: 'enqueued' });
		const claimed: readonly ClaimedPdfSealJob[] = await store.claim({
			claimToken: 'lease-1',
			claimedAt: '2026-09-23T00:04:01.000Z',
			staleBefore: '2026-09-22T23:00:00.000Z',
			limit: 1
		});
		expect(claimed).toHaveLength(1);
		await expect(
			store.checkpoint({
				kind: 'ambiguous_submit',
				jobId: command.jobId,
				claimToken: 'lease-1',
				attemptId: '019a0000-0000-7000-8000-000000000105',
				attemptNumber: 1,
				startedAt: '2026-09-23T00:04:01.000Z',
				finishedAt: '2026-09-23T00:04:02.000Z'
			})
		).resolves.toBe(true);
		await expect(store.find(command.jobId)).resolves.toMatchObject({
			status: 'pending',
			nextAction: 'recover_submit',
			attempts: 1
		});
		expect(
			await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM pdf_seal_attempt`
		).toEqual([{ count: 1 }]);
	});
});
