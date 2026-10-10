import { describe, expect, it } from 'vitest';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import type { PdfSealPublicationStore } from '$lib/ports/pdf-seal-publication-store';
import type { PdfSealRequestStore } from '$lib/ports/pdf-seal-request-store';
import {
	PdfSealDownloadError,
	PdfSealDownloadService,
	pdfSealDownloadFailureLog
} from './pdf-seal-download';
import { pdfSealSealedObjectKey } from './pdf-seal-service';
import { sha256Hex } from '$lib/application/completion-artifacts/completion-manifest';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const JOB_ID: string = '01900000-0000-7000-8000-000000000002';
const BYTES: Uint8Array<ArrayBuffer> = new TextEncoder().encode('%PDF-1.7\nsealed');

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller): void {
			controller.enqueue(bytes);
			controller.close();
		}
	});
}

async function fixture(overrides?: {
	publication?: Awaited<ReturnType<PdfSealPublicationStore['readPdfSealPublicationByEnvelope']>>;
	status?: Awaited<ReturnType<PdfSealRequestStore['findStatus']>>;
	metadata?: ObjectMetadata | null;
	objectBytes?: Uint8Array<ArrayBuffer> | null;
}): Promise<PdfSealDownloadService> {
	const digest: string = await sha256Hex(BYTES);
	const key: string = pdfSealSealedObjectKey(ENVELOPE_ID, digest);
	const publication =
		overrides !== undefined && 'publication' in overrides
			? overrides.publication
			: {
					jobId: JOB_ID,
					envelopeId: ENVELOPE_ID,
					operationId: '01900000-0000-7000-8000-000000000003',
					validationId: '01900000-0000-7000-8000-000000000004',
					sourceObjectKey: 'completion.pdf',
					sourceSha256: 'a'.repeat(64),
					sourceByteSize: 10,
					requestedProfile: 'pades-b-b' as const,
					signerCertificateSha256: 'b'.repeat(64),
					sealPolicyId: 'seal-v1',
					validationPolicyId: 'validation-v1',
					tsaPolicyId: null,
					tsaTrustBundleSha256: null,
					providerReceiptId: 'provider-receipt',
					sealedArtifact: {
						objectKey: key,
						sha256: digest,
						byteSize: BYTES.byteLength,
						achievedProfile: 'pades-b-b' as const
					},
					validationEvidence: {
						validatorReceiptId: 'validator-receipt',
						checks: {
							sourcePrefixExact: true,
							incrementalUpdateValid: true,
							byteRangeComplete: true,
							cmsSignatureValid: true,
							cmsSubFilter: 'ETSI.CAdES.detached' as const,
							signerCertificateProtected: true,
							signerCertificateDigestMatches: true,
							certificatePathValid: true,
							sealPolicyValid: true,
							invisibleApprovalSignature: true,
							docMdpAbsent: true,
							noPostSealChanges: true,
							timestamp: null
						},
						reportObjectKey: 'report.json',
						reportSha256: 'c'.repeat(64),
						reportByteSize: 10,
						validatedAt: '2026-09-23T00:00:00.000Z'
					},
					publishedAt: '2026-09-23T00:00:01.000Z',
					auditEventId: '01900000-0000-7000-8000-000000000005',
					auditHeadSequence: 2,
					auditHeadEventHash: 'd'.repeat(64)
				};
	const requests: PdfSealRequestStore = {
		request: async () => ({ outcome: 'not_found' }),
		findStatus: async () => overrides?.status ?? { status: 'not_requested', sourceAvailable: true }
	};
	const publications = {
		readPdfSealPublicationByEnvelope: async () => publication
	} as unknown as PdfSealPublicationStore;
	const metadata: ObjectMetadata | null =
		overrides?.metadata !== undefined
			? overrides.metadata
			: {
					key,
					contentType: 'application/pdf',
					size: BYTES.byteLength,
					sha256: digest,
					version: '1'
				};
	const objectBytes: Uint8Array<ArrayBuffer> | null =
		overrides?.objectBytes !== undefined ? overrides.objectBytes : BYTES;
	const objects: ObjectStore = {
		head: async () => metadata,
		get: async () => (objectBytes === null ? null : stream(objectBytes)),
		putImmutable: async () => {
			throw new Error('not used');
		},
		delete: async () => undefined,
		list: async () => ({ objects: [], truncated: false }),
		deleteMany: async () => undefined
	};
	return new PdfSealDownloadService(requests, publications, objects);
}

describe('PdfSealDownloadService', () => {
	it('returns exact published bytes and public evidence', async () => {
		const result = await (await fixture()).read(ENVELOPE_ID);
		expect(result).toMatchObject({
			outcome: 'available',
			pdf: { byteSize: BYTES.byteLength, achievedProfile: 'pades-b-b' }
		});
		if (result.outcome === 'available') expect(result.pdf.bytes).toEqual(BYTES);
	});

	it('distinguishes an unknown envelope from an unpublished seal', async () => {
		expect(
			await (
				await fixture({ publication: null, status: { status: 'not_found' } })
			).read(ENVELOPE_ID)
		).toEqual({ outcome: 'not_found' });
		expect(await (await fixture({ publication: null })).read(ENVELOPE_ID)).toEqual({
			outcome: 'not_published'
		});
	});

	it('fails closed when object metadata or bytes drift', async () => {
		await expect((await fixture({ metadata: null })).read(ENVELOPE_ID)).rejects.toMatchObject({
			code: 'pdf_seal_object_missing'
		});
		const digest: string = await sha256Hex(BYTES);
		await expect(
			(
				await fixture({
					metadata: {
						key: pdfSealSealedObjectKey(ENVELOPE_ID, digest),
						contentType: 'application/octet-stream',
						size: BYTES.byteLength,
						sha256: digest,
						version: '1'
					}
				})
			).read(ENVELOPE_ID)
		).rejects.toMatchObject({ code: 'pdf_seal_object_mismatch' });
		await expect(
			(await fixture({ objectBytes: new TextEncoder().encode('%PDF-tampered') })).read(ENVELOPE_ID)
		).rejects.toMatchObject({ code: 'pdf_seal_object_mismatch' });
	});

	it('logs only stable error classification', () => {
		expect(pdfSealDownloadFailureLog(new PdfSealDownloadError('pdf_seal_object_missing'))).toEqual({
			errorName: 'PdfSealDownloadError',
			code: 'pdf_seal_object_missing'
		});
	});
});
