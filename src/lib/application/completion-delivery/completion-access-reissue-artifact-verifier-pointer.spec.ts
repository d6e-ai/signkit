import { describe, expect, it, vi } from 'vitest';
import { completionArtifactObjectKey } from '$lib/application/completion-artifacts/completion-artifact-service';
import { MAX_PUBLISHED_COMPLETION_PDF_BYTES } from '$lib/application/completion-artifacts/completion-pdf-limits';
import { sha256Hex } from '$lib/application/completion-artifacts/completion-manifest';
import type {
	CompletionArtifactStatusRow,
	CompletionArtifactStore
} from '$lib/ports/completion-artifact-store';
import type {
	CompletionArtifactPdfRecord,
	CompletionArtifactPdfStore
} from '$lib/ports/completion-artifact-pdf-store';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import { CompletionAccessReissueArtifactVerifier } from './completion-access-reissue-artifact-verifier';

/**
 * F6 regression coverage: the verifier must enforce that the PDF pointer it
 * reads from is the exact stored `pdf_object_key`, not merely a key the
 * digest alone would canonically resolve to -- `completion_artifact_pdf` has
 * a repair path that can replace that pointer independently of the digest a
 * stale caller observed, and every other PDF-serving reader in this codebase
 * (`CompletionPdfAttachmentReader`, `PublicCompletionArtifactService`,
 * `CompletionEvidenceService.readPdf`) already guards against exactly this.
 * JSON/Markdown have no equivalent stored-key field to diverge from (see the
 * verifier's own doc comment), so their coverage here is the nearest
 * reachable analogue: real bytes at the canonically derived location that no
 * longer match the recorded digest.
 */

const ENVELOPE_ID: string = 'envelope-1';

function mockObjectStore(objects: Map<string, Uint8Array> = new Map()): ObjectStore {
	return {
		head: vi.fn(async (key: string): Promise<ObjectMetadata | null> => {
			const bytes: Uint8Array | undefined = objects.get(key);
			if (bytes === undefined) return null;
			return {
				key,
				contentType: 'application/octet-stream',
				size: bytes.byteLength,
				sha256: await sha256Hex(bytes),
				version: null
			};
		}),
		get: vi.fn(async (key: string): Promise<ReadableStream<Uint8Array> | null> => {
			const bytes = objects.get(key);
			if (bytes === undefined) return null;
			return new ReadableStream<Uint8Array>({
				start(controller): void {
					controller.enqueue(Uint8Array.from(bytes));
					controller.close();
				}
			});
		}),
		putImmutable: vi.fn(async () => {
			throw new Error('unused');
		}),
		delete: vi.fn(async () => {
			throw new Error('unused');
		}),
		list: vi.fn(async () => {
			throw new Error('unused');
		}),
		deleteMany: vi.fn(async () => {
			throw new Error('unused');
		})
	};
}

function artifactStoreFixture(status: CompletionArtifactStatusRow | null): CompletionArtifactStore {
	return {
		claimPendingCompletionArtifacts: vi.fn(),
		readClaimedCompletionArtifact: vi.fn(),
		readCompletionEvidence: vi.fn(),
		publishCompletionArtifact: vi.fn(),
		failCompletionArtifact: vi.fn(),
		requeueExhaustedCompletionArtifact: vi.fn(),
		findCompletionArtifactRetry: vi.fn(),
		findCompletionArtifactStatus: vi.fn(async () => status)
	};
}

function pdfStoreFixture(record: CompletionArtifactPdfRecord | null): CompletionArtifactPdfStore {
	return {
		publishCompletionArtifactPdf: vi.fn(async () => {
			throw new Error('unused');
		}),
		readCompletionArtifactPdf: vi.fn(async () => record)
	};
}

async function seedArtifacts(): Promise<{
	objects: Map<string, Uint8Array>;
	status: CompletionArtifactStatusRow;
	pdfRecord: CompletionArtifactPdfRecord;
}> {
	const jsonBytes: Uint8Array = new TextEncoder().encode('{"gzip":"json"}');
	const markdownBytes: Uint8Array = new TextEncoder().encode('# markdown');
	const pdfBytes: Uint8Array = new TextEncoder().encode('%PDF-1.7 synthetic');
	const jsonSha256: string = await sha256Hex(jsonBytes);
	const markdownSha256: string = await sha256Hex(markdownBytes);
	const pdfSha256: string = await sha256Hex(pdfBytes);
	const objects = new Map<string, Uint8Array>([
		[completionArtifactObjectKey(ENVELOPE_ID, 'json', jsonSha256), jsonBytes],
		[completionArtifactObjectKey(ENVELOPE_ID, 'markdown', markdownSha256), markdownBytes],
		[completionArtifactObjectKey(ENVELOPE_ID, 'pdf', pdfSha256), pdfBytes]
	]);
	return {
		objects,
		status: {
			envelopeId: ENVELOPE_ID,
			envelopeCompleted: true,
			jobStatus: 'published',
			attempts: 0,
			lastError: null,
			availableAt: null,
			updatedAt: null,
			published: {
				envelopeId: ENVELOPE_ID,
				manifestSha256: 'm'.repeat(64),
				jsonSha256,
				markdownSha256,
				publishedAt: '2026-09-11T00:03:00.000Z',
				auditEventId: 'audit-1'
			}
		},
		pdfRecord: {
			envelopeId: ENVELOPE_ID,
			pdfObjectKey: completionArtifactObjectKey(ENVELOPE_ID, 'pdf', pdfSha256),
			pdfSha256,
			pdfByteSize: pdfBytes.byteLength,
			pdfManifestObjectKey: 'completion/pdf-manifest.json.gz',
			pdfManifestSha256: 'b'.repeat(64),
			publishedAt: '2026-09-11T00:03:00.000Z'
		}
	};
}

describe('CompletionAccessReissueArtifactVerifier wrong-pointer regressions', () => {
	it('rejects a PDF record whose stored pointer key does not match its own recorded digest, even though matching bytes exist at the canonical digest key', async () => {
		const { objects, status, pdfRecord } = await seedArtifacts();
		// A real object with the recorded digest sits at the canonical
		// location -- if the verifier only re-derived the key from the digest
		// (the pre-fix behavior), this would wrongly verify.
		const wrongPointer: CompletionArtifactPdfRecord = {
			...pdfRecord,
			pdfObjectKey:
				'completion-artifacts/v1/envelopes/envelope-1/sha256/not-the-recorded-digest.pdf'
		};
		const verifier = new CompletionAccessReissueArtifactVerifier(
			artifactStoreFixture(status),
			pdfStoreFixture(wrongPointer),
			mockObjectStore(objects)
		);
		const result = await verifier.verify(ENVELOPE_ID);
		expect(result.outcome).toBe('integrity_error');
		if (result.outcome !== 'integrity_error') return;
		expect(result.errorCode).toBe('completion_pdf_key_mismatch');
	});

	it('never reads the PDF object at all when the stored PDF pointer key is wrong', async () => {
		const { objects, status, pdfRecord } = await seedArtifacts();
		const wrongPointer: CompletionArtifactPdfRecord = {
			...pdfRecord,
			pdfObjectKey:
				'completion-artifacts/v1/envelopes/envelope-1/sha256/not-the-recorded-digest.pdf'
		};
		const objectStore: ObjectStore = mockObjectStore(objects);
		const verifier = new CompletionAccessReissueArtifactVerifier(
			artifactStoreFixture(status),
			pdfStoreFixture(wrongPointer),
			objectStore
		);
		await verifier.verify(ENVELOPE_ID);
		// The json/markdown legs run first and legitimately call head(); the
		// mismatched PDF pointer must stop the chain before either PDF key --
		// the wrong stored one or the canonical one the real bytes sit at --
		// is ever read.
		const headKeys: string[] = (objectStore.head as ReturnType<typeof vi.fn>).mock.calls.map(
			(call: unknown[]): string => call[0] as string
		);
		expect(headKeys.some((key: string): boolean => key.endsWith('.pdf'))).toBe(false);
		const getKeys: string[] = (objectStore.get as ReturnType<typeof vi.fn>).mock.calls.map(
			(call: unknown[]): string => call[0] as string
		);
		expect(getKeys.some((key: string): boolean => key.endsWith('.pdf'))).toBe(false);
	});

	it('rejects a json object whose actual bytes at the canonically derived key no longer match the recorded digest', async () => {
		const { objects, status, pdfRecord } = await seedArtifacts();
		const key: string = completionArtifactObjectKey(
			ENVELOPE_ID,
			'json',
			status.published!.jsonSha256
		);
		const original: Uint8Array = objects.get(key)!;
		const corrupted: Uint8Array = new Uint8Array(original.byteLength);
		corrupted.set(original);
		corrupted[0] = corrupted[0] ^ 0xff;
		objects.set(key, corrupted);
		const verifier = new CompletionAccessReissueArtifactVerifier(
			artifactStoreFixture(status),
			pdfStoreFixture(pdfRecord),
			mockObjectStore(objects)
		);
		const result = await verifier.verify(ENVELOPE_ID);
		expect(result.outcome).toBe('integrity_error');
		if (result.outcome !== 'integrity_error') return;
		expect(result.errorCode).toBe('completion_json_metadata_mismatch');
	});

	it('rejects a published PDF whose verified object metadata exceeds the 32 MiB publication bound, without reading the body', async () => {
		const { objects, status, pdfRecord } = await seedArtifacts();
		const pdfKey: string = pdfRecord.pdfObjectKey;
		const base: ObjectStore = mockObjectStore(objects);
		const fakedHead = vi.fn(async (key: string): Promise<ObjectMetadata | null> => ({
			key,
			contentType: 'application/pdf',
			size: MAX_PUBLISHED_COMPLETION_PDF_BYTES + 1,
			sha256: pdfRecord.pdfSha256,
			version: null
		}));
		const pdfGetGuard = vi.fn(async (): Promise<ReadableStream<Uint8Array> | null> => {
			throw new Error('must not read object bytes once metadata already exceeds the bound');
		});
		// Only the PDF key leg is faked oversize; json/markdown must still pass
		// their own real-bytes verification first so this is a true PDF-only
		// bound regression, not a side effect of a global stub.
		const oversizeObjectStore: ObjectStore = {
			...base,
			head: vi.fn(async (key: string): Promise<ObjectMetadata | null> =>
				key === pdfKey ? await fakedHead(key) : await base.head(key)
			),
			get: vi.fn(async (key: string): Promise<ReadableStream<Uint8Array> | null> =>
				key === pdfKey ? await pdfGetGuard() : await base.get(key)
			)
		};
		const verifier = new CompletionAccessReissueArtifactVerifier(
			artifactStoreFixture(status),
			pdfStoreFixture(pdfRecord),
			oversizeObjectStore
		);
		const result = await verifier.verify(ENVELOPE_ID);
		expect(result.outcome).toBe('integrity_error');
		if (result.outcome !== 'integrity_error') return;
		expect(result.errorCode).toBe('completion_pdf_metadata_mismatch');
		expect(fakedHead).toHaveBeenCalledWith(pdfKey);
		expect(pdfGetGuard).not.toHaveBeenCalled();
	});
});
