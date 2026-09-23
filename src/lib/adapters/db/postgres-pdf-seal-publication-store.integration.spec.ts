import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresPdfSealPublicationStore } from './postgres-pdf-seal-publication-store';
import type { PublishPdfSealCommand } from '$lib/ports/pdf-seal-publication-store';
import type { PdfSealValidationChecks } from '$lib/ports/pdf-seal-validator';

const DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const postgresDescribe = DATABASE_URL === undefined ? describe.skip : describe;
const SCHEMA: string = `signkit_pdf_seal_pub_${randomUUID().replaceAll('-', '')}`;
const ENVELOPE_ID: string = '019a0000-0000-7000-8000-000000000101';
const JOB_ID: string = '019a0000-0000-7000-8000-000000000102';
const OPERATION_ID: string = '019a0000-0000-7000-8000-000000000103';
const VALIDATION_ID: string = '019a0000-0000-7000-8000-000000000104';
const SOURCE_KEY: string = 'completion-artifacts/postgres-source.pdf';
const SOURCE_SHA: string = 'a'.repeat(64);
const SEALED_SHA: string = 'b'.repeat(64);
const ANCHOR_EVENT_ID: string = '019a0000-0000-7000-8000-000000000111';
const ANCHOR_HASH: string = 'e'.repeat(64);
const AUDIT_EVENT_ID: string = '019a0000-0000-7000-8000-000000000121';
const AUDIT_EVENT_HASH: string = 'f'.repeat(64);
let sql: ReturnType<typeof postgres> | null = null;

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

postgresDescribe('PostgresPdfSealPublicationStore integration', () => {
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
				'2026-09-23T00:02:00.000Z', '019a0000-0000-7000-8000-000000000112'
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
	});

	afterAll(async () => {
		if (sql === null) return;
		await sql.unsafe('SET search_path TO public');
		await sql.unsafe(`DROP SCHEMA "${SCHEMA}" CASCADE`);
		await sql.end({ timeout: 5 });
		sql = null;
	});

	it('publishes atomically, appends the chained audit event, and leaves the job untouched', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const store = new PostgresPdfSealPublicationStore(sql);

		const published = await store.publishPdfSeal(command());
		expect(published).toMatchObject({
			outcome: 'published',
			result: { jobId: JOB_ID, envelopeId: ENVELOPE_ID, sealedSha256: SEALED_SHA }
		});
		if (published.outcome !== 'published') throw new Error('Expected a fresh publication');

		const auditRows = await sql<
			{
				sequence: number | string;
				previousHash: string;
				eventHash: string;
				actorType: string;
				hashVersion: number | string;
			}[]
		>`SELECT sequence, previous_hash AS "previousHash", event_hash AS "eventHash",
				actor_type AS "actorType", hash_version AS "hashVersion"
			FROM audit_event WHERE event_type = 'envelope.pdf_seal_published'`;
		expect(
			auditRows.map((row) => ({
				...row,
				sequence: Number(row.sequence),
				hashVersion: Number(row.hashVersion)
			}))
		).toEqual([
			{
				sequence: 2,
				previousHash: ANCHOR_HASH,
				eventHash: AUDIT_EVENT_HASH,
				actorType: 'system',
				hashVersion: 3
			}
		]);

		const jobRows = await sql<
			{ status: string; nextAction: string }[]
		>`SELECT status, next_action AS "nextAction" FROM pdf_seal_job WHERE id = ${JOB_ID}`;
		expect(jobRows).toEqual([{ status: 'publication_ready', nextAction: 'publish' }]);

		const read = await store.readPdfSealPublicationByEnvelope(ENVELOPE_ID);
		expect(read).toMatchObject({ jobId: JOB_ID, providerReceiptId: 'provider-receipt-1' });

		const replay = await store.publishPdfSeal(command());
		expect(replay).toEqual({ outcome: 'replayed', result: published.result });

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

		const discovered = await store.discoverPdfSealPublicationCandidates({ limit: 10 });
		expect(discovered).toEqual([]);

		await expect(
			sql`UPDATE pdf_seal_publication SET provider_receipt_id = 'forged' WHERE job_id = ${JOB_ID}`
		).rejects.toThrow(/immutable/);
		await expect(
			sql`DELETE FROM pdf_seal_publish_command WHERE job_id = ${JOB_ID}`
		).rejects.toThrow(/immutable/);
	});
});
