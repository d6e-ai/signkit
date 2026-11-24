import { describe, expect, it, vi } from 'vitest';
import type {
	ClaimedInstanceInvitationDelivery,
	InstanceInvitationDeliveryStore
} from '$lib/ports/instance-invitation-delivery-store';
import { CONSOLE_HANDOFF_PROVIDER_MESSAGE_ID } from '$lib/ports/instance-store';
import {
	computeInstanceInvitationEmailBinding,
	hashInstanceInvitationToken
} from '$lib/security/instance-invitation';
import { AesGcmInstanceInvitationDeliveryPayloadSealer } from '$lib/security/instance-invitation-delivery-payload';
import {
	InstanceInvitationDeliveryService,
	type InstanceInvitationNoteOutcome,
	type InstanceInvitationNotifier
} from './instance-invitation-delivery-service';

const NOW: Date = new Date('2026-09-17T12:00:00.000Z');
const INVITATION_ID: string = '01900000-0000-7000-8000-000000000001';
const DELIVERY_ID: string = '01900000-0000-7000-8000-000000000002';
const TOKEN: string = `ski1_${'a'.repeat(43)}`;
const EMAIL: string = 'invitee@example.com';
const INVITER: string = 'inviter-user-1';

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
		locale: 'en',
		role: 'member',
		invitationStatus: 'pending',
		expiresAt: '2026-09-19T12:00:00.000Z',
		inviterUserId: INVITER,
		tokenHash: await hashInstanceInvitationToken(TOKEN),
		emailBinding: await computeInstanceInvitationEmailBinding(TOKEN, EMAIL),
		sealedPayload: sealed.sealedPayload,
		sealedPayloadSha256: sealed.sealedPayloadSha256,
		sealingKeyId: sealed.sealingKeyId,
		attempts: 1,
		...overrides
	};
}

function storeFor(
	claim: ClaimedInstanceInvitationDelivery,
	readClaimed: ClaimedInstanceInvitationDelivery | null = claim
): InstanceInvitationDeliveryStore & {
	complete: ReturnType<typeof vi.fn>;
	fail: ReturnType<typeof vi.fn>;
} {
	return {
		claimPending: vi.fn(async () => [claim]),
		readClaimed: vi.fn(async () => readClaimed),
		complete: vi.fn(async () => ({ outcome: 'completed' as const })),
		fail: vi.fn(async () => ({ outcome: 'failed' as const }))
	};
}

function service(
	store: InstanceInvitationDeliveryStore,
	sealer: AesGcmInstanceInvitationDeliveryPayloadSealer,
	notify: InstanceInvitationNotifier
): InstanceInvitationDeliveryService {
	return new InstanceInvitationDeliveryService(
		store,
		sealer,
		notify,
		(): Date => NOW,
		(): string => 'claim-token'
	);
}

describe('InstanceInvitationDeliveryService', () => {
	it('opens the bound payload, notes D6E Auth, and closes the row as handed off', async () => {
		const sealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(key());
		const store = storeFor(await eligibleClaim(sealer));
		const notify = vi.fn(async (): Promise<InstanceInvitationNoteOutcome> => 'sent');

		const result = await service(store, sealer, notify).deliverPending();

		expect(result.delivered).toBe(1);
		expect(notify).toHaveBeenCalledExactlyOnceWith({
			invitationId: INVITATION_ID,
			recipientEmail: EMAIL,
			expiresAt: '2026-09-19T12:00:00.000Z',
			inviterSubject: INVITER,
			locale: 'en'
		});
		expect(store.complete).toHaveBeenCalledWith(
			expect.objectContaining({
				deliveryId: DELIVERY_ID,
				providerMessageId: CONSOLE_HANDOFF_PROVIDER_MESSAGE_ID
			})
		);
	});

	it('closes the row when D6E Auth already holds a withdrawal for the invitation', async () => {
		const sealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(key());
		const store = storeFor(await eligibleClaim(sealer));

		const result = await service(store, sealer, async () => 'withdrawn').deliverPending();

		expect(result.delivered).toBe(1);
		expect(store.fail).not.toHaveBeenCalled();
	});

	it.each([
		['failed', 'console_note_failed'],
		['disabled', 'console_not_configured']
	] as const)('retries a %s note with backoff', async (outcome, errorCode) => {
		const sealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(key());
		const store = storeFor(await eligibleClaim(sealer));

		const result = await service(store, sealer, async () => outcome).deliverPending();

		expect(result.retryableFailed).toBe(1);
		expect(store.complete).not.toHaveBeenCalled();
		expect(store.fail).toHaveBeenCalledWith(
			expect.objectContaining({ errorCode, retryable: true })
		);
	});

	it('treats a throwing notifier as a failed note', async () => {
		const sealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(key());
		const store = storeFor(await eligibleClaim(sealer));

		const result = await service(store, sealer, async () => {
			throw new Error('network down');
		}).deliverPending();

		expect(result.outcomes[0]).toMatchObject({ errorCode: 'console_note_failed' });
	});

	it('treats a lost claim as stale without opening or noting', async () => {
		const sealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(key());
		const store = storeFor(await eligibleClaim(sealer), null);
		const notify = vi.fn();

		const result = await service(store, sealer, notify).deliverPending();

		expect(result.stale).toBe(1);
		expect(notify).not.toHaveBeenCalled();
		expect(store.fail).not.toHaveBeenCalled();
	});

	it.each([
		['digest mismatch', { sealedPayloadSha256: 'f'.repeat(64) }, 'ciphertext_digest_mismatch'],
		['unknown key', { sealingKeyId: 'unknown-key' }, 'sealing_key_mismatch'],
		['binding mismatch', { emailBinding: 'f'.repeat(64) }, 'payload_binding_mismatch'],
		['a finished invitation', { invitationStatus: 'revoked' }, 'invitation_not_active']
	] as const)('fails closed on %s without noting', async (_label, overrides, expectedCode) => {
		const sealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(key());
		const store = storeFor(await eligibleClaim(sealer, overrides));
		const notify = vi.fn();

		const result = await service(store, sealer, notify).deliverPending();

		expect(result.outcomes[0]).toMatchObject({ errorCode: expectedCode });
		expect(notify).not.toHaveBeenCalled();
		expect(store.fail).toHaveBeenCalledWith(expect.objectContaining({ errorCode: expectedCode }));
	});

	it('terminates and scrubs after the attempt cap', async () => {
		const sealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(key());
		const store = storeFor(await eligibleClaim(sealer, { attempts: 10 }));

		const result = await service(store, sealer, async () => 'failed').deliverPending();

		expect(result.permanentlyFailed).toBe(1);
		expect(result.outcomes[0]).toMatchObject({ errorCode: 'delivery_attempts_exhausted' });
		expect(store.fail).toHaveBeenCalledWith(
			expect.objectContaining({ errorCode: 'delivery_attempts_exhausted', retryable: false })
		);
	});
});
