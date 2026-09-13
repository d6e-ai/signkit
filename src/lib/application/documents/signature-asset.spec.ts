import { describe, expect, it } from 'vitest';
import type { RecipientAccessApplicationPort } from '$lib/application/signing/recipient-access';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import type { ObjectMetadata, ObjectStore, PutObject } from '$lib/ports/object-store';
import {
	MAX_SIGNATURE_ASSET_BYTES,
	SignatureAssetApplication,
	signatureAssetKey
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

const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBytes(extra: number = 32): Uint8Array {
	const bytes = new Uint8Array(PNG_MAGIC.byteLength + extra);
	bytes.set(PNG_MAGIC);
	return bytes;
}

class FakeAccess implements RecipientAccessApplicationPort {
	constructor(private readonly result: RecipientSigningContext | null = context) {}
	async resolve(): Promise<RecipientSigningContext | null> {
		return this.result;
	}
}

class FakeObjectStore implements ObjectStore {
	puts: Array<{ key: string; object: PutObject }> = [];
	async head(): Promise<ObjectMetadata | null> {
		return null;
	}
	async get(): Promise<ReadableStream<Uint8Array> | null> {
		return null;
	}
	async putImmutable(key: string, object: PutObject): Promise<ObjectMetadata> {
		this.puts.push({ key, object });
		return { key, contentType: object.contentType, size: 0, sha256: object.sha256, version: null };
	}
	async delete(): Promise<void> {}
}

describe('SignatureAssetApplication', () => {
	it('stores a bounded PNG scoped to the resolved recipient and returns a stable assetRef', async () => {
		const objects = new FakeObjectStore();
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
		expect(objects.puts).toHaveLength(1);
		expect(objects.puts[0].key).toBe(
			signatureAssetKey(
				context.organizationId,
				context.envelopeId,
				context.recipientId,
				objects.puts[0].object.sha256
			)
		);
	});

	it('rejects an oversized upload before resolving the recipient', async () => {
		const access: RecipientAccessApplicationPort = {
			resolve: async () => {
				throw new Error('must not be called for an oversized upload');
			}
		};
		const application = new SignatureAssetApplication(access, new FakeObjectStore());

		const result = await application.store({
			token: 'token',
			expectedEnvelopeId: context.envelopeId,
			expectedRecipientId: context.recipientId,
			pngBytes: new Uint8Array(MAX_SIGNATURE_ASSET_BYTES + 1)
		});
		expect(result).toEqual({ outcome: 'too_large' });
	});

	it('rejects bytes that are not a PNG', async () => {
		const application = new SignatureAssetApplication(new FakeAccess(), new FakeObjectStore());
		const result = await application.store({
			token: 'token',
			expectedEnvelopeId: context.envelopeId,
			expectedRecipientId: context.recipientId,
			pngBytes: new Uint8Array([1, 2, 3, 4])
		});
		expect(result).toEqual({ outcome: 'invalid_image' });
	});

	it('returns not_found for an inactive or unknown capability', async () => {
		const application = new SignatureAssetApplication(new FakeAccess(null), new FakeObjectStore());
		const result = await application.store({
			token: 'token',
			expectedEnvelopeId: context.envelopeId,
			expectedRecipientId: context.recipientId,
			pngBytes: pngBytes()
		});
		expect(result).toEqual({ outcome: 'not_found' });
	});

	it('rejects a request whose envelope or recipient does not match the resolved context', async () => {
		const application = new SignatureAssetApplication(new FakeAccess(), new FakeObjectStore());
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
			delete: async () => {}
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
