import { describe, expect, it } from 'vitest';
import { issueRecipientCapability } from './recipient-capability';
import { AesGcmRecipientCapabilitySealer, type CapabilitySealContext } from './delivery-capability';

const key: string = btoa(
	String.fromCharCode(...Array.from({ length: 32 }, (_, index: number): number => index + 1))
);
const context: CapabilitySealContext = {
	organizationId: 'org-1',
	envelopeId: 'env-1',
	recipientId: 'recipient-1',
	deliveryId: 'delivery-1'
};

describe('AesGcmRecipientCapabilitySealer', () => {
	it('round trips a capability without including the plaintext in the sealed value', async () => {
		const sealer: AesGcmRecipientCapabilitySealer = new AesGcmRecipientCapabilitySealer(key);
		const issued = await issueRecipientCapability();
		const sealed = await sealer.seal(issued.token, context);
		expect(await sealer.currentSealingKeyId()).toBe(sealed.sealingKeyId);
		expect(sealed.sealedCapability).toMatch(/^skdc1_/);
		expect(sealed.sealedCapability).not.toContain(issued.token);
		expect(sealed.sealedCapabilitySha256).toMatch(/^[0-9a-f]{64}$/);
		expect(await sealer.open(sealed.sealedCapability, context)).toBe(issued.token);
	});

	it('rejects ciphertext moved to another recipient or delivery', async () => {
		const sealer: AesGcmRecipientCapabilitySealer = new AesGcmRecipientCapabilitySealer(key);
		const issued = await issueRecipientCapability();
		const sealed = await sealer.seal(issued.token, context);
		await expect(
			sealer.open(sealed.sealedCapability, { ...context, recipientId: 'recipient-2' })
		).rejects.toThrow('authentication failed');
	});

	it('requires a 32-byte base64 key', () => {
		expect(
			(): AesGcmRecipientCapabilitySealer => new AesGcmRecipientCapabilitySealer('bad')
		).toThrow('exactly 32 bytes');
	});
});
