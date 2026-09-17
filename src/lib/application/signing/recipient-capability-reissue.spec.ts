import { describe, expect, it, vi } from 'vitest';
import {
	RecipientCapabilityReissueApplication,
	type ReissueRecipientCapabilityInput
} from './recipient-capability-reissue';
import type {
	PublishReissueCommand,
	PublishReissueResult,
	PublishedReissueResult,
	RecipientCapabilityReissueStore,
	ReissuePreparation
} from '$lib/ports/recipient-capability-reissue-store';
import type { RecipientCapabilitySealer } from '$lib/security/delivery-capability';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';

const actor: EnvelopeRequestActor = {
	id: '01900000-0000-7000-8000-000000000001',
	createdByUserId: '01900000-0000-7000-8000-000000000001'
};

const defaultInput: ReissueRecipientCapabilityInput = {
	envelopeId: '01900000-0000-7000-8000-000000000020',
	recipientId: '01900000-0000-7000-8000-000000000030',
	idempotencyKey: 'idemp-key-1',
	reason: 'resending invitation'
};

const fixedNow = new Date('2026-09-13T12:00:00.000Z');

function readyPreparation(sequence: number = 3): Extract<ReissuePreparation, { outcome: 'ready' }> {
	return {
		outcome: 'ready',
		previousCapabilityHash: 'b'.repeat(64),
		recipientStatus: 'pending',
		envelopeStatus: 'sent',
		auditHead: { sequence, eventHash: `${sequence}`.padStart(64, '0') }
	};
}

function publishedResult(
	cmd: Pick<
		PublishReissueCommand,
		'envelopeId' | 'recipientId' | 'updatedAt' | 'newCapabilityHash' | 'outboxId' | 'auditEventId'
	>
): PublishedReissueResult {
	return {
		envelopeId: cmd.envelopeId,
		recipientId: cmd.recipientId,
		newCapabilityHash: cmd.newCapabilityHash,
		outboxId: cmd.outboxId,
		reissuedAt: cmd.updatedAt,
		auditEventId: cmd.auditEventId
	};
}

describe('RecipientCapabilityReissueApplication', () => {
	it('prepares, mints capability, seals, and publishes reissue', async () => {
		const prepareReissue = vi.fn(async (): Promise<ReissuePreparation> => ({
			...readyPreparation(3),
			auditHead: { sequence: 3, eventHash: 'a'.repeat(64) }
		}));

		const publishReissue = vi.fn(
			async (cmd: PublishReissueCommand): Promise<PublishReissueResult> => ({
				outcome: 'published',
				result: publishedResult(cmd)
			})
		);

		const store: RecipientCapabilityReissueStore = { prepareReissue, publishReissue };

		const seal = vi.fn(async () => ({
			sealedCapability: 'sealed-data',
			sealingKeyId: 'key-1',
			sealedCapabilitySha256: 'c'.repeat(64)
		}));
		const sealer: RecipientCapabilitySealer = { seal };

		const app = new RecipientCapabilityReissueApplication(
			store,
			sealer,
			() => fixedNow,
			() => '01900000-0000-7000-8000-000000000099'
		);

		const result = await app.reissue(actor, defaultInput);

		expect(result.outcome).toBe('published');
		if (result.outcome === 'published') {
			expect(result.result.envelopeId).toBe(defaultInput.envelopeId);
			expect(result.result.recipientId).toBe(defaultInput.recipientId);
			expect(result.result.reissuedAt).toBe('2026-09-13T12:00:00.000Z');
		}

		expect(prepareReissue).toHaveBeenCalledOnce();
		expect(seal).toHaveBeenCalledOnce();
		expect(publishReissue).toHaveBeenCalledOnce();

		const publishedCommand: PublishReissueCommand = publishReissue.mock.calls[0][0];
		expect(publishedCommand.envelopeId).toBe(defaultInput.envelopeId);
		expect(publishedCommand.recipientId).toBe(defaultInput.recipientId);
		expect(publishedCommand.expectedAuditSequence).toBe(3);
		expect(publishedCommand.previousAuditHash).toBe('a'.repeat(64));
		expect(publishedCommand.previousCapabilityHash).toBe('b'.repeat(64));
		expect(publishedCommand.newCapabilityHash).toMatch(/^[a-f0-9]{64}$/);
		expect(publishedCommand.outboxId).toBe('01900000-0000-7000-8000-000000000099');
		expect(publishedCommand.sealedCapability).toBe('sealed-data');
	});

	it('returns replayed outcome without re-sealing or re-minting', async () => {
		const prepareReissue = vi.fn(async (): Promise<ReissuePreparation> => ({
			outcome: 'replayed',
			result: {
				envelopeId: defaultInput.envelopeId,
				recipientId: defaultInput.recipientId,
				newCapabilityHash: 'd'.repeat(64),
				outboxId: '01900000-0000-7000-8000-000000000099',
				reissuedAt: '2026-09-12T10:00:00.000Z',
				auditEventId: '01900000-0000-7000-8000-000000000088'
			}
		}));

		const publishReissue = vi.fn();
		const store: RecipientCapabilityReissueStore = { prepareReissue, publishReissue };
		const seal = vi.fn();
		const sealer: RecipientCapabilitySealer = { seal };

		const app = new RecipientCapabilityReissueApplication(store, sealer);
		const result = await app.reissue(actor, defaultInput);

		expect(result.outcome).toBe('replayed');
		if (result.outcome === 'replayed') {
			expect(result.result.reissuedAt).toBe('2026-09-12T10:00:00.000Z');
		}
		expect(prepareReissue).toHaveBeenCalledOnce();
		expect(seal).not.toHaveBeenCalled();
		expect(publishReissue).not.toHaveBeenCalled();
	});

	it('maps prepare non-ready outcomes directly (not_found, not_eligible, delivery_in_flight)', async () => {
		const storeNotFound: RecipientCapabilityReissueStore = {
			prepareReissue: async () => ({ outcome: 'not_found' }),
			publishReissue: vi.fn()
		};
		const sealer: RecipientCapabilitySealer = { seal: vi.fn() };

		const appNotFound = new RecipientCapabilityReissueApplication(storeNotFound, sealer);
		await expect(appNotFound.reissue(actor, defaultInput)).resolves.toEqual({
			outcome: 'not_found'
		});

		const storeNotEligible: RecipientCapabilityReissueStore = {
			prepareReissue: async () => ({ outcome: 'not_eligible', reason: 'envelope_terminal' }),
			publishReissue: vi.fn()
		};
		const appNotEligible = new RecipientCapabilityReissueApplication(storeNotEligible, sealer);
		await expect(appNotEligible.reissue(actor, defaultInput)).resolves.toEqual({
			outcome: 'not_eligible',
			reason: 'envelope_terminal'
		});

		const storeInFlight: RecipientCapabilityReissueStore = {
			prepareReissue: async () => ({ outcome: 'delivery_in_flight' }),
			publishReissue: vi.fn()
		};
		const appInFlight = new RecipientCapabilityReissueApplication(storeInFlight, sealer);
		await expect(appInFlight.reissue(actor, defaultInput)).resolves.toEqual({
			outcome: 'delivery_in_flight'
		});
	});

	it('retries on audit_conflict up to MAX_AUDIT_ATTEMPTS', async () => {
		let callCount = 0;
		const prepareReissue = vi.fn(async (): Promise<ReissuePreparation> => {
			callCount += 1;
			return readyPreparation(callCount);
		});

		const publishReissue = vi.fn(
			async (cmd: PublishReissueCommand): Promise<PublishReissueResult> => {
				if (cmd.expectedAuditSequence < 3) {
					return { outcome: 'audit_conflict' };
				}
				return {
					outcome: 'published',
					result: publishedResult(cmd)
				};
			}
		);

		const store: RecipientCapabilityReissueStore = { prepareReissue, publishReissue };
		const sealer: RecipientCapabilitySealer = {
			seal: async () => ({
				sealedCapability: 'sealed-data',
				sealingKeyId: 'key-1',
				sealedCapabilitySha256: 'c'.repeat(64)
			})
		};

		const app = new RecipientCapabilityReissueApplication(store, sealer);
		const result = await app.reissue(actor, defaultInput);

		expect(result.outcome).toBe('published');
		expect(prepareReissue).toHaveBeenCalledTimes(3);
		expect(publishReissue).toHaveBeenCalledTimes(3);
	});
});
