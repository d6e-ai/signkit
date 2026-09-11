import { isRecipientCapability } from './recipient-capability';

const FORMAT_PREFIX: string = 'skdc1_';
const IV_BYTES: number = 12;
const KEY_BYTES: number = 32;

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

export class AesGcmRecipientCapabilitySealer implements RecipientCapabilitySealer {
	readonly #keyBytes: Uint8Array<ArrayBuffer>;
	readonly #keyId: Promise<string>;
	readonly #cryptoKey: Promise<CryptoKey>;

	constructor(encodedKey: string) {
		this.#keyBytes = decodeKey(encodedKey);
		this.#keyId = sha256Hex(this.#keyBytes).then((digest: string): string => digest.slice(0, 16));
		this.#cryptoKey = crypto.subtle.importKey('raw', this.#keyBytes, { name: 'AES-GCM' }, false, [
			'encrypt',
			'decrypt'
		]);
	}

	async currentSealingKeyId(): Promise<string> {
		return await this.#keyId;
	}

	async seal(token: string, context: CapabilitySealContext): Promise<SealedRecipientCapability> {
		if (!isRecipientCapability(token)) throw new Error('Invalid recipient capability token');
		const iv: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(IV_BYTES));
		crypto.getRandomValues(iv);
		const plaintext: Uint8Array<ArrayBuffer> = new TextEncoder().encode(token);
		const ciphertext: ArrayBuffer = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv, additionalData: additionalData(context) },
			await this.#cryptoKey,
			plaintext
		);
		const payload: Uint8Array<ArrayBuffer> = new Uint8Array(
			new ArrayBuffer(iv.byteLength + ciphertext.byteLength)
		);
		payload.set(iv, 0);
		payload.set(new Uint8Array(ciphertext), iv.byteLength);
		const sealedCapability: string = `${FORMAT_PREFIX}${base64UrlEncode(payload)}`;
		return {
			sealedCapability,
			sealingKeyId: await this.#keyId,
			sealedCapabilitySha256: await sha256Hex(new TextEncoder().encode(sealedCapability))
		};
	}

	async open(sealedCapability: string, context: CapabilitySealContext): Promise<string> {
		if (!sealedCapability.startsWith(FORMAT_PREFIX)) throw new Error('Invalid sealed capability');
		const payload: Uint8Array<ArrayBuffer> = base64UrlDecode(
			sealedCapability.slice(FORMAT_PREFIX.length)
		);
		if (payload.byteLength <= IV_BYTES + 16) throw new Error('Invalid sealed capability');
		const iv: Uint8Array<ArrayBuffer> = payload.slice(0, IV_BYTES);
		const ciphertext: Uint8Array<ArrayBuffer> = payload.slice(IV_BYTES);
		let plaintext: ArrayBuffer;
		try {
			plaintext = await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv, additionalData: additionalData(context) },
				await this.#cryptoKey,
				ciphertext
			);
		} catch {
			throw new Error('Sealed capability authentication failed');
		}
		const token: string = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
		if (!isRecipientCapability(token)) throw new Error('Invalid recipient capability token');
		return token;
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
		].join('\u0000')
	);
}

function decodeKey(encodedKey: string): Uint8Array<ArrayBuffer> {
	let binary: string;
	try {
		binary = atob(encodedKey.trim());
	} catch {
		throw new Error('DELIVERY_ENCRYPTION_KEY must be valid base64');
	}
	if (binary.length !== KEY_BYTES) {
		throw new Error('DELIVERY_ENCRYPTION_KEY must encode exactly 32 bytes');
	}
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(KEY_BYTES));
	for (let index: number = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
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

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
