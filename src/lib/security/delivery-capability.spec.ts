import { describe, expect, it } from 'vitest';
import { issueRecipientCapability } from './recipient-capability';
import { AesGcmRecipientCapabilitySealer, type CapabilitySealContext } from './delivery-capability';

function key(seed: number): string {
	return btoa(
		String.fromCharCode(...Array.from({ length: 32 }, (_, index: number): number => index + seed))
	);
}

const activeKey: string = key(1);
const previousKey: string = key(100);
const context: CapabilitySealContext = {
	envelopeId: 'env-1',
	recipientId: 'recipient-1',
	deliveryId: 'delivery-1'
};

describe('AesGcmRecipientCapabilitySealer', () => {
	it('round trips a capability without including the plaintext in the sealed value', async () => {
		const sealer: AesGcmRecipientCapabilitySealer = new AesGcmRecipientCapabilitySealer(activeKey);
		const issued = await issueRecipientCapability();
		const sealed = await sealer.seal(issued.token, context);
		expect(await sealer.currentSealingKeyId()).toBe(sealed.sealingKeyId);
		expect(sealed.sealedCapability).toMatch(/^skdc1_/);
		expect(sealed.sealedCapability).not.toContain(issued.token);
		expect(sealed.sealedCapabilitySha256).toMatch(/^[0-9a-f]{64}$/);
		expect(await sealer.open(sealed.sealedCapability, context, sealed.sealingKeyId)).toBe(
			issued.token
		);
	});

	it('rejects ciphertext moved to another recipient or delivery', async () => {
		const sealer: AesGcmRecipientCapabilitySealer = new AesGcmRecipientCapabilitySealer(activeKey);
		const issued = await issueRecipientCapability();
		const sealed = await sealer.seal(issued.token, context);
		await expect(
			sealer.open(
				sealed.sealedCapability,
				{ ...context, recipientId: 'recipient-2' },
				sealed.sealingKeyId
			)
		).rejects.toThrow('authentication failed');
	});

	it('requires a 32-byte base64 key', () => {
		expect(
			(): AesGcmRecipientCapabilitySealer => new AesGcmRecipientCapabilitySealer('bad')
		).toThrow('exactly 32 bytes');
	});

	it('opens ciphertext sealed under the previous key once the active key rotates', async () => {
		const beforeRotation: AesGcmRecipientCapabilitySealer = new AesGcmRecipientCapabilitySealer(
			previousKey
		);
		const issued = await issueRecipientCapability();
		const sealed = await beforeRotation.seal(issued.token, context);

		const afterRotation: AesGcmRecipientCapabilitySealer = new AesGcmRecipientCapabilitySealer(
			activeKey,
			previousKey
		);
		expect(await afterRotation.currentSealingKeyId()).not.toBe(sealed.sealingKeyId);
		expect(await afterRotation.isKnownSealingKeyId(sealed.sealingKeyId)).toBe(true);
		expect(await afterRotation.needsReseal(sealed.sealingKeyId)).toBe(true);
		expect(await afterRotation.open(sealed.sealedCapability, context, sealed.sealingKeyId)).toBe(
			issued.token
		);

		const resealed = await afterRotation.reseal(issued.token, context);
		expect(resealed.sealingKeyId).toBe(await afterRotation.currentSealingKeyId());
		expect(await afterRotation.needsReseal(resealed.sealingKeyId)).toBe(false);
	});

	it('fails closed on a key ID outside the active/previous keyring', async () => {
		const sealer: AesGcmRecipientCapabilitySealer = new AesGcmRecipientCapabilitySealer(
			activeKey,
			previousKey
		);
		const issued = await issueRecipientCapability();
		const sealed = await sealer.seal(issued.token, context);
		expect(await sealer.isKnownSealingKeyId('0000000000000000')).toBe(false);
		await expect(sealer.open(sealed.sealedCapability, context, '0000000000000000')).rejects.toThrow(
			'authentication failed'
		);
	});
});
