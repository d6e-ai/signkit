import { describe, expect, it, vi } from 'vitest';
import type {
	ClaimedInstanceInvitationDelivery,
	InstanceInvitationDeliveryStore
} from '$lib/ports/instance-invitation-delivery-store';
import { MailDeliveryError, type MailMessage, type MailSender } from '$lib/ports/mail-sender';
import {
	computeInstanceInvitationEmailBinding,
	hashInstanceInvitationToken
} from '$lib/security/instance-invitation';
import { AesGcmInstanceInvitationDeliveryPayloadSealer } from '$lib/security/instance-invitation-delivery-payload';
import {
	InstanceInvitationDeliveryService,
	InvalidInstanceInvitationDeliveryConfigError
} from './instance-invitation-delivery-service';

const NOW: Date = new Date('2026-09-17T12:00:00.000Z');
const INVITATION_ID: string = '01900000-0000-7000-8000-000000000001';
const DELIVERY_ID: string = '01900000-0000-7000-8000-000000000002';
const TOKEN: string = `ski1_${'a'.repeat(43)}`;
const EMAIL: string = 'invitee@example.com';

function key(): string {
	return btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i: number): number => i + 1)));
}

async function eligibleClaim(
	sealer: AesGcmInstanceInvitationDeliveryPayloadSealer,
	overrides: Partial<ClaimedInstanceInvitationDelivery> = {}
): Promise<ClaimedInstanceInvitationDelivery> {
	const sealed = await sealer.seal(
		{ email: EMAIL, token: TOKEN },
		{ invitationId: INVITATION_ID, deliveryId: DELIVERY_ID }
	);
	return {
		deliveryId: DELIVERY_ID,
		invitationId: INVITATION_ID,
		locale: 'ja',
		role: 'member',
		invitationStatus: 'pending',
		expiresAt: '2026-09-19T12:00:00.000Z',
		tokenHash: await hashInstanceInvitationToken(TOKEN),
		emailBinding: await computeInstanceInvitationEmailBinding(TOKEN, EMAIL),
		sealedPayload: sealed.sealedPayload,
		sealedPayloadSha256: sealed.sealedPayloadSha256,
		sealingKeyId: sealed.sealingKeyId,
		attempts: 1,
		...overrides
	};
}

describe('InstanceInvitationDeliveryService', () => {
	it('opens a bound payload, sends localized HTML and text, then scrubs through completion', async () => {
		const sealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(key());
		const claim: ClaimedInstanceInvitationDelivery = await eligibleClaim(sealer);
		const complete = vi.fn(async () => ({ outcome: 'completed' as const }));
		const store: InstanceInvitationDeliveryStore = {
			claimPending: vi.fn(async () => [claim]),
			readClaimed: vi.fn(async () => claim),
			complete,
			fail: vi.fn(async () => ({ outcome: 'failed' as const }))
		};
		const messages: MailMessage[] = [];
		const mail: MailSender = {
			async send(message: MailMessage) {
				messages.push(message);
				return { outcome: 'accepted', providerMessageId: '<message@example>' };
			}
		};
		const service = new InstanceInvitationDeliveryService(
			store,
			sealer,
			mail,
			'https://signkit.example',
			{ fromEmail: 'noreply@example.com', fromName: 'SignKit' },
			(): Date => NOW,
			(): string => 'claim-token'
		);
		const result = await service.deliverPending();
		expect(result.delivered).toBe(1);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			to: EMAIL,
			deliveryKey: DELIVERY_ID,
			from: { email: 'noreply@example.com', name: 'SignKit' }
		});
		expect(messages[0].text).toContain(TOKEN);
		expect(messages[0].html).toContain('https://signkit.example/ja/settings');
		expect(complete).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: DELIVERY_ID }));
	});

	it('treats a lost claim as stale without opening or sending', async () => {
		const sealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(key());
		const claim: ClaimedInstanceInvitationDelivery = await eligibleClaim(sealer);
		const mail: MailSender = { send: vi.fn() };
		const store: InstanceInvitationDeliveryStore = {
			claimPending: vi.fn(async () => [claim]),
			readClaimed: vi.fn(async () => null),
			complete: vi.fn(),
			fail: vi.fn()
		};
		const result = await new InstanceInvitationDeliveryService(
			store,
			sealer,
			mail,
			'https://signkit.example',
			{ fromEmail: 'noreply@example.com', fromName: 'SignKit' },
			(): Date => NOW,
			(): string => 'claim-token'
		).deliverPending();
		expect(result.stale).toBe(1);
		expect(mail.send).not.toHaveBeenCalled();
		expect(store.fail).not.toHaveBeenCalled();
	});

	it.each([
		['digest mismatch', { sealedPayloadSha256: 'f'.repeat(64) }, 'ciphertext_digest_mismatch'],
		['unknown key', { sealingKeyId: 'unknown-key' }, 'sealing_key_mismatch'],
		['binding mismatch', { emailBinding: 'f'.repeat(64) }, 'payload_binding_mismatch']
	] as const)('fails closed on %s without sending', async (_label, overrides, expectedCode) => {
		const sealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(key());
		const claim: ClaimedInstanceInvitationDelivery = await eligibleClaim(sealer, overrides);
		const fail = vi.fn(async () => ({ outcome: 'failed' as const }));
		const mail: MailSender = { send: vi.fn() };
		const store: InstanceInvitationDeliveryStore = {
			claimPending: vi.fn(async () => [claim]),
			readClaimed: vi.fn(async () => claim),
			complete: vi.fn(),
			fail
		};
		const result = await new InstanceInvitationDeliveryService(
			store,
			sealer,
			mail,
			'https://signkit.example',
			{ fromEmail: 'noreply@example.com', fromName: 'SignKit' },
			(): Date => NOW,
			(): string => 'claim-token'
		).deliverPending();
		expect(result.outcomes[0]).toMatchObject({ errorCode: expectedCode });
		expect(mail.send).not.toHaveBeenCalled();
		expect(fail).toHaveBeenCalledWith(expect.objectContaining({ errorCode: expectedCode }));
	});

	it('retries provider failures but terminates and scrubs after the attempt cap', async () => {
		const sealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(key());
		const claim: ClaimedInstanceInvitationDelivery = await eligibleClaim(sealer, { attempts: 10 });
		const fail = vi.fn(async () => ({ outcome: 'failed' as const }));
		const store: InstanceInvitationDeliveryStore = {
			claimPending: vi.fn(async () => [claim]),
			readClaimed: vi.fn(async () => claim),
			complete: vi.fn(),
			fail
		};
		const mail: MailSender = {
			async send(): Promise<never> {
				throw new MailDeliveryError('provider_timeout', true);
			}
		};
		const result = await new InstanceInvitationDeliveryService(
			store,
			sealer,
			mail,
			'https://signkit.example',
			{ fromEmail: 'noreply@example.com', fromName: 'SignKit' },
			(): Date => NOW,
			(): string => 'claim-token'
		).deliverPending();
		expect(result.permanentlyFailed).toBe(1);
		expect(result.outcomes[0]).toMatchObject({ errorCode: 'delivery_attempts_exhausted' });
		expect(fail).toHaveBeenCalledWith(
			expect.objectContaining({ errorCode: 'delivery_attempts_exhausted', retryable: false })
		);
	});

	it('rejects non-root origins and invalid sender headers', () => {
		const store = {} as InstanceInvitationDeliveryStore;
		const sealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(key());
		const mail = {} as MailSender;
		expect(
			() =>
				new InstanceInvitationDeliveryService(store, sealer, mail, 'https://signkit.example/base', {
					fromEmail: 'noreply@example.com',
					fromName: 'SignKit'
				})
		).toThrow(InvalidInstanceInvitationDeliveryConfigError);
		expect(
			() =>
				new InstanceInvitationDeliveryService(store, sealer, mail, 'https://signkit.example', {
					fromEmail: 'noreply@example.com\r\nBcc: victim@example.com',
					fromName: 'SignKit'
				})
		).toThrow(InvalidInstanceInvitationDeliveryConfigError);
		expect(
			() =>
				new InstanceInvitationDeliveryService(store, sealer, mail, 'https://signkit.example', {
					fromEmail: 'noreply@example.com',
					fromName: 'SignKit\r\nBcc: victim@example.com'
				})
		).toThrow(InvalidInstanceInvitationDeliveryConfigError);
	});
});
