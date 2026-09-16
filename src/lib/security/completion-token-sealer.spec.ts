import { describe, expect, it } from 'vitest';
import { issueCompletionToken } from './completion-token';
import {
	AesGcmCompletionTokenSealer,
	type CompletionTokenSealContext
} from './completion-token-sealer';
import { issueRecipientCapability } from './recipient-capability';
import { AesGcmRecipientCapabilitySealer, type CapabilitySealContext } from './delivery-capability';

function key(seed: number): string {
	return btoa(
		String.fromCharCode(...Array.from({ length: 32 }, (_, index: number): number => index + seed))
	);
}

const activeKey: string = key(1);
const previousKey: string = key(100);

const context: CompletionTokenSealContext = {
	envelopeId: 'env-1',
	recipientId: 'recipient-1',
	deliveryId: 'delivery-1'
};

describe('AesGcmCompletionTokenSealer', () => {
	it('round trips a completion token without exposing plaintext in the sealed value', async () => {
		const sealer = new AesGcmCompletionTokenSealer(activeKey);
		const issued = await issueCompletionToken();
		const sealed = await sealer.seal(issued.token, context);
		expect(await sealer.currentSealingKeyId()).toBe(sealed.sealingKeyId);
		expect(sealed.sealedToken).toMatch(/^skcd1_/);
		expect(sealed.sealedToken).not.toContain(issued.token);
		expect(sealed.sealedTokenSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(await sealer.open(sealed.sealedToken, context, sealed.sealingKeyId)).toBe(issued.token);
	});

	it('enforces purpose separation with recipient capability sealer', async () => {
		const completionSealer = new AesGcmCompletionTokenSealer(activeKey);
		const recipientSealer = new AesGcmRecipientCapabilitySealer(activeKey);

		const completionToken = await issueCompletionToken();
		const recipientToken = await issueRecipientCapability();

		// Cannot seal recipient token with completion sealer
		await expect(completionSealer.seal(recipientToken.token, context)).rejects.toThrow(
			'Invalid completion token'
		);

		// Cannot seal completion token with recipient sealer
		await expect(
			recipientSealer.seal(completionToken.token, context as unknown as CapabilitySealContext)
		).rejects.toThrow('Invalid recipient capability token');

		// Sealed completion token cannot be opened by recipient capability sealer
		const sealedCompletion = await completionSealer.seal(completionToken.token, context);
		await expect(
			recipientSealer.open(
				sealedCompletion.sealedToken,
				context as unknown as CapabilitySealContext,
				sealedCompletion.sealingKeyId
			)
		).rejects.toThrow('Invalid sealed capability');

		// Sealed recipient capability cannot be opened by completion token sealer
		const sealedRecipient = await recipientSealer.seal(
			recipientToken.token,
			context as unknown as CapabilitySealContext
		);
		await expect(
			completionSealer.open(sealedRecipient.sealedCapability, context, sealedRecipient.sealingKeyId)
		).rejects.toThrow('Invalid sealed completion token');
	});

	it('rejects ciphertext moved to another recipient or delivery', async () => {
		const sealer = new AesGcmCompletionTokenSealer(activeKey);
		const issued = await issueCompletionToken();
		const sealed = await sealer.seal(issued.token, context);
		await expect(
			sealer.open(
				sealed.sealedToken,
				{ ...context, recipientId: 'recipient-2' },
				sealed.sealingKeyId
			)
		).rejects.toThrow('authentication failed');
		await expect(
			sealer.open(sealed.sealedToken, { ...context, deliveryId: 'delivery-2' }, sealed.sealingKeyId)
		).rejects.toThrow('authentication failed');
	});

	it('requires a 32-byte base64 key', () => {
		expect(() => new AesGcmCompletionTokenSealer('bad')).toThrow('exactly 32 bytes');
	});

	it('opens ciphertext sealed under the previous key once the active key rotates and reseals it', async () => {
		const beforeRotation = new AesGcmCompletionTokenSealer(previousKey);
		const issued = await issueCompletionToken();
		const sealed = await beforeRotation.seal(issued.token, context);

		const afterRotation = new AesGcmCompletionTokenSealer(activeKey, previousKey);
		expect(await afterRotation.currentSealingKeyId()).not.toBe(sealed.sealingKeyId);
		expect(await afterRotation.isKnownSealingKeyId(sealed.sealingKeyId)).toBe(true);
		expect(await afterRotation.needsReseal(sealed.sealingKeyId)).toBe(true);
		expect(await afterRotation.open(sealed.sealedToken, context, sealed.sealingKeyId)).toBe(
			issued.token
		);

		const resealed = await afterRotation.reseal(issued.token, context);
		expect(resealed.sealingKeyId).toBe(await afterRotation.currentSealingKeyId());
		expect(await afterRotation.needsReseal(resealed.sealingKeyId)).toBe(false);
	});

	it('fails closed on a key ID outside the active/previous keyring', async () => {
		const sealer = new AesGcmCompletionTokenSealer(activeKey, previousKey);
		const issued = await issueCompletionToken();
		const sealed = await sealer.seal(issued.token, context);
		expect(await sealer.isKnownSealingKeyId('0000000000000000')).toBe(false);
		await expect(sealer.open(sealed.sealedToken, context, '0000000000000000')).rejects.toThrow(
			'authentication failed'
		);
	});
});
