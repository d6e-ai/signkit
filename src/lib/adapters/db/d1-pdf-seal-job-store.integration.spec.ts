import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1PdfSealJobStore } from './d1-pdf-seal-job-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';
import type {
	ClaimedPdfSealJob,
	EnqueuePdfSealJobCommand,
	PdfSealJob,
	PdfSealValidationEvidence
} from '$lib/ports/pdf-seal-job-store';
import type { PdfSealValidationChecks } from '$lib/ports/pdf-seal-validator';

const ENVELOPE_ID: string = '019a0000-0000-7000-8000-000000000001';
const JOB_ID: string = '019a0000-0000-7000-8000-000000000002';
const OPERATION_ID: string = '019a0000-0000-7000-8000-000000000003';
const VALIDATION_ID: string = '019a0000-0000-7000-8000-000000000004';
const SOURCE_KEY: string = 'completion-artifacts/source.pdf';
const SOURCE_SHA: string = 'a'.repeat(64);
const SEALED_SHA: string = 'b'.repeat(64);

function fixture(): { sqlite: DatabaseSync; store: D1PdfSealJobStore } {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	seedCompletionPdf(sqlite);
	return { sqlite, store: new D1PdfSealJobStore(sqliteD1Database(sqlite)) };
}

function seedCompletionPdf(sqlite: DatabaseSync): void {
	sqlite.exec(`
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
			'019a0000-0000-7000-8000-000000000011', '${ENVELOPE_ID}', 1,
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
			'019a0000-0000-7000-8000-000000000011', 1, '${'e'.repeat(64)}',
			'2026-09-23T00:02:00.000Z', '019a0000-0000-7000-8000-000000000012'
		);
		INSERT INTO completion_artifact_pdf (
			envelope_id, pdf_object_key, pdf_sha256, pdf_manifest_object_key,
			pdf_manifest_sha256, published_at
		) VALUES (
			'${ENVELOPE_ID}', '${SOURCE_KEY}', '${SOURCE_SHA}', 'manifest.json.gz',
			'${'9'.repeat(64)}', '2026-09-23T00:03:00.000Z'
		);
	`);
}

const enqueueCommand: EnqueuePdfSealJobCommand = {
	jobId: JOB_ID,
	envelopeId: ENVELOPE_ID,
	operationId: OPERATION_ID,
	validationId: VALIDATION_ID,
	sourceObjectKey: SOURCE_KEY,
	sourceSha256: SOURCE_SHA,
	sourceByteSize: 1024,
	requestedProfile: 'pades-b-b',
	signerCertificateSha256: '8'.repeat(64),
	sealPolicyId: 'seal-policy-v1',
	validationPolicyId: 'validation-policy-v1',
	tsaPolicyId: null,
	tsaTrustBundleSha256: null,
	createdAt: '2026-09-23T00:04:00.000Z'
};

const checks: PdfSealValidationChecks = {
	sourcePrefixExact: true,
	incrementalUpdateValid: true,
	byteRangeComplete: true,
	cmsSignatureValid: true,
	cmsSubFilter: 'ETSI.CAdES.detached',
	signerCertificateProtected: true,
	signerCertificateDigestMatches: true,
	certificatePathValid: true,
	sealPolicyValid: true,
	invisibleApprovalSignature: true,
	docMdpAbsent: true,
	noPostSealChanges: true,
	timestamp: null
};

const validationEvidence: PdfSealValidationEvidence = {
	validatorReceiptId: 'validator-receipt-1',
	checks,
	reportObjectKey: 'pdf-seals/reports/report.json',
	reportSha256: 'c'.repeat(64),
	reportByteSize: 2048,
	validatedAt: '2026-09-23T00:05:30.000Z'
};

describe('D1PdfSealJobStore integration', () => {
	it('enqueues one evidence-bound job and rejects mismatched replay/source', async () => {
		const { sqlite, store } = fixture();
		try {
			await expect(store.enqueue(enqueueCommand)).resolves.toMatchObject({ outcome: 'enqueued' });
			await expect(store.enqueue(enqueueCommand)).resolves.toMatchObject({ outcome: 'existing' });
			await expect(
				store.enqueue({ ...enqueueCommand, operationId: '019a0000-0000-7000-8000-000000000099' })
			).resolves.toEqual({ outcome: 'conflict' });
			const missing = fixture();
			try {
				await expect(
					missing.store.enqueue({ ...enqueueCommand, sourceSha256: '7'.repeat(64) })
				).resolves.toEqual({ outcome: 'source_mismatch' });
			} finally {
				missing.sqlite.close();
			}
		} finally {
			sqlite.close();
		}
	});

	it('persists ambiguous recovery, receipts, sealed metadata, and publication-ready evidence', async () => {
		const { sqlite, store } = fixture();
		try {
			await store.enqueue(enqueueCommand);
			const submit: ClaimedPdfSealJob = await claim(store, 'lease-1', '2026-09-23T00:04:01.000Z');
			expect(submit.job.nextAction).toBe('submit');
			await expect(
				store.checkpoint({
					kind: 'ambiguous_submit',
					...attempt(submit, '019a0000-0000-7000-8000-000000000021', '2026-09-23T00:04:02.000Z')
				})
			).resolves.toBe(true);
			expect((await store.find(JOB_ID))?.nextAction).toBe('recover_submit');

			const recover: ClaimedPdfSealJob = await claim(store, 'lease-2', '2026-09-23T00:04:03.000Z');
			await expect(
				store.checkpoint({
					kind: 'provider_receipt',
					...attempt(recover, '019a0000-0000-7000-8000-000000000022', '2026-09-23T00:04:04.000Z'),
					providerReceiptId: 'provider-receipt-1'
				})
			).resolves.toBe(true);

			const poll: ClaimedPdfSealJob = await claim(store, 'lease-3', '2026-09-23T00:04:05.000Z');
			await expect(
				store.checkpoint({
					kind: 'provider_result',
					...attempt(poll, '019a0000-0000-7000-8000-000000000023', '2026-09-23T00:04:06.000Z'),
					providerReceiptId: 'provider-receipt-1',
					sealedArtifact: {
						objectKey: 'pdf-seals/sealed.pdf',
						sha256: SEALED_SHA,
						byteSize: 2048,
						achievedProfile: 'pades-b-b'
					}
				})
			).resolves.toBe(true);

			const validate: ClaimedPdfSealJob = await claim(store, 'lease-4', '2026-09-23T00:04:07.000Z');
			await expect(
				store.complete({
					...attempt(validate, '019a0000-0000-7000-8000-000000000024', '2026-09-23T00:05:31.000Z'),
					providerReceiptId: 'provider-receipt-1',
					sealedArtifact: validate.job.sealedArtifact!,
					validationEvidence
				})
			).resolves.toBe(true);

			const ready: PdfSealJob | null = await store.find(JOB_ID);
			expect(ready).toMatchObject({
				status: 'publication_ready',
				nextAction: 'publish',
				providerReceiptId: 'provider-receipt-1',
				sealedArtifact: { sha256: SEALED_SHA },
				validationEvidence: { validatorReceiptId: 'validator-receipt-1', checks }
			});
			await expect(
				store.claim({
					claimToken: 'lease-5',
					claimedAt: '2026-09-23T00:06:00.000Z',
					staleBefore: '2026-09-23T00:05:00.000Z',
					limit: 1
				})
			).resolves.toHaveLength(0);
			expect(sqlite.prepare('SELECT count(*) AS count FROM pdf_seal_attempt').get()).toEqual({
				count: 4
			});
			expect(() =>
				sqlite.prepare("UPDATE pdf_seal_attempt SET outcome = 'deferred'").run()
			).toThrow(/immutable/);
		} finally {
			sqlite.close();
		}
	});

	it('uses CAS leases, deterministic retry scheduling, and terminal attempt exhaustion', async () => {
		const { sqlite, store } = fixture();
		try {
			await store.enqueue(enqueueCommand);
			let claimed: ClaimedPdfSealJob = await claim(store, 'lease-1', '2026-09-23T00:04:01.000Z');
			await expect(
				store.fail({
					...attempt(claimed, '019a0000-0000-7000-8000-000000000031', '2026-09-23T00:04:02.000Z'),
					errorCode: 'network_error',
					retryable: true
				})
			).resolves.toBe(true);
			expect(await store.find(JOB_ID)).toMatchObject({
				status: 'failed',
				retryable: true,
				availableAt: '2026-09-23T00:04:32.000Z'
			});
			await expect(
				store.claim({
					claimToken: 'too-early',
					claimedAt: '2026-09-23T00:04:31.000Z',
					staleBefore: '2026-09-23T00:00:00.000Z',
					limit: 1
				})
			).resolves.toHaveLength(0);

			for (let attemptNumber: number = 2; attemptNumber <= 8; attemptNumber += 1) {
				const minute: string = String(attemptNumber).padStart(2, '0');
				claimed = await claim(
					store,
					`lease-${attemptNumber}`,
					`2026-09-23T0${attemptNumber}:00:00.000Z`
				);
				await store.fail({
					...attempt(
						claimed,
						`019a0000-0000-7000-8000-${String(40 + attemptNumber).padStart(12, '0')}`,
						`2026-09-23T0${attemptNumber}:00:01.000Z`
					),
					errorCode: 'network_error',
					retryable: true
				});
				void minute;
			}
			expect(await store.find(JOB_ID)).toMatchObject({
				status: 'failed',
				attempts: 8,
				retryable: false,
				failedAt: '2026-09-23T08:00:01.000Z'
			});
			await expect(
				store.claim({
					claimToken: 'lease-9',
					claimedAt: '2026-09-24T00:00:00.000Z',
					staleBefore: '2026-09-23T23:00:00.000Z',
					limit: 1
				})
			).resolves.toHaveLength(0);
		} finally {
			sqlite.close();
		}
	});

	it('reclaims an abandoned final lease without incrementing beyond the attempt ceiling', async () => {
		const { sqlite, store } = fixture();
		try {
			await store.enqueue(enqueueCommand);
			sqlite
				.prepare(
					`UPDATE pdf_seal_job
					 SET status = 'processing', claim_token = 'abandoned', attempts = 8,
						locked_at = '2026-09-23T00:00:00.000Z'
					 WHERE id = ?`
				)
				.run(JOB_ID);
			const reclaimed: readonly ClaimedPdfSealJob[] = await store.claim({
				claimToken: 'recovery-lease',
				claimedAt: '2026-09-23T01:00:00.000Z',
				staleBefore: '2026-09-23T00:30:00.000Z',
				limit: 1,
				jobId: JOB_ID
			});
			expect(reclaimed).toHaveLength(1);
			expect(reclaimed[0]?.job.attempts).toBe(8);
			await expect(
				store.fail({
					...attempt(
						reclaimed[0],
						'019a0000-0000-7000-8000-000000000060',
						'2026-09-23T01:00:01.000Z'
					),
					errorCode: 'request_timeout',
					retryable: true
				})
			).resolves.toBe(true);
			expect(await store.find(JOB_ID)).toMatchObject({
				status: 'failed',
				attempts: 8,
				retryable: false
			});
		} finally {
			sqlite.close();
		}
	});
});

async function claim(
	store: D1PdfSealJobStore,
	token: string,
	claimedAt: string
): Promise<ClaimedPdfSealJob> {
	const jobs: readonly ClaimedPdfSealJob[] = await store.claim({
		claimToken: token,
		claimedAt,
		staleBefore: '2026-09-22T23:00:00.000Z',
		limit: 1,
		jobId: JOB_ID
	});
	expect(jobs).toHaveLength(1);
	return jobs[0];
}

function attempt(claimed: ClaimedPdfSealJob, attemptId: string, finishedAt: string) {
	return {
		jobId: claimed.job.jobId,
		claimToken: claimed.claimToken,
		attemptId,
		attemptNumber: claimed.job.attempts,
		startedAt: claimed.startedAt,
		finishedAt
	};
}
