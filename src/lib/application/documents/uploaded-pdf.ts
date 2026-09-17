export const MAX_UPLOADED_PDF_BYTES: number = 20 * 1024 * 1024;
export const MAX_UPLOADED_PDF_PAGES: number = 400;
export const MAX_UPLOADED_PDF_PAGE_DIMENSION: number = 20_000;
export const MAX_UPLOADED_DOCUMENTS_PER_ENVELOPE: number = 20;
export const UPLOADED_PDF_CONTENT_TYPE: string = 'application/pdf';

const SHA256_PATTERN: RegExp = /^[a-f0-9]{64}$/;
const UPLOADED_PDF_KEY_PATTERN: RegExp =
	/^uploaded-documents\/v1\/envelopes\/([^/]+)\/sha256\/([a-f0-9]{64})\.pdf$/;

export class UploadedPdfError extends Error {
	readonly code = 'UPLOADED_PDF_ERROR';

	constructor(message: string) {
		super(message);
		this.name = 'UploadedPdfError';
	}
}

export function uploadedPdfObjectKey(envelopeId: string, sha256: string): string {
	if (!SHA256_PATTERN.test(sha256)) throw new UploadedPdfError('Uploaded PDF digest is invalid');
	assertScopeSegment(envelopeId);
	return `uploaded-documents/v1/envelopes/${encodeScopeSegment(envelopeId)}/sha256/${sha256}.pdf`;
}

export interface ParsedUploadedPdfKey {
	envelopeId: string;
	sha256: string;
}

export function parseUploadedPdfObjectKey(key: string): ParsedUploadedPdfKey | null {
	const match: RegExpExecArray | null = UPLOADED_PDF_KEY_PATTERN.exec(key);
	if (match === null) return null;
	try {
		const parsed: ParsedUploadedPdfKey = {
			envelopeId: decodeURIComponent(match[1]),
			sha256: match[2]
		};
		if (uploadedPdfObjectKey(parsed.envelopeId, parsed.sha256) !== key) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

function assertScopeSegment(value: string): void {
	const byteLength: number = new TextEncoder().encode(value).byteLength;
	if (value.length === 0 || byteLength > 256) {
		throw new UploadedPdfError('Invalid envelope identifier');
	}
	for (let index = 0; index < value.length; index += 1) {
		const code: number = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) {
			throw new UploadedPdfError('Invalid envelope identifier');
		}
	}
}

function encodeScopeSegment(value: string): string {
	return encodeURIComponent(value).replaceAll('.', '%2E');
}
