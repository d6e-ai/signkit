import { isInstanceInvitationToken } from './instance-invitation';
import { AesGcmSealingKeyring, decodeBase64SealingKey, sha256Hex } from './sealing-keyring';

const FORMAT_PREFIX: string = 'skiod1_';
const IV_BYTES: number = 12;
const ENV_VAR_NAME: string = 'DELIVERY_ENCRYPTION_KEY';
const REQUEST_FINGERPRINT_INFO: Uint8Array<ArrayBuffer> = new TextEncoder().encode(
	'signkit-instance-invitation-request-fingerprint-v1'
);

export type InstanceInvitationDeliveryLocale = 'en' | 'ja';

export interface InstanceInvitationDeliveryPayload {
	email: string;
	token: string;
}

export interface InstanceInvitationDeliverySealContext {
	invitationId: string;
	deliveryId: string;
}

export interface SealedInstanceInvitationDeliveryPayload {
	sealedPayload: string;
	sealingKeyId: string;
	sealedPayloadSha256: string;
}

export interface InstanceInvitationRequestFingerprintInput {
	email: string;
	role: 'owner' | 'admin' | 'member';
	locale: InstanceInvitationDeliveryLocale;
}

export interface InstanceInvitationRequestFingerprints {
	active: string;
	previous?: string;
}

export interface InstanceInvitationDeliveryPayloadSealer {
	fingerprintRequest(
		input: InstanceInvitationRequestFingerprintInput
	): Promise<InstanceInvitationRequestFingerprints>;
	seal(
		payload: InstanceInvitationDeliveryPayload,
		context: InstanceInvitationDeliverySealContext
	): Promise<SealedInstanceInvitationDeliveryPayload>;
	open(
		sealedPayload: string,
		context: InstanceInvitationDeliverySealContext,
		sealingKeyId: string
	): Promise<InstanceInvitationDeliveryPayload>;
	isKnownSealingKeyId(keyId: string): Promise<boolean>;
}

/**
 * Purpose-separated AEAD for the only plaintext needed to deliver an instance
 * invitation. The invited mailbox and bearer token are encrypted together;
 * SQL stores no reversible plaintext and binds the ciphertext to both durable
 * row identifiers through authenticated additional data.
 */
export class AesGcmInstanceInvitationDeliveryPayloadSealer implements InstanceInvitationDeliveryPayloadSealer {
	readonly #keyring: AesGcmSealingKeyring;
	readonly #activeFingerprintKey: Promise<CryptoKey>;
	readonly #previousFingerprintKey: Promise<CryptoKey | null>;

	constructor(activeEncodedKey: string, previousEncodedKey?: string) {
		const activeKeyBytes: Uint8Array<ArrayBuffer> = decodeBase64SealingKey(
			activeEncodedKey,
			ENV_VAR_NAME
		);
		const previousKeyBytes: Uint8Array<ArrayBuffer> | null =
			previousEncodedKey === undefined || previousEncodedKey.trim().length === 0
				? null
				: decodeBase64SealingKey(previousEncodedKey, `${ENV_VAR_NAME}_PREVIOUS`);
		this.#keyring = new AesGcmSealingKeyring(activeKeyBytes, previousKeyBytes);
		this.#activeFingerprintKey = deriveFingerprintKey(activeKeyBytes);
		this.#previousFingerprintKey =
			previousKeyBytes === null ? Promise.resolve(null) : deriveFingerprintKey(previousKeyBytes);
	}

	async fingerprintRequest(
		input: InstanceInvitationRequestFingerprintInput
	): Promise<InstanceInvitationRequestFingerprints> {
		const bytes: Uint8Array<ArrayBuffer> = new TextEncoder().encode(
			JSON.stringify({ email: input.email, locale: input.locale, role: input.role })
		);
		const active: string = await hmacHex(await this.#activeFingerprintKey, bytes);
		const previousKey: CryptoKey | null = await this.#previousFingerprintKey;
		return previousKey === null
			? { active }
			: { active, previous: await hmacHex(previousKey, bytes) };
	}

	async isKnownSealingKeyId(keyId: string): Promise<boolean> {
		return await this.#keyring.isKnownKeyId(keyId);
	}

	async seal(
		payload: InstanceInvitationDeliveryPayload,
		context: InstanceInvitationDeliverySealContext
	): Promise<SealedInstanceInvitationDeliveryPayload> {
		assertPayload(payload);
		const plaintext: Uint8Array<ArrayBuffer> = new TextEncoder().encode(JSON.stringify(payload));
		const sealed = await this.#keyring.sealWithActive(plaintext, additionalData(context));
		const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(
			new ArrayBuffer(sealed.iv.byteLength + sealed.ciphertext.byteLength)
		);
		bytes.set(sealed.iv, 0);
		bytes.set(sealed.ciphertext, sealed.iv.byteLength);
		const sealedPayload: string = `${FORMAT_PREFIX}${base64UrlEncode(bytes)}`;
		return {
			sealedPayload,
			sealingKeyId: sealed.keyId,
			sealedPayloadSha256: await sha256Hex(new TextEncoder().encode(sealedPayload))
		};
	}

	async open(
		sealedPayload: string,
		context: InstanceInvitationDeliverySealContext,
		sealingKeyId: string
	): Promise<InstanceInvitationDeliveryPayload> {
		if (!sealedPayload.startsWith(FORMAT_PREFIX)) throw new Error('Invalid sealed payload');
		const bytes: Uint8Array<ArrayBuffer> = base64UrlDecode(
			sealedPayload.slice(FORMAT_PREFIX.length)
		);
		if (bytes.byteLength <= IV_BYTES + 16) throw new Error('Invalid sealed payload');
		let plaintext: Uint8Array;
		try {
			plaintext = await this.#keyring.openWithKeyId(
				sealingKeyId,
				bytes.slice(0, IV_BYTES),
				bytes.slice(IV_BYTES),
				additionalData(context)
			);
		} catch {
			throw new Error('Sealed payload authentication failed');
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
		} catch {
			throw new Error('Invalid sealed payload');
		}
		assertPayload(parsed);
		return parsed;
	}
}

async function deriveFingerprintKey(keyBytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
	const keyMaterial: CryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'HKDF', false, [
		'deriveKey'
	]);
	return await crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new Uint8Array(new ArrayBuffer(0)),
			info: REQUEST_FINGERPRINT_INFO
		},
		keyMaterial,
		{ name: 'HMAC', hash: 'SHA-256', length: 256 },
		false,
		['sign']
	);
}

async function hmacHex(key: CryptoKey, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const signature: ArrayBuffer = await crypto.subtle.sign('HMAC', key, bytes);
	return Array.from(new Uint8Array(signature), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

function assertPayload(value: unknown): asserts value is InstanceInvitationDeliveryPayload {
	if (value === null || typeof value !== 'object') throw new Error('Invalid invitation payload');
	const payload = value as Record<string, unknown>;
	if (
		typeof payload.email !== 'string' ||
		payload.email.length < 3 ||
		payload.email.length > 320 ||
		!payload.email.includes('@') ||
		typeof payload.token !== 'string' ||
		!isInstanceInvitationToken(payload.token)
	) {
		throw new Error('Invalid invitation payload');
	}
}

function additionalData(context: InstanceInvitationDeliverySealContext): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(
		['signkit-instance-invitation-delivery-v1', context.invitationId, context.deliveryId].join('\0')
	);
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary: string = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid sealed payload');
	const padded: string = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`;
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		throw new Error('Invalid sealed payload');
	}
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index: number = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}
