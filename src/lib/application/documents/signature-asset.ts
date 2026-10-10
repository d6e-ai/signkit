import { emittedImageStreamBytes } from '$lib/adapters/pdf/pdf-composer';
import {
	decodePng,
	estimatePngDecodeMemory,
	isPngSignature,
	MAX_PNG_DIMENSION,
	MAX_PNG_INFLATE_SCRATCH_BYTES,
	PngDecodeError,
	type DecodedPngImage,
	type PngDecodeMemoryEstimate
} from '$lib/adapters/pdf/png-image';
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

/**
 * The signing canvas's raster (`signature-canvas.svelte`: a fixed 600 x 200
 * backing store, not scaled by device pixel ratio). The decode caps below are
 * what `png-image.ts` accounts for a PNG of this many pixels at its widest
 * supported sample format (16-bit RGBA, 8 bytes per pixel).
 */
const SIGNATURE_CANVAS_PIXELS: number = 600 * 200;

/** Decoded sample and alpha planes the composer retains per signature: at most 3 + 1 bytes per pixel. */
export const MAX_SIGNATURE_RETAINED_DECODE_BYTES: number = 4 * SIGNATURE_CANVAS_PIXELS;

/**
 * Peak decode working set per signature: the compressed copy (at most the
 * upload cap), inflated scanlines (`(8 * width + 1) * height + 1`), inflater
 * scratch, unfiltered scanlines (`8 * pixels`), and the retained planes.
 */
export const MAX_SIGNATURE_PEAK_DECODE_BYTES: number =
	MAX_SIGNATURE_ASSET_BYTES +
	(8 * SIGNATURE_CANVAS_PIXELS + MAX_PNG_DIMENSION + 1) +
	MAX_PNG_INFLATE_SCRATCH_BYTES +
	8 * SIGNATURE_CANVAS_PIXELS +
	MAX_SIGNATURE_RETAINED_DECODE_BYTES;

/**
 * Bytes one signature may occupy once the executed agreement re-deflates its
 * planes (`emittedImageStreamBytes`). The upload cap does not bound this:
 * planes are re-encoded without PNG's predictors. Holding it to the same
 * 64 KiB means an accepted asset never grows past its own upload cap inside
 * the agreement, which is what the send-time budget reserves per signature.
 */
export const MAX_SIGNATURE_EMITTED_IMAGE_BYTES: number = MAX_SIGNATURE_ASSET_BYTES;

/** `sig:sha256:` (11) + 64 hex chars = 75, well inside the 200-char signature field value budget. */
export const SIGNATURE_ASSET_REF_PREFIX: string = 'sig:sha256:';

/** The only well-formed shape a `sig:sha256:` field value may take. */
export const SIGNATURE_ASSET_REF_PATTERN: RegExp = /^sig:sha256:[a-f0-9]{64}$/;

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
 * outside Git, scoped to the exact envelope/recipient resolved from their
 * active signing capability. The returned `assetRef` is a stable
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

		// Resolve the capability and its route binding before CPU- and
		// allocation-heavy image decoding. Decoding here, rather than merely
		// sniffing magic bytes, still guarantees that an accepted asset can be
		// composited into the executed agreement later. The send-time
		// completion budget reserves decode memory and output bytes per
		// signature from the caps checked here, so they must hold for every
		// asset accepted.
		const validated: ValidatedSignaturePng = validateSignaturePngBytes(input.pngBytes);
		if (validated.outcome !== 'ok') return { outcome: validated.outcome };

		const sha256: string = await sha256Hex(input.pngBytes);
		const key: string = signatureAssetKey(context.envelopeId, context.recipientId, sha256);
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

type ValidatedSignaturePng =
	{ outcome: 'ok' } | { outcome: 'too_large' } | { outcome: 'invalid_image' };

/** The decode-cap checks `store()` applies to a fresh upload, factored out so {@link verifySignatureAssetReference} can re-apply them to bytes read back from the object store. */
function validateSignaturePngBytes(bytes: Uint8Array): ValidatedSignaturePng {
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_SIGNATURE_ASSET_BYTES) {
		return { outcome: 'too_large' };
	}
	if (!isPngSignature(bytes)) return { outcome: 'invalid_image' };
	let decoded: DecodedPngImage;
	try {
		const estimate: PngDecodeMemoryEstimate = estimatePngDecodeMemory(bytes);
		if (
			estimate.retainedBytes > MAX_SIGNATURE_RETAINED_DECODE_BYTES ||
			estimate.peakWorkingBytes > MAX_SIGNATURE_PEAK_DECODE_BYTES
		) {
			return { outcome: 'too_large' };
		}
		decoded = decodePng(bytes, { maximumWorkingBytes: MAX_SIGNATURE_PEAK_DECODE_BYTES });
	} catch (error: unknown) {
		if (error instanceof PngDecodeError) return { outcome: 'invalid_image' };
		throw error;
	}
	if (emittedImageStreamBytes(decoded) > MAX_SIGNATURE_EMITTED_IMAGE_BYTES) {
		return { outcome: 'too_large' };
	}
	return { outcome: 'ok' };
}

export type SignatureAssetReferenceCheck =
	{ outcome: 'ok' } | { outcome: 'invalid' } | { outcome: 'provider_error' };

class SignatureAssetOverflowError extends Error {}

/**
 * Re-proves a `sig:sha256:` field value against the envelope+recipient
 * scoped object it names. A field value submitted alongside a signing
 * command is only ever a claim from the recipient's browser; nothing stops a
 * forged reference from naming a key that was never actually uploaded, or a
 * sibling envelope/recipient's asset. This reads the named object back with
 * the same bounded-byte-count, SHA-256, and PNG decode-cap checks `store()`
 * applies to a fresh upload, so an accepted reference is provably the same
 * bytes the executed agreement will later composite.
 *
 * A thrown/opaque object-store failure returns `provider_error` rather than
 * `invalid`: a recipient must not have a genuine asset rejected outright
 * because the store was briefly unavailable.
 */
export async function verifySignatureAssetReference(
	objects: ObjectStore,
	envelopeId: string,
	recipientId: string,
	value: string
): Promise<SignatureAssetReferenceCheck> {
	if (!SIGNATURE_ASSET_REF_PATTERN.test(value)) return { outcome: 'invalid' };
	const sha256: string = value.slice(SIGNATURE_ASSET_REF_PREFIX.length);
	const key: string = signatureAssetKey(envelopeId, recipientId, sha256);

	let stream: ReadableStream<Uint8Array> | null;
	try {
		stream = await objects.get(key);
	} catch {
		return { outcome: 'provider_error' };
	}
	if (stream === null) return { outcome: 'invalid' };

	let bytes: Uint8Array;
	try {
		bytes = await readBoundedSignatureAsset(stream);
	} catch (error: unknown) {
		if (error instanceof SignatureAssetOverflowError) return { outcome: 'invalid' };
		return { outcome: 'provider_error' };
	}

	if ((await sha256Hex(bytes)) !== sha256) return { outcome: 'invalid' };
	return validateSignaturePngBytes(bytes).outcome === 'ok'
		? { outcome: 'ok' }
		: { outcome: 'invalid' };
}

async function readBoundedSignatureAsset(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader: ReadableStreamDefaultReader<Uint8Array> = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size: number = 0;
	try {
		for (;;) {
			const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
			if (result.done) break;
			size += result.value.byteLength;
			if (size > MAX_SIGNATURE_ASSET_BYTES) {
				await reader.cancel();
				throw new SignatureAssetOverflowError();
			}
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes: Uint8Array = new Uint8Array(size);
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

const SIGNATURE_ASSET_KEY_PATTERN: RegExp =
	/^signature-assets\/v1\/envelopes\/([^/]+)\/recipients\/([^/]+)\/sha256\/([a-f0-9]{64})\.png$/;
const SHA256_HEX_PATTERN: RegExp = /^[a-f0-9]{64}$/;

export function signatureAssetKey(envelopeId: string, recipientId: string, sha256: string): string {
	return `signature-assets/v1/envelopes/${encodeScopeSegment(envelopeId)}/recipients/${encodeScopeSegment(recipientId)}/sha256/${sha256}.png`;
}

export interface ParsedSignatureAssetKey {
	envelopeId: string;
	recipientId: string;
	sha256: string;
}

export function parseSignatureAssetKey(key: string): ParsedSignatureAssetKey | null {
	const match: RegExpExecArray | null = SIGNATURE_ASSET_KEY_PATTERN.exec(key);
	if (match === null) return null;
	try {
		const parsed: ParsedSignatureAssetKey = {
			envelopeId: decodeURIComponent(match[1]),
			recipientId: decodeURIComponent(match[2]),
			sha256: match[3]
		};
		if (signatureAssetKey(parsed.envelopeId, parsed.recipientId, parsed.sha256) !== key) {
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
		const key: string = signatureAssetKey(row.envelopeId, row.recipientId, sha256);
		if (wanted.has(key)) referenced.add(key);
	}
	return referenced;
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
