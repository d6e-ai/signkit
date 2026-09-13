/**
 * Shared zero-PII request fingerprinting for instance command application
 * services (invitations, member administration): deterministic canonical
 * JSON serialization plus a SHA-256 hex digest over it.
 */

/** Deterministic canonical JSON serialization with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortJsonKeys(value));
}

function sortJsonKeys(value: unknown): unknown {
	if (value === null || typeof value !== 'object') {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(sortJsonKeys);
	}
	const sortedEntries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
		a.localeCompare(b)
	);
	const sortedObj: Record<string, unknown> = {};
	for (const [key, val] of sortedEntries) {
		sortedObj[key] = sortJsonKeys(val);
	}
	return sortedObj;
}

export async function sha256Hex(value: string): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value)
	);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
