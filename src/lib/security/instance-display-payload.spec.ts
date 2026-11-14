import { describe, expect, it } from 'vitest';
import { memberDisplayExpiresAt } from '$lib/domain/instance-display';
import { AesGcmInstanceDisplayPayloadSealer } from './instance-display-payload';
import { AesGcmInstanceInvitationDeliveryPayloadSealer } from './instance-invitation-delivery-payload';

function key(seed: number): string {
	return btoa(
		String.fromCharCode(...Array.from({ length: 32 }, (_, index: number): number => index + seed))
	);
}

const OBSERVED_AT: string = '2026-09-12T12:00:00.000Z';
const USER_ID: string = 'user-1';
const INVITATION_ID: string = '01900000-0000-7000-8000-000000000001';

const memberPayload = {
	name: 'Ada Lovelace',
	email: 'ada@example.com',
	observedAt: OBSERVED_AT,
	expiresAt: memberDisplayExpiresAt(OBSERVED_AT)
};

describe('AesGcmInstanceDisplayPayloadSealer', () => {
	it('does not schedule rotation when the previous key duplicates the active key', async () => {
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1), key(1));
		expect(await sealer.memberPreviousKeyId()).toBeNull();
		expect(await sealer.invitationPreviousKeyId()).toBeNull();
		const sealed = await sealer.sealMember(memberPayload, USER_ID);
		await expect(
			sealer.openMember(sealed.sealedPayload, USER_ID, sealed.sealingKeyId)
		).resolves.toEqual(memberPayload);
	});

	it('round-trips member snapshots under a distinct prefix and purpose key', async () => {
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const sealed = await sealer.sealMember(memberPayload, USER_ID);
		expect(sealed.sealedPayload).toMatch(/^skidm1_/);
		expect(sealed.sealedPayload).not.toContain(memberPayload.email);
		expect(sealed.sealedPayload).not.toContain(memberPayload.name);
		await expect(
			sealer.openMember(sealed.sealedPayload, USER_ID, sealed.sealingKeyId)
		).resolves.toEqual(memberPayload);
	});

	it('round-trips invitation targets without a token field', async () => {
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const sealed = await sealer.sealInvitationTarget(
			{ email: 'invitee@example.com' },
			INVITATION_ID
		);
		expect(sealed.sealedPayload).toMatch(/^skidt1_/);
		expect(sealed.sealedPayload).not.toContain('invitee@example.com');
		expect(sealed.sealedPayload).not.toContain('ski1_');
		await expect(
			sealer.openInvitationTarget(sealed.sealedPayload, INVITATION_ID, sealed.sealingKeyId)
		).resolves.toEqual({ email: 'invitee@example.com' });
	});

	it('rejects ciphertext copied onto another member or invitation id', async () => {
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const member = await sealer.sealMember(memberPayload, USER_ID);
		await expect(
			sealer.openMember(member.sealedPayload, 'user-2', member.sealingKeyId)
		).rejects.toThrow('authentication failed');
		const target = await sealer.sealInvitationTarget(
			{ email: 'invitee@example.com' },
			INVITATION_ID
		);
		await expect(
			sealer.openInvitationTarget(
				target.sealedPayload,
				'01900000-0000-7000-8000-000000000002',
				target.sealingKeyId
			)
		).rejects.toThrow('authentication failed');
	});

	it('does not open display ciphertext as invitation mail or the reverse', async () => {
		const display = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const mail = new AesGcmInstanceInvitationDeliveryPayloadSealer(key(1));
		const sealedDisplay = await display.sealInvitationTarget(
			{ email: 'invitee@example.com' },
			INVITATION_ID
		);
		await expect(
			mail.open(
				sealedDisplay.sealedPayload,
				{ invitationId: INVITATION_ID, deliveryId: INVITATION_ID },
				sealedDisplay.sealingKeyId
			)
		).rejects.toThrow();
		const sealedMail = await mail.seal(
			{ email: 'invitee@example.com', token: `ski1_${'a'.repeat(43)}` },
			{ invitationId: INVITATION_ID, deliveryId: INVITATION_ID }
		);
		await expect(
			display.openInvitationTarget(sealedMail.sealedPayload, INVITATION_ID, sealedMail.sealingKeyId)
		).rejects.toThrow();
	});

	it('derives distinct member and invitation key ids from the same master key', async () => {
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		expect(await sealer.memberActiveKeyId()).not.toBe(await sealer.invitationActiveKeyId());
	});

	it('opens previous-key ciphertext and seals new writes under the active key', async () => {
		const oldSealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const sealed = await oldSealer.sealMember(memberPayload, USER_ID);
		const rotated = new AesGcmInstanceDisplayPayloadSealer(key(2), key(1));
		expect(await rotated.isKnownMemberKeyId(sealed.sealingKeyId)).toBe(true);
		expect(await rotated.isActiveMemberKeyId(sealed.sealingKeyId)).toBe(false);
		await expect(
			rotated.openMember(sealed.sealedPayload, USER_ID, sealed.sealingKeyId)
		).resolves.toEqual(memberPayload);
		const resealed = await rotated.sealMember(memberPayload, USER_ID);
		expect(resealed.sealingKeyId).toBe(await rotated.memberActiveKeyId());
	});

	it('rejects an unknown key id without widening the keyring', async () => {
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		const sealed = await sealer.sealMember(memberPayload, USER_ID);
		const other = new AesGcmInstanceDisplayPayloadSealer(key(2));
		expect(await other.isKnownMemberKeyId(sealed.sealingKeyId)).toBe(false);
		await expect(
			other.openMember(sealed.sealedPayload, USER_ID, sealed.sealingKeyId)
		).rejects.toThrow('authentication failed');
	});

	it('rejects member payloads whose lifetime does not match the original observation', async () => {
		const sealer = new AesGcmInstanceDisplayPayloadSealer(key(1));
		await expect(
			sealer.sealMember({ ...memberPayload, expiresAt: '2026-09-13T12:00:00.000Z' }, USER_ID)
		).rejects.toThrow('Invalid member display payload');
	});
});
