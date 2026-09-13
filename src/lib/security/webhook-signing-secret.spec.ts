import { describe, expect, it } from 'vitest';
import { issueWebhookSecret } from './webhook';
import { AesGcmWebhookSigningSecretSealer } from './webhook-signing-secret';

const TEST_KEY: string = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const PREVIOUS_KEY: string = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const CONTEXT = {
	organizationId: 'org-1',
	endpointId: '01900000-0000-7000-8000-000000000401'
};

describe('AesGcmWebhookSigningSecretSealer', () => {
	it('seals a webhook secret under AAD so a different endpoint cannot open it', async () => {
		const sealer = new AesGcmWebhookSigningSecretSealer(TEST_KEY);
		const issued = await issueWebhookSecret();
		const sealed = await sealer.seal(issued.secret, CONTEXT);
		expect(sealed.sealedSigningSecret.startsWith('skwhs1_')).toBe(true);
		expect(sealed.sealedSigningSecret).not.toContain(issued.secret);
		await expect(
			sealer.open(sealed.sealedSigningSecret, CONTEXT, sealed.sealingKeyId)
		).resolves.toBe(issued.secret);
		await expect(
			sealer.open(
				sealed.sealedSigningSecret,
				{ ...CONTEXT, endpointId: 'other' },
				sealed.sealingKeyId
			)
		).rejects.toThrow('authentication failed');
	});

	it('opens a legacy plaintext secret when no sealing key ID is stored', async () => {
		const sealer = new AesGcmWebhookSigningSecretSealer(TEST_KEY);
		const issued = await issueWebhookSecret();
		await expect(sealer.open(issued.secret, CONTEXT, null)).resolves.toBe(issued.secret);
		expect(await sealer.needsReseal(null)).toBe(true);
	});

	it('opens ciphertext sealed under the previous key and reseals onto the active key', async () => {
		const before = new AesGcmWebhookSigningSecretSealer(PREVIOUS_KEY);
		const issued = await issueWebhookSecret();
		const sealed = await before.seal(issued.secret, CONTEXT);
		const after = new AesGcmWebhookSigningSecretSealer(TEST_KEY, PREVIOUS_KEY);
		expect(await after.needsReseal(sealed.sealingKeyId)).toBe(true);
		const opened: string = await after.open(
			sealed.sealedSigningSecret,
			CONTEXT,
			sealed.sealingKeyId
		);
		const resealed = await after.reseal(opened, CONTEXT);
		expect(resealed.sealingKeyId).toBe(await after.currentSealingKeyId());
		expect(await after.needsReseal(resealed.sealingKeyId)).toBe(false);
		await expect(
			after.open(resealed.sealedSigningSecret, CONTEXT, resealed.sealingKeyId)
		).resolves.toBe(issued.secret);
	});
});
