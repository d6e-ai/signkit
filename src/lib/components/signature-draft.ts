import { SIGNATURE_ASSET_REF_PREFIX } from '$lib/application/documents/signature-asset';

export type SignatureMode = 'type' | 'draw';

export interface SignatureDraft {
	mode: SignatureMode;
	typedValue: string;
	assetRef: string;
}

const SIGNATURE_ASSET_REF_PATTERN: RegExp = new RegExp(
	`^${SIGNATURE_ASSET_REF_PREFIX}[a-f0-9]{64}$`
);

export function isSignatureAssetRef(value: string): boolean {
	return SIGNATURE_ASSET_REF_PATTERN.test(value);
}

export function draftFromCommitted(committed: string, recipientName: string): SignatureDraft {
	if (isSignatureAssetRef(committed)) {
		return { mode: 'draw', typedValue: recipientName, assetRef: committed };
	}
	if (committed.trim().length > 0) {
		return { mode: 'type', typedValue: committed, assetRef: '' };
	}
	return { mode: 'type', typedValue: recipientName, assetRef: '' };
}

export function committedFromDraft(draft: SignatureDraft): string | null {
	if (draft.mode === 'type') {
		const trimmed: string = draft.typedValue.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	if (isSignatureAssetRef(draft.assetRef)) return draft.assetRef;
	return null;
}
