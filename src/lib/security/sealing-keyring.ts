const KEY_BYTES: number = 32;

export interface LoadedSealingKey {
	readonly keyId: string;
	readonly cryptoKey: CryptoKey;
}

/**
 * Shared active+previous AES-256-GCM keyring for every encrypted cookie/token
 * purpose (delivery capability, completion token, recipient-session cookie,
 * declined-receipt cookie). Rotation is: promote a new active key, keep the
 * old one as "previous" so in-flight ciphertext can still be opened, run the
 * bounded reseal sweep to migrate outstanding rows onto the active key, then
 * retire the previous key once nothing references it anymore.
 *
 * Open is fail-closed by explicit key ID: a caller must name the key ID a
 * ciphertext claims to be sealed under, and this keyring only ever decrypts
 * with the exact key matching that ID (active or previous) — it never tries
 * keys speculatively, so a wrong or unknown ID never falls through to a
 * different key's AEAD tag check.
 *
 * Takes already-derived raw key bytes rather than an encoded env var, so
 * callers that HKDF-derive a purpose-specific subkey (recipient-session,
 * declined-receipt cookies) can still share this fail-closed open/reseal
 * logic without this class knowing about derivation at all.
 */
export class AesGcmSealingKeyring {
	readonly #active: Promise<LoadedSealingKey>;
	readonly #previous: Promise<LoadedSealingKey | null>;

	constructor(
		activeKeyBytes: Uint8Array<ArrayBuffer>,
		previousKeyBytes: Uint8Array<ArrayBuffer> | null
	) {
		this.#active = importKey(activeKeyBytes);
		this.#previous =
			previousKeyBytes === null ? Promise.resolve(null) : importKey(previousKeyBytes);
	}

	async activeKeyId(): Promise<string> {
		return (await this.#active).keyId;
	}

	async isKnownKeyId(keyId: string): Promise<boolean> {
		if (keyId === (await this.#active).keyId) return true;
		const previous: LoadedSealingKey | null = await this.#previous;
		return previous !== null && keyId === previous.keyId;
	}

	async isActiveKeyId(keyId: string): Promise<boolean> {
		return keyId === (await this.#active).keyId;
	}

	async sealWithActive(
		plaintext: Uint8Array<ArrayBuffer>,
		aad: Uint8Array<ArrayBuffer>
	): Promise<SealedPayload> {
		const active: LoadedSealingKey = await this.#active;
		return { ...(await encrypt(active.cryptoKey, plaintext, aad)), keyId: active.keyId };
	}

	/**
	 * Fails closed: an unknown `keyId` (neither active nor previous) throws
	 * before any AEAD operation is attempted, and a known key ID whose tag
	 * does not verify also throws. There is no fallback path that tries a
	 * different key than the one the ciphertext claims.
	 */
	async openWithKeyId(
		keyId: string,
		iv: Uint8Array<ArrayBuffer>,
		ciphertext: Uint8Array<ArrayBuffer>,
		aad: Uint8Array<ArrayBuffer>
	): Promise<Uint8Array<ArrayBuffer>> {
		const active: LoadedSealingKey = await this.#active;
		if (keyId === active.keyId) return decrypt(active.cryptoKey, iv, ciphertext, aad);
		const previous: LoadedSealingKey | null = await this.#previous;
		if (previous !== null && keyId === previous.keyId) {
			return decrypt(previous.cryptoKey, iv, ciphertext, aad);
		}
		throw new UnknownSealingKeyError();
	}
}

/**
 * Constructs a keyring directly from base64-encoded 32-byte env var values,
 * the shape used by the delivery capability and completion token sealers.
 * Decodes synchronously so a malformed key throws immediately from the
 * caller's constructor rather than as a later unhandled rejection.
 */
export function sealingKeyringFromEncodedEnv(
	activeEncodedKey: string,
	previousEncodedKey: string | undefined,
	envVarName: string
): AesGcmSealingKeyring {
	const activeBytes: Uint8Array<ArrayBuffer> = decodeBase64SealingKey(activeEncodedKey, envVarName);
	const previousBytes: Uint8Array<ArrayBuffer> | null =
		previousEncodedKey === undefined || previousEncodedKey.trim().length === 0
			? null
			: decodeBase64SealingKey(previousEncodedKey, `${envVarName}_PREVIOUS`);
	return new AesGcmSealingKeyring(activeBytes, previousBytes);
}

export interface SealedPayload {
	readonly iv: Uint8Array<ArrayBuffer>;
	readonly ciphertext: Uint8Array<ArrayBuffer>;
	readonly keyId: string;
}

export class UnknownSealingKeyError extends Error {
	constructor() {
		super('Ciphertext references a sealing key outside the active/previous keyring');
		this.name = 'UnknownSealingKeyError';
	}
}

async function encrypt(
	cryptoKey: CryptoKey,
	plaintext: Uint8Array<ArrayBuffer>,
	aad: Uint8Array<ArrayBuffer>
): Promise<{ iv: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer> }> {
	const iv: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
	const ciphertext: ArrayBuffer = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: aad },
		cryptoKey,
		plaintext
	);
	return { iv, ciphertext: new Uint8Array(ciphertext) };
}

async function decrypt(
	cryptoKey: CryptoKey,
	iv: Uint8Array<ArrayBuffer>,
	ciphertext: Uint8Array<ArrayBuffer>,
	aad: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
	const plaintext: ArrayBuffer = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv, additionalData: aad },
		cryptoKey,
		ciphertext
	);
	return new Uint8Array(plaintext);
}

async function importKey(bytes: Uint8Array<ArrayBuffer>): Promise<LoadedSealingKey> {
	const keyId: string = (await sha256Hex(bytes)).slice(0, 16);
	const cryptoKey: CryptoKey = await crypto.subtle.importKey(
		'raw',
		bytes,
		{ name: 'AES-GCM' },
		false,
		['encrypt', 'decrypt']
	);
	return { keyId, cryptoKey };
}

export function decodeBase64SealingKey(
	encodedKey: string,
	envVarName: string
): Uint8Array<ArrayBuffer> {
	let binary: string;
	try {
		binary = atob(encodedKey.trim());
	} catch {
		throw new Error(`${envVarName} must be valid base64`);
	}
	if (binary.length !== KEY_BYTES) {
		throw new Error(`${envVarName} must encode exactly 32 bytes`);
	}
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(KEY_BYTES));
	for (let index: number = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
