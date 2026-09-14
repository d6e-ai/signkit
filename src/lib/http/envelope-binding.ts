import { isUuidV7 } from '$lib/ids/uuid-v7';

/**
 * Returns the envelope ID only when every provided source is a canonical
 * lowercase UUIDv7 and all of them are equal. A path/body/query mismatch,
 * a missing set of sources, or a non-UUIDv7 value fails closed.
 */
export function boundEnvelopeId(
	...candidates: readonly (string | null | undefined)[]
): string | null {
	let envelopeId: string | null = null;
	for (const candidate of candidates) {
		if (candidate === null || candidate === undefined) continue;
		if (!isUuidV7(candidate)) return null;
		if (envelopeId === null) {
			envelopeId = candidate;
			continue;
		}
		if (candidate !== envelopeId) return null;
	}
	return envelopeId;
}
