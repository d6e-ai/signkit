import { describe, expect, it } from 'vitest';
import { SIGNATURE_ASSET_REF_PREFIX } from '$lib/application/documents/signature-asset';
import { committedFromDraft, draftFromCommitted, isSignatureAssetRef } from './signature-draft';

const assetRef = `${SIGNATURE_ASSET_REF_PREFIX}${'a'.repeat(64)}`;

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
