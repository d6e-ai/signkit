import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1OrphanReferenceStore } from '$lib/application/maintenance/orphan-collector';
import { D1CompletionArtifactPdfRepairStore } from './d1-completion-artifact-pdf-repair-store';
import { D1CompletionArtifactStore } from './d1-completion-artifact-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';
import { EXHAUSTED_TRANSIENT_COMPLETION_ARTIFACT_ERROR } from '$lib/ports/completion-artifact-store';
import { EXHAUSTED_TRANSIENT_COMPLETION_PDF_REPAIR_ERROR } from '$lib/ports/completion-artifact-pdf-repair-store';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const ANCHOR_ID: string = '01960000-0000-7000-8000-000000000001';
const PUBLISHED_ID: string = '01960000-0000-7000-8000-000000000002';
const CLAIMED_AT: string = '2026-09-12T00:00:00.000Z';
const STALE_BEFORE: string = '2026-09-11T23:55:00.000Z';
const PDF = {
	pdfObjectKey: 'completion-artifacts/v1/envelopes/e/sha256/p.pdf',
	pdfSha256: 'f'.repeat(64),
	pdfByteSize: 128,
	pdfManifestObjectKey: 'completion-artifacts/v1/envelopes/e/sha256/p.json.gz',
	pdfManifestSha256: 'g'.repeat(64)
};

function database(): { sqlite: DatabaseSync; d1: D1Database } {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	return { sqlite, d1: sqliteD1Database(sqlite) };
}

function seedEnvelope(sqlite: DatabaseSync, withArtifact: boolean, withPdf: boolean): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('user-1', 'owner', 'active', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, repository_head,
			sent_commit_sha, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}', 'user-1', 'Agreement', 'completed', 1, 'commit-1',
			'commit-1', '2026-09-11T00:00:00.000Z', '2026-09-11T00:02:00.000Z'
		);
		INSERT INTO audit_event (
			id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'${ANCHOR_ID}', '${ENVELOPE_ID}', 1, 'envelope.completed', 'system', 'system',
			'{}', '${'0'.repeat(64)}', '${'e'.repeat(64)}', '2026-09-11T00:02:00.000Z'
		);
		INSERT INTO completion_artifact_job (
			envelope_id, status, attempts, available_at, retryable, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}', 'pending', 1, '${CLAIMED_AT}', 1,
			'${CLAIMED_AT}', '${CLAIMED_AT}'
		);
		UPDATE completion_artifact_job
		SET status = 'processing', claim_token = 'claim-token-1', locked_at = '${CLAIMED_AT}',
			retryable = 0
		WHERE envelope_id = '${ENVELOPE_ID}';
	`);
	if (!withArtifact) return;
	sqlite.exec(`
		INSERT INTO completion_artifact (
			envelope_id, schema_version, manifest_sha256, json_object_key, json_sha256,
			markdown_object_key, markdown_sha256, sent_commit_sha, field_generation,
			anchor_audit_event_id, audit_head_sequence, audit_head_event_hash,
			published_at, audit_event_id
		) VALUES (
			'${ENVELOPE_ID}', 1, '${'m'.repeat(64)}', 'artifact.json.gz', '${'j'.repeat(64)}',
			'artifact.md.gz', '${'d'.repeat(64)}', 'commit-1', 0,
			'${ANCHOR_ID}', 2, '${'p'.repeat(64)}', '${CLAIMED_AT}', '${PUBLISHED_ID}'
		);
		INSERT INTO audit_event (
			id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'${PUBLISHED_ID}', '${ENVELOPE_ID}', 2, 'envelope.completion_artifact_published',
			'system', 'completion-artifact-worker', '{"manifestSha256":"${'m'.repeat(64)}"}',
			'${'e'.repeat(64)}', '${'p'.repeat(64)}', '${CLAIMED_AT}'
		);
		UPDATE completion_artifact_job
		SET status = 'published', claim_token = NULL, locked_at = NULL, retryable = 0
		WHERE envelope_id = '${ENVELOPE_ID}';
	`);
	if (!withPdf) return;
	sqlite
		.prepare(
			`INSERT INTO completion_artifact_pdf (
				envelope_id, pdf_object_key, pdf_sha256, pdf_byte_size,
				pdf_manifest_object_key, pdf_manifest_sha256, published_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			ENVELOPE_ID,
			PDF.pdfObjectKey,
			PDF.pdfSha256,
			PDF.pdfByteSize,
			PDF.pdfManifestObjectKey,
			PDF.pdfManifestSha256,
			CLAIMED_AT
		);
}

describe('D1 completion artifact PDF repair and atomic publish', () => {
	it('rolls back the publish receipt, job, artifact, and audit when PDF insert fails', async () => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite, false, false);
			sqlite.exec(`
				CREATE TEMP TRIGGER fail_pdf_insert BEFORE INSERT ON completion_artifact_pdf
				BEGIN
					SELECT RAISE(ABORT, 'injected pdf insert failure');
				END;
			`);
			const store = new D1CompletionArtifactStore(d1);
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
			expect(
				sqlite.prepare('SELECT COUNT(*) AS n FROM completion_artifact').get() as { n: number }
			).toEqual({ n: 0 });
			expect(
				sqlite.prepare('SELECT COUNT(*) AS n FROM completion_artifact_pdf').get() as { n: number }
			).toEqual({ n: 0 });
			expect(
				sqlite.prepare('SELECT COUNT(*) AS n FROM completion_artifact_publish_command').get() as {
					n: number;
				}
			).toEqual({ n: 0 });
			expect(
				sqlite
					.prepare(
						`SELECT COUNT(*) AS n FROM audit_event WHERE event_type = 'envelope.completion_artifact_published'`
					)
					.get() as { n: number }
			).toEqual({ n: 0 });
			expect(
				sqlite.prepare('SELECT status, claim_token FROM completion_artifact_job').get() as Record<
					string,
					unknown
				>
			).toEqual({ status: 'processing', claim_token: 'claim-token-1' });

			sqlite.exec('DROP TRIGGER fail_pdf_insert');
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
			expect(
				sqlite.prepare('SELECT pdf_sha256 FROM completion_artifact_pdf').get() as {
					pdf_sha256: string;
				}
			).toEqual({ pdf_sha256: PDF.pdfSha256 });
		} finally {
			sqlite.close();
		}
	});

	it('repairs a missing pointer, replays identical bytes, and fails closed on a different pointer', async () => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite, true, false);
			const store = new D1CompletionArtifactPdfRepairStore(d1);
			const claimed = await store.claimPendingPdfRepairs({
				claimToken: 'repair-1',
				claimedAt: CLAIMED_AT,
				staleBefore: STALE_BEFORE,
				discoveryLimit: 25,
				claimLimit: 1
			});
			expect(claimed).toHaveLength(1);
			expect(claimed[0]?.manifestSha256).toBe('m'.repeat(64));
			expect(claimed[0]?.auditHeadSequence).toBe(2);

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
					pdf: PDF,
					updatedAt: CLAIMED_AT
				})
			).resolves.toEqual({ outcome: 'replayed' });
			await expect(
				store.completePdfRepair({
					envelopeId: ENVELOPE_ID,
					claimToken: 'repair-1',
					expectedManifestSha256: 'm'.repeat(64),
					pdf: { ...PDF, pdfSha256: 'a'.repeat(64) },
					updatedAt: CLAIMED_AT
				})
			).resolves.toEqual({ outcome: 'integrity_error' });
			expect(
				sqlite.prepare('SELECT pdf_sha256 FROM completion_artifact_pdf').get() as {
					pdf_sha256: string;
				}
			).toEqual({ pdf_sha256: PDF.pdfSha256 });
		} finally {
			sqlite.close();
		}
	});

	it('ignores later audit events when reading the original evidence prefix', async () => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite, true, false);
			sqlite.exec(`
				INSERT INTO audit_event (
					id, envelope_id, sequence, event_type, actor_type, actor_id,
					payload_json, previous_hash, event_hash, occurred_at
				) VALUES (
					'01960000-0000-7000-8000-000000000099', '${ENVELOPE_ID}', 3,
					'envelope.voided', 'user', 'user-1', '{}', '${'p'.repeat(64)}', '${'z'.repeat(64)}',
					'2026-09-12T01:00:00.000Z'
				);
			`);
			const store = new D1CompletionArtifactStore(d1);
			const prefix = await store.readCompletionEvidence(ENVELOPE_ID, { throughSequence: 1 });
			expect(prefix.auditEvents.map((event) => event.eventType)).toEqual(['envelope.completed']);
			const throughPublication = await store.readCompletionEvidence(ENVELOPE_ID, {
				throughSequence: 2
			});
			expect(throughPublication.auditEvents.map((event) => event.eventType)).toEqual([
				'envelope.completed',
				'envelope.completion_artifact_published'
			]);
		} finally {
			sqlite.close();
		}
	});

	it('treats a mismatched lease as stale and does not write a pointer', async () => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite, true, false);
			const store = new D1CompletionArtifactPdfRepairStore(d1);
			await store.claimPendingPdfRepairs({
				claimToken: 'repair-live',
				claimedAt: CLAIMED_AT,
				staleBefore: STALE_BEFORE,
				discoveryLimit: 25,
				claimLimit: 1
			});
			await expect(
				store.completePdfRepair({
					envelopeId: ENVELOPE_ID,
					claimToken: 'stale-token',
					expectedManifestSha256: 'm'.repeat(64),
					pdf: PDF,
					updatedAt: CLAIMED_AT
				})
			).resolves.toEqual({ outcome: 'stale' });
			expect(
				sqlite.prepare('SELECT COUNT(*) AS n FROM completion_artifact_pdf').get() as { n: number }
			).toEqual({ n: 0 });
		} finally {
			sqlite.close();
		}
	});

	it('requeues only the observed exhausted generation, exactly once, and refuses stale or permanent retries', async () => {
		const { sqlite, d1 } = database();
		const FIRST_FAILURE: string = '2026-09-12T01:00:00.000Z';
		const SECOND_FAILURE: string = '2026-09-12T09:00:00.000Z';
		const exhaust = (failedAt: string, lastError: string): void => {
			sqlite.exec(`
				UPDATE completion_artifact_job
				SET status = 'failed', retryable = 0, attempts = 10, claim_token = NULL, locked_at = NULL,
					last_error = '${lastError}', updated_at = '${failedAt}'
				WHERE envelope_id = '${ENVELOPE_ID}';
			`);
		};
		const job = (): Record<string, unknown> =>
			sqlite
				.prepare(
					'SELECT status, attempts, retryable, last_error, updated_at FROM completion_artifact_job'
				)
				.get() as Record<string, unknown>;
		try {
			seedEnvelope(sqlite, false, false);
			exhaust(FIRST_FAILURE, EXHAUSTED_TRANSIENT_COMPLETION_ARTIFACT_ERROR);
			const store = new D1CompletionArtifactStore(d1);
			const retry = (idempotencyKey: string, expectedFailedAt: string, expectedAttempts = 10) =>
				store.requeueExhaustedCompletionArtifact({
					envelopeId: ENVELOPE_ID,
					idempotencyKey,
					expectedAttempts,
					expectedFailedAt,
					requeuedAt: '2026-09-12T02:00:00.000Z'
				});

			await expect(retry('retry-1', FIRST_FAILURE)).resolves.toEqual({ outcome: 'requeued' });
			expect(job()).toMatchObject({
				status: 'pending',
				attempts: 0,
				retryable: 1,
				last_error: null
			});
			await expect(retry('retry-1', FIRST_FAILURE)).resolves.toEqual({ outcome: 'replayed' });
			await expect(retry('retry-1', FIRST_FAILURE, 9)).resolves.toEqual({ outcome: 'conflict' });
			await expect(retry('retry-1', SECOND_FAILURE)).resolves.toEqual({ outcome: 'conflict' });
			// A concurrent duplicate under a different key cannot requeue a live job.
			await expect(retry('retry-2', FIRST_FAILURE)).resolves.toEqual({ outcome: 'not_eligible' });

			// The requeued job exhausts again: attempts return to 10, so only the
			// failure generation tells the new failure from the old one.
			exhaust(SECOND_FAILURE, EXHAUSTED_TRANSIENT_COMPLETION_ARTIFACT_ERROR);
			await expect(retry('retry-stale', FIRST_FAILURE)).resolves.toEqual({
				outcome: 'not_eligible'
			});
			expect(job()).toMatchObject({ status: 'failed', attempts: 10, updated_at: SECOND_FAILURE });
			await expect(retry('retry-1', FIRST_FAILURE)).resolves.toEqual({ outcome: 'replayed' });
			expect(job()).toMatchObject({ status: 'failed', updated_at: SECOND_FAILURE });
			await expect(retry('retry-3', SECOND_FAILURE)).resolves.toEqual({ outcome: 'requeued' });
			expect(
				sqlite.prepare('SELECT COUNT(*) AS n FROM completion_artifact_retry_command').get() as {
					n: number;
				}
			).toEqual({ n: 2 });

			exhaust(SECOND_FAILURE, 'completion_artifact_evidence_invalid');
			await expect(retry('retry-integrity', SECOND_FAILURE)).resolves.toEqual({
				outcome: 'not_eligible'
			});
			exhaust(SECOND_FAILURE, 'completion_artifact_evidence_too_large');
			await expect(retry('retry-budget', SECOND_FAILURE)).resolves.toEqual({
				outcome: 'not_eligible'
			});
			sqlite.exec(`
				UPDATE completion_artifact_job
				SET status = 'processing', claim_token = 'live', locked_at = '${SECOND_FAILURE}',
					last_error = '${EXHAUSTED_TRANSIENT_COMPLETION_ARTIFACT_ERROR}'
				WHERE envelope_id = '${ENVELOPE_ID}';
			`);
			await expect(retry('retry-live', SECOND_FAILURE)).resolves.toEqual({
				outcome: 'not_eligible'
			});
			expect(job()).toMatchObject({ status: 'processing' });
			await expect(
				store.requeueExhaustedCompletionArtifact({
					envelopeId: '01900000-0000-7000-8000-00000000ffff',
					idempotencyKey: 'retry-missing',
					expectedAttempts: 10,
					expectedFailedAt: SECOND_FAILURE,
					requeuedAt: SECOND_FAILURE
				})
			).resolves.toEqual({ outcome: 'not_found' });
		} finally {
			sqlite.close();
		}
	});

	it('lets only one of two concurrent repair claimers publish the pointer', async () => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite, true, false);
			const store = new D1CompletionArtifactPdfRepairStore(d1);
			const claim = (claimToken: string, claimedAt: string, staleBefore: string) =>
				store.claimPendingPdfRepairs({
					claimToken,
					claimedAt,
					staleBefore,
					discoveryLimit: 25,
					claimLimit: 1
				});
			await expect(claim('repair-a', CLAIMED_AT, STALE_BEFORE)).resolves.toHaveLength(1);
			// A live lease is not reclaimable.
			await expect(claim('repair-b', CLAIMED_AT, STALE_BEFORE)).resolves.toHaveLength(0);
			// After the lease expires a new claimer takes over; the old one is stale.
			await expect(
				claim('repair-c', '2026-09-12T00:10:00.000Z', '2026-09-12T00:05:00.000Z')
			).resolves.toHaveLength(1);
			await expect(
				store.completePdfRepair({
					envelopeId: ENVELOPE_ID,
					claimToken: 'repair-a',
					expectedManifestSha256: 'm'.repeat(64),
					pdf: PDF,
					updatedAt: CLAIMED_AT
				})
			).resolves.toEqual({ outcome: 'stale' });
			expect(
				sqlite.prepare('SELECT COUNT(*) AS n FROM completion_artifact_pdf').get() as { n: number }
			).toEqual({ n: 0 });
			await expect(
				store.completePdfRepair({
					envelopeId: ENVELOPE_ID,
					claimToken: 'repair-c',
					expectedManifestSha256: 'm'.repeat(64),
					pdf: PDF,
					updatedAt: '2026-09-12T00:10:00.000Z'
				})
			).resolves.toEqual({ outcome: 'repaired' });
			// The published manifest, receipt, and publication audit are untouched.
			expect(
				sqlite.prepare('SELECT manifest_sha256 FROM completion_artifact').get() as {
					manifest_sha256: string;
				}
			).toEqual({ manifest_sha256: 'm'.repeat(64) });
			expect(
				sqlite
					.prepare(
						`SELECT COUNT(*) AS n FROM audit_event WHERE event_type = 'envelope.completion_artifact_published'`
					)
					.get() as { n: number }
			).toEqual({ n: 1 });
			await expect(store.findPdfRepairStatus(ENVELOPE_ID)).resolves.toMatchObject({
				status: 'repaired',
				retryable: false
			});
		} finally {
			sqlite.close();
		}
	});

	it('fails closed on a repair whose stored manifest digest changed', async () => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite, true, false);
			const store = new D1CompletionArtifactPdfRepairStore(d1);
			await store.claimPendingPdfRepairs({
				claimToken: 'repair-1',
				claimedAt: CLAIMED_AT,
				staleBefore: STALE_BEFORE,
				discoveryLimit: 25,
				claimLimit: 1
			});
			await expect(
				store.completePdfRepair({
					envelopeId: ENVELOPE_ID,
					claimToken: 'repair-1',
					expectedManifestSha256: 'x'.repeat(64),
					pdf: PDF,
					updatedAt: CLAIMED_AT
				})
			).resolves.toEqual({ outcome: 'integrity_error' });
			expect(
				sqlite.prepare('SELECT COUNT(*) AS n FROM completion_artifact_pdf').get() as { n: number }
			).toEqual({ n: 0 });
		} finally {
			sqlite.close();
		}
	});

	it('protects completion objects of unpublished or PDF-pending envelopes from orphan GC before discovery', async () => {
		const { sqlite, d1 } = database();
		const own: string = `completion-artifacts/v1/envelopes/${ENVELOPE_ID}/sha256/${'1'.repeat(64)}.pdf`;
		const foreign: string = `completion-artifacts/v1/envelopes/01900000-0000-7000-8000-00000000ffff/sha256/${'2'.repeat(64)}.pdf`;
		try {
			seedEnvelope(sqlite, false, false);
			const references = new D1OrphanReferenceStore(d1);
			// Primary job still processing: its pre-publication objects are live.
			await expect(references.filterReferencedKeys([own, foreign])).resolves.toEqual(
				new Set([own])
			);

			sqlite.exec(`
				INSERT INTO completion_artifact (
					envelope_id, schema_version, manifest_sha256, json_object_key, json_sha256,
					markdown_object_key, markdown_sha256, sent_commit_sha, field_generation,
					anchor_audit_event_id, audit_head_sequence, audit_head_event_hash,
					published_at, audit_event_id
				) VALUES (
					'${ENVELOPE_ID}', 1, '${'m'.repeat(64)}', 'artifact.json.gz', '${'j'.repeat(64)}',
					'artifact.md.gz', '${'d'.repeat(64)}', 'commit-1', 0,
					'${ANCHOR_ID}', 2, '${'p'.repeat(64)}', '${CLAIMED_AT}', '${PUBLISHED_ID}'
				);
				UPDATE completion_artifact_job
				SET status = 'published', claim_token = NULL, locked_at = NULL, retryable = 0
				WHERE envelope_id = '${ENVELOPE_ID}';
			`);
			// Published without a PDF pointer and no repair row discovered yet.
			expect(
				sqlite.prepare('SELECT COUNT(*) AS n FROM completion_artifact_pdf_repair').get() as {
					n: number;
				}
			).toEqual({ n: 0 });
			await expect(references.filterReferencedKeys([own, foreign])).resolves.toEqual(
				new Set([own])
			);

			sqlite
				.prepare(
					`INSERT INTO completion_artifact_pdf (
						envelope_id, pdf_object_key, pdf_sha256, pdf_byte_size,
						pdf_manifest_object_key, pdf_manifest_sha256, published_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					ENVELOPE_ID,
					PDF.pdfObjectKey,
					PDF.pdfSha256,
					PDF.pdfByteSize,
					PDF.pdfManifestObjectKey,
					PDF.pdfManifestSha256,
					CLAIMED_AT
				);
			// Once the pointer lands, only referenced objects stay live.
			await expect(references.filterReferencedKeys([own, PDF.pdfObjectKey])).resolves.toEqual(
				new Set([PDF.pdfObjectKey])
			);
		} finally {
			sqlite.close();
		}
	});

	it('requeues exhausted PDF repair failures under a matching attempt count and generation', async () => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite, true, false);
			const store = new D1CompletionArtifactPdfRepairStore(d1);
			await store.claimPendingPdfRepairs({
				claimToken: 'repair-1',
				claimedAt: CLAIMED_AT,
				staleBefore: STALE_BEFORE,
				discoveryLimit: 25,
				claimLimit: 1
			});
			await store.failPdfRepair({
				envelopeId: ENVELOPE_ID,
				claimToken: 'repair-1',
				errorCode: EXHAUSTED_TRANSIENT_COMPLETION_PDF_REPAIR_ERROR,
				retryable: false,
				nextAvailableAt: CLAIMED_AT,
				failedAt: CLAIMED_AT
			});
			sqlite.exec(`
				UPDATE completion_artifact_pdf_repair SET attempts = 10 WHERE envelope_id = '${ENVELOPE_ID}';
			`);
			await expect(store.findPdfRepairStatus(ENVELOPE_ID)).resolves.toMatchObject({
				status: 'failed',
				retryable: false,
				updatedAt: CLAIMED_AT
			});
			await expect(
				store.requeueExhaustedPdfRepair({
					envelopeId: ENVELOPE_ID,
					idempotencyKey: 'pdf-retry-stale',
					expectedAttempts: 10,
					expectedFailedAt: '2026-09-11T00:00:00.000Z',
					requeuedAt: CLAIMED_AT
				})
			).resolves.toEqual({ outcome: 'not_eligible' });
			await expect(
				store.requeueExhaustedPdfRepair({
					envelopeId: ENVELOPE_ID,
					idempotencyKey: 'pdf-retry-1',
					expectedAttempts: 10,
					expectedFailedAt: CLAIMED_AT,
					requeuedAt: '2026-09-12T03:00:00.000Z'
				})
			).resolves.toEqual({ outcome: 'requeued' });
			await expect(
				store.requeueExhaustedPdfRepair({
					envelopeId: ENVELOPE_ID,
					idempotencyKey: 'pdf-retry-1',
					expectedAttempts: 10,
					expectedFailedAt: CLAIMED_AT,
					requeuedAt: '2026-09-12T03:00:00.000Z'
				})
			).resolves.toEqual({ outcome: 'replayed' });
			await expect(store.findPdfRepairStatus(ENVELOPE_ID)).resolves.toMatchObject({
				status: 'pending',
				attempts: 0,
				retryable: true
			});
		} finally {
			sqlite.close();
		}
	});
});
