import type { RecipientAccessApplicationPort } from '$lib/application/signing/recipient-access';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';

/**
 * Bounded raster budget for a drawn signature. Large enough for a compressed
 * PNG of a simple line drawing at a modest device pixel ratio, small enough
 * to keep the recipient-signed field value's underlying image bounded and
 * fast to fetch when an operator reviews a completed envelope.
 */
export const MAX_SIGNATURE_ASSET_BYTES: number = 64 * 1024;

const PNG_MAGIC: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** `sig:sha256:` (11) + 64 hex chars = 75, well inside the 200-char signature field value budget. */
export const SIGNATURE_ASSET_REF_PREFIX: string = 'sig:sha256:';

export interface StoreSignatureAssetInput {
	token: string;
	expectedEnvelopeId: string;
	expectedRecipientId: string;
	pngBytes: Uint8Array;
}

export type StoreSignatureAssetResult =
	| { outcome: 'stored'; assetRef: string }
	| { outcome: 'not_found' }
	| { outcome: 'context_mismatch' }
	| { outcome: 'too_large' }
	| { outcome: 'invalid_image' }
	| { outcome: 'integrity_error' };

export interface SignatureAssetApplicationPort {
	store(input: StoreSignatureAssetInput): Promise<StoreSignatureAssetResult>;
}

/**
 * Stores a recipient's drawn signature as a bounded, content-addressed PNG
 * outside Git, scoped to the exact organization/envelope/recipient resolved
 * from their active signing capability. The returned `assetRef` is a stable
 * reference short enough to travel as an ordinary "signature" field value
 * through the existing recipient-signed command, so no change to that
 * command's field-value contract is required.
 *
 * Content addressing makes this operation naturally idempotent: re-uploading
 * identical bytes writes the same immutable key, so no separate replay ledger
 * is needed the way stateful commands require one.
 */
export class SignatureAssetApplication implements SignatureAssetApplicationPort {
	constructor(
		private readonly access: RecipientAccessApplicationPort,
		private readonly objects: ObjectStore,
		private readonly now: () => Date = (): Date => new Date()
	) {}

	async store(input: StoreSignatureAssetInput): Promise<StoreSignatureAssetResult> {
		if (input.pngBytes.byteLength === 0 || input.pngBytes.byteLength > MAX_SIGNATURE_ASSET_BYTES) {
			return { outcome: 'too_large' };
		}
		if (!isPngSignature(input.pngBytes)) return { outcome: 'invalid_image' };

		const context: RecipientSigningContext | null = await this.access.resolve(
			input.token,
			this.now().toISOString()
		);
		if (context === null) return { outcome: 'not_found' };
		if (
			context.envelopeId !== input.expectedEnvelopeId ||
			context.recipientId !== input.expectedRecipientId
		) {
			return { outcome: 'context_mismatch' };
		}

		const sha256: string = await sha256Hex(input.pngBytes);
		const key: string = signatureAssetKey(
			context.organizationId,
			context.envelopeId,
			context.recipientId,
			sha256
		);
		try {
			const stored: ObjectMetadata = await this.objects.putImmutable(key, {
				contentType: 'image/png',
				body: input.pngBytes,
				sha256
			});
			if (stored.key !== key || stored.sha256 !== sha256) return { outcome: 'integrity_error' };
		} catch {
			return { outcome: 'integrity_error' };
		}
		return { outcome: 'stored', assetRef: `${SIGNATURE_ASSET_REF_PREFIX}${sha256}` };
	}
}

const SIGNATURE_ASSET_KEY_PATTERN: RegExp =
	/^signature-assets\/v1\/organizations\/([^/]+)\/envelopes\/([^/]+)\/recipients\/([^/]+)\/sha256\/([a-f0-9]{64})\.png$/;
const SHA256_HEX_PATTERN: RegExp = /^[a-f0-9]{64}$/;

export function signatureAssetKey(
	organizationId: string,
	envelopeId: string,
	recipientId: string,
	sha256: string
): string {
	return `signature-assets/v1/organizations/${encodeScopeSegment(organizationId)}/envelopes/${encodeScopeSegment(envelopeId)}/recipients/${encodeScopeSegment(recipientId)}/sha256/${sha256}.png`;
}

export interface ParsedSignatureAssetKey {
	organizationId: string;
	envelopeId: string;
	recipientId: string;
	sha256: string;
}

export function parseSignatureAssetKey(key: string): ParsedSignatureAssetKey | null {
	const match: RegExpExecArray | null = SIGNATURE_ASSET_KEY_PATTERN.exec(key);
	if (match === null) return null;
	try {
		const parsed: ParsedSignatureAssetKey = {
			organizationId: decodeURIComponent(match[1]),
			envelopeId: decodeURIComponent(match[2]),
			recipientId: decodeURIComponent(match[3]),
			sha256: match[4]
		};
		if (
			signatureAssetKey(
				parsed.organizationId,
				parsed.envelopeId,
				parsed.recipientId,
				parsed.sha256
			) !== key
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

export function signatureAssetRefValueJson(sha256: string): string {
	return JSON.stringify(`${SIGNATURE_ASSET_REF_PREFIX}${sha256}`);
}

export function referencedSignatureAssetKeys(
	candidates: readonly string[],
	fieldValues: readonly {
		organizationId: string;
		envelopeId: string;
		recipientId: string;
		valueJson: string;
	}[]
): Set<string> {
	const wanted: Set<string> = new Set(
		candidates.filter((key: string): boolean => parseSignatureAssetKey(key) !== null)
	);
	const referenced: Set<string> = new Set();
	if (wanted.size === 0) return referenced;
	for (const row of fieldValues) {
		let value: unknown;
		try {
			value = JSON.parse(row.valueJson);
		} catch {
			continue;
		}
		if (typeof value !== 'string' || !value.startsWith(SIGNATURE_ASSET_REF_PREFIX)) continue;
		const sha256: string = value.slice(SIGNATURE_ASSET_REF_PREFIX.length);
		if (!SHA256_HEX_PATTERN.test(sha256)) continue;
		const key: string = signatureAssetKey(
			row.organizationId,
			row.envelopeId,
			row.recipientId,
			sha256
		);
		if (wanted.has(key)) referenced.add(key);
	}
	return referenced;
}

function isPngSignature(bytes: Uint8Array): boolean {
	if (bytes.byteLength < PNG_MAGIC.length) return false;
	return PNG_MAGIC.every((expected: number, index: number): boolean => bytes[index] === expected);
}

function encodeScopeSegment(value: string): string {
	return encodeURIComponent(value).replaceAll('.', '%2E');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
