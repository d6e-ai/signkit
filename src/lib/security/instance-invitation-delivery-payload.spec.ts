import { describe, expect, it } from 'vitest';
import { AesGcmInstanceInvitationDeliveryPayloadSealer } from './instance-invitation-delivery-payload';

function key(seed: number): string {
	return btoa(
		String.fromCharCode(...Array.from({ length: 32 }, (_, index: number): number => index + seed))
	);
}

const context = {
	invitationId: '01900000-0000-7000-8000-000000000001',
	deliveryId: '01900000-0000-7000-8000-000000000002'
};
const payload = { email: 'invitee@example.com', token: `ski1_${'a'.repeat(43)}` };

describe('AesGcmInstanceInvitationDeliveryPayloadSealer', () => {
	it('round trips encrypted email and token without exposing either in ciphertext', async () => {
		const sealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(key(1));
		const sealed = await sealer.seal(payload, context);
		expect(sealed.sealedPayload).toMatch(/^skiod1_/);
		expect(sealed.sealedPayload).not.toContain(payload.email);
		expect(sealed.sealedPayload).not.toContain(payload.token);
		expect(sealed.sealedPayloadSha256).toMatch(/^[0-9a-f]{64}$/);
		await expect(sealer.open(sealed.sealedPayload, context, sealed.sealingKeyId)).resolves.toEqual(
			payload
		);
	});

	it('rejects ciphertext copied to another durable delivery row', async () => {
		const sealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(key(1));
		const sealed = await sealer.seal(payload, context);
		await expect(
			sealer.open(
				sealed.sealedPayload,
				{ ...context, deliveryId: '01900000-0000-7000-8000-000000000003' },
				sealed.sealingKeyId
			)
		).rejects.toThrow('authentication failed');
	});

	it('opens outstanding payloads through the configured previous key', async () => {
		const oldSealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(key(1));
		const sealed = await oldSealer.seal(payload, context);
		const rotated = new AesGcmInstanceInvitationDeliveryPayloadSealer(key(2), key(1));
		expect(await rotated.isKnownSealingKeyId(sealed.sealingKeyId)).toBe(true);
		await expect(rotated.open(sealed.sealedPayload, context, sealed.sealingKeyId)).resolves.toEqual(
			payload
		);
	});

	it('keys request fingerprints, binds email/role/locale, and supports rotation replay', async () => {
		const oldSealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(key(1));
		const request = {
			email: 'invitee@example.com',
			role: 'member' as const,
			locale: 'ja' as const
		};
		const oldFingerprint = await oldSealer.fingerprintRequest(request);
		expect(oldFingerprint.active).toMatch(/^[0-9a-f]{64}$/);
		expect(oldFingerprint.active).not.toContain(request.email);
		expect((await oldSealer.fingerprintRequest({ ...request, locale: 'en' })).active).not.toBe(
			oldFingerprint.active
		);
		expect(
			(await oldSealer.fingerprintRequest({ ...request, email: 'other@example.com' })).active
		).not.toBe(oldFingerprint.active);

		const rotated = new AesGcmInstanceInvitationDeliveryPayloadSealer(key(2), key(1));
		const rotatedFingerprints = await rotated.fingerprintRequest(request);
		expect(rotatedFingerprints.active).not.toBe(oldFingerprint.active);
		expect(rotatedFingerprints.previous).toBe(oldFingerprint.active);
	});
});
