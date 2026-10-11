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

/** Problem type the upload endpoint returns when these exact bytes were retired. */
export const SIGNATURE_ASSET_EXPIRED_PROBLEM: string =
	'urn:signkit:problem:signature-asset-expired';

/** Problem type the sign endpoint returns when a submitted drawn asset was retired. */
export const SIGNED_ASSET_EXPIRED_PROBLEM: string =
	'urn:signkit:problem:recipient-signed-signature-asset-expired';

/** True only for an explicit problem document of exactly `type`; anything else is ambiguous. */
export async function isProblemOfType(response: Response, type: string): Promise<boolean> {
	if (response.status !== 409) return false;
	try {
		const body: unknown = await response.clone().json();
		return (
			typeof body === 'object' && body !== null && (body as Record<string, unknown>).type === type
		);
	} catch {
		return false;
	}
}

const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_IHDR_END: number = PNG_SIGNATURE.length + 8 + 13 + 4;
const UPLOAD_NONCE_KEYWORD: string = 'signkit-upload-nonce';

/**
 * Returns the same image with a `tEXt` chunk carrying `nonce` inserted after
 * IHDR. Ancillary text never changes decoded pixels, so the visible signature
 * is identical while the bytes -- and therefore the content-addressed key --
 * are fresh. Used only to recover from an explicit retired-key refusal; every
 * other upload sends the canvas bytes unchanged. Returns null for input that
 * does not start with a well-formed PNG signature and IHDR chunk.
 */
export function withUploadNonce(png: Uint8Array, nonce: string): Uint8Array<ArrayBuffer> | null {
	if (png.byteLength < PNG_IHDR_END) return null;
	for (let index: number = 0; index < PNG_SIGNATURE.length; index += 1) {
		if (png[index] !== PNG_SIGNATURE[index]) return null;
	}
	const ihdrLength: number = new DataView(png.buffer, png.byteOffset + 8, 4).getUint32(0);
	const ihdrType: string = String.fromCharCode(...png.subarray(12, 16));
	if (ihdrLength !== 13 || ihdrType !== 'IHDR' || !/^[0-9a-f]{1,64}$/.test(nonce)) return null;

	const text: string = `${UPLOAD_NONCE_KEYWORD}\0${nonce}`;
	const chunk: Uint8Array = new Uint8Array(12 + text.length);
	const view: DataView = new DataView(chunk.buffer);
	view.setUint32(0, text.length);
	for (const [offset, character] of [...`tEXt${text}`].entries()) {
		chunk[4 + offset] = character.charCodeAt(0);
	}
	view.setUint32(8 + text.length, crc32(chunk.subarray(4, 8 + text.length)));

	const result: Uint8Array<ArrayBuffer> = new Uint8Array(png.byteLength + chunk.byteLength);
	result.set(png.subarray(0, PNG_IHDR_END), 0);
	result.set(chunk, PNG_IHDR_END);
	result.set(png.subarray(PNG_IHDR_END), PNG_IHDR_END + chunk.byteLength);
	return result;
}

function crc32(bytes: Uint8Array): number {
	let crc: number = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit: number = 0; bit < 8; bit += 1) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}
