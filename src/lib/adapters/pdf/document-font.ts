import { gunzipSync } from 'fflate';
import {
	DOCUMENT_FONT_BYTE_LENGTH,
	DOCUMENT_FONT_GZIP_BASE64,
	DOCUMENT_FONT_SHA256
} from './fonts/document-font';
import { TrueTypeFont, TrueTypeFontError } from './truetype-font';

/**
 * The single typeface SignKit renders agreement PDFs with.
 *
 * It ships inside the deployment bundle, gzipped and base64-encoded, because
 * the renderer has to work identically on Cloudflare Workers, Node, and
 * Vercel, and because fetching a typeface from another origin while a
 * recipient reads their agreement would leak both the fact of the reading and
 * a dependency on a third party staying up. Inflating ~1.4 MB costs a few
 * milliseconds, so it happens once per isolate and is then cached.
 */
let cached: TrueTypeFont | null = null;

export function documentFont(): TrueTypeFont {
	if (cached !== null) return cached;
	const compressed: Uint8Array = decodeBase64(DOCUMENT_FONT_GZIP_BASE64);
	const bytes: Uint8Array = gunzipSync(compressed);
	if (bytes.byteLength !== DOCUMENT_FONT_BYTE_LENGTH) {
		throw new TrueTypeFontError('Bundled document font has an unexpected length');
	}
	cached = new TrueTypeFont(bytes);
	return cached;
}

/** Verifies the bundled artifact against its recorded digest. Used by tests. */
export async function verifyDocumentFontDigest(): Promise<boolean> {
	const bytes: Uint8Array = gunzipSync(decodeBase64(DOCUMENT_FONT_GZIP_BASE64));
	const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
	const hex: string = Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
	return hex === DOCUMENT_FONT_SHA256;
}

function decodeBase64(encoded: string): Uint8Array {
	const binary: string = atob(encoded);
	const bytes: Uint8Array = new Uint8Array(binary.length);
	for (let index: number = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}
