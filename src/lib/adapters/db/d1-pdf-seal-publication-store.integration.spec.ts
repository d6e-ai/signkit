import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1PdfSealPublicationStore } from './d1-pdf-seal-publication-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';
import type { PublishPdfSealCommand } from '$lib/ports/pdf-seal-publication-store';
import type { PdfSealValidationChecks } from '$lib/ports/pdf-seal-validator';

const ENVELOPE_ID: string = '019a0000-0000-7000-8000-000000000001';
const JOB_ID: string = '019a0000-0000-7000-8000-000000000002';
const OPERATION_ID: string = '019a0000-0000-7000-8000-000000000003';
const VALIDATION_ID: string = '019a0000-0000-7000-8000-000000000004';
const SOURCE_KEY: string = 'completion-artifacts/source.pdf';
const SOURCE_SHA: string = 'a'.repeat(64);
const SEALED_SHA: string = 'b'.repeat(64);
const ANCHOR_EVENT_ID: string = '019a0000-0000-7000-8000-000000000011';
const ANCHOR_HASH: string = 'e'.repeat(64);
const AUDIT_EVENT_ID: string = '019a0000-0000-7000-8000-000000000021';
const AUDIT_EVENT_HASH: string = 'f'.repeat(64);

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

function fixture(): { sqlite: DatabaseSync; store: D1PdfSealPublicationStore } {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
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
			'${ANCHOR_EVENT_ID}', '${ENVELOPE_ID}', 1,
			'envelope.completed', 'system', 'system', '{}', '${'0'.repeat(64)}', '${ANCHOR_HASH}',
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
			'${ANCHOR_EVENT_ID}', 1, '${ANCHOR_HASH}',
			'2026-09-23T00:02:00.000Z', '019a0000-0000-7000-8000-000000000012'
		);
		INSERT INTO completion_artifact_pdf (
			envelope_id, pdf_object_key, pdf_sha256, pdf_manifest_object_key,
			pdf_manifest_sha256, pdf_byte_size, published_at
		) VALUES (
			'${ENVELOPE_ID}', '${SOURCE_KEY}', '${SOURCE_SHA}', 'manifest.json.gz',
			'${'9'.repeat(64)}', 1024, '2026-09-23T00:03:00.000Z'
		);
		INSERT INTO pdf_seal_job (
			id, envelope_id, operation_id, validation_id, status, next_action,
			attempt_sequence, retry_failures, available_at,
			source_object_key, source_sha256, source_byte_size, requested_profile,
			signer_certificate_sha256, seal_policy_id, validation_policy_id,
			tsa_policy_id, tsa_trust_bundle_sha256, provider_receipt_id,
			sealed_object_key, sealed_sha256, sealed_byte_size, achieved_profile,
			validator_receipt_id, validation_checks_json, validation_report_object_key,
			validation_report_sha256, validation_report_byte_size, validated_at,
			created_at, updated_at, ready_at
		) VALUES (
			'${JOB_ID}', '${ENVELOPE_ID}', '${OPERATION_ID}', '${VALIDATION_ID}',
			'publication_ready', 'publish', 4, 0, '2026-09-23T00:05:31.000Z',
			'${SOURCE_KEY}', '${SOURCE_SHA}', 1024, 'pades-b-b',
			'${'8'.repeat(64)}', 'seal-policy-v1', 'validation-policy-v1',
			NULL, NULL, 'provider-receipt-1',
			'pdf-seals/sealed.pdf', '${SEALED_SHA}', 2048, 'pades-b-b',
			'validator-receipt-1', '${JSON.stringify(checks).replaceAll("'", "''")}',
			'pdf-seals/reports/report.json', '${'c'.repeat(64)}', 2048, '2026-09-23T00:05:30.000Z',
			'2026-09-23T00:04:00.000Z', '2026-09-23T00:05:31.000Z', '2026-09-23T00:05:31.000Z'
		);
	`);
	return { sqlite, store: new D1PdfSealPublicationStore(sqliteD1Database(sqlite)) };
}

function command(overrides: Partial<PublishPdfSealCommand> = {}): PublishPdfSealCommand {
	return {
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
		providerReceiptId: 'provider-receipt-1',
		sealedArtifact: {
			objectKey: 'pdf-seals/sealed.pdf',
			sha256: SEALED_SHA,
			byteSize: 2048,
			achievedProfile: 'pades-b-b'
		},
		validationEvidence: {
			validatorReceiptId: 'validator-receipt-1',
			checks,
			reportObjectKey: 'pdf-seals/reports/report.json',
			reportSha256: 'c'.repeat(64),
			reportByteSize: 2048,
			validatedAt: '2026-09-23T00:05:30.000Z'
		},
		publishedAt: '2026-09-23T00:06:00.000Z',
		anchorAuditEventId: ANCHOR_EVENT_ID,
		expectedAuditSequence: 1,
		previousAuditHash: ANCHOR_HASH,
		auditEventId: AUDIT_EVENT_ID,
		auditEventHash: AUDIT_EVENT_HASH,
		auditPayloadJson: '{"sealedSha256":"' + SEALED_SHA + '"}',
		...overrides
	};
}

describe('D1PdfSealPublicationStore integration', () => {
	it('publishes atomically, appends the chained audit event, and leaves the job untouched', async () => {
		const { sqlite, store } = fixture();
		try {
			const result = await store.publishPdfSeal(command());
			expect(result).toMatchObject({
				outcome: 'published',
				result: { jobId: JOB_ID, envelopeId: ENVELOPE_ID, sealedSha256: SEALED_SHA }
			});

			const publication = sqlite
				.prepare('SELECT job_id, envelope_id, audit_event_id FROM pdf_seal_publication')
				.get();
			expect(publication).toEqual({
				job_id: JOB_ID,
				envelope_id: ENVELOPE_ID,
				audit_event_id: AUDIT_EVENT_ID
			});

			const auditRow = sqlite
				.prepare(
					"SELECT sequence, previous_hash, event_hash, actor_type FROM audit_event WHERE event_type = 'envelope.pdf_seal_published'"
				)
				.get();
			expect(auditRow).toEqual({
				sequence: 2,
				previous_hash: ANCHOR_HASH,
				event_hash: AUDIT_EVENT_HASH,
				actor_type: 'system'
			});

			const job = sqlite
				.prepare('SELECT status, next_action FROM pdf_seal_job WHERE id = ?')
				.get(JOB_ID);
			expect(job).toEqual({ status: 'publication_ready', next_action: 'publish' });

			const read = await store.readPdfSealPublicationByEnvelope(ENVELOPE_ID);
			expect(read).toMatchObject({ jobId: JOB_ID, providerReceiptId: 'provider-receipt-1' });
		} finally {
			sqlite.close();
		}
	});

	it('replays an identical retry exactly and rejects a changed retry as an integrity conflict', async () => {
		const { sqlite, store } = fixture();
		try {
			const first = await store.publishPdfSeal(command());
			expect(first.outcome).toBe('published');

			const replay = await store.publishPdfSeal(command());
			expect(replay).toEqual({
				outcome: 'replayed',
				result: (first as { result: unknown }).result
			});

			const changed = await store.publishPdfSeal(
				command({
					sealedArtifact: {
						objectKey: 'pdf-seals/sealed.pdf',
						sha256: 'd'.repeat(64),
						byteSize: 2048,
						achievedProfile: 'pades-b-b'
					}
				})
			);
			expect(changed).toEqual({ outcome: 'integrity_error' });

			const publicationCount = sqlite
				.prepare('SELECT COUNT(*) AS count FROM pdf_seal_publication')
				.get() as { count: number };
			expect(publicationCount.count).toBe(1);
		} finally {
			sqlite.close();
		}
	});

	it('reports stale when the job no longer matches the frozen tuple, without mutating state', async () => {
		const { sqlite, store } = fixture();
		try {
			const result = await store.publishPdfSeal(command({ sourceObjectKey: 'other/source.pdf' }));
			expect(result).toEqual({ outcome: 'stale' });
			const counts = sqlite
				.prepare(
					'SELECT (SELECT COUNT(*) FROM pdf_seal_publication) AS publications, (SELECT COUNT(*) FROM pdf_seal_publish_command) AS commands'
				)
				.get() as { publications: number; commands: number };
			expect(counts).toEqual({ publications: 0, commands: 0 });
		} finally {
			sqlite.close();
		}
	});

	it('reports an integrity conflict and leaves no orphan rows when the envelope is no longer completed', async () => {
		const { sqlite, store } = fixture();
		try {
			sqlite.prepare("UPDATE envelope SET status = 'voided' WHERE id = ?").run(ENVELOPE_ID);
			const result = await store.publishPdfSeal(command());
			expect(result).toEqual({ outcome: 'integrity_error' });
			const counts = sqlite
				.prepare(
					'SELECT (SELECT COUNT(*) FROM pdf_seal_publication) AS publications, (SELECT COUNT(*) FROM pdf_seal_publish_command) AS commands, (SELECT COUNT(*) FROM audit_event) AS events'
				)
				.get() as { publications: number; commands: number; events: number };
			expect(counts).toEqual({ publications: 0, commands: 0, events: 1 });
		} finally {
			sqlite.close();
		}
	});

	it('reports an integrity conflict when the source completion_artifact_pdf row no longer matches', async () => {
		const { sqlite, store } = fixture();
		try {
			sqlite
				.prepare('UPDATE completion_artifact_pdf SET pdf_sha256 = ? WHERE envelope_id = ?')
				.run('7'.repeat(64), ENVELOPE_ID);
			const result = await store.publishPdfSeal(command());
			expect(result).toEqual({ outcome: 'integrity_error' });
		} finally {
			sqlite.close();
		}
	});

	it('reports an integrity conflict when the supplied audit anchor is no longer the head', async () => {
		const { sqlite, store } = fixture();
		try {
			sqlite
				.prepare(
					`INSERT INTO audit_event (
						id, envelope_id, sequence, event_type, actor_type, actor_id, payload_json,
						previous_hash, event_hash, occurred_at
					) VALUES (?, ?, 2, 'recipient.capability_reissued', 'system', 'system', '{}', ?, ?, ?)`
				)
				.run(
					'019a0000-0000-7000-8000-000000000031',
					ENVELOPE_ID,
					ANCHOR_HASH,
					'1'.repeat(64),
					'2026-09-23T00:05:45.000Z'
				);
			const result = await store.publishPdfSeal(command());
			expect(result).toEqual({ outcome: 'integrity_error' });
			const publicationCount = sqlite
				.prepare('SELECT COUNT(*) AS count FROM pdf_seal_publication')
				.get() as { count: number };
			expect(publicationCount.count).toBe(0);
		} finally {
			sqlite.close();
		}
	});

	it('resolves concurrent publish attempts to exactly one published row and one replay', async () => {
		const { sqlite, store } = fixture();
		try {
			const [first, second] = await Promise.all([
				store.publishPdfSeal(command()),
				store.publishPdfSeal(command())
			]);
			const outcomes: readonly string[] = [first.outcome, second.outcome].sort();
			expect(outcomes).toEqual(['published', 'replayed']);
			const publicationCount = sqlite
				.prepare('SELECT COUNT(*) AS count FROM pdf_seal_publication')
				.get() as { count: number };
			expect(publicationCount.count).toBe(1);
		} finally {
			sqlite.close();
		}
	});

	it('excludes an envelope that already has a publication row from discovery', async () => {
		const { sqlite, store } = fixture();
		try {
			await expect(store.discoverPdfSealPublicationCandidates({ limit: 10 })).resolves.toEqual([
				{ jobId: JOB_ID, envelopeId: ENVELOPE_ID }
			]);
			await store.publishPdfSeal(command());
			await expect(store.discoverPdfSealPublicationCandidates({ limit: 10 })).resolves.toEqual([]);
		} finally {
			sqlite.close();
		}
	});

	it('keeps publication rows and replay receipts immutable', async () => {
		const { sqlite, store } = fixture();
		try {
			await store.publishPdfSeal(command());
			expect(() =>
				sqlite
					.prepare('UPDATE pdf_seal_publication SET provider_receipt_id = ? WHERE job_id = ?')
					.run('forged-receipt', JOB_ID)
			).toThrow(/immutable/);
			expect(() =>
				sqlite.prepare('DELETE FROM pdf_seal_publish_command WHERE job_id = ?').run(JOB_ID)
			).toThrow(/immutable/);
		} finally {
			sqlite.close();
		}
	});
});
