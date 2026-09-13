import { describe, expect, it } from 'vitest';
import {
	AesGcmSealingKeyring,
	sealingKeyringFromEncodedEnv,
	UnknownSealingKeyError
} from './sealing-keyring';

function keyBytes(seed: number): Uint8Array<ArrayBuffer> {
	return new Uint8Array(
		Array.from({ length: 32 }, (_, index: number): number => (index + seed) % 256)
	);
}

function encodedKey(seed: number): string {
	return btoa(String.fromCharCode(...keyBytes(seed)));
}

describe('AesGcmSealingKeyring', () => {
	it('seals with the active key and opens by explicit key ID', async () => {
		const keyring = new AesGcmSealingKeyring(keyBytes(1), null);
		const aad = new TextEncoder().encode('context');
		const plaintext = new TextEncoder().encode('hello');
		const sealed = await keyring.sealWithActive(plaintext, aad);
		expect(sealed.keyId).toBe(await keyring.activeKeyId());
		const opened = await keyring.openWithKeyId(sealed.keyId, sealed.iv, sealed.ciphertext, aad);
		expect(new TextDecoder().decode(opened)).toBe('hello');
	});

	it('opens ciphertext sealed under the previous key by explicit ID', async () => {
		const beforeRotation = new AesGcmSealingKeyring(keyBytes(1), null);
		const aad = new TextEncoder().encode('context');
		const sealed = await beforeRotation.sealWithActive(new TextEncoder().encode('hello'), aad);

		const afterRotation = new AesGcmSealingKeyring(keyBytes(2), keyBytes(1));
		expect(await afterRotation.isKnownKeyId(sealed.keyId)).toBe(true);
		expect(await afterRotation.isActiveKeyId(sealed.keyId)).toBe(false);
		const opened = await afterRotation.openWithKeyId(
			sealed.keyId,
			sealed.iv,
			sealed.ciphertext,
			aad
		);
		expect(new TextDecoder().decode(opened)).toBe('hello');
	});

	it('fails closed for a key ID outside the active/previous keyring without attempting decryption', async () => {
		const keyring = new AesGcmSealingKeyring(keyBytes(1), keyBytes(2));
		const aad = new TextEncoder().encode('context');
		const sealed = await keyring.sealWithActive(new TextEncoder().encode('hello'), aad);
		await expect(
			keyring.openWithKeyId('unknown-key-id-0', sealed.iv, sealed.ciphertext, aad)
		).rejects.toThrow(UnknownSealingKeyError);
	});

	it('fails closed when the correct key ID is claimed but the ciphertext does not verify', async () => {
		const keyring = new AesGcmSealingKeyring(keyBytes(1), null);
		const aad = new TextEncoder().encode('context');
		const sealed = await keyring.sealWithActive(new TextEncoder().encode('hello'), aad);
		await expect(
			keyring.openWithKeyId(
				sealed.keyId,
				sealed.iv,
				sealed.ciphertext,
				new TextEncoder().encode('other')
			)
		).rejects.toThrow();
	});
});

describe('sealingKeyringFromEncodedEnv', () => {
	it('decodes synchronously so a malformed key throws immediately', () => {
		expect(() =>
			sealingKeyringFromEncodedEnv('not-valid-base64!!!', undefined, 'TEST_KEY')
		).toThrow('TEST_KEY must be valid base64');
		expect(() => sealingKeyringFromEncodedEnv(btoa('short'), undefined, 'TEST_KEY')).toThrow(
			'TEST_KEY must encode exactly 32 bytes'
		);
	});

	it('reports the _PREVIOUS suffix for an invalid previous key', () => {
		expect(() => sealingKeyringFromEncodedEnv(encodedKey(1), btoa('short'), 'TEST_KEY')).toThrow(
			'TEST_KEY_PREVIOUS must encode exactly 32 bytes'
		);
	});

	it('treats an empty previous key as unset', async () => {
		const keyring = sealingKeyringFromEncodedEnv(encodedKey(1), '   ', 'TEST_KEY');
		expect(await keyring.isKnownKeyId('anything')).toBe(false);
	});
});
