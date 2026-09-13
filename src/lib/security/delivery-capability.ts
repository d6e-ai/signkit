import { isRecipientCapability } from './recipient-capability';
import { AesGcmSealingKeyring, sealingKeyringFromEncodedEnv, sha256Hex } from './sealing-keyring';

const FORMAT_PREFIX: string = 'skdc1_';
const IV_BYTES: number = 12;
const ENV_VAR_NAME: string = 'DELIVERY_ENCRYPTION_KEY';

export interface CapabilitySealContext {
	organizationId: string;
	envelopeId: string;
	recipientId: string;
	deliveryId: string;
}

export interface SealedRecipientCapability {
	sealedCapability: string;
	sealingKeyId: string;
	sealedCapabilitySha256: string;
}

export interface RecipientCapabilitySealer {
	seal(token: string, context: CapabilitySealContext): Promise<SealedRecipientCapability>;
}

/**
 * Active+previous keyring for delivery capability ciphertext. Opening is
 * fail-closed by the explicit `sealingKeyId` recorded alongside the
 * ciphertext: only the active key or the configured previous key can ever
 * decrypt, and an ID matching neither throws before any AEAD attempt.
 */
export class AesGcmRecipientCapabilitySealer implements RecipientCapabilitySealer {
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

	/** Whether `keyId` is the active key or the configured previous key. */
	async isKnownSealingKeyId(keyId: string): Promise<boolean> {
		return await this.#keyring.isKnownKeyId(keyId);
	}

	/** Whether a ciphertext recorded under `keyId` is stale and due for the reseal sweep. */
	async needsReseal(keyId: string): Promise<boolean> {
		return !(await this.#keyring.isActiveKeyId(keyId));
	}

	async seal(token: string, context: CapabilitySealContext): Promise<SealedRecipientCapability> {
		if (!isRecipientCapability(token)) throw new Error('Invalid recipient capability token');
		const plaintext: Uint8Array<ArrayBuffer> = new TextEncoder().encode(token);
		const sealed = await this.#keyring.sealWithActive(plaintext, additionalData(context));
		const payload: Uint8Array<ArrayBuffer> = new Uint8Array(
			new ArrayBuffer(sealed.iv.byteLength + sealed.ciphertext.byteLength)
		);
		payload.set(sealed.iv, 0);
		payload.set(sealed.ciphertext, sealed.iv.byteLength);
		const sealedCapability: string = `${FORMAT_PREFIX}${base64UrlEncode(payload)}`;
		return {
			sealedCapability,
			sealingKeyId: sealed.keyId,
			sealedCapabilitySha256: await sha256Hex(new TextEncoder().encode(sealedCapability))
		};
	}

	/**
	 * `sealingKeyId` must be the ID recorded alongside the ciphertext (e.g.
	 * the outbox row's `sealing_key_id`). An ID outside the active/previous
	 * keyring fails closed immediately without attempting decryption.
	 */
	async open(
		sealedCapability: string,
		context: CapabilitySealContext,
		sealingKeyId: string
	): Promise<string> {
		if (!sealedCapability.startsWith(FORMAT_PREFIX)) throw new Error('Invalid sealed capability');
		const payload: Uint8Array<ArrayBuffer> = base64UrlDecode(
			sealedCapability.slice(FORMAT_PREFIX.length)
		);
		if (payload.byteLength <= IV_BYTES + 16) throw new Error('Invalid sealed capability');
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
			throw new Error('Sealed capability authentication failed');
		}
		const token: string = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
		if (!isRecipientCapability(token)) throw new Error('Invalid recipient capability token');
		return token;
	}

	/**
	 * Re-encrypts a capability already opened from stale ciphertext under the
	 * active key, for the bounded reseal sweep. Never used on the hot
	 * delivery path — only by the maintenance sweep migrating rows off a
	 * retiring key.
	 */
	async reseal(token: string, context: CapabilitySealContext): Promise<SealedRecipientCapability> {
		return this.seal(token, context);
	}
}

function additionalData(context: CapabilitySealContext): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(
		[
			'signkit-delivery-capability-v1',
			context.organizationId,
			context.envelopeId,
			context.recipientId,
			context.deliveryId
		].join('\0')
	);
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary: string = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid sealed capability');
	const padded: string = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`;
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		throw new Error('Invalid sealed capability');
	}
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index: number = 0; index < binary.length; index += 1)
		bytes[index] = binary.charCodeAt(index);
	return bytes;
}
