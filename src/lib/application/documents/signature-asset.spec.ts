import { describe, expect, it } from 'vitest';
import { drawnSignaturePng, encodeTestPng } from '$lib/adapters/pdf/png-image-test-support';
import type { RecipientAccessApplicationPort } from '$lib/application/signing/recipient-access';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import {
	MAX_SIGNATURE_ASSET_BYTES,
	SignatureAssetApplication,
	parseSignatureAssetKey,
	referencedSignatureAssetKeys,
	signatureAssetKey,
	signatureAssetRefValueJson
} from './signature-asset';

const context: RecipientSigningContext = {
	organizationId: 'org-1',
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
			signatureAssetKey(
				context.organizationId,
				context.envelopeId,
				context.recipientId,
				metadata?.sha256 ?? ''
			)
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

describe('signature asset object keys', () => {
	const sha256: string = 'a'.repeat(64);
	const key: string = signatureAssetKey(
		context.organizationId,
		context.envelopeId,
		context.recipientId,
		sha256
	);

	it('round-trips a classified signature-assets/v1 key', () => {
		expect(parseSignatureAssetKey(key)).toEqual({
			organizationId: context.organizationId,
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
					organizationId: context.organizationId,
					envelopeId: context.envelopeId,
					recipientId: context.recipientId,
					valueJson: signatureAssetRefValueJson(sha256)
				},
				{
					organizationId: 'org-other',
					envelopeId: context.envelopeId,
					recipientId: context.recipientId,
					valueJson: signatureAssetRefValueJson(sha256)
				}
			]
		);
		expect([...referenced]).toEqual([key]);
	});
});
