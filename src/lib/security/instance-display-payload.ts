import {
	isIsoInstant,
	isUsableDisplayName,
	memberDisplayExpiresAt,
	INSTANCE_DISPLAY_EMAIL_MAX_LENGTH
} from '$lib/domain/instance-display';
import { AesGcmSealingKeyring, decodeBase64SealingKey } from './sealing-keyring';

const MEMBER_PREFIX: string = 'skidm1_';
const INVITATION_PREFIX: string = 'skidt1_';
const IV_BYTES: number = 12;
const ENV_VAR_NAME: string = 'DELIVERY_ENCRYPTION_KEY';
const HKDF_SALT: Uint8Array<ArrayBuffer> = utf8('signkit:instance-display-key-derivation:v1');
const MEMBER_HKDF_INFO: Uint8Array<ArrayBuffer> = utf8('signkit:instance-display-member-key:v1');
const INVITATION_HKDF_INFO: Uint8Array<ArrayBuffer> = utf8(
	'signkit:instance-display-invitation-key:v1'
);

export interface MemberDisplayPayload {
	name: string;
	email: string;
	observedAt: string;
	expiresAt: string;
}

export interface InvitationTargetDisplayPayload {
	email: string;
}

export interface SealedInstanceDisplayPayload {
	sealedPayload: string;
	sealingKeyId: string;
}

export interface InstanceDisplayPayloadSealer {
	sealMember(payload: MemberDisplayPayload, userId: string): Promise<SealedInstanceDisplayPayload>;
	openMember(
		sealedPayload: string,
		userId: string,
		sealingKeyId: string
	): Promise<MemberDisplayPayload>;
	sealInvitationTarget(
		payload: InvitationTargetDisplayPayload,
		invitationId: string
	): Promise<SealedInstanceDisplayPayload>;
	openInvitationTarget(
		sealedPayload: string,
		invitationId: string,
		sealingKeyId: string
	): Promise<InvitationTargetDisplayPayload>;
	memberActiveKeyId(): Promise<string>;
	invitationActiveKeyId(): Promise<string>;
	memberPreviousKeyId(): Promise<string | null>;
	invitationPreviousKeyId(): Promise<string | null>;
	isKnownMemberKeyId(keyId: string): Promise<boolean>;
	isKnownInvitationKeyId(keyId: string): Promise<boolean>;
	isActiveMemberKeyId(keyId: string): Promise<boolean>;
	isActiveInvitationKeyId(keyId: string): Promise<boolean>;
}

/**
 * Purpose-separated AEAD for instance display snapshots and invitation targets.
 * Shares `DELIVERY_ENCRYPTION_KEY` / `_PREVIOUS` with delivery ciphertext, but
 * HKDF-derives distinct member and invitation keys, prefixes, and AAD bound to
 * kind plus record id. Opening is fail-closed by explicit key ID.
 */
export class AesGcmInstanceDisplayPayloadSealer implements InstanceDisplayPayloadSealer {
	readonly #memberKeyring: Promise<AesGcmSealingKeyring>;
	readonly #invitationKeyring: Promise<AesGcmSealingKeyring>;

	constructor(activeEncodedKey: string, previousEncodedKey?: string) {
		const activeBytes: Uint8Array<ArrayBuffer> = decodeBase64SealingKey(
			activeEncodedKey,
			ENV_VAR_NAME
		);
		const previousBytes: Uint8Array<ArrayBuffer> | null =
			previousEncodedKey === undefined || previousEncodedKey.trim().length === 0
				? null
				: decodeBase64SealingKey(previousEncodedKey, `${ENV_VAR_NAME}_PREVIOUS`);
		this.#memberKeyring = createPurposeKeyring(activeBytes, previousBytes, MEMBER_HKDF_INFO);
		this.#invitationKeyring = createPurposeKeyring(
			activeBytes,
			previousBytes,
			INVITATION_HKDF_INFO
		);
	}

	async memberActiveKeyId(): Promise<string> {
		return (await this.#memberKeyring).activeKeyId();
	}

	async invitationActiveKeyId(): Promise<string> {
		return (await this.#invitationKeyring).activeKeyId();
	}

	async memberPreviousKeyId(): Promise<string | null> {
		return (await this.#memberKeyring).previousKeyId();
	}

	async invitationPreviousKeyId(): Promise<string | null> {
		return (await this.#invitationKeyring).previousKeyId();
	}

	async isKnownMemberKeyId(keyId: string): Promise<boolean> {
		return await (await this.#memberKeyring).isKnownKeyId(keyId);
	}

	async isKnownInvitationKeyId(keyId: string): Promise<boolean> {
		return await (await this.#invitationKeyring).isKnownKeyId(keyId);
	}

	async isActiveMemberKeyId(keyId: string): Promise<boolean> {
		return await (await this.#memberKeyring).isActiveKeyId(keyId);
	}

	async isActiveInvitationKeyId(keyId: string): Promise<boolean> {
		return await (await this.#invitationKeyring).isActiveKeyId(keyId);
	}

	async sealMember(
		payload: MemberDisplayPayload,
		userId: string
	): Promise<SealedInstanceDisplayPayload> {
		assertMemberPayload(payload);
		assertRecordId(userId);
		return await sealPayload(
			await this.#memberKeyring,
			MEMBER_PREFIX,
			JSON.stringify(payload),
			memberAad(userId)
		);
	}

	async openMember(
		sealedPayload: string,
		userId: string,
		sealingKeyId: string
	): Promise<MemberDisplayPayload> {
		assertRecordId(userId);
		const parsed: unknown = await openPayload(
			await this.#memberKeyring,
			MEMBER_PREFIX,
			sealedPayload,
			sealingKeyId,
			memberAad(userId)
		);
		assertMemberPayload(parsed);
		return parsed;
	}

	async sealInvitationTarget(
		payload: InvitationTargetDisplayPayload,
		invitationId: string
	): Promise<SealedInstanceDisplayPayload> {
		assertInvitationPayload(payload);
		assertRecordId(invitationId);
		return await sealPayload(
			await this.#invitationKeyring,
			INVITATION_PREFIX,
			JSON.stringify(payload),
			invitationAad(invitationId)
		);
	}

	async openInvitationTarget(
		sealedPayload: string,
		invitationId: string,
		sealingKeyId: string
	): Promise<InvitationTargetDisplayPayload> {
		assertRecordId(invitationId);
		const parsed: unknown = await openPayload(
			await this.#invitationKeyring,
			INVITATION_PREFIX,
			sealedPayload,
			sealingKeyId,
			invitationAad(invitationId)
		);
		assertInvitationPayload(parsed);
		return parsed;
	}
}

async function createPurposeKeyring(
	activeMaster: Uint8Array<ArrayBuffer>,
	previousMaster: Uint8Array<ArrayBuffer> | null,
	info: Uint8Array<ArrayBuffer>
): Promise<AesGcmSealingKeyring> {
	const activeSubkey: Uint8Array<ArrayBuffer> = await deriveSubkey(activeMaster, info);
	const previousSubkey: Uint8Array<ArrayBuffer> | null =
		previousMaster === null ? null : await deriveSubkey(previousMaster, info);
	return new AesGcmSealingKeyring(activeSubkey, previousSubkey);
}

async function deriveSubkey(
	masterKeyBytes: Uint8Array<ArrayBuffer>,
	info: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
	const masterKey: CryptoKey = await crypto.subtle.importKey('raw', masterKeyBytes, 'HKDF', false, [
		'deriveBits'
	]);
	const derived: ArrayBuffer = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info },
		masterKey,
		256
	);
	return new Uint8Array(derived);
}

async function sealPayload(
	keyring: AesGcmSealingKeyring,
	prefix: string,
	plaintextJson: string,
	aad: Uint8Array<ArrayBuffer>
): Promise<SealedInstanceDisplayPayload> {
	const plaintext: Uint8Array<ArrayBuffer> = utf8(plaintextJson);
	const sealed = await keyring.sealWithActive(plaintext, aad);
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(
		new ArrayBuffer(sealed.iv.byteLength + sealed.ciphertext.byteLength)
	);
	bytes.set(sealed.iv, 0);
	bytes.set(sealed.ciphertext, sealed.iv.byteLength);
	return {
		sealedPayload: `${prefix}${base64UrlEncode(bytes)}`,
		sealingKeyId: sealed.keyId
	};
}

async function openPayload(
	keyring: AesGcmSealingKeyring,
	prefix: string,
	sealedPayload: string,
	sealingKeyId: string,
	aad: Uint8Array<ArrayBuffer>
): Promise<unknown> {
	if (!sealedPayload.startsWith(prefix)) throw new Error('Invalid sealed display payload');
	const bytes: Uint8Array<ArrayBuffer> = base64UrlDecode(sealedPayload.slice(prefix.length));
	if (bytes.byteLength <= IV_BYTES + 16) throw new Error('Invalid sealed display payload');
	let plaintext: Uint8Array;
	try {
		plaintext = await keyring.openWithKeyId(
			sealingKeyId,
			bytes.slice(0, IV_BYTES),
			bytes.slice(IV_BYTES),
			aad
		);
	} catch {
		throw new Error('Sealed display payload authentication failed');
	}
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
	} catch {
		throw new Error('Invalid sealed display payload');
	}
}

function assertMemberPayload(value: unknown): asserts value is MemberDisplayPayload {
	if (value === null || typeof value !== 'object')
		throw new Error('Invalid member display payload');
	const payload = value as Record<string, unknown>;
	const keys: string[] = Object.keys(payload);
	if (keys.length !== 4 || !keys.includes('name') || !keys.includes('email')) {
		throw new Error('Invalid member display payload');
	}
	if (
		typeof payload.name !== 'string' ||
		!isUsableDisplayName(payload.name) ||
		typeof payload.email !== 'string' ||
		!isDisplayEmail(payload.email) ||
		typeof payload.observedAt !== 'string' ||
		typeof payload.expiresAt !== 'string' ||
		!isIsoInstant(payload.observedAt) ||
		!isIsoInstant(payload.expiresAt) ||
		payload.expiresAt !== memberDisplayExpiresAt(payload.observedAt)
	) {
		throw new Error('Invalid member display payload');
	}
}

function assertInvitationPayload(value: unknown): asserts value is InvitationTargetDisplayPayload {
	if (value === null || typeof value !== 'object') {
		throw new Error('Invalid invitation display payload');
	}
	const payload = value as Record<string, unknown>;
	const keys: string[] = Object.keys(payload);
	if (keys.length !== 1 || typeof payload.email !== 'string' || !isDisplayEmail(payload.email)) {
		throw new Error('Invalid invitation display payload');
	}
}

function isDisplayEmail(value: string): boolean {
	if (value.length < 3 || value.length > INSTANCE_DISPLAY_EMAIL_MAX_LENGTH) return false;
	if (!value.includes('@') || value.includes(' ')) return false;
	return true;
}

function assertRecordId(value: string): void {
	if (value.length < 1 || value.length > 200) throw new Error('Invalid display record id');
}

function memberAad(userId: string): Uint8Array<ArrayBuffer> {
	return utf8(['signkit-instance-display-member-v1', userId].join('\0'));
}

function invitationAad(invitationId: string): Uint8Array<ArrayBuffer> {
	return utf8(['signkit-instance-display-invitation-v1', invitationId].join('\0'));
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
	const encoded: Uint8Array = new TextEncoder().encode(value);
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(encoded.byteLength));
	bytes.set(encoded);
	return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary: string = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid sealed display payload');
	const padded: string = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`;
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		throw new Error('Invalid sealed display payload');
	}
	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index: number = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}
