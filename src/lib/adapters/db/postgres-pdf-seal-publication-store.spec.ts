import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { PostgresPdfSealPublicationStore } from './postgres-pdf-seal-publication-store';
import type { PublishPdfSealCommand } from '$lib/ports/pdf-seal-publication-store';
import type { PdfSealValidationChecks } from '$lib/ports/pdf-seal-validator';

interface RecordedQuery {
	text: string;
	values: readonly unknown[];
}

type ScriptedResult = readonly object[] | Error;

class ScriptedPostgres {
	readonly directQueries: RecordedQuery[] = [];
	readonly transactionQueries: RecordedQuery[] = [];
	beginCalls: number = 0;
	readonly #results: ScriptedResult[];

	constructor(results: readonly ScriptedResult[]) {
		this.#results = results.map((result: ScriptedResult): ScriptedResult =>
			result instanceof Error ? result : [...result]
		);
	}

	client(): ReturnType<typeof postgres> {
		const direct: ReturnType<typeof postgres> = this.#tag(this.directQueries);
		Object.assign(direct, {
			begin: async <T>(callback: (sql: postgres.TransactionSql) => Promise<T>): Promise<T> => {
				this.beginCalls += 1;
				return callback(this.#tag(this.transactionQueries) as unknown as postgres.TransactionSql);
			}
		});
		return direct;
	}

	#tag(target: RecordedQuery[]): ReturnType<typeof postgres> {
		const fn = (async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
			target.push({ text: strings.join('?').replaceAll(/\s+/g, ' ').trim(), values });
			const result: ScriptedResult | undefined = this.#results.shift();
			if (result === undefined)
				throw new Error(`Unexpected PostgreSQL query: ${target.at(-1)?.text}`);
			if (result instanceof Error) throw result;
			return result;
		}) as ReturnType<typeof postgres>;
		Object.assign(fn, { unsafe: (text: string): string => text });
		return fn;
	}
}

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

const command: PublishPdfSealCommand = {
	jobId: '019a0000-0000-7000-8000-000000000001',
	envelopeId: '019a0000-0000-7000-8000-000000000002',
	operationId: '019a0000-0000-7000-8000-000000000003',
	validationId: '019a0000-0000-7000-8000-000000000004',
	sourceObjectKey: 'completion/source.pdf',
	sourceSha256: 'a'.repeat(64),
	sourceByteSize: 1024,
	requestedProfile: 'pades-b-b',
	signerCertificateSha256: 'b'.repeat(64),
	sealPolicyId: 'seal-policy-v1',
	validationPolicyId: 'validation-policy-v1',
	tsaPolicyId: null,
	tsaTrustBundleSha256: null,
	providerReceiptId: 'provider-receipt-1',
	sealedArtifact: {
		objectKey: 'pdf-seals/sealed.pdf',
		sha256: 'c'.repeat(64),
		byteSize: 2048,
		achievedProfile: 'pades-b-b'
	},
	validationEvidence: {
		validatorReceiptId: 'validator-receipt-1',
		checks,
		reportObjectKey: 'pdf-seals/reports/report.json',
		reportSha256: 'd'.repeat(64),
		reportByteSize: 2048,
		validatedAt: '2026-09-23T00:05:30.000Z'
	},
	publishedAt: '2026-09-23T00:06:00.000Z',
	anchorAuditEventId: '019a0000-0000-7000-8000-000000000011',
	expectedAuditSequence: 1,
	previousAuditHash: 'e'.repeat(64),
	auditEventId: '019a0000-0000-7000-8000-000000000021',
	auditEventHash: 'f'.repeat(64),
	auditPayloadJson: '{"sealedSha256":"' + 'c'.repeat(64) + '"}'
};

function matchingJobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: command.jobId,
		envelopeId: command.envelopeId,
		operationId: command.operationId,
		validationId: command.validationId,
		status: 'publication_ready',
		nextAction: 'publish',
		sourceObjectKey: command.sourceObjectKey,
		sourceSha256: command.sourceSha256,
		sourceByteSize: command.sourceByteSize,
		requestedProfile: command.requestedProfile,
		signerCertificateSha256: command.signerCertificateSha256,
		sealPolicyId: command.sealPolicyId,
		validationPolicyId: command.validationPolicyId,
		tsaPolicyId: command.tsaPolicyId,
		tsaTrustBundleSha256: command.tsaTrustBundleSha256,
		providerReceiptId: command.providerReceiptId,
		sealedObjectKey: command.sealedArtifact.objectKey,
		sealedSha256: command.sealedArtifact.sha256,
		sealedByteSize: command.sealedArtifact.byteSize,
		achievedProfile: command.sealedArtifact.achievedProfile,
		validatorReceiptId: command.validationEvidence.validatorReceiptId,
		validationChecksJson: JSON.stringify(command.validationEvidence.checks),
		validationReportObjectKey: command.validationEvidence.reportObjectKey,
		validationReportSha256: command.validationEvidence.reportSha256,
		validationReportByteSize: command.validationEvidence.reportByteSize,
		validatedAt: new Date(command.validationEvidence.validatedAt),
		...overrides
	};
}

describe('PostgresPdfSealPublicationStore', () => {
	it('discovers publication_ready jobs lacking a publication row', async () => {
		const scripted = new ScriptedPostgres([
			[{ jobId: command.jobId, envelopeId: command.envelopeId }]
		]);
		const store = new PostgresPdfSealPublicationStore(scripted.client());
		await expect(store.discoverPdfSealPublicationCandidates({ limit: 5 })).resolves.toEqual([
			{ jobId: command.jobId, envelopeId: command.envelopeId }
		]);
		expect(scripted.directQueries[0]?.text).toContain("status = 'publication_ready'");
		expect(scripted.directQueries[0]?.text).toContain('NOT EXISTS');
		expect(scripted.directQueries[0]?.text).toContain('pdf_seal_publication');
	});

	it('locks the envelope before the job and publishes atomically', async () => {
		const scripted = new ScriptedPostgres([
			[{ status: 'completed' }], // envelope lock
			[matchingJobRow()], // job lock
			[], // resolveCommand: no existing command row
			[{ ok: 1 }], // source row matches
			[{ sequence: 1, eventHash: command.previousAuditHash }], // anchor row
			[], // no newer audit rows
			[], // insert publication
			[], // insert audit_event
			[] // insert publish_command
		]);
		const store = new PostgresPdfSealPublicationStore(scripted.client());
		const result = await store.publishPdfSeal(command);
		expect(result).toMatchObject({
			outcome: 'published',
			result: { jobId: command.jobId, envelopeId: command.envelopeId }
		});
		expect(scripted.beginCalls).toBe(1);
		expect(scripted.transactionQueries[0]?.text).toContain('FROM envelope');
		expect(scripted.transactionQueries[0]?.text).toContain('FOR UPDATE');
		expect(scripted.transactionQueries[1]?.text).toContain('FROM pdf_seal_job');
		expect(scripted.transactionQueries[1]?.text).toContain('FOR UPDATE');
		expect(scripted.transactionQueries[6]?.text).toContain('INSERT INTO pdf_seal_publication');
		expect(scripted.transactionQueries[7]?.text).toContain('INSERT INTO audit_event');
		expect(scripted.transactionQueries[8]?.text).toContain('INSERT INTO pdf_seal_publish_command');
	});

	it('reports stale when the locked job no longer matches the frozen tuple', async () => {
		const scripted = new ScriptedPostgres([
			[{ status: 'completed' }], // envelope lock
			[matchingJobRow({ status: 'pending', nextAction: 'submit' })], // job no longer eligible
			[] // resolveCommand: no existing command row
		]);
		const store = new PostgresPdfSealPublicationStore(scripted.client());
		await expect(store.publishPdfSeal(command)).resolves.toEqual({ outcome: 'stale' });
		expect(scripted.transactionQueries).toHaveLength(3);
	});

	it('reports an integrity conflict when the envelope is no longer completed', async () => {
		const scripted = new ScriptedPostgres([
			[{ status: 'voided' }], // envelope lock: no longer completed
			[matchingJobRow()], // job lock matches
			[] // resolveCommand: no existing command row
		]);
		const store = new PostgresPdfSealPublicationStore(scripted.client());
		await expect(store.publishPdfSeal(command)).resolves.toEqual({ outcome: 'integrity_error' });
		expect(scripted.transactionQueries).toHaveLength(3);
	});

	it('replays an identical command without re-evaluating envelope or job state', async () => {
		const commandRow = {
			jobId: command.jobId,
			envelopeId: command.envelopeId,
			operationId: command.operationId,
			validationId: command.validationId,
			sourceObjectKey: command.sourceObjectKey,
			sourceSha256: command.sourceSha256,
			sourceByteSize: command.sourceByteSize,
			requestedProfile: command.requestedProfile,
			signerCertificateSha256: command.signerCertificateSha256,
			sealPolicyId: command.sealPolicyId,
			validationPolicyId: command.validationPolicyId,
			tsaPolicyId: command.tsaPolicyId,
			tsaTrustBundleSha256: command.tsaTrustBundleSha256,
			providerReceiptId: command.providerReceiptId,
			sealedObjectKey: command.sealedArtifact.objectKey,
			sealedSha256: command.sealedArtifact.sha256,
			sealedByteSize: command.sealedArtifact.byteSize,
			achievedProfile: command.sealedArtifact.achievedProfile,
			validatorReceiptId: command.validationEvidence.validatorReceiptId,
			validationChecksJson: JSON.stringify(command.validationEvidence.checks),
			validationReportObjectKey: command.validationEvidence.reportObjectKey,
			validationReportSha256: command.validationEvidence.reportSha256,
			validationReportByteSize: command.validationEvidence.reportByteSize,
			validatedAt: new Date(command.validationEvidence.validatedAt),
			publishedAt: new Date(command.publishedAt),
			anchorAuditEventId: command.anchorAuditEventId,
			auditSequence: command.expectedAuditSequence + 1,
			previousAuditHash: command.previousAuditHash,
			auditEventId: command.auditEventId,
			auditEventHash: command.auditEventHash,
			auditPayloadJson: command.auditPayloadJson
		};
		const scripted = new ScriptedPostgres([
			[{ status: 'completed' }], // envelope lock
			[matchingJobRow()], // job lock
			[commandRow] // resolveCommand: identical existing row
		]);
		const store = new PostgresPdfSealPublicationStore(scripted.client());
		await expect(store.publishPdfSeal(command)).resolves.toMatchObject({
			outcome: 'replayed',
			result: { jobId: command.jobId, envelopeId: command.envelopeId }
		});
		expect(scripted.transactionQueries).toHaveLength(3);
	});
});
