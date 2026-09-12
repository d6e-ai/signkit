/**
 * The single source of unprefixed opaque high-entropy tokens.
 *
 * OAuth CSRF state and invitation/completion worker lease claim tokens are
 * minted here. These values are canonical unpadded base64url over at least 32
 * cryptographic random bytes — 256 bits, with no embedded time and no
 * structure to correlate.
 *
 * They are deliberately not identifiers and not UUIDs. A UUIDv7 identifier
 * carries only 74 random bits and leaks its creation millisecond, so
 * persistent row identifiers (`$lib/ids/uuid-v7`) and this helper never share
 * a generator. Prefixed credentials (`skr1_`, `skca1_`, `signkit_`) keep their
 * existing issuance modules. Caller-chosen idempotency keys are opaque by
 * semantics but are not minted here: first-party browsers use
 * `crypto.randomUUID()` UUIDv4, and the server accepts bounded arbitrary keys
 * without parsing UUID structure.
 *
 * Web Crypto is the only entropy source. Node 22, Cloudflare Workers, Vercel,
 * and browsers all provide `crypto.getRandomValues`; if a runtime does not,
 * minting fails loudly instead of degrading to a predictable fallback.
 */

/** 256 bits: the floor for every token minted here. */
export const OPAQUE_TOKEN_BYTES: number = 32;

/** Canonical unpadded base64url encoding of {@link OPAQUE_TOKEN_BYTES} bytes. */
export const OPAQUE_TOKEN_PATTERN: RegExp = /^[A-Za-z0-9_-]{43}$/;

export type OpaqueTokenGenerator = () => string;

export interface OpaqueTokenGeneratorOptions {
	/** Random bytes per token. Defaults to {@link OPAQUE_TOKEN_BYTES}; never lower. */
	byteLength?: number;
	/** Returns `byteLength` cryptographic random bytes. Defaults to Web Crypto. */
	randomBytes?: (byteLength: number) => Uint8Array;
}

/** Raised when no cryptographic entropy source is available or usable. */
export class InsecureEntropyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InsecureEntropyError';
	}
}

/**
 * Fills a buffer from Web Crypto, failing explicitly when the runtime exposes
 * no cryptographic generator.
 */
export function randomTokenBytes(byteLength: number = OPAQUE_TOKEN_BYTES): Uint8Array<ArrayBuffer> {
	assertByteLength(byteLength);
	const source: Crypto | undefined = globalThis.crypto;
	if (source === undefined || typeof source.getRandomValues !== 'function') {
		throw new InsecureEntropyError('This runtime provides no cryptographic random source');
	}
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(byteLength));
	source.getRandomValues(bytes);
	return bytes;
}

/** Canonical unpadded base64url, the encoding every token from this helper uses. */
export function base64UrlEncode(bytes: Uint8Array): string {
	let binary: string = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * Creates an independent generator. Tests inject `randomBytes`; production
 * uses Web Crypto. An entropy source that returns the wrong number of bytes is
 * a fault, not something to pad around.
 */
export function createOpaqueTokenGenerator(
	options: OpaqueTokenGeneratorOptions = {}
): OpaqueTokenGenerator {
	const byteLength: number = options.byteLength ?? OPAQUE_TOKEN_BYTES;
	assertByteLength(byteLength);
	const randomBytes: (byteLength: number) => Uint8Array = options.randomBytes ?? randomTokenBytes;

	return function nextOpaqueToken(): string {
		const bytes: Uint8Array = randomBytes(byteLength);
		if (bytes.length !== byteLength) {
			throw new InsecureEntropyError(`An opaque token requires exactly ${byteLength} random bytes`);
		}
		return base64UrlEncode(bytes);
	};
}

/** The process-wide generator for OAuth state and delivery lease claim tokens. */
export const newOpaqueToken: OpaqueTokenGenerator = createOpaqueTokenGenerator();

export function isOpaqueToken(value: string): boolean {
	return OPAQUE_TOKEN_PATTERN.test(value);
}

function assertByteLength(byteLength: number): void {
	if (!Number.isSafeInteger(byteLength) || byteLength < OPAQUE_TOKEN_BYTES) {
		throw new InsecureEntropyError(`An opaque token needs at least ${OPAQUE_TOKEN_BYTES} bytes`);
	}
}
