export const BEARER_SECRET_PATTERN: RegExp = /^[\x21-\x7e]{32,200}$/;

export function parseBearerSecret(header: string | null): string | null {
	if (header === null) return null;
	const match: RegExpExecArray | null = /^Bearer ([\x21-\x7e]{32,200})$/.exec(header);
	return match?.[1] ?? null;
}

export async function secretsEqual(presented: string, expected: string): Promise<boolean> {
	const [presentedDigest, expectedDigest]: [ArrayBuffer, ArrayBuffer] = await Promise.all([
		sha256(presented),
		sha256(expected)
	]);
	const left: Uint8Array = new Uint8Array(presentedDigest);
	const right: Uint8Array = new Uint8Array(expectedDigest);
	let difference: number = left.byteLength ^ right.byteLength;
	const length: number = Math.max(left.byteLength, right.byteLength);
	for (let index: number = 0; index < length; index += 1) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return difference === 0;
}

export function isStrictSecret(value: string | undefined): boolean {
	return value !== undefined && BEARER_SECRET_PATTERN.test(value);
}

function sha256(value: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
}
