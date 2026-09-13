import { isCompletionToken } from './completion-token';
import { AesGcmSealingKeyring, sealingKeyringFromEncodedEnv, sha256Hex } from './sealing-keyring';

const FORMAT_PREFIX: string = 'skcd1_';
const IV_BYTES: number = 12;
const DOMAIN_SEPARATOR: string = 'signkit-completion-delivery-v1';
const ENV_VAR_NAME: string = 'DELIVERY_ENCRYPTION_KEY';

export interface CompletionTokenSealContext {
	organizationId: string;
	envelopeId: string;
	recipientId: string;
	deliveryId: string;
}

export interface SealedCompletionToken {
	sealedToken: string;
	sealingKeyId: string;
	sealedTokenSha256: string;
}

export interface CompletionTokenSealer {
	currentSealingKeyId(): Promise<string>;
	seal(token: string, context: CompletionTokenSealContext): Promise<SealedCompletionToken>;
}

export interface CompletionTokenOpener {
	currentSealingKeyId(): Promise<string>;
	isKnownSealingKeyId(keyId: string): Promise<boolean>;
	open(
		sealedToken: string,
		context: CompletionTokenSealContext,
		sealingKeyId: string
	): Promise<string>;
}

/**
 * Active+previous keyring for completion delivery token ciphertext, sharing
 * the same `DELIVERY_ENCRYPTION_KEY`/`DELIVERY_ENCRYPTION_KEY_PREVIOUS`
 * master key material as {@link AesGcmRecipientCapabilitySealer} — purpose
 * separation comes entirely from the format prefix and AAD, never a
 * different key. Opening is fail-closed by explicit `sealingKeyId`.
 */
export class AesGcmCompletionTokenSealer implements CompletionTokenSealer, CompletionTokenOpener {
	readonly #keyring: AesGcmSealingKeyring;

	constructor(activeEncodedKey: string, previousEncodedKey?: string) {
		this.#keyring = sealingKeyringFromEncodedEnv(
			activeEncodedKey,
			previousEncodedKey,
			ENV_VAR_NAME
		);
	}

	async currentSealingKeyId(): Promise<string> {
		return await this.#keyring.activeKeyId();
	}

	async isKnownSealingKeyId(keyId: string): Promise<boolean> {
		return await this.#keyring.isKnownKeyId(keyId);
	}

	async needsReseal(keyId: string): Promise<boolean> {
		return !(await this.#keyring.isActiveKeyId(keyId));
	}

	async seal(token: string, context: CompletionTokenSealContext): Promise<SealedCompletionToken> {
		if (!isCompletionToken(token)) {
			throw new Error('Invalid completion token');
		}
		const plaintext: Uint8Array<ArrayBuffer> = new TextEncoder().encode(token);
		const sealed = await this.#keyring.sealWithActive(plaintext, additionalData(context));
		const payload: Uint8Array<ArrayBuffer> = new Uint8Array(
			new ArrayBuffer(sealed.iv.byteLength + sealed.ciphertext.byteLength)
		);
		payload.set(sealed.iv, 0);
		payload.set(sealed.ciphertext, sealed.iv.byteLength);
		const sealedToken: string = `${FORMAT_PREFIX}${base64UrlEncode(payload)}`;
		return {
			sealedToken,
			sealingKeyId: sealed.keyId,
			sealedTokenSha256: await sha256Hex(new TextEncoder().encode(sealedToken))
		};
	}

	async open(
		sealedToken: string,
		context: CompletionTokenSealContext,
		sealingKeyId: string
	): Promise<string> {
		if (!sealedToken.startsWith(FORMAT_PREFIX)) {
			throw new Error('Invalid sealed completion token');
		}
		const payload: Uint8Array<ArrayBuffer> = base64UrlDecode(
			sealedToken.slice(FORMAT_PREFIX.length)
		);
		if (payload.byteLength <= IV_BYTES + 16) {
			throw new Error('Invalid sealed completion token');
		}
		const iv: Uint8Array<ArrayBuffer> = payload.slice(0, IV_BYTES);
		const ciphertext: Uint8Array<ArrayBuffer> = payload.slice(IV_BYTES);
		let plaintext: Uint8Array;
		try {
			plaintext = await this.#keyring.openWithKeyId(
				sealingKeyId,
				iv,
				ciphertext,
				additionalData(context)
			);
		} catch {
			throw new Error('Sealed completion token authentication failed');
		}
		const token: string = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
		if (!isCompletionToken(token)) {
			throw new Error('Invalid completion token');
		}
		return token;
	}

	/** Re-encrypts under the active key for the bounded reseal sweep only. */
	async reseal(token: string, context: CompletionTokenSealContext): Promise<SealedCompletionToken> {
		return this.seal(token, context);
	}
}

function additionalData(context: CompletionTokenSealContext): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(
		[
			DOMAIN_SEPARATOR,
			context.organizationId,
			context.envelopeId,
			context.recipientId,
			context.deliveryId
		].join('\0')
	);
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary: string = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new Error('Invalid sealed completion token');
	}
	const padded: string = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`;
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		throw new Error('Invalid sealed completion token');
	}
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index: number = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}
