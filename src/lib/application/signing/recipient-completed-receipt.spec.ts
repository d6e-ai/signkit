import { describe, expect, it, vi } from 'vitest';
import type {
	ProvenRecipientCompletedReceipt,
	RecipientCompletedReceiptLocator,
	RecipientCompletedReceiptStore
} from '$lib/ports/recipient-completed-receipt-store';
import { issueRecipientCapability } from '$lib/security/recipient-capability';
import { RecipientCompletedReceiptApplication } from './recipient-completed-receipt';

const COMPLETED_AT: string = '2026-09-12T00:00:00.000Z';
const EXPIRES_AT: string = '2026-10-12T00:00:00.000Z';
const BEFORE_EXPIRY: Date = new Date('2026-10-11T23:59:59.999Z');

function store(evidence: ProvenRecipientCompletedReceipt | null): RecipientCompletedReceiptStore & {
	findByCapabilityHash: ReturnType<typeof vi.fn>;
	findByIdentity: ReturnType<typeof vi.fn>;
} {
	return {
		findByCapabilityHash: vi.fn(
			async (): Promise<ProvenRecipientCompletedReceipt | null> => evidence
		),
		findByIdentity: vi.fn(async (): Promise<ProvenRecipientCompletedReceipt | null> => evidence)
	};
}

function evidence(
	capabilityHash: string,
	overrides: Partial<ProvenRecipientCompletedReceipt> = {}
): ProvenRecipientCompletedReceipt {
	return {
		envelopeId: 'envelope-1',
		recipientId: 'recipient-1',
		idempotencyKey: 'sign-1',
		capabilityHash,
		action: 'signed',
		completedAt: COMPLETED_AT,
		envelopeStatus: 'in_progress',
		envelopeCompletedByThisAction: false,
		locale: 'ja',
		...overrides
	};
}

function locator(capabilityHash: string): RecipientCompletedReceiptLocator {
	return {
		envelopeId: 'envelope-1',
		recipientId: 'recipient-1',
		idempotencyKey: 'sign-1',
		capabilityHash,
		action: 'signed',
		completedAt: COMPLETED_AT,
		expiresAt: EXPIRES_AT
	};
}

describe('RecipientCompletedReceiptApplication', () => {
	it('recovers a minimal read-only receipt and strict internal locator from the original token', async () => {
		const capability = await issueRecipientCapability();
		const storePort = store(evidence(capability.tokenHash));
		const result = await new RecipientCompletedReceiptApplication(storePort).recoverByToken(
			capability.token,
			BEFORE_EXPIRY
		);

		expect(storePort.findByCapabilityHash).toHaveBeenCalledWith(capability.tokenHash);
		expect(result).toEqual({
			receipt: {
				envelopeId: 'envelope-1',
				recipientId: 'recipient-1',
				recipientStatus: 'completed',
				action: 'signed',
				completedAt: COMPLETED_AT,
				envelopeStatus: 'in_progress',
				envelopeCompletedByThisAction: false,
				locale: 'ja'
			},
			locator: locator(capability.tokenHash)
		});
		// No document, field, evidence, or completion-artifact reference is exposed.
		expect(Object.keys(result?.receipt ?? {}).sort()).toEqual([
			'action',
			'completedAt',
			'envelopeCompletedByThisAction',
			'envelopeId',
			'envelopeStatus',
			'locale',
			'recipientId',
			'recipientStatus'
		]);
	});

	it('reports this recipient’s action and whole-envelope progress independently', async () => {
		const capability = await issueRecipientCapability();
		const laterSignerCompleted = await new RecipientCompletedReceiptApplication(
			store(
				evidence(capability.tokenHash, {
					envelopeStatus: 'completed',
					envelopeCompletedByThisAction: false
				})
			)
		).recoverByToken(capability.token, BEFORE_EXPIRY);
		const completedByThisApprover = await new RecipientCompletedReceiptApplication(
			store(
				evidence(capability.tokenHash, {
					action: 'approved',
					envelopeStatus: 'completed',
					envelopeCompletedByThisAction: true
				})
			)
		).recoverByToken(capability.token, BEFORE_EXPIRY);

		expect(laterSignerCompleted?.receipt).toMatchObject({
			action: 'signed',
			envelopeStatus: 'completed',
			envelopeCompletedByThisAction: false
		});
		expect(completedByThisApprover?.receipt).toMatchObject({
			action: 'approved',
			envelopeStatus: 'completed',
			envelopeCompletedByThisAction: true
		});
		expect(completedByThisApprover?.locator.action).toBe('approved');
	});

	it('treats malformed, unknown, and expired capabilities alike', async () => {
		const capability = await issueRecipientCapability();
		const missingStore = store(null);
		const application = new RecipientCompletedReceiptApplication(missingStore);

		await expect(application.recoverByToken('not-a-capability', BEFORE_EXPIRY)).resolves.toBeNull();
		expect(missingStore.findByCapabilityHash).not.toHaveBeenCalled();
		await expect(application.recoverByToken(capability.token, BEFORE_EXPIRY)).resolves.toBeNull();

		const expired = new RecipientCompletedReceiptApplication(store(evidence(capability.tokenHash)));
		await expect(
			expired.recoverByToken(capability.token, new Date(EXPIRES_AT))
		).resolves.toBeNull();
	});

	it('resolves only a locator whose identity, action, and derived timestamps match evidence', async () => {
		const capability = await issueRecipientCapability();
		const storePort = store(evidence(capability.tokenHash));
		const application = new RecipientCompletedReceiptApplication(storePort);
		const exact: RecipientCompletedReceiptLocator = locator(capability.tokenHash);

		await expect(application.resolveLocator(exact, BEFORE_EXPIRY)).resolves.toMatchObject({
			receipt: { recipientStatus: 'completed', action: 'signed' },
			locator: exact
		});
		expect(storePort.findByIdentity).toHaveBeenCalledWith(exact);

		for (const changed of [
			{ ...exact, envelopeId: 'envelope-2' },
			{ ...exact, recipientId: 'recipient-2' },
			{ ...exact, idempotencyKey: 'sign-2' },
			{ ...exact, capabilityHash: 'b'.repeat(64) },
			{ ...exact, action: 'approved' as const },
			{ ...exact, completedAt: '2026-09-12T00:00:00.001Z' },
			{ ...exact, expiresAt: '2026-10-12T00:00:00.001Z' }
		]) {
			await expect(application.resolveLocator(changed, BEFORE_EXPIRY)).resolves.toBeNull();
		}
	});

	it('fails closed on malformed locators and invalid clocks without querying evidence', async () => {
		const capability = await issueRecipientCapability();
		const storePort = store(evidence(capability.tokenHash));
		const application = new RecipientCompletedReceiptApplication(storePort);

		for (const malformed of [
			{ ...locator(capability.tokenHash), envelopeId: '' },
			{ ...locator(capability.tokenHash), capabilityHash: 'A'.repeat(64) },
			{
				...locator(capability.tokenHash),
				action: 'declined' as unknown as RecipientCompletedReceiptLocator['action']
			}
		]) {
			await expect(application.resolveLocator(malformed, BEFORE_EXPIRY)).resolves.toBeNull();
		}
		expect(storePort.findByIdentity).not.toHaveBeenCalled();
		await expect(
			application.recoverByToken(capability.token, new Date(Number.NaN))
		).resolves.toBeNull();
	});
});
