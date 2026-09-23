import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1PdfSealRequestStore } from './d1-pdf-seal-request-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';
import type { RequestPdfSealCommand } from '$lib/ports/pdf-seal-request-store';

const ENVELOPE_ID: string = '019a0000-0000-7000-8000-000000000001';
const WITHOUT_SOURCE_ID: string = '019a0000-0000-7000-8000-000000000101';
const JOB_ID: string = '019a0000-0000-7000-8000-000000000002';
const SOURCE_KEY: string = 'completion-artifacts/source.pdf';
const SOURCE_SHA: string = 'a'.repeat(64);

const command: RequestPdfSealCommand = {
	actor: { type: 'user', id: 'user-1' },
	idempotencyKey: 'request-1',
	requestHash: 'b'.repeat(64),
	envelopeId: ENVELOPE_ID,
	jobId: JOB_ID,
	operationId: '019a0000-0000-7000-8000-000000000003',
	validationId: '019a0000-0000-7000-8000-000000000004',
	requestedProfile: 'pades-b-b',
	signerCertificateSha256: 'c'.repeat(64),
	sealPolicyId: 'seal-policy-v1',
	validationPolicyId: 'validation-policy-v1',
	tsaPolicyId: null,
	tsaTrustBundleSha256: null,
	requestedAt: '2026-09-23T00:04:00.000Z'
};

function fixture(): { sqlite: DatabaseSync; store: D1PdfSealRequestStore } {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	seed(sqlite);
	return { sqlite, store: new D1PdfSealRequestStore(sqliteD1Database(sqlite)) };
}

function seed(sqlite: DatabaseSync): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('user-1', 'owner', 'active', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
		INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, repository_head,
			sent_commit_sha, created_at, updated_at
		) VALUES
			('${ENVELOPE_ID}', 'user-1', 'Agreement', 'completed', 1, 'commit-1',
			 'commit-1', '2026-09-23T00:00:00.000Z', '2026-09-23T00:01:00.000Z'),
			('${WITHOUT_SOURCE_ID}', 'user-1', 'No source', 'completed', 1, 'commit-2',
			 'commit-2', '2026-09-23T00:00:00.000Z', '2026-09-23T00:01:00.000Z');
		INSERT INTO audit_event (
			id, envelope_id, sequence, event_type, actor_type, actor_id, payload_json,
			previous_hash, event_hash, occurred_at
		) VALUES (
			'019a0000-0000-7000-8000-000000000011', '${ENVELOPE_ID}', 1,
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
			'019a0000-0000-7000-8000-000000000011', 1, '${'d'.repeat(64)}',
			'2026-09-23T00:02:00.000Z', '019a0000-0000-7000-8000-000000000012'
		);
		INSERT INTO completion_artifact_pdf (
			envelope_id, pdf_object_key, pdf_sha256, pdf_manifest_object_key,
			pdf_manifest_sha256, pdf_byte_size, published_at
		) VALUES (
			'${ENVELOPE_ID}', '${SOURCE_KEY}', '${SOURCE_SHA}', 'manifest.json.gz',
			'${'2'.repeat(64)}', 1024, '2026-09-23T00:03:00.000Z'
		);
	`);
}

describe('D1PdfSealRequestStore integration', () => {
	it('atomically freezes source/policy, creates the job, and replays the exact receipt', async () => {
		const { sqlite, store } = fixture();
		try {
			await expect(store.request(command)).resolves.toEqual({
				outcome: 'requested',
				job: {
					jobId: JOB_ID,
					envelopeId: ENVELOPE_ID,
					requestedProfile: 'pades-b-b',
					requestedAt: command.requestedAt
				}
			});
			const persisted = sqlite
				.prepare(
					`SELECT request.source_object_key, request.source_sha256, request.source_byte_size,
						request.signer_certificate_sha256, job.status, job.next_action
					 FROM pdf_seal_request_command request
					 JOIN pdf_seal_job job ON job.id = request.job_id`
				)
				.get();
			expect(persisted).toEqual({
				source_object_key: SOURCE_KEY,
				source_sha256: SOURCE_SHA,
				source_byte_size: 1024,
				signer_certificate_sha256: command.signerCertificateSha256,
				status: 'pending',
				next_action: 'submit'
			});

			await expect(
				store.request({
					...command,
					jobId: '019a0000-0000-7000-8000-000000000092',
					operationId: '019a0000-0000-7000-8000-000000000093',
					validationId: '019a0000-0000-7000-8000-000000000094'
				})
			).resolves.toMatchObject({ outcome: 'replayed', job: { jobId: JOB_ID } });
			await expect(store.request({ ...command, requestHash: '3'.repeat(64) })).resolves.toEqual({
				outcome: 'idempotency_conflict'
			});
			await expect(
				store.request({
					...command,
					actor: { type: 'agent', id: 'agent-1' },
					idempotencyKey: 'other-request',
					requestHash: '4'.repeat(64)
				})
			).resolves.toMatchObject({ outcome: 'existing_envelope', job: { jobId: JOB_ID } });
			expect(sqlite.prepare('SELECT count(*) AS count FROM pdf_seal_job').get()).toEqual({
				count: 1
			});
		} finally {
			sqlite.close();
		}
	});

	it('classifies missing envelopes and unavailable completion PDF bytes without partial writes', async () => {
		const { sqlite, store } = fixture();
		try {
			await expect(
				store.request({
					...command,
					envelopeId: '019a0000-0000-7000-8000-000000000999'
				})
			).resolves.toEqual({ outcome: 'not_found' });
			await expect(store.request({ ...command, envelopeId: WITHOUT_SOURCE_ID })).resolves.toEqual({
				outcome: 'source_unavailable'
			});
			sqlite
				.prepare('UPDATE completion_artifact_pdf SET pdf_byte_size = NULL WHERE envelope_id = ?')
				.run(ENVELOPE_ID);
			await expect(store.request(command)).resolves.toEqual({ outcome: 'source_unavailable' });
			expect(
				sqlite.prepare('SELECT count(*) AS count FROM pdf_seal_request_command').get()
			).toEqual({
				count: 0
			});
			expect(sqlite.prepare('SELECT count(*) AS count FROM pdf_seal_job').get()).toEqual({
				count: 0
			});
		} finally {
			sqlite.close();
		}
	});

	it('returns bounded public statuses and maps publication_ready to pending', async () => {
		const { sqlite, store } = fixture();
		try {
			await expect(store.findStatus('019a0000-0000-7000-8000-000000000999')).resolves.toEqual({
				status: 'not_found'
			});
			await expect(store.findStatus(ENVELOPE_ID)).resolves.toEqual({
				status: 'not_requested',
				sourceAvailable: true
			});
			await expect(store.findStatus(WITHOUT_SOURCE_ID)).resolves.toEqual({
				status: 'not_requested',
				sourceAvailable: false
			});
			await store.request(command);
			await expect(store.findStatus(ENVELOPE_ID)).resolves.toMatchObject({
				status: 'pending',
				attempts: 0,
				job: { jobId: JOB_ID }
			});

			sqlite
				.prepare(
					`UPDATE pdf_seal_job SET status = 'failed', retryable = 0,
					 last_error_code = 'provider.timeout', failed_at = ?, updated_at = ? WHERE id = ?`
				)
				.run('2026-09-23T00:05:00.000Z', '2026-09-23T00:05:00.000Z', JOB_ID);
			await expect(store.findStatus(ENVELOPE_ID)).resolves.toMatchObject({
				status: 'failed',
				retryable: false,
				lastErrorCode: 'pdf_seal_failed'
			});

			sqlite
				.prepare(
					`UPDATE pdf_seal_job SET status = 'publication_ready', next_action = 'publish',
					 retryable = NULL, last_error_code = NULL, failed_at = NULL,
					 provider_receipt_id = 'provider-1', sealed_object_key = 'sealed.pdf',
					 sealed_sha256 = ?, sealed_byte_size = 2048, achieved_profile = 'pades-b-b',
					 validator_receipt_id = 'validator-1', validation_checks_json = '{}',
					 validation_report_object_key = 'report.json', validation_report_sha256 = ?,
					 validation_report_byte_size = 100, validated_at = ?, ready_at = ?, updated_at = ?
					 WHERE id = ?`
				)
				.run(
					'5'.repeat(64),
					'6'.repeat(64),
					'2026-09-23T00:06:00.000Z',
					'2026-09-23T00:06:00.000Z',
					'2026-09-23T00:06:00.000Z',
					JOB_ID
				);
			await expect(store.findStatus(ENVELOPE_ID)).resolves.toMatchObject({
				status: 'pending',
				attempts: 0
			});

			insertPublication(sqlite);
			await expect(store.findStatus(ENVELOPE_ID)).resolves.toEqual({
				status: 'published',
				job: {
					jobId: JOB_ID,
					envelopeId: ENVELOPE_ID,
					requestedProfile: 'pades-b-b',
					requestedAt: command.requestedAt
				},
				achievedProfile: 'pades-b-b',
				signerCertificateSha256: command.signerCertificateSha256,
				sealedSha256: '5'.repeat(64),
				sealedByteSize: 2048,
				validationReportSha256: '6'.repeat(64),
				validatedAt: '2026-09-23T00:06:00.000Z',
				publishedAt: '2026-09-23T00:07:00.000Z'
			});
		} finally {
			sqlite.close();
		}
	});

	it('makes command receipts immutable', async () => {
		const { sqlite, store } = fixture();
		try {
			await store.request(command);
			expect((): void => {
				sqlite.prepare('UPDATE pdf_seal_request_command SET request_hash = ?').run('7'.repeat(64));
			}).toThrow(/immutable/);
			expect((): void => {
				sqlite.prepare('DELETE FROM pdf_seal_request_command').run();
			}).toThrow(/immutable/);
		} finally {
			sqlite.close();
		}
	});
});

function insertPublication(sqlite: DatabaseSync): void {
	sqlite
		.prepare(
			`INSERT INTO pdf_seal_publication (
				job_id, envelope_id, operation_id, validation_id, source_object_key, source_sha256,
				source_byte_size, requested_profile, signer_certificate_sha256, seal_policy_id,
				validation_policy_id, tsa_policy_id, tsa_trust_bundle_sha256, provider_receipt_id,
				sealed_object_key, sealed_sha256, sealed_byte_size, achieved_profile,
				validator_receipt_id, validation_checks_json, validation_report_object_key,
				validation_report_sha256, validation_report_byte_size, validated_at, published_at,
				anchor_audit_event_id, audit_head_sequence, audit_head_event_hash, audit_event_id
			) VALUES (?, ?, ?, ?, ?, ?, 1024, 'pades-b-b', ?, ?, ?, NULL, NULL, 'provider-1',
				'sealed.pdf', ?, 2048, 'pades-b-b', 'validator-1', '{}', 'report.json', ?, 100,
				?, ?, ?, 2, ?, ?)`
		)
		.run(
			JOB_ID,
			ENVELOPE_ID,
			command.operationId,
			command.validationId,
			SOURCE_KEY,
			SOURCE_SHA,
			command.signerCertificateSha256,
			command.sealPolicyId,
			command.validationPolicyId,
			'5'.repeat(64),
			'6'.repeat(64),
			'2026-09-23T00:06:00.000Z',
			'2026-09-23T00:07:00.000Z',
			'019a0000-0000-7000-8000-000000000011',
			'8'.repeat(64),
			'019a0000-0000-7000-8000-000000000021'
		);
}
