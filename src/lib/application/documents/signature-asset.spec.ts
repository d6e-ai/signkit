import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { emittedImageStreamBytes } from '$lib/adapters/pdf/pdf-composer';
import { decodePng } from '$lib/adapters/pdf/png-image';
import { drawnSignaturePng, encodeTestPng } from '$lib/adapters/pdf/png-image-test-support';
import type { RecipientAccessApplicationPort } from '$lib/application/signing/recipient-access';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import {
	MAX_SIGNATURE_ASSET_BYTES,
	MAX_SIGNATURE_EMITTED_IMAGE_BYTES,
	SIGNATURE_ASSET_REF_PREFIX,
	SignatureAssetApplication,
	parseSignatureAssetKey,
	referencedSignatureAssetKeys,
	signatureAssetKey,
	signatureAssetRefValueJson,
	verifySignatureAssetReference
} from './signature-asset';

const context: RecipientSigningContext = {
	envelopeId: '01900000-0000-7000-8000-000000000001',
	recipientId: '01900000-0000-7000-8000-000000000002',
	recipientName: 'Alice',
	recipientLocale: 'en',
	recipientRole: 'signer',
	recipientStatus: 'viewed',
	envelopeTitle: 'Agreement',
	envelopeStatus: 'sent',
	expiresAt: '2026-09-20T00:00:00.000Z',
	sentRevision: {
		commitSha: '0123456789abcdef0123456789abcdef01234567',
		archiveKey: 'archive-key',
		archiveSha256: 'a'.repeat(64)
	}
};

function pngBytes(): Uint8Array {
	return drawnSignaturePng();
}

/**
 * What `signature-canvas.svelte` uploads: its 600 x 200 backing store as
 * unpremultiplied RGBA, transparent everywhere but a few anti-aliased 2.5 px
 * strokes in #111827.
 */
function canvasSignaturePng(): Uint8Array {
	const width: number = 600;
	const height: number = 200;
	const samples: Uint8Array = new Uint8Array(width * height * 4);
	const strokes: readonly ((x: number) => number)[] = [
		(x: number): number => 100 + 55 * Math.sin(x / 37) + 18 * Math.sin(x / 7),
		(x: number): number => 120 + 30 * Math.cos(x / 23) - 25 * Math.sin(x / 11),
		(x: number): number => 70 + 40 * Math.sin(x / 15 + 1)
	];
	for (let x: number = 20; x < width - 20; x += 1) {
		for (const stroke of strokes) {
			const center: number = stroke(x);
			for (let y: number = Math.floor(center - 3); y <= Math.ceil(center + 3); y += 1) {
				if (y < 0 || y >= height) continue;
				const coverage: number = Math.min(1, Math.max(0, 1.75 - Math.abs(y - center)));
				const offset: number = (y * width + x) * 4;
				const alpha: number = Math.max(samples[offset + 3], Math.round(coverage * 255));
				if (alpha === 0) continue;
				samples.set([17, 24, 39, alpha], offset);
			}
		}
	}
	return encodeTestPng({ width, height, colorType: 6, samples, filterType: 1 });
}

function xorshift(seed: number): () => number {
	let state: number = seed >>> 0 || 1;
	return (): number => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state;
	};
}

class FakeAccess implements RecipientAccessApplicationPort {
	constructor(private readonly result: RecipientSigningContext | null = context) {}
	async resolve(): Promise<RecipientSigningContext | null> {
		return this.result;
	}
}

describe('SignatureAssetApplication', () => {
	it('stores a bounded PNG scoped to the resolved recipient and returns a stable assetRef', async () => {
		const objects = new InMemoryObjectStore();
		const application = new SignatureAssetApplication(new FakeAccess(), objects);

		const result = await application.store({
			token: 'token',
			expectedEnvelopeId: context.envelopeId,
			expectedRecipientId: context.recipientId,
			pngBytes: pngBytes()
		});

		expect(result.outcome).toBe('stored');
		if (result.outcome !== 'stored') throw new Error('expected stored outcome');
		expect(result.assetRef).toMatch(/^sig:sha256:[a-f0-9]{64}$/);
		expect(result.assetRef.length).toBeLessThanOrEqual(200);
		expect(objects.putCalls).toBe(1);
		const [key] = objects.keys();
		const metadata = await objects.head(key);
		expect(key).toBe(
			signatureAssetKey(context.envelopeId, context.recipientId, metadata?.sha256 ?? '')
		);
	});

	it('rejects an oversized upload before resolving the recipient', async () => {
		const access: RecipientAccessApplicationPort = {
			resolve: async () => {
				throw new Error('must not be called for an oversized upload');
			}
		};
		const application = new SignatureAssetApplication(access, new InMemoryObjectStore());

		const result = await application.store({
			token: 'token',
			expectedEnvelopeId: context.envelopeId,
			expectedRecipientId: context.recipientId,
			pngBytes: new Uint8Array(MAX_SIGNATURE_ASSET_BYTES + 1)
		});
		expect(result).toEqual({ outcome: 'too_large' });
	});

	it('rejects a PNG the executed agreement PDF could not composite later', async () => {
		const objects = new InMemoryObjectStore();
		const application = new SignatureAssetApplication(new FakeAccess(), objects);

		const result = await application.store({
			token: 'token',
			expectedEnvelopeId: context.envelopeId,
			expectedRecipientId: context.recipientId,
			// Well-formed PNG bytes, but interlaced: decodable by a browser and
			// not by the compositor, so it must never reach a signed field value.
			pngBytes: encodeTestPng({
				width: 2,
				height: 2,
				colorType: 6,
				samples: new Uint8Array(2 * 2 * 4),
				interlace: 1
			})
		});

		expect(result).toEqual({ outcome: 'invalid_image' });
		expect(objects.size).toBe(0);
	});

	it('accepts a drawn signature shaped like the signing canvas export', async () => {
		const objects = new InMemoryObjectStore();
		const png: Uint8Array = canvasSignaturePng();
		const result = await new SignatureAssetApplication(new FakeAccess(), objects).store({
			token: 'token',
			expectedEnvelopeId: context.envelopeId,
			expectedRecipientId: context.recipientId,
			pngBytes: png
		});

		expect(result.outcome).toBe('stored');
		expect(emittedImageStreamBytes(decodePng(png))).toBeLessThanOrEqual(
			MAX_SIGNATURE_EMITTED_IMAGE_BYTES
		);
	});

	it('rejects a small PNG whose planes the agreement would re-deflate past the cap', async () => {
		const objects = new InMemoryObjectStore();
		// Sixteen random palette colors at four bits a pixel: the PNG stays
		// under its cap, but the composer re-deflates three bytes of RGB per pixel.
		const next: () => number = xorshift(7);
		const packed: Uint8Array = new Uint8Array((600 * 200) / 2);
		for (let index: number = 0; index < packed.length; index += 1) packed[index] = next() & 0xff;
		const palette: Uint8Array = new Uint8Array(16 * 3);
		for (let index: number = 0; index < palette.length; index += 1) palette[index] = next() & 0xff;
		const png: Uint8Array = encodeTestPng({
			width: 600,
			height: 200,
			colorType: 3,
			bitDepth: 4,
			samples: packed,
			palette
		});
		expect(png.byteLength).toBeLessThanOrEqual(MAX_SIGNATURE_ASSET_BYTES);
		expect(emittedImageStreamBytes(decodePng(png))).toBeGreaterThan(
			MAX_SIGNATURE_EMITTED_IMAGE_BYTES
		);

		const result = await new SignatureAssetApplication(new FakeAccess(), objects).store({
			token: 'token',
			expectedEnvelopeId: context.envelopeId,
			expectedRecipientId: context.recipientId,
			pngBytes: png
		});

		expect(result).toEqual({ outcome: 'too_large' });
		expect(objects.size).toBe(0);
	});

	it('rejects a small PNG whose decoded planes exceed the canvas raster', async () => {
		const objects = new InMemoryObjectStore();
		const png: Uint8Array = drawnSignaturePng(2000, 1000);
		expect(png.byteLength).toBeLessThanOrEqual(MAX_SIGNATURE_ASSET_BYTES);

		const result = await new SignatureAssetApplication(new FakeAccess(), objects).store({
			token: 'token',
			expectedEnvelopeId: context.envelopeId,
			expectedRecipientId: context.recipientId,
			pngBytes: png
		});

		expect(result).toEqual({ outcome: 'too_large' });
		expect(objects.size).toBe(0);
	});

	it('rejects bytes that are not a PNG', async () => {
		const application = new SignatureAssetApplication(new FakeAccess(), new InMemoryObjectStore());
		const result = await application.store({
			token: 'token',
			expectedEnvelopeId: context.envelopeId,
			expectedRecipientId: context.recipientId,
			pngBytes: new Uint8Array([1, 2, 3, 4])
		});
		expect(result).toEqual({ outcome: 'invalid_image' });
	});

	it('returns not_found for an inactive or unknown capability', async () => {
		const application = new SignatureAssetApplication(
			new FakeAccess(null),
			new InMemoryObjectStore()
		);
		const result = await application.store({
			token: 'token',
			expectedEnvelopeId: context.envelopeId,
			expectedRecipientId: context.recipientId,
			pngBytes: pngBytes()
		});
		expect(result).toEqual({ outcome: 'not_found' });
	});

	it('rejects an inactive capability before attempting an expensive PNG decode', async () => {
		const application: SignatureAssetApplication = new SignatureAssetApplication(
			new FakeAccess(null),
			new InMemoryObjectStore()
		);
		const fakePngBomb: Uint8Array = Uint8Array.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xff, 0xff, 0xff
		]);

		const result = await application.store({
			token: 'inactive-token',
			expectedEnvelopeId: context.envelopeId,
			expectedRecipientId: context.recipientId,
			pngBytes: fakePngBomb
		});

		expect(result).toEqual({ outcome: 'not_found' });
	});

	it('rejects a request whose envelope or recipient does not match the resolved context', async () => {
		const application = new SignatureAssetApplication(new FakeAccess(), new InMemoryObjectStore());
		const result = await application.store({
			token: 'token',
			expectedEnvelopeId: context.envelopeId,
			expectedRecipientId: 'a-different-recipient',
			pngBytes: pngBytes()
		});
		expect(result).toEqual({ outcome: 'context_mismatch' });
	});

	it('reports an integrity error when the object store does not confirm the write', async () => {
		const objects: ObjectStore = {
			head: async () => null,
			get: async () => null,
			putImmutable: async (key: string): Promise<ObjectMetadata> => ({
				key,
				contentType: 'image/png',
				size: 0,
				sha256: 'mismatched-sha256',
				version: null
			}),
			delete: async () => {},
			list: async () => {
				throw new Error('unused');
			},
			deleteMany: async () => {
				throw new Error('unused');
			}
		};
		const application = new SignatureAssetApplication(new FakeAccess(), objects);
		const result = await application.store({
			token: 'token',
			expectedEnvelopeId: context.envelopeId,
			expectedRecipientId: context.recipientId,
			pngBytes: pngBytes()
		});
		expect(result).toEqual({ outcome: 'integrity_error' });
	});
});

describe('verifySignatureAssetReference', () => {
	const envelopeId: string = context.envelopeId;
	const recipientId: string = context.recipientId;

	async function seedCanvasSignature(objects: InMemoryObjectStore): Promise<string> {
		const png: Uint8Array = canvasSignaturePng();
		const sha256: string = createHash('sha256').update(png).digest('hex');
		objects.seed(signatureAssetKey(envelopeId, recipientId, sha256), png, sha256);
		return sha256;
	}

	it('accepts a signature-field reference to a canvas-upload asset', async () => {
		const objects = new InMemoryObjectStore();
		const sha256: string = await seedCanvasSignature(objects);

		const check = await verifySignatureAssetReference(
			objects,
			envelopeId,
			recipientId,
			`${SIGNATURE_ASSET_REF_PREFIX}${sha256}`
		);

		expect(check).toEqual({ outcome: 'ok' });
	});

	it('accepts an initials-field reference to the same canvas-upload asset', async () => {
		// Initials and signature fields share the same object store and key
		// shape; the field type does not change what is verified.
		const objects = new InMemoryObjectStore();
		const sha256: string = await seedCanvasSignature(objects);

		const check = await verifySignatureAssetReference(
			objects,
			envelopeId,
			recipientId,
			`${SIGNATURE_ASSET_REF_PREFIX}${sha256}`
		);

		expect(check).toEqual({ outcome: 'ok' });
	});

	it('rejects a reference to a key that was never stored', async () => {
		const objects = new InMemoryObjectStore();

		const check = await verifySignatureAssetReference(
			objects,
			envelopeId,
			recipientId,
			`${SIGNATURE_ASSET_REF_PREFIX}${'a'.repeat(64)}`
		);

		expect(check).toEqual({ outcome: 'invalid' });
	});

	it('rejects a malformed reference shape without touching the object store', async () => {
		const objects: ObjectStore = {
			head: async () => {
				throw new Error('must not be called for a malformed reference');
			},
			get: async () => {
				throw new Error('must not be called for a malformed reference');
			},
			putImmutable: async () => {
				throw new Error('unused');
			},
			delete: async () => {},
			list: async () => {
				throw new Error('unused');
			},
			deleteMany: async () => {
				throw new Error('unused');
			}
		};

		const check = await verifySignatureAssetReference(
			objects,
			envelopeId,
			recipientId,
			`${SIGNATURE_ASSET_REF_PREFIX}${'g'.repeat(64)}`
		);

		expect(check).toEqual({ outcome: 'invalid' });
	});

	it("rejects a reference scoped to a different envelope's asset", async () => {
		const objects = new InMemoryObjectStore();
		const sha256: string = await seedCanvasSignature(objects);

		const check = await verifySignatureAssetReference(
			objects,
			'a-different-envelope',
			recipientId,
			`${SIGNATURE_ASSET_REF_PREFIX}${sha256}`
		);

		expect(check).toEqual({ outcome: 'invalid' });
	});

	it("rejects a reference scoped to a different recipient's asset", async () => {
		const objects = new InMemoryObjectStore();
		const sha256: string = await seedCanvasSignature(objects);

		const check = await verifySignatureAssetReference(
			objects,
			envelopeId,
			'a-different-recipient',
			`${SIGNATURE_ASSET_REF_PREFIX}${sha256}`
		);

		expect(check).toEqual({ outcome: 'invalid' });
	});

	it('rejects a stored object whose bytes do not hash to the referenced digest', async () => {
		const objects = new InMemoryObjectStore();
		const png: Uint8Array = canvasSignaturePng();
		const claimedSha256: string = 'b'.repeat(64);
		objects.seed(
			signatureAssetKey(envelopeId, recipientId, claimedSha256),
			png,
			createHash('sha256').update(png).digest('hex')
		);

		const check = await verifySignatureAssetReference(
			objects,
			envelopeId,
			recipientId,
			`${SIGNATURE_ASSET_REF_PREFIX}${claimedSha256}`
		);

		expect(check).toEqual({ outcome: 'invalid' });
	});

	it('rejects a stored object that oversteps the bounded read', async () => {
		const objects = new InMemoryObjectStore();
		const oversized: Uint8Array = new Uint8Array(MAX_SIGNATURE_ASSET_BYTES + 1);
		const sha256: string = createHash('sha256').update(oversized).digest('hex');
		objects.seed(signatureAssetKey(envelopeId, recipientId, sha256), oversized, sha256);

		const check = await verifySignatureAssetReference(
			objects,
			envelopeId,
			recipientId,
			`${SIGNATURE_ASSET_REF_PREFIX}${sha256}`
		);

		expect(check).toEqual({ outcome: 'invalid' });
	});

	it('rejects a stored object that is not a decodable PNG within the signature decode caps', async () => {
		const objects = new InMemoryObjectStore();
		const corrupt: Uint8Array = new Uint8Array([1, 2, 3, 4]);
		const sha256: string = createHash('sha256').update(corrupt).digest('hex');
		objects.seed(signatureAssetKey(envelopeId, recipientId, sha256), corrupt, sha256);

		const check = await verifySignatureAssetReference(
			objects,
			envelopeId,
			recipientId,
			`${SIGNATURE_ASSET_REF_PREFIX}${sha256}`
		);

		expect(check).toEqual({ outcome: 'invalid' });
	});

	it('reports a provider failure, not an invalid reference, when the store errors', async () => {
		const objects: ObjectStore = {
			head: async () => null,
			get: async () => {
				throw new Error('object store unavailable');
			},
			putImmutable: async () => {
				throw new Error('unused');
			},
			delete: async () => {},
			list: async () => {
				throw new Error('unused');
			},
			deleteMany: async () => {
				throw new Error('unused');
			}
		};

		const check = await verifySignatureAssetReference(
			objects,
			envelopeId,
			recipientId,
			`${SIGNATURE_ASSET_REF_PREFIX}${'c'.repeat(64)}`
		);

		expect(check).toEqual({ outcome: 'provider_error' });
	});
});

describe('signature asset object keys', () => {
	const sha256: string = 'a'.repeat(64);
	const key: string = signatureAssetKey(context.envelopeId, context.recipientId, sha256);

	it('round-trips a classified signature-assets/v1 key', () => {
		expect(parseSignatureAssetKey(key)).toEqual({
			envelopeId: context.envelopeId,
			recipientId: context.recipientId,
			sha256
		});
	});

	it('classifies a field_value sig:sha256 reference as the reconstructed object key', () => {
		const referenced = referencedSignatureAssetKeys(
			[key, 'drafts/unrelated.git.gz'],
			[
				{
					envelopeId: context.envelopeId,
					recipientId: context.recipientId,
					valueJson: signatureAssetRefValueJson(sha256)
				},
				{
					envelopeId: context.envelopeId,
					recipientId: context.recipientId,
					valueJson: signatureAssetRefValueJson(sha256)
				}
			]
		);
		expect([...referenced]).toEqual([key]);
	});
});
