import { gzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { completionArtifactObjectKey } from '$lib/application/completion-artifacts/completion-artifact-service';
import {
	COMPLETION_MANIFEST_SCHEMA,
	MAX_MANIFEST_GZIP_BYTES,
	MAX_MANIFEST_SOURCE_BYTES,
	sha256Hex
} from '$lib/application/completion-artifacts/completion-manifest';
import {
	MAX_EVIDENCE_SUMMARY_PDF_BYTES,
	MAX_PUBLISHED_COMPLETION_PDF_BYTES
} from '$lib/application/completion-artifacts/completion-pdf-limits';
import type {
	CompletionArtifactLocator,
	CompletionDeliveryStore
} from '$lib/ports/completion-delivery-store';
import type {
	CompletionArtifactPdfRecord,
	CompletionArtifactPdfStore
} from '$lib/ports/completion-artifact-pdf-store';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import { issueCompletionToken } from '$lib/security/completion-token';
import {
	PublicCompletionArtifactIntegrityError,
	PublicCompletionArtifactNotFoundError,
	PublicCompletionArtifactService,
	PublicCompletionArtifactStorageError
} from './public-completion-artifact';

const NOW: Date = new Date('2026-09-12T12:00:00.000Z');
const ENV_ID: string = 'envelope-completion-1';

function mockObjectStore(objects: Map<string, Uint8Array> = new Map()): ObjectStore {
	return {
		head: vi.fn(async (key: string): Promise<ObjectMetadata | null> => {
			const bytes: Uint8Array | undefined = objects.get(key);
			if (bytes === undefined) return null;
			return {
				key,
				contentType: 'application/pdf',
				size: bytes.byteLength,
				sha256: await sha256Hex(bytes),
				version: null
			};
		}),
		get: vi.fn(async (key: string): Promise<ReadableStream<Uint8Array> | null> => {
			const bytes = objects.get(key);
			if (!bytes) return null;
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

function pdfStoreFixture(record: CompletionArtifactPdfRecord | null): CompletionArtifactPdfStore {
	return {
		publishCompletionArtifactPdf: vi.fn(async () => {
			throw new Error('unused');
		}),
		readCompletionArtifactPdf: vi.fn(async () => record)
	};
}

function mockStore(
	locatorResolver: (tokenHash: string, at: string) => Promise<CompletionArtifactLocator | null>
): CompletionDeliveryStore {
	return {
		discoverEligibleRecipients: vi.fn(),
		enrollDeliveries: vi.fn(),
		claimPendingDeliveries: vi.fn(),
		readClaimedDelivery: vi.fn(),
		completeDelivery: vi.fn(),
		failDelivery: vi.fn(),
		resolveArtifactLocatorByTokenHash: vi.fn(locatorResolver),
		findStaleSealedCompletionTokens: vi.fn(),
		resealCompletionToken: vi.fn()
	};
}

describe('PublicCompletionArtifactService', () => {
	it('reads decompressed JSON manifest for a valid skca1 token', async () => {
		const issued = await issueCompletionToken();
		const manifestJson = JSON.stringify({
			schema: COMPLETION_MANIFEST_SCHEMA,
			envelopeId: ENV_ID,
			title: 'Test Envelope'
		});
		const gzipped = gzipSync(new TextEncoder().encode(manifestJson), { level: 9, mtime: 0 });
		const digest = await sha256Hex(gzipped);
		const objectKey = completionArtifactObjectKey(ENV_ID, 'json', digest);

		const objects = mockObjectStore(new Map([[objectKey, gzipped]]));
		const locator: CompletionArtifactLocator = {
			envelopeId: ENV_ID,
			jsonObjectKey: objectKey,
			jsonSha256: digest,
			markdownObjectKey: 'unused-md-key',
			markdownSha256: 'a'.repeat(64)
		};
		const store = mockStore(async (hash, at) => {
			expect(hash).toBe(issued.tokenHash);
			expect(at).toBe(NOW.toISOString());
			return locator;
		});

		const service = new PublicCompletionArtifactService(store, objects);
		const result = await service.read(issued.token, 'json', NOW);

		expect(result).toEqual({
			content: manifestJson,
			contentType: 'application/json'
		});
		expect(objects.get).toHaveBeenCalledWith(objectKey);
	});

	it('reads decompressed Markdown manifest for a valid skca1 token', async () => {
		const issued = await issueCompletionToken();
		const markdownContent = '# Completion evidence\n- Title: Test';
		const gzipped = gzipSync(new TextEncoder().encode(markdownContent), { level: 9, mtime: 0 });
		const digest = await sha256Hex(gzipped);
		const objectKey = completionArtifactObjectKey(ENV_ID, 'markdown', digest);

		const objects = mockObjectStore(new Map([[objectKey, gzipped]]));
		const locator: CompletionArtifactLocator = {
			envelopeId: ENV_ID,
			jsonObjectKey: 'unused-json-key',
			jsonSha256: 'b'.repeat(64),
			markdownObjectKey: objectKey,
			markdownSha256: digest
		};
		const store = mockStore(async () => locator);

		const service = new PublicCompletionArtifactService(store, objects);
		const result = await service.read(issued.token, 'markdown', NOW);

		expect(result).toEqual({
			content: markdownContent,
			contentType: 'text/markdown; charset=utf-8'
		});
		expect(objects.get).toHaveBeenCalledWith(objectKey);
	});

	it('preserves non-ASCII Japanese text and reports an explicit UTF-8 charset for Markdown', async () => {
		const issued = await issueCompletionToken();
		const markdownContent = '# 完了証明\n- タイトル: テスト契約書\n- 署名者: 山田太郎';
		const gzipped = gzipSync(new TextEncoder().encode(markdownContent), { level: 9, mtime: 0 });
		const digest = await sha256Hex(gzipped);
		const objectKey = completionArtifactObjectKey(ENV_ID, 'markdown', digest);

		const objects = mockObjectStore(new Map([[objectKey, gzipped]]));
		const locator: CompletionArtifactLocator = {
			envelopeId: ENV_ID,
			jsonObjectKey: 'unused-json-key',
			jsonSha256: 'b'.repeat(64),
			markdownObjectKey: objectKey,
			markdownSha256: digest
		};
		const store = mockStore(async () => locator);

		const service = new PublicCompletionArtifactService(store, objects);
		const result = await service.read(issued.token, 'markdown', NOW);

		expect(result.content).toBe(markdownContent);
		expect(result.contentType).toBe('text/markdown; charset=utf-8');
	});

	describe('PDF reads', () => {
		async function fixture(size: number): Promise<{
			issued: Awaited<ReturnType<typeof issueCompletionToken>>;
			locator: CompletionArtifactLocator;
			record: CompletionArtifactPdfRecord;
			bytes: Uint8Array;
		}> {
			const issued = await issueCompletionToken();
			const bytes = new Uint8Array(size);
			bytes.set(new TextEncoder().encode('%PDF-1.7'));
			const digest = await sha256Hex(bytes);
			const objectKey = completionArtifactObjectKey(ENV_ID, 'pdf', digest);
			return {
				issued,
				bytes,
				record: {
					pdfObjectKey: objectKey,
					pdfSha256: digest,
					pdfByteSize: bytes.byteLength,
					pdfManifestObjectKey: 'unused',
					pdfManifestSha256: 'a'.repeat(64),
					publishedAt: NOW.toISOString()
				},
				locator: {
					envelopeId: ENV_ID,
					jsonObjectKey: 'unused',
					jsonSha256: 'b'.repeat(64),
					markdownObjectKey: 'unused',
					markdownSha256: 'c'.repeat(64)
				}
			};
		}

		it('returns a verified executed PDF larger than the evidence-summary ceiling', async () => {
			const { issued, locator, record, bytes } = await fixture(MAX_EVIDENCE_SUMMARY_PDF_BYTES + 1);
			const objects = mockObjectStore(new Map([[record.pdfObjectKey, bytes]]));
			const service = new PublicCompletionArtifactService(
				mockStore(async () => locator),
				objects,
				pdfStoreFixture(record)
			);

			await expect(service.read(issued.token, 'pdf', NOW)).resolves.toMatchObject({
				contentType: 'application/pdf'
			});
		});

		it('rejects oversized metadata opaquely before fetching the body', async () => {
			const { issued, locator, record } = await fixture(8);
			const objects = mockObjectStore();
			vi.mocked(objects.head).mockResolvedValue({
				key: record.pdfObjectKey,
				contentType: 'application/pdf',
				size: MAX_PUBLISHED_COMPLETION_PDF_BYTES + 1,
				sha256: record.pdfSha256,
				version: null
			});
			const service = new PublicCompletionArtifactService(
				mockStore(async () => locator),
				objects,
				pdfStoreFixture(record)
			);

			await expect(service.read(issued.token, 'pdf', NOW)).rejects.toThrow(
				PublicCompletionArtifactIntegrityError
			);
			expect(objects.get).not.toHaveBeenCalled();
		});

		it.each([
			['short', 1],
			['long', -1]
		])('maps a %s object stream to the opaque integrity error', async (_label, delta) => {
			const { issued, locator, record, bytes } = await fixture(32);
			const objects = mockObjectStore(new Map([[record.pdfObjectKey, bytes]]));
			vi.mocked(objects.head).mockResolvedValue({
				key: record.pdfObjectKey,
				contentType: 'application/pdf',
				size: bytes.byteLength + delta,
				sha256: record.pdfSha256,
				version: null
			});
			const service = new PublicCompletionArtifactService(
				mockStore(async () => locator),
				objects,
				pdfStoreFixture(record)
			);

			await expect(service.read(issued.token, 'pdf', NOW)).rejects.toThrow(
				PublicCompletionArtifactIntegrityError
			);
		});

		it('rehashes the body even when metadata claims the published digest', async () => {
			const { issued, locator, record, bytes } = await fixture(32);
			const tampered = Uint8Array.from(bytes);
			tampered[tampered.byteLength - 1] = 1;
			const objects = mockObjectStore(new Map([[record.pdfObjectKey, tampered]]));
			vi.mocked(objects.head).mockResolvedValue({
				key: record.pdfObjectKey,
				contentType: 'application/pdf',
				size: tampered.byteLength,
				sha256: record.pdfSha256,
				version: null
			});
			const service = new PublicCompletionArtifactService(
				mockStore(async () => locator),
				objects,
				pdfStoreFixture(record)
			);

			await expect(service.read(issued.token, 'pdf', NOW)).rejects.toThrow(
				PublicCompletionArtifactIntegrityError
			);
		});
	});

	describe('status', () => {
		it('rejects a malformed token as not found without querying the store', async () => {
			const store = mockStore(async () => null);
			const objects = mockObjectStore();
			const service = new PublicCompletionArtifactService(store, objects);

			await expect(service.status('invalid-token', NOW)).rejects.toThrow(
				PublicCompletionArtifactNotFoundError
			);
			expect(store.resolveArtifactLocatorByTokenHash).not.toHaveBeenCalled();
		});

		it('throws PublicCompletionArtifactNotFoundError for an unknown, expired, or revoked grant', async () => {
			const issued = await issueCompletionToken();
			const store = mockStore(async () => null);
			const objects = mockObjectStore();
			const service = new PublicCompletionArtifactService(store, objects);

			await expect(service.status(issued.token, NOW)).rejects.toThrow(
				PublicCompletionArtifactNotFoundError
			);
		});

		it('reports pdfAvailable=false without a PDF store configured, and never exposes the envelope ID', async () => {
			const issued = await issueCompletionToken();
			const locator: CompletionArtifactLocator = {
				envelopeId: ENV_ID,
				jsonObjectKey: 'unused',
				jsonSha256: 'a'.repeat(64),
				markdownObjectKey: 'unused',
				markdownSha256: 'b'.repeat(64)
			};
			const store = mockStore(async () => locator);
			const objects = mockObjectStore();
			const service = new PublicCompletionArtifactService(store, objects);

			const status = await service.status(issued.token, NOW);
			expect(status).toEqual({ pdfAvailable: false });
			expect(JSON.stringify(status)).not.toContain(ENV_ID);
		});

		it('reports pdfAvailable=false when a PDF store is configured but has not published a record yet', async () => {
			const issued = await issueCompletionToken();
			const locator: CompletionArtifactLocator = {
				envelopeId: ENV_ID,
				jsonObjectKey: 'unused',
				jsonSha256: 'a'.repeat(64),
				markdownObjectKey: 'unused',
				markdownSha256: 'b'.repeat(64)
			};
			const store = mockStore(async () => locator);
			const objects = mockObjectStore();
			const pdfStore: CompletionArtifactPdfStore = {
				publishCompletionArtifactPdf: vi.fn(async () => {
					throw new Error('unused');
				}),
				readCompletionArtifactPdf: vi.fn(async () => null)
			};
			const service = new PublicCompletionArtifactService(store, objects, pdfStore);

			await expect(service.status(issued.token, NOW)).resolves.toEqual({ pdfAvailable: false });
		});

		it('reports pdfAvailable=true once the PDF store has a published record, without exposing its key or digest', async () => {
			const issued = await issueCompletionToken();
			const locator: CompletionArtifactLocator = {
				envelopeId: ENV_ID,
				jsonObjectKey: 'unused',
				jsonSha256: 'a'.repeat(64),
				markdownObjectKey: 'unused',
				markdownSha256: 'b'.repeat(64)
			};
			const store = mockStore(async () => locator);
			const objects = mockObjectStore();
			const pdfStore: CompletionArtifactPdfStore = {
				publishCompletionArtifactPdf: vi.fn(async () => {
					throw new Error('unused');
				}),
				readCompletionArtifactPdf: vi.fn(async () => ({
					pdfObjectKey: 'completion-artifacts/v1/envelopes/env/sha256/abc.pdf',
					pdfSha256: 'c'.repeat(64),
					pdfByteSize: 1024,
					pdfManifestObjectKey: 'completion-artifacts/v1/envelopes/env/sha256/abc.json.gz',
					pdfManifestSha256: 'c'.repeat(64),
					publishedAt: NOW.toISOString()
				}))
			};
			const service = new PublicCompletionArtifactService(store, objects, pdfStore);

			const status = await service.status(issued.token, NOW);
			expect(status).toEqual({ pdfAvailable: true });
			expect(JSON.stringify(status)).not.toContain('completion-artifacts/');
			expect(JSON.stringify(status)).not.toContain('c'.repeat(64));
		});

		it('wraps PDF store failures in PublicCompletionArtifactStorageError', async () => {
			const issued = await issueCompletionToken();
			const locator: CompletionArtifactLocator = {
				envelopeId: ENV_ID,
				jsonObjectKey: 'unused',
				jsonSha256: 'a'.repeat(64),
				markdownObjectKey: 'unused',
				markdownSha256: 'b'.repeat(64)
			};
			const store = mockStore(async () => locator);
			const objects = mockObjectStore();
			const pdfStore: CompletionArtifactPdfStore = {
				publishCompletionArtifactPdf: vi.fn(async () => {
					throw new Error('unused');
				}),
				readCompletionArtifactPdf: vi.fn(async () => {
					throw new Error('object store unavailable');
				})
			};
			const service = new PublicCompletionArtifactService(store, objects, pdfStore);

			await expect(service.status(issued.token, NOW)).rejects.toThrow(
				PublicCompletionArtifactStorageError
			);
		});
	});

	it('rejects an skr1 cross-purpose token as not found without querying store', async () => {
		const store = mockStore(async () => null);
		const objects = mockObjectStore();
		const service = new PublicCompletionArtifactService(store, objects);

		const skr1Token = `skr1_${'a'.repeat(43)}`;
		await expect(service.read(skr1Token, 'json', NOW)).rejects.toThrow(
			PublicCompletionArtifactNotFoundError
		);
		expect(store.resolveArtifactLocatorByTokenHash).not.toHaveBeenCalled();
	});

	it('rejects malformed tokens as not found without querying store', async () => {
		const store = mockStore(async () => null);
		const objects = mockObjectStore();
		const service = new PublicCompletionArtifactService(store, objects);

		for (const bad of ['', 'skca1_', 'skca1_short', `skca1_${'#'.repeat(43)}`]) {
			await expect(service.read(bad, 'json', NOW)).rejects.toThrow(
				PublicCompletionArtifactNotFoundError
			);
		}
		expect(store.resolveArtifactLocatorByTokenHash).not.toHaveBeenCalled();
	});

	it('throws PublicCompletionArtifactNotFoundError when store resolver returns null', async () => {
		const issued = await issueCompletionToken();
		const store = mockStore(async () => null);
		const objects = mockObjectStore();
		const service = new PublicCompletionArtifactService(store, objects);

		await expect(service.read(issued.token, 'json', NOW)).rejects.toThrow(
			PublicCompletionArtifactNotFoundError
		);
	});

	it('wraps store resolver failures in PublicCompletionArtifactStorageError', async () => {
		const issued = await issueCompletionToken();
		const store = mockStore(async () => {
			throw new Error('Database connection pool exhausted');
		});
		const objects = mockObjectStore();
		const service = new PublicCompletionArtifactService(store, objects);

		const promise = service.read(issued.token, 'json', NOW);
		await expect(promise).rejects.toThrow(PublicCompletionArtifactStorageError);
		await expect(promise).rejects.toThrow('Completion artifact storage is unavailable');
	});

	it('throws PublicCompletionArtifactIntegrityError when stored key does not match rederived key', async () => {
		const issued = await issueCompletionToken();
		const digest = 'c'.repeat(64);
		const locator: CompletionArtifactLocator = {
			envelopeId: ENV_ID,
			jsonObjectKey: 'wrong/path/to/manifest.json.gz',
			jsonSha256: digest,
			markdownObjectKey: 'unused',
			markdownSha256: 'd'.repeat(64)
		};
		const store = mockStore(async () => locator);
		const objects = mockObjectStore();
		const service = new PublicCompletionArtifactService(store, objects);

		await expect(service.read(issued.token, 'json', NOW)).rejects.toThrow(
			PublicCompletionArtifactIntegrityError
		);
		expect(objects.get).not.toHaveBeenCalled();
	});

	it('throws PublicCompletionArtifactIntegrityError when locator digest is not a 64-hex sha256', async () => {
		const issued = await issueCompletionToken();
		const locator: CompletionArtifactLocator = {
			envelopeId: ENV_ID,
			jsonObjectKey: 'any-key',
			jsonSha256: 'not-a-valid-sha256',
			markdownObjectKey: 'unused',
			markdownSha256: 'd'.repeat(64)
		};
		const store = mockStore(async () => locator);
		const objects = mockObjectStore();
		const service = new PublicCompletionArtifactService(store, objects);

		await expect(service.read(issued.token, 'json', NOW)).rejects.toThrow(
			PublicCompletionArtifactIntegrityError
		);
	});

	it('throws PublicCompletionArtifactIntegrityError when object is missing from store', async () => {
		const issued = await issueCompletionToken();
		const digest = 'e'.repeat(64);
		const expectedKey = completionArtifactObjectKey(ENV_ID, 'json', digest);
		const locator: CompletionArtifactLocator = {
			envelopeId: ENV_ID,
			jsonObjectKey: expectedKey,
			jsonSha256: digest,
			markdownObjectKey: 'unused',
			markdownSha256: 'f'.repeat(64)
		};
		const store = mockStore(async () => locator);
		const objects = mockObjectStore(); // empty store -> returns null
		const service = new PublicCompletionArtifactService(store, objects);

		await expect(service.read(issued.token, 'json', NOW)).rejects.toThrow(
			PublicCompletionArtifactIntegrityError
		);
	});

	it('wraps object store get errors in PublicCompletionArtifactStorageError', async () => {
		const issued = await issueCompletionToken();
		const digest = '1'.repeat(64);
		const expectedKey = completionArtifactObjectKey(ENV_ID, 'json', digest);
		const locator: CompletionArtifactLocator = {
			envelopeId: ENV_ID,
			jsonObjectKey: expectedKey,
			jsonSha256: digest,
			markdownObjectKey: 'unused',
			markdownSha256: '2'.repeat(64)
		};
		const store = mockStore(async () => locator);
		const objects = mockObjectStore();
		vi.mocked(objects.get).mockRejectedValue(new Error('S3 bucket unreachable'));
		const service = new PublicCompletionArtifactService(store, objects);

		await expect(service.read(issued.token, 'json', NOW)).rejects.toThrow(
			PublicCompletionArtifactStorageError
		);
	});

	it('throws PublicCompletionArtifactIntegrityError when gzip digest does not match locator digest', async () => {
		const issued = await issueCompletionToken();
		const validGzip = gzipSync(
			new TextEncoder().encode(JSON.stringify({ schema: COMPLETION_MANIFEST_SCHEMA }))
		);
		const realDigest = await sha256Hex(validGzip);
		const differentDigest = '3'.repeat(64);
		expect(differentDigest).not.toBe(realDigest);
		const expectedKey = completionArtifactObjectKey(ENV_ID, 'json', differentDigest);

		const locator: CompletionArtifactLocator = {
			envelopeId: ENV_ID,
			jsonObjectKey: expectedKey,
			jsonSha256: differentDigest,
			markdownObjectKey: 'unused',
			markdownSha256: '4'.repeat(64)
		};
		const store = mockStore(async () => locator);
		// Return valid gzip whose SHA-256 is realDigest, not differentDigest
		const objects = mockObjectStore(new Map([[expectedKey, validGzip]]));
		const service = new PublicCompletionArtifactService(store, objects);

		await expect(service.read(issued.token, 'json', NOW)).rejects.toThrow(
			PublicCompletionArtifactIntegrityError
		);
	});

	it('throws PublicCompletionArtifactIntegrityError when input gzip exceeds MAX_MANIFEST_GZIP_BYTES', async () => {
		const issued = await issueCompletionToken();
		const oversizedGzip = new Uint8Array(MAX_MANIFEST_GZIP_BYTES + 100);
		oversizedGzip.fill(1);
		const digest = await sha256Hex(oversizedGzip);
		const expectedKey = completionArtifactObjectKey(ENV_ID, 'json', digest);

		const locator: CompletionArtifactLocator = {
			envelopeId: ENV_ID,
			jsonObjectKey: expectedKey,
			jsonSha256: digest,
			markdownObjectKey: 'unused',
			markdownSha256: '5'.repeat(64)
		};
		const store = mockStore(async () => locator);
		const objects = mockObjectStore(new Map([[expectedKey, oversizedGzip]]));
		const service = new PublicCompletionArtifactService(store, objects);

		await expect(service.read(issued.token, 'json', NOW)).rejects.toThrow(
			PublicCompletionArtifactIntegrityError
		);
	});

	it('throws PublicCompletionArtifactIntegrityError on invalid or corrupted gzip data', async () => {
		const issued = await issueCompletionToken();
		const corruptBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff, 0xff]); // corrupt gzip
		const digest = await sha256Hex(corruptBytes);
		const expectedKey = completionArtifactObjectKey(ENV_ID, 'markdown', digest);

		const locator: CompletionArtifactLocator = {
			envelopeId: ENV_ID,
			jsonObjectKey: 'unused',
			jsonSha256: '6'.repeat(64),
			markdownObjectKey: expectedKey,
			markdownSha256: digest
		};
		const store = mockStore(async () => locator);
		const objects = mockObjectStore(new Map([[expectedKey, corruptBytes]]));
		const service = new PublicCompletionArtifactService(store, objects);

		await expect(service.read(issued.token, 'markdown', NOW)).rejects.toThrow(
			PublicCompletionArtifactIntegrityError
		);
	});

	it('throws PublicCompletionArtifactIntegrityError on a decompression bomb exceeding MAX_MANIFEST_SOURCE_BYTES', async () => {
		const issued = await issueCompletionToken();
		// Compress 2.5 MB of zeroes: compresses to ~2.5 KB, well within MAX_MANIFEST_GZIP_BYTES
		const bombSource = new Uint8Array(MAX_MANIFEST_SOURCE_BYTES + 512 * 1024);
		const bombGzip = gzipSync(bombSource, { level: 9, mtime: 0 });
		expect(bombGzip.byteLength).toBeLessThan(MAX_MANIFEST_GZIP_BYTES);

		const digest = await sha256Hex(bombGzip);
		const expectedKey = completionArtifactObjectKey(ENV_ID, 'markdown', digest);
		const locator: CompletionArtifactLocator = {
			envelopeId: ENV_ID,
			jsonObjectKey: 'unused',
			jsonSha256: '7'.repeat(64),
			markdownObjectKey: expectedKey,
			markdownSha256: digest
		};
		const store = mockStore(async () => locator);
		const objects = mockObjectStore(new Map([[expectedKey, bombGzip]]));
		const service = new PublicCompletionArtifactService(store, objects);

		await expect(service.read(issued.token, 'markdown', NOW)).rejects.toThrow(
			PublicCompletionArtifactIntegrityError
		);
	});

	it('throws PublicCompletionArtifactIntegrityError on non-UTF-8 decompressed content', async () => {
		const issued = await issueCompletionToken();
		// Non-UTF-8 bytes: 0xff, 0xfe
		const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0x80, 0x81]);
		const gzipped = gzipSync(invalidUtf8, { level: 9, mtime: 0 });
		const digest = await sha256Hex(gzipped);
		const expectedKey = completionArtifactObjectKey(ENV_ID, 'markdown', digest);

		const locator: CompletionArtifactLocator = {
			envelopeId: ENV_ID,
			jsonObjectKey: 'unused',
			jsonSha256: '8'.repeat(64),
			markdownObjectKey: expectedKey,
			markdownSha256: digest
		};
		const store = mockStore(async () => locator);
		const objects = mockObjectStore(new Map([[expectedKey, gzipped]]));
		const service = new PublicCompletionArtifactService(store, objects);

		await expect(service.read(issued.token, 'markdown', NOW)).rejects.toThrow(
			PublicCompletionArtifactIntegrityError
		);
	});

	it('throws PublicCompletionArtifactIntegrityError on invalid JSON syntax for format json', async () => {
		const issued = await issueCompletionToken();
		const gzipped = gzipSync(new TextEncoder().encode('{ not valid json'), { level: 9, mtime: 0 });
		const digest = await sha256Hex(gzipped);
		const objectKey = completionArtifactObjectKey(ENV_ID, 'json', digest);

		const locator: CompletionArtifactLocator = {
			envelopeId: ENV_ID,
			jsonObjectKey: objectKey,
			jsonSha256: digest,
			markdownObjectKey: 'unused',
			markdownSha256: '9'.repeat(64)
		};
		const store = mockStore(async () => locator);
		const objects = mockObjectStore(new Map([[objectKey, gzipped]]));
		const service = new PublicCompletionArtifactService(store, objects);

		await expect(service.read(issued.token, 'json', NOW)).rejects.toThrow(
			PublicCompletionArtifactIntegrityError
		);
	});

	it('throws PublicCompletionArtifactIntegrityError on JSON with incorrect or missing schema', async () => {
		const issued = await issueCompletionToken();

		for (const badJson of [
			JSON.stringify({ schema: 'wrong-schema-v2', envelopeId: ENV_ID }),
			JSON.stringify({ envelopeId: ENV_ID }),
			JSON.stringify([1, 2, 3]),
			JSON.stringify(null),
			JSON.stringify('string-only')
		]) {
			const gzipped = gzipSync(new TextEncoder().encode(badJson), { level: 9, mtime: 0 });
			const digest = await sha256Hex(gzipped);
			const objectKey = completionArtifactObjectKey(ENV_ID, 'json', digest);

			const locator: CompletionArtifactLocator = {
				envelopeId: ENV_ID,
				jsonObjectKey: objectKey,
				jsonSha256: digest,
				markdownObjectKey: 'unused',
				markdownSha256: 'a'.repeat(64)
			};
			const store = mockStore(async () => locator);
			const objects = mockObjectStore(new Map([[objectKey, gzipped]]));
			const service = new PublicCompletionArtifactService(store, objects);

			await expect(service.read(issued.token, 'json', NOW)).rejects.toThrow(
				PublicCompletionArtifactIntegrityError
			);
		}
	});

	it('never leaks internal tokens, keys, hashes, or envelope IDs in thrown error messages', async () => {
		const issued = await issueCompletionToken();
		const errors: Error[] = [
			new PublicCompletionArtifactNotFoundError(),
			new PublicCompletionArtifactIntegrityError(),
			new PublicCompletionArtifactStorageError()
		];

		for (const err of errors) {
			const text = `${err.name}: ${err.message}`;
			expect(text).not.toContain(issued.token);
			expect(text).not.toContain(issued.tokenHash);
			expect(text).not.toContain(ENV_ID);
			expect(text).not.toContain('completion-artifacts');
			expect(text).not.toContain('@');
		}
	});
});
