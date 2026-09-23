import { describe, expect, it, vi } from 'vitest';
import type {
	PdfSealRequestStore,
	PublicPdfSealStoreStatus,
	RequestPdfSealCommand,
	RequestPdfSealResult
} from '$lib/ports/pdf-seal-request-store';
import { PdfSealApiApplication } from './pdf-seal-api';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const IDS: readonly string[] = [
	'01900000-0000-7000-8000-000000000002',
	'01900000-0000-7000-8000-000000000003',
	'01900000-0000-7000-8000-000000000004'
];

function store(
	requestResult: RequestPdfSealResult,
	status: PublicPdfSealStoreStatus = { status: 'not_requested', sourceAvailable: true }
): PdfSealRequestStore & { request: ReturnType<typeof vi.fn> } {
	return {
		request: vi.fn(async () => requestResult),
		findStatus: vi.fn(async () => status)
	};
}

function application(requestStore: PdfSealRequestStore): PdfSealApiApplication {
	let index: number = 0;
	return new PdfSealApiApplication(
		requestStore,
		() => new Date('2026-09-23T00:00:00.000Z'),
		() => IDS[index++] ?? IDS[IDS.length - 1]!
	);
}

const policy = {
	requestedProfile: 'pades-b-b' as const,
	signerCertificateSha256: 'a'.repeat(64),
	sealPolicyId: 'seal-policy-v1',
	validationPolicyId: 'validation-policy-v1',
	tsaPolicyId: null,
	tsaTrustBundleSha256: null
};

describe('PDF seal API application', () => {
	it('freezes generated identifiers, provenance, policy, and request fingerprint', async () => {
		const requestStore = store({
			outcome: 'requested',
			job: {
				jobId: IDS[0]!,
				envelopeId: ENVELOPE_ID,
				requestedProfile: 'pades-b-b',
				requestedAt: '2026-09-23T00:00:00.000Z'
			}
		});
		const result = await application(requestStore).request(
			{ id: 'api-key-1', createdByUserId: 'user-1', actorType: 'agent' },
			ENVELOPE_ID,
			{ idempotencyKey: 'seal-1', requestedProfile: 'pades-b-b', policy }
		);
		expect(result.outcome).toBe('requested');
		expect(requestStore.request).toHaveBeenCalledWith(
			expect.objectContaining({
				actor: { type: 'agent', id: 'api-key-1' },
				idempotencyKey: 'seal-1',
				envelopeId: ENVELOPE_ID,
				jobId: IDS[0],
				operationId: IDS[1],
				validationId: IDS[2],
				requestedAt: '2026-09-23T00:00:00.000Z',
				...policy
			})
		);
		const command: RequestPdfSealCommand = requestStore.request.mock.calls[0]?.[0];
		expect(command.requestHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('maps an envelope singleton collision to an existing safe request', async () => {
		const job = {
			jobId: IDS[0]!,
			envelopeId: ENVELOPE_ID,
			requestedProfile: 'pades-b-b' as const,
			requestedAt: '2026-09-23T00:00:00.000Z'
		};
		const result = await application(store({ outcome: 'existing_envelope', job })).request(
			{ id: 'user-1', createdByUserId: 'user-1' },
			ENVELOPE_ID,
			{ idempotencyKey: 'seal-2', requestedProfile: 'pades-b-b', policy }
		);
		expect(result).toEqual({ outcome: 'existing', request: job });
	});

	it('projects disabled only when no durable request exists', async () => {
		const noRequest = application(
			store({ outcome: 'not_found' }, { status: 'not_requested', sourceAvailable: true })
		);
		expect(await noRequest.findStatus(ENVELOPE_ID, false)).toEqual({
			envelopeId: ENVELOPE_ID,
			status: 'disabled'
		});

		const pending = application(
			store(
				{ outcome: 'not_found' },
				{
					status: 'pending',
					job: {
						jobId: IDS[0]!,
						envelopeId: ENVELOPE_ID,
						requestedProfile: 'pades-b-b',
						requestedAt: '2026-09-23T00:00:00.000Z'
					},
					attempts: 0
				}
			)
		);
		expect(await pending.findStatus(ENVELOPE_ID, false)).toMatchObject({ status: 'pending' });
	});

	it('returns only safe publication evidence after current seal configuration is removed', async () => {
		const published = application(
			store(
				{ outcome: 'not_found' },
				{
					status: 'published',
					job: {
						jobId: IDS[0]!,
						envelopeId: ENVELOPE_ID,
						requestedProfile: 'pades-b-b',
						requestedAt: '2026-09-23T00:00:00.000Z'
					},
					achievedProfile: 'pades-b-b',
					signerCertificateSha256: 'a'.repeat(64),
					sealedSha256: 'b'.repeat(64),
					sealedByteSize: 4096,
					validationReportSha256: 'c'.repeat(64),
					validatedAt: '2026-09-23T00:01:00.000Z',
					publishedAt: '2026-09-23T00:02:00.000Z'
				}
			)
		);
		const serialized: string = JSON.stringify(await published.findStatus(ENVELOPE_ID, false));
		expect(serialized).toContain('b'.repeat(64));
		expect(serialized).not.toMatch(/objectKey|receipt|audit|claimToken|provider/i);
	});
});
