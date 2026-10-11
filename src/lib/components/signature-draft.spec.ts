import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng } from '$lib/adapters/pdf/png-image';
import { drawnSignaturePng } from '$lib/adapters/pdf/png-image-test-support';
import {
	SIGNATURE_ASSET_REF_PREFIX,
	SignatureAssetApplication
} from '$lib/application/documents/signature-asset';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import { InMemorySignatureAssetLedger } from '$lib/ports/signature-asset-ledger-test-support';
import {
	committedFromDraft,
	draftFromCommitted,
	isProblemOfType,
	isSignatureAssetRef,
	SIGNATURE_ASSET_EXPIRED_PROBLEM,
	withUploadNonce
} from './signature-draft';

const assetRef = `${SIGNATURE_ASSET_REF_PREFIX}${'a'.repeat(64)}`;

describe('retired upload recovery', () => {
	const nonce: string = '0123456789abcdef0123456789abcdef';

	it('re-encodes the same picture with a fresh content hash and valid chunk CRCs', () => {
		const original: Uint8Array = drawnSignaturePng();
		const fresh: Uint8Array | null = withUploadNonce(original, nonce);
		if (fresh === null) throw new Error('expected nonce PNG');

		expect(createHash('sha256').update(fresh).digest('hex')).not.toBe(
			createHash('sha256').update(original).digest('hex')
		);
		expect(decodePng(fresh)).toEqual(decodePng(original));
		// Every chunk, including the inserted tEXt, carries a correct CRC-32.
		let cursor: number = 8;
		const types: string[] = [];
		while (cursor < fresh.byteLength) {
			const view = new DataView(fresh.buffer, fresh.byteOffset);
			const length: number = view.getUint32(cursor);
			const typed: Uint8Array = fresh.subarray(cursor + 4, cursor + 8 + length);
			types.push(String.fromCharCode(...typed.subarray(0, 4)));
			expect(view.getUint32(cursor + 8 + length)).toBe(crc32(typed));
			cursor += 12 + length;
		}
		expect(types.slice(0, 2)).toEqual(['IHDR', 'tEXt']);
	});

	it('is accepted by the server-side upload validation', async () => {
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
		const fresh = withUploadNonce(drawnSignaturePng(), nonce);
		if (fresh === null) throw new Error('expected nonce PNG');
		const result = await new SignatureAssetApplication(
			{ resolve: async () => context },
			new InMemoryObjectStore(),
			new InMemorySignatureAssetLedger()
		).store({
			token: 'token',
			expectedEnvelopeId: context.envelopeId,
			expectedRecipientId: context.recipientId,
			pngBytes: fresh
		});
		expect(result.outcome).toBe('stored');
	});

	it('refuses bytes that are not a PNG with a leading IHDR, and malformed nonces', () => {
		expect(withUploadNonce(new Uint8Array(64), nonce)).toBeNull();
		expect(withUploadNonce(drawnSignaturePng(), 'not hex')).toBeNull();
	});

	it('recognizes only an explicit 409 problem of the exact type', async () => {
		const problem = (status: number, type: string): Response =>
			new Response(JSON.stringify({ type }), { status });
		expect(
			await isProblemOfType(
				problem(409, SIGNATURE_ASSET_EXPIRED_PROBLEM),
				SIGNATURE_ASSET_EXPIRED_PROBLEM
			)
		).toBe(true);
		expect(
			await isProblemOfType(
				problem(503, SIGNATURE_ASSET_EXPIRED_PROBLEM),
				SIGNATURE_ASSET_EXPIRED_PROBLEM
			)
		).toBe(false);
		expect(
			await isProblemOfType(
				problem(409, 'urn:signkit:problem:other'),
				SIGNATURE_ASSET_EXPIRED_PROBLEM
			)
		).toBe(false);
		expect(
			await isProblemOfType(
				new Response('not json', { status: 409 }),
				SIGNATURE_ASSET_EXPIRED_PROBLEM
			)
		).toBe(false);
	});
});

describe('signature draft', () => {
	it('prefills typed mode from the sender-provided name without committing it', () => {
		expect(draftFromCommitted('', 'Alex Rivera')).toEqual({
			mode: 'type',
			typedValue: 'Alex Rivera',
			assetRef: ''
		});
		expect(committedFromDraft(draftFromCommitted('', 'Alex Rivera'))).toBe('Alex Rivera');
	});

	it('restores a previously confirmed typed value instead of the name prefill', () => {
		expect(draftFromCommitted('Jordan Lee', 'Alex Rivera')).toEqual({
			mode: 'type',
			typedValue: 'Jordan Lee',
			assetRef: ''
		});
	});

	it('commits the trimmed typed value and rejects whitespace-only input', () => {
		expect(committedFromDraft({ mode: 'type', typedValue: '  Alex Rivera  ', assetRef: '' })).toBe(
			'Alex Rivera'
		);
		expect(committedFromDraft({ mode: 'type', typedValue: '', assetRef: '' })).toBeNull();
		expect(committedFromDraft({ mode: 'type', typedValue: '   ', assetRef: '' })).toBeNull();
		expect(committedFromDraft({ mode: 'type', typedValue: '\n\t', assetRef: '' })).toBeNull();
	});

	it('restores a previously confirmed drawn asset ref without treating it as typed text', () => {
		expect(isSignatureAssetRef(assetRef)).toBe(true);
		expect(draftFromCommitted(assetRef, 'Alex Rivera')).toEqual({
			mode: 'draw',
			typedValue: 'Alex Rivera',
			assetRef
		});
		expect(committedFromDraft(draftFromCommitted(assetRef, 'Alex Rivera'))).toBe(assetRef);
	});

	it('accepts only sig:sha256: plus 64 lowercase hex characters', () => {
		expect(isSignatureAssetRef(assetRef)).toBe(true);
		expect(isSignatureAssetRef(SIGNATURE_ASSET_REF_PREFIX)).toBe(false);
		expect(isSignatureAssetRef(`${SIGNATURE_ASSET_REF_PREFIX}${'A'.repeat(64)}`)).toBe(false);
		expect(isSignatureAssetRef(`${SIGNATURE_ASSET_REF_PREFIX}${'a'.repeat(63)}`)).toBe(false);
		expect(isSignatureAssetRef(`${SIGNATURE_ASSET_REF_PREFIX}${'a'.repeat(65)}`)).toBe(false);
		expect(isSignatureAssetRef(`${assetRef}0`)).toBe(false);
		expect(isSignatureAssetRef(`x${assetRef}`)).toBe(false);
		expect(isSignatureAssetRef(`${SIGNATURE_ASSET_REF_PREFIX}${'a'.repeat(63)}g`)).toBe(false);
		expect(
			committedFromDraft({
				mode: 'draw',
				typedValue: 'Alex Rivera',
				assetRef: `${SIGNATURE_ASSET_REF_PREFIX}not-a-digest`
			})
		).toBeNull();
	});

	it('refuses to confirm a drawn signature until a well-formed asset ref exists', () => {
		expect(
			committedFromDraft({ mode: 'draw', typedValue: 'Alex Rivera', assetRef: '' })
		).toBeNull();
	});
});
