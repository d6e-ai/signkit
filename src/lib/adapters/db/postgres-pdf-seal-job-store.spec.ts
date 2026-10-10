import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { PostgresPdfSealJobStore } from './postgres-pdf-seal-job-store';
import type { EnqueuePdfSealJobCommand } from '$lib/ports/pdf-seal-job-store';

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
		return (async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
			target.push({ text: strings.join('?').replaceAll(/\s+/g, ' ').trim(), values });
			const result: ScriptedResult | undefined = this.#results.shift();
			if (result === undefined)
				throw new Error(`Unexpected PostgreSQL query: ${target.at(-1)?.text}`);
			if (result instanceof Error) throw result;
			return result;
		}) as ReturnType<typeof postgres>;
	}
}

const command: EnqueuePdfSealJobCommand = {
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
	createdAt: '2026-09-23T00:00:00.000Z'
};

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: command.jobId,
		envelope_id: command.envelopeId,
		operation_id: command.operationId,
		validation_id: command.validationId,
		status: 'pending',
		next_action: 'submit',
		attempt_sequence: 0,
		retry_failures: 0,
		available_at: new Date(command.createdAt),
		locked_at: null,
		retryable: null,
		last_error_code: null,
		source_object_key: command.sourceObjectKey,
		source_sha256: command.sourceSha256,
		source_byte_size: command.sourceByteSize,
		requested_profile: command.requestedProfile,
		signer_certificate_sha256: command.signerCertificateSha256,
		seal_policy_id: command.sealPolicyId,
		validation_policy_id: command.validationPolicyId,
		tsa_policy_id: null,
		tsa_trust_bundle_sha256: null,
		provider_receipt_id: null,
		sealed_object_key: null,
		sealed_sha256: null,
		sealed_byte_size: null,
		achieved_profile: null,
		validator_receipt_id: null,
		validation_checks_json: null,
		validation_report_object_key: null,
		validation_report_sha256: null,
		validation_report_byte_size: null,
		validated_at: null,
		created_at: new Date(command.createdAt),
		updated_at: new Date(command.createdAt),
		ready_at: null,
		failed_at: null,
		...overrides
	};
}

describe('PostgresPdfSealJobStore', () => {
	it('enqueues only by selecting the exact immutable completion PDF', async () => {
		const scripted = new ScriptedPostgres([[row()]]);
		const store = new PostgresPdfSealJobStore(scripted.client());
		await expect(store.enqueue(command)).resolves.toMatchObject({
			outcome: 'enqueued',
			job: { jobId: command.jobId, nextAction: 'submit', sourceSha256: command.sourceSha256 }
		});
		expect(scripted.directQueries[0]?.text).toContain('FROM completion_artifact_pdf AS pdf');
		expect(scripted.directQueries[0]?.text).toContain('pdf.pdf_object_key = ?');
		expect(scripted.directQueries[0]?.text).toContain('pdf.pdf_sha256 = ?');
		expect(scripted.directQueries[0]?.text).toContain('pdf.pdf_byte_size = ?');
		expect(scripted.directQueries[0]?.text).toContain('ON CONFLICT DO NOTHING');
	});

	it('claims due jobs with a bounded lease under FOR UPDATE SKIP LOCKED', async () => {
		const scripted = new ScriptedPostgres([
			[
				row({
					status: 'processing',
					attempt_sequence: 1,
					retry_failures: 0,
					locked_at: new Date('2026-09-23T00:01:00.000Z')
				})
			]
		]);
		const store = new PostgresPdfSealJobStore(scripted.client());
		const claimed = await store.claim({
			claimToken: 'lease-1',
			claimedAt: '2026-09-23T00:01:00.000Z',
			staleBefore: '2026-09-22T23:56:00.000Z',
			limit: 100
		});
		expect(claimed).toHaveLength(1);
		expect(claimed[0]?.job.attemptSequence).toBe(1);
		expect(scripted.beginCalls).toBe(1);
		expect(scripted.transactionQueries[0]?.text).toContain('LIMIT ? FOR UPDATE SKIP LOCKED');
		expect(scripted.transactionQueries[0]?.values).toContain(10);
	});

	it('checkpoints a lease and its immutable attempt in one transaction', async () => {
		const scripted = new ScriptedPostgres([
			[
				{
					id: command.jobId,
					nextAction: 'submit',
					attemptSequence: 1,
					retryFailures: 0,
					lockedAt: new Date('2026-09-23T00:01:00.000Z'),
					sourceByteSize: 1024,
					requestedProfile: 'pades-b-b',
					providerReceiptId: null,
					sealedObjectKey: null,
					sealedSha256: null,
					sealedByteSize: null,
					achievedProfile: null
				}
			],
			[],
			[]
		]);
		const store = new PostgresPdfSealJobStore(scripted.client());
		await expect(
			store.checkpoint({
				kind: 'ambiguous_submit',
				jobId: command.jobId,
				claimToken: 'lease-1',
				attemptId: '019a0000-0000-7000-8000-000000000005',
				attemptNumber: 1,
				startedAt: '2026-09-23T00:01:00.000Z',
				finishedAt: '2026-09-23T00:01:01.000Z'
			})
		).resolves.toBe(true);
		expect(scripted.transactionQueries).toHaveLength(3);
		expect(scripted.transactionQueries[0]?.text).toContain('FOR UPDATE');
		expect(scripted.transactionQueries[0]?.text).toContain('locked_at = ?::timestamptz');
		expect(scripted.transactionQueries[0]?.values).toContain('2026-09-23T00:01:00.000Z');
		expect(scripted.transactionQueries[1]?.text).toContain("next_action = 'recover_submit'");
		expect(scripted.transactionQueries[2]?.text).toContain('INSERT INTO pdf_seal_attempt');
		expect(scripted.transactionQueries[2]?.values).toContainEqual(
			new Date('2026-09-23T00:01:00.000Z')
		);
	});

	it('does not mutate when the lease CAS no longer matches', async () => {
		const scripted = new ScriptedPostgres([[]]);
		const store = new PostgresPdfSealJobStore(scripted.client());
		await expect(
			store.checkpoint({
				kind: 'ambiguous_submit',
				jobId: command.jobId,
				claimToken: 'stale-lease',
				attemptId: '019a0000-0000-7000-8000-000000000005',
				attemptNumber: 1,
				startedAt: '2026-09-23T00:01:00.000Z',
				finishedAt: '2026-09-23T00:01:01.000Z'
			})
		).resolves.toBe(false);
		expect(scripted.transactionQueries).toHaveLength(1);
	});
});
