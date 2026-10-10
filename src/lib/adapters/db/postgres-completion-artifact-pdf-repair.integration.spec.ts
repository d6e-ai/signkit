import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresCompletionArtifactPdfRepairStore } from './postgres-completion-artifact-pdf-repair-store';
import { PostgresCompletionArtifactStore } from './postgres-completion-artifact-store';
import { PostgresOrphanReferenceStore } from '$lib/application/maintenance/orphan-collector';
import { EXHAUSTED_TRANSIENT_COMPLETION_ARTIFACT_ERROR } from '$lib/ports/completion-artifact-store';
import { EXHAUSTED_TRANSIENT_COMPLETION_PDF_REPAIR_ERROR } from '$lib/ports/completion-artifact-pdf-repair-store';

const DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const postgresDescribe = DATABASE_URL === undefined ? describe.skip : describe;
const SCHEMA: string = `signkit_completion_repair_${randomUUID().replaceAll('-', '')}`;
const ENVELOPE_ID: string = '019a0000-0000-7000-8000-000000000201';
const ANCHOR_ID: string = '019a0000-0000-7000-8000-000000000211';
const PUBLISHED_ID: string = '019a0000-0000-7000-8000-000000000212';
const CLAIMED_AT: string = '2026-09-12T00:00:00.000Z';
const STALE_BEFORE: string = '2026-09-11T23:55:00.000Z';
const PDF = {
	pdfObjectKey: 'completion-artifacts/v1/envelopes/e/sha256/p.pdf',
	pdfSha256: 'f'.repeat(64),
	pdfByteSize: 128,
	pdfManifestObjectKey: 'completion-artifacts/v1/envelopes/e/sha256/p.json.gz',
	pdfManifestSha256: 'g'.repeat(64)
};

let sql: ReturnType<typeof postgres> | null = null;

async function seed(withArtifact: boolean): Promise<void> {
	if (sql === null) throw new Error('PostgreSQL fixture is not connected');
	await sql`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('user-1', 'owner', 'active', ${CLAIMED_AT}::timestamptz, ${CLAIMED_AT}::timestamptz)`;
	await sql`
		INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, repository_head,
			sent_commit_sha, created_at, updated_at
		) VALUES (
			${ENVELOPE_ID}, 'user-1', 'Agreement', 'completed', 1, 'commit-1',
			'commit-1', ${CLAIMED_AT}::timestamptz, ${CLAIMED_AT}::timestamptz
		)`;
	await sql`
		INSERT INTO audit_event (
			id, envelope_id, sequence, event_type, actor_type, actor_id, payload_json,
			previous_hash, event_hash, occurred_at
		) VALUES (
			${ANCHOR_ID}, ${ENVELOPE_ID}, 1, 'envelope.completed', 'system', 'system', '{}',
			${'0'.repeat(64)}, ${'e'.repeat(64)}, ${CLAIMED_AT}::timestamptz
		)`;
	await sql`
		INSERT INTO completion_artifact_job (
			envelope_id, status, attempts, available_at, retryable, created_at, updated_at
		) VALUES (
			${ENVELOPE_ID}, 'pending', 1, ${CLAIMED_AT}::timestamptz, true,
			${CLAIMED_AT}::timestamptz, ${CLAIMED_AT}::timestamptz
		)`;
	await sql`
		UPDATE completion_artifact_job
		SET status = 'processing', claim_token = 'claim-token-1', locked_at = ${CLAIMED_AT}::timestamptz
		WHERE envelope_id = ${ENVELOPE_ID}`;
	if (!withArtifact) return;
	await sql`
		INSERT INTO completion_artifact (
			envelope_id, schema_version, manifest_sha256, json_object_key, json_sha256,
			markdown_object_key, markdown_sha256, sent_commit_sha, field_generation,
			anchor_audit_event_id, audit_head_sequence, audit_head_event_hash,
			published_at, audit_event_id
		) VALUES (
			${ENVELOPE_ID}, 1, ${'m'.repeat(64)}, 'artifact.json.gz', ${'j'.repeat(64)},
			'artifact.md.gz', ${'d'.repeat(64)}, 'commit-1', 0,
			${ANCHOR_ID}, 2, ${'p'.repeat(64)}, ${CLAIMED_AT}::timestamptz, ${PUBLISHED_ID}
		)`;
	await sql`
		INSERT INTO audit_event (
			id, envelope_id, sequence, event_type, actor_type, actor_id, payload_json,
			previous_hash, event_hash, occurred_at
		) VALUES (
			${PUBLISHED_ID}, ${ENVELOPE_ID}, 2, 'envelope.completion_artifact_published',
			'system', 'completion-artifact-worker', ${'{"manifestSha256":"' + 'm'.repeat(64) + '"}'},
			${'e'.repeat(64)}, ${'p'.repeat(64)}, ${CLAIMED_AT}::timestamptz
		)`;
	await sql`
		UPDATE completion_artifact_job
		SET status = 'published', claim_token = NULL, locked_at = NULL, retryable = false
		WHERE envelope_id = ${ENVELOPE_ID}`;
}

postgresDescribe('Postgres completion artifact PDF repair and atomic publish', () => {
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
	});

	afterAll(async () => {
		if (sql === null) return;
		await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
		await sql.end();
	});

	it('rolls back the publish transaction when PDF insert fails', async () => {
		if (sql === null) throw new Error('PostgreSQL fixture is not connected');
		await seed(false);
		await sql.unsafe(`
			CREATE FUNCTION fail_pdf_insert() RETURNS trigger AS $$
			BEGIN
				RAISE EXCEPTION 'injected pdf insert failure';
			END;
			$$ LANGUAGE plpgsql;
			CREATE TRIGGER fail_pdf_insert
			BEFORE INSERT ON completion_artifact_pdf
			FOR EACH ROW EXECUTE PROCEDURE fail_pdf_insert();
		`);
		const store = new PostgresCompletionArtifactStore(sql);
		await expect(
			store.publishCompletionArtifact({
				envelopeId: ENVELOPE_ID,
				claimToken: 'claim-token-1',
				sentCommitSha: 'commit-1',
				fieldGeneration: 0,
				anchorAuditEventId: ANCHOR_ID,
				expectedAuditSequence: 1,
				previousAuditHash: 'e'.repeat(64),
				manifestSha256: 'm'.repeat(64),
				jsonObjectKey: 'artifact.json.gz',
				jsonSha256: 'j'.repeat(64),
				markdownObjectKey: 'artifact.md.gz',
				markdownSha256: 'd'.repeat(64),
				updatedAt: CLAIMED_AT,
				auditEventId: PUBLISHED_ID,
				auditEventHash: 'p'.repeat(64),
				auditPayloadJson: '{"manifestSha256":"' + 'm'.repeat(64) + '"}',
				pdf: PDF
			})
		).rejects.toThrow();
		// The cut-point after manifest, job, and audit writes rolls every one of
		// them back with the PDF pointer; the lease stays live and retryable.
		const leaked = await sql<
			{ artifacts: string; pdfs: string; receipts: string; publications: string }[]
		>`
			SELECT
				(SELECT COUNT(*) FROM completion_artifact)::text AS artifacts,
				(SELECT COUNT(*) FROM completion_artifact_pdf)::text AS pdfs,
				(SELECT COUNT(*) FROM completion_artifact_publish_command)::text AS receipts,
				(SELECT COUNT(*) FROM audit_event
					WHERE event_type = 'envelope.completion_artifact_published')::text AS publications`;
		expect(leaked[0]).toEqual({ artifacts: '0', pdfs: '0', receipts: '0', publications: '0' });
		const lease = await sql<{ status: string; claimToken: string | null }[]>`
			SELECT status, claim_token AS "claimToken" FROM completion_artifact_job
			WHERE envelope_id = ${ENVELOPE_ID}`;
		expect(lease[0]).toEqual({ status: 'processing', claimToken: 'claim-token-1' });
		await sql.unsafe('DROP TRIGGER fail_pdf_insert ON completion_artifact_pdf');
		await sql.unsafe('DROP FUNCTION fail_pdf_insert()');
		await expect(
			store.publishCompletionArtifact({
				envelopeId: ENVELOPE_ID,
				claimToken: 'claim-token-1',
				sentCommitSha: 'commit-1',
				fieldGeneration: 0,
				anchorAuditEventId: ANCHOR_ID,
				expectedAuditSequence: 1,
				previousAuditHash: 'e'.repeat(64),
				manifestSha256: 'm'.repeat(64),
				jsonObjectKey: 'artifact.json.gz',
				jsonSha256: 'j'.repeat(64),
				markdownObjectKey: 'artifact.md.gz',
				markdownSha256: 'd'.repeat(64),
				updatedAt: CLAIMED_AT,
				auditEventId: PUBLISHED_ID,
				auditEventHash: 'p'.repeat(64),
				auditPayloadJson: '{"manifestSha256":"' + 'm'.repeat(64) + '"}',
				pdf: PDF
			})
		).resolves.toMatchObject({ outcome: 'published' });
	});

	it('repairs a missing pointer and fails closed on a different digest', async () => {
		if (sql === null) throw new Error('PostgreSQL fixture is not connected');
		await sql.unsafe(`
			TRUNCATE completion_artifact_pdf, completion_artifact_pdf_repair,
				completion_artifact_pdf_repair_command, completion_artifact,
				completion_artifact_job, audit_event, envelope, instance_member CASCADE
		`);
		await seed(true);
		const store = new PostgresCompletionArtifactPdfRepairStore(sql);
		const claimed = await store.claimPendingPdfRepairs({
			claimToken: 'repair-1',
			claimedAt: CLAIMED_AT,
			staleBefore: STALE_BEFORE,
			discoveryLimit: 25,
			claimLimit: 1
		});
		expect(claimed).toHaveLength(1);
		await expect(
			store.completePdfRepair({
				envelopeId: ENVELOPE_ID,
				claimToken: 'repair-1',
				expectedManifestSha256: 'm'.repeat(64),
				pdf: PDF,
				updatedAt: CLAIMED_AT
			})
		).resolves.toEqual({ outcome: 'repaired' });
		await expect(
			store.completePdfRepair({
				envelopeId: ENVELOPE_ID,
				claimToken: 'repair-1',
				expectedManifestSha256: 'm'.repeat(64),
				pdf: { ...PDF, pdfSha256: 'a'.repeat(64) },
				updatedAt: CLAIMED_AT
			})
		).resolves.toEqual({ outcome: 'integrity_error' });
	});

	async function reset(): Promise<void> {
		if (sql === null) throw new Error('PostgreSQL fixture is not connected');
		await sql.unsafe(`
			TRUNCATE completion_artifact_pdf, completion_artifact_pdf_repair,
				completion_artifact_pdf_repair_command, completion_artifact_retry_command,
				completion_artifact_pdf_repair_retry_command, completion_artifact_publish_command,
				completion_artifact, completion_artifact_job, audit_event, envelope,
				instance_member CASCADE
		`);
	}

	async function exhaust(failedAt: string, lastError: string): Promise<void> {
		if (sql === null) throw new Error('PostgreSQL fixture is not connected');
		await sql`
			UPDATE completion_artifact_job
			SET status = 'failed', retryable = false, attempts = 10, claim_token = NULL, locked_at = NULL,
				last_error = ${lastError}, updated_at = ${failedAt}::timestamptz
			WHERE envelope_id = ${ENVELOPE_ID}`;
	}

	it('requeues only the observed exhausted generation and refuses stale, permanent, or live retries', async () => {
		if (sql === null) throw new Error('PostgreSQL fixture is not connected');
		await reset();
		await seed(false);
		const FIRST_FAILURE: string = '2026-09-12T01:00:00.000Z';
		const SECOND_FAILURE: string = '2026-09-12T09:00:00.000Z';
		await exhaust(FIRST_FAILURE, EXHAUSTED_TRANSIENT_COMPLETION_ARTIFACT_ERROR);
		const store = new PostgresCompletionArtifactStore(sql);
		// The status read exposes the generation as exact microsecond text.
		await expect(store.findCompletionArtifactStatus(ENVELOPE_ID)).resolves.toMatchObject({
			jobStatus: 'failed',
			updatedAt: '2026-09-12T01:00:00.000000Z'
		});
		const retry = (idempotencyKey: string, expectedFailedAt: string, expectedAttempts = 10) =>
			store.requeueExhaustedCompletionArtifact({
				envelopeId: ENVELOPE_ID,
				idempotencyKey,
				expectedAttempts,
				expectedFailedAt,
				requeuedAt: '2026-09-12T02:00:00.000Z'
			});

		await expect(retry('retry-1', '2026-09-12T01:00:00.000000Z')).resolves.toEqual({
			outcome: 'requeued'
		});
		await expect(retry('retry-1', FIRST_FAILURE)).resolves.toEqual({ outcome: 'replayed' });
		await expect(retry('retry-1', FIRST_FAILURE, 9)).resolves.toEqual({ outcome: 'conflict' });
		await expect(retry('retry-2', FIRST_FAILURE)).resolves.toEqual({ outcome: 'not_eligible' });

		await exhaust(SECOND_FAILURE, EXHAUSTED_TRANSIENT_COMPLETION_ARTIFACT_ERROR);
		await expect(retry('retry-stale', FIRST_FAILURE)).resolves.toEqual({
			outcome: 'not_eligible'
		});
		const unchanged = await sql<{ status: string; attempts: number }[]>`
			SELECT status, attempts FROM completion_artifact_job WHERE envelope_id = ${ENVELOPE_ID}`;
		expect(unchanged[0]).toEqual({ status: 'failed', attempts: 10 });
		await expect(retry('retry-3', SECOND_FAILURE)).resolves.toEqual({ outcome: 'requeued' });
		const receipts = await sql<{ n: string }[]>`
			SELECT COUNT(*)::text AS n FROM completion_artifact_retry_command`;
		expect(receipts[0]?.n).toBe('2');

		await exhaust(SECOND_FAILURE, 'completion_artifact_evidence_invalid');
		await expect(retry('retry-integrity', SECOND_FAILURE)).resolves.toEqual({
			outcome: 'not_eligible'
		});
		await exhaust(SECOND_FAILURE, 'completion_artifact_evidence_too_large');
		await expect(retry('retry-budget', SECOND_FAILURE)).resolves.toEqual({
			outcome: 'not_eligible'
		});
		await sql`
			UPDATE completion_artifact_job
			SET status = 'processing', claim_token = 'live', locked_at = ${SECOND_FAILURE}::timestamptz,
				last_error = ${EXHAUSTED_TRANSIENT_COMPLETION_ARTIFACT_ERROR}
			WHERE envelope_id = ${ENVELOPE_ID}`;
		await expect(retry('retry-live', SECOND_FAILURE)).resolves.toEqual({
			outcome: 'not_eligible'
		});
	});

	it('lets exactly one of two concurrent requeues reset the job', async () => {
		if (sql === null || DATABASE_URL === undefined) {
			throw new Error('PostgreSQL fixture is not connected');
		}
		await reset();
		await seed(false);
		const FAILED_AT: string = '2026-09-12T01:00:00.000Z';
		const second = postgres(DATABASE_URL, {
			max: 2,
			onnotice: (): void => undefined,
			connection: { search_path: SCHEMA, TimeZone: 'UTC' }
		});
		try {
			const command = (idempotencyKey: string) => ({
				envelopeId: ENVELOPE_ID,
				idempotencyKey,
				expectedAttempts: 10,
				expectedFailedAt: FAILED_AT,
				requeuedAt: '2026-09-12T02:00:00.000Z'
			});
			await exhaust(FAILED_AT, EXHAUSTED_TRANSIENT_COMPLETION_ARTIFACT_ERROR);
			const different = await Promise.all([
				new PostgresCompletionArtifactStore(sql).requeueExhaustedCompletionArtifact(
					command('retry-a')
				),
				new PostgresCompletionArtifactStore(second).requeueExhaustedCompletionArtifact(
					command('retry-b')
				)
			]);
			expect(different.map((result) => result.outcome).sort()).toEqual([
				'not_eligible',
				'requeued'
			]);

			await exhaust(FAILED_AT, EXHAUSTED_TRANSIENT_COMPLETION_ARTIFACT_ERROR);
			await sql`DELETE FROM completion_artifact_retry_command`;
			const duplicate = await Promise.all([
				new PostgresCompletionArtifactStore(sql).requeueExhaustedCompletionArtifact(
					command('retry-same')
				),
				new PostgresCompletionArtifactStore(second).requeueExhaustedCompletionArtifact(
					command('retry-same')
				)
			]);
			expect(duplicate.map((result) => result.outcome).sort()).toEqual(['replayed', 'requeued']);
			const job = await sql<{ status: string; attempts: number }[]>`
				SELECT status, attempts FROM completion_artifact_job WHERE envelope_id = ${ENVELOPE_ID}`;
			expect(job[0]).toEqual({ status: 'pending', attempts: 0 });
		} finally {
			await second.end();
		}
	});

	it('reports PDF repair generation and requeues only that exhausted generation', async () => {
		if (sql === null) throw new Error('PostgreSQL fixture is not connected');
		await reset();
		await seed(true);
		const store = new PostgresCompletionArtifactPdfRepairStore(sql);
		await store.claimPendingPdfRepairs({
			claimToken: 'repair-1',
			claimedAt: CLAIMED_AT,
			staleBefore: STALE_BEFORE,
			discoveryLimit: 25,
			claimLimit: 1
		});
		await expect(
			store.failPdfRepair({
				envelopeId: ENVELOPE_ID,
				claimToken: 'repair-1',
				errorCode: 'completion_artifact_build_failed',
				retryable: true,
				nextAvailableAt: '2026-09-12T00:00:30.000Z',
				failedAt: CLAIMED_AT
			})
		).resolves.toEqual({ outcome: 'failed' });
		await expect(store.findPdfRepairStatus(ENVELOPE_ID)).resolves.toMatchObject({
			status: 'failed',
			retryable: true
		});
		await sql`
			UPDATE completion_artifact_pdf_repair
			SET retryable = false, attempts = 10, last_error = ${EXHAUSTED_TRANSIENT_COMPLETION_PDF_REPAIR_ERROR}
			WHERE envelope_id = ${ENVELOPE_ID}`;
		await expect(store.findPdfRepairStatus(ENVELOPE_ID)).resolves.toMatchObject({
			status: 'failed',
			retryable: false,
			updatedAt: '2026-09-12T00:00:00.000000Z'
		});
		const retry = (idempotencyKey: string, expectedFailedAt: string) =>
			store.requeueExhaustedPdfRepair({
				envelopeId: ENVELOPE_ID,
				idempotencyKey,
				expectedAttempts: 10,
				expectedFailedAt,
				requeuedAt: '2026-09-12T03:00:00.000Z'
			});
		await expect(retry('pdf-stale', '2026-09-11T00:00:00.000Z')).resolves.toEqual({
			outcome: 'not_eligible'
		});
		await expect(retry('pdf-1', CLAIMED_AT)).resolves.toEqual({ outcome: 'requeued' });
		await expect(retry('pdf-1', CLAIMED_AT)).resolves.toEqual({ outcome: 'replayed' });
		await expect(store.findPdfRepairStatus(ENVELOPE_ID)).resolves.toMatchObject({
			status: 'pending',
			attempts: 0,
			retryable: true
		});
	});

	it('protects completion objects of unpublished or PDF-pending envelopes from orphan GC', async () => {
		if (sql === null) throw new Error('PostgreSQL fixture is not connected');
		await reset();
		await seed(false);
		const own: string = `completion-artifacts/v1/envelopes/${ENVELOPE_ID}/sha256/${'1'.repeat(64)}.pdf`;
		const foreign: string = `completion-artifacts/v1/envelopes/019a0000-0000-7000-8000-00000000ffff/sha256/${'2'.repeat(64)}.pdf`;
		const references = new PostgresOrphanReferenceStore(sql);
		await expect(references.filterReferencedKeys([own, foreign])).resolves.toEqual(new Set([own]));
		await reset();
		await seed(true);
		await expect(references.filterReferencedKeys([own, foreign])).resolves.toEqual(new Set([own]));
		await sql`
			INSERT INTO completion_artifact_pdf (
				envelope_id, pdf_object_key, pdf_sha256, pdf_byte_size,
				pdf_manifest_object_key, pdf_manifest_sha256, published_at
			) VALUES (
				${ENVELOPE_ID}, ${PDF.pdfObjectKey}, ${PDF.pdfSha256}, ${PDF.pdfByteSize},
				${PDF.pdfManifestObjectKey}, ${PDF.pdfManifestSha256}, ${CLAIMED_AT}::timestamptz
			)`;
		await expect(references.filterReferencedKeys([own, PDF.pdfObjectKey])).resolves.toEqual(
			new Set([PDF.pdfObjectKey])
		);
	});
});
