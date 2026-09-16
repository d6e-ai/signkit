import { WEBHOOK_SECRET_PATTERN } from './webhook';
import { AesGcmSealingKeyring, sealingKeyringFromEncodedEnv } from './sealing-keyring';

const FORMAT_PREFIX: string = 'skwhs1_';
const IV_BYTES: number = 12;
const DOMAIN_SEPARATOR: string = 'signkit-webhook-signing-secret-v1';
const ENV_VAR_NAME: string = 'DELIVERY_ENCRYPTION_KEY';

export interface WebhookSecretSealContext {
	endpointId: string;
}

export interface SealedWebhookSigningSecret {
	sealedSigningSecret: string;
	sealingKeyId: string;
}

export interface WebhookSigningSecretSealer {
	currentSealingKeyId(): Promise<string>;
	seal(secret: string, context: WebhookSecretSealContext): Promise<SealedWebhookSigningSecret>;
	open(
		stored: string,
		context: WebhookSecretSealContext,
		sealingKeyId: string | null
	): Promise<string>;
	needsReseal(sealingKeyId: string | null): Promise<boolean>;
	reseal(secret: string, context: WebhookSecretSealContext): Promise<SealedWebhookSigningSecret>;
}

/**
 * Active+previous keyring for webhook HMAC signing secrets at rest. Shares
 * `DELIVERY_ENCRYPTION_KEY` / `DELIVERY_ENCRYPTION_KEY_PREVIOUS` with delivery
 * and completion sealers; purpose isolation is the `skwhs1_` prefix and AAD
 * (`signkit-webhook-signing-secret-v1` + endpoint). Opening is
 * fail-closed by explicit key ID. Legacy rows with a null key ID are treated
 * as plaintext `skwh1_` secrets so existing databases can reseal in place.
 */
export class AesGcmWebhookSigningSecretSealer implements WebhookSigningSecretSealer {
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

	async needsReseal(sealingKeyId: string | null): Promise<boolean> {
		if (sealingKeyId === null || sealingKeyId.length === 0) return true;
		return !(await this.#keyring.isActiveKeyId(sealingKeyId));
	}

	async seal(
		secret: string,
		context: WebhookSecretSealContext
	): Promise<SealedWebhookSigningSecret> {
		if (!WEBHOOK_SECRET_PATTERN.test(secret)) {
			throw new Error('Invalid webhook secret');
		}
		const plaintext: Uint8Array<ArrayBuffer> = new TextEncoder().encode(secret);
		const sealed = await this.#keyring.sealWithActive(plaintext, additionalData(context));
		const payload: Uint8Array<ArrayBuffer> = new Uint8Array(
			new ArrayBuffer(sealed.iv.byteLength + sealed.ciphertext.byteLength)
		);
		payload.set(sealed.iv, 0);
		payload.set(sealed.ciphertext, sealed.iv.byteLength);
		return {
			sealedSigningSecret: `${FORMAT_PREFIX}${base64UrlEncode(payload)}`,
			sealingKeyId: sealed.keyId
		};
	}

	async open(
		stored: string,
		context: WebhookSecretSealContext,
		sealingKeyId: string | null
	): Promise<string> {
		if (sealingKeyId === null || sealingKeyId.length === 0) {
			if (!WEBHOOK_SECRET_PATTERN.test(stored)) {
				throw new Error('Invalid webhook secret');
			}
			return stored;
		}
		if (!stored.startsWith(FORMAT_PREFIX)) {
			throw new Error('Invalid sealed webhook signing secret');
		}
		const payload: Uint8Array<ArrayBuffer> = base64UrlDecode(stored.slice(FORMAT_PREFIX.length));
		if (payload.byteLength <= IV_BYTES + 16) {
			throw new Error('Invalid sealed webhook signing secret');
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
			throw new Error('Sealed webhook signing secret authentication failed');
		}
		const secret: string = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
		if (!WEBHOOK_SECRET_PATTERN.test(secret)) {
			throw new Error('Invalid webhook secret');
		}
		return secret;
	}

	async reseal(
		secret: string,
		context: WebhookSecretSealContext
	): Promise<SealedWebhookSigningSecret> {
		return this.seal(secret, context);
	}
}

function additionalData(context: WebhookSecretSealContext): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode([DOMAIN_SEPARATOR, context.endpointId].join('\0'));
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary: string = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new Error('Invalid sealed webhook signing secret');
	}
	const padded: string = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`;
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		throw new Error('Invalid sealed webhook signing secret');
	}
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index: number = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}
