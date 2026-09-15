export const MAX_UPLOADED_PDF_BYTES: number = 20 * 1024 * 1024;
export const MAX_UPLOADED_PDF_PAGES: number = 400;
export const MAX_UPLOADED_PDF_PAGE_DIMENSION: number = 20_000;
export const MAX_UPLOADED_DOCUMENTS_PER_ENVELOPE: number = 20;
export const UPLOADED_PDF_CONTENT_TYPE: string = 'application/pdf';

const SHA256_PATTERN: RegExp = /^[a-f0-9]{64}$/;
const UPLOADED_PDF_KEY_PATTERN: RegExp =
	/^uploaded-documents\/v1\/organizations\/([^/]+)\/envelopes\/([^/]+)\/sha256\/([a-f0-9]{64})\.pdf$/;

export class UploadedPdfError extends Error {
	readonly code = 'UPLOADED_PDF_ERROR';

	constructor(message: string) {
		super(message);
		this.name = 'UploadedPdfError';
	}
}

export function uploadedPdfObjectKey(
	organizationId: string,
	envelopeId: string,
	sha256: string
): string {
	if (!SHA256_PATTERN.test(sha256)) throw new UploadedPdfError('Uploaded PDF digest is invalid');
	assertScopeSegment(organizationId, 'organization');
	assertScopeSegment(envelopeId, 'envelope');
	return `uploaded-documents/v1/organizations/${encodeScopeSegment(organizationId)}/envelopes/${encodeScopeSegment(envelopeId)}/sha256/${sha256}.pdf`;
}

export interface ParsedUploadedPdfKey {
	organizationId: string;
	envelopeId: string;
	sha256: string;
}

export function parseUploadedPdfObjectKey(key: string): ParsedUploadedPdfKey | null {
	const match: RegExpExecArray | null = UPLOADED_PDF_KEY_PATTERN.exec(key);
	if (match === null) return null;
	try {
		const parsed: ParsedUploadedPdfKey = {
			organizationId: decodeURIComponent(match[1]),
			envelopeId: decodeURIComponent(match[2]),
			sha256: match[3]
		};
		if (uploadedPdfObjectKey(parsed.organizationId, parsed.envelopeId, parsed.sha256) !== key) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

function assertScopeSegment(value: string, kind: 'organization' | 'envelope'): void {
	const byteLength: number = new TextEncoder().encode(value).byteLength;
	if (value.length === 0 || byteLength > 256) {
		throw new UploadedPdfError(`Invalid ${kind} identifier`);
	}
	for (let index = 0; index < value.length; index += 1) {
		const code: number = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) {
			throw new UploadedPdfError(`Invalid ${kind} identifier`);
		}
	}
}

function encodeScopeSegment(value: string): string {
	return encodeURIComponent(value).replaceAll('.', '%2E');
}
