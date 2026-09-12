import type { ZodIssue } from 'zod';
import type { ProblemValidationError } from './problem';

export type JsonBodyResult =
	{ ok: true; value: unknown } | { ok: false; reason: 'invalid' | 'too_large' };

/**
 * Reads a request body up to `maxBytes`, cancelling the underlying stream as
 * soon as the limit is exceeded so an oversized upload is not read to
 * completion. Any stream read error (network abort, protocol violation) and
 * any non-UTF-8 or non-JSON payload both classify as `invalid` rather than
 * throwing, so callers can map them to a bounded RFC 9457 response.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBodyResult> {
	const contentLength: string | null = request.headers.get('content-length');
	if (contentLength !== null) {
		const declaredBytes: number = Number(contentLength);
		if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
			return { ok: false, reason: 'too_large' };
		}
	}
	if (request.body === null) return { ok: false, reason: 'invalid' };

	const reader: ReadableStreamDefaultReader<Uint8Array> = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes: number = 0;
	try {
		while (true) {
			const next: ReadableStreamReadResult<Uint8Array> = await reader.read();
			if (next.done) break;
			totalBytes += next.value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel('request body exceeded the configured limit');
				return { ok: false, reason: 'too_large' };
			}
			chunks.push(next.value);
		}
	} catch {
		return { ok: false, reason: 'invalid' };
	} finally {
		reader.releaseLock();
	}

	const bytes: Uint8Array = new Uint8Array(totalBytes);
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	try {
		return {
			ok: true,
			value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
		};
	} catch {
		return { ok: false, reason: 'invalid' };
	}
}

export function acceptsJson(request: Request): boolean {
	return (
		request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
		'application/json'
	);
}

/**
 * `prefixRoot` reproduces each endpoint's existing (pre-extraction) error
 * shape: bootstrap emits JSON-Pointer-style `$.field` paths while the other
 * endpoints emit bare `field` paths. Both keep the `$` sentinel at the root.
 */
export function validationErrors(
	issues: readonly ZodIssue[],
	prefixRoot: boolean = false
): readonly ProblemValidationError[] {
	return issues.map((issue: ZodIssue): ProblemValidationError => {
		if (issue.path.length === 0) return { path: '$', message: issue.message };
		const joined: string = issue.path.join('.');
		return { path: prefixRoot ? `$.${joined}` : joined, message: issue.message };
	});
}
