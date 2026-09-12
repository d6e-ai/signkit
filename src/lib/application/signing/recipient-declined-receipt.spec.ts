import { describe, expect, it, vi } from 'vitest';
import type {
	ProvenRecipientDeclinedReceipt,
	RecipientDeclinedReceiptLocator,
	RecipientDeclinedReceiptStore
} from '$lib/ports/recipient-declined-receipt-store';
import { issueRecipientCapability } from '$lib/security/recipient-capability';
import { RecipientDeclinedReceiptApplication } from './recipient-declined-receipt';

const DECLINED_AT: string = '2026-09-12T00:00:00.000Z';
const EXPIRES_AT: string = '2026-10-12T00:00:00.000Z';
const BEFORE_EXPIRY: Date = new Date('2026-10-11T23:59:59.999Z');

function store(evidence: ProvenRecipientDeclinedReceipt | null): RecipientDeclinedReceiptStore & {
	findByCapabilityHash: ReturnType<typeof vi.fn>;
	findByIdentity: ReturnType<typeof vi.fn>;
} {
	return {
		findByCapabilityHash: vi.fn(
			async (): Promise<ProvenRecipientDeclinedReceipt | null> => evidence
		),
		findByIdentity: vi.fn(async (): Promise<ProvenRecipientDeclinedReceipt | null> => evidence)
	};
}

function evidence(capabilityHash: string): ProvenRecipientDeclinedReceipt {
	return {
		organizationId: 'org-1',
		envelopeId: 'envelope-1',
		recipientId: 'recipient-1',
		idempotencyKey: 'decline-1',
		capabilityHash,
		declinedAt: DECLINED_AT,
		locale: 'ja'
	};
}

function locator(capabilityHash: string): RecipientDeclinedReceiptLocator {
	return {
		organizationId: 'org-1',
		envelopeId: 'envelope-1',
		recipientId: 'recipient-1',
		idempotencyKey: 'decline-1',
		capabilityHash,
		declinedAt: DECLINED_AT,
		expiresAt: EXPIRES_AT
	};
}

describe('RecipientDeclinedReceiptApplication', () => {
	it('recovers a minimal public receipt and strict internal locator from the original token', async () => {
		const capability = await issueRecipientCapability();
		const storePort = store(evidence(capability.tokenHash));
		const result = await new RecipientDeclinedReceiptApplication(storePort).recoverByToken(
			capability.token,
			BEFORE_EXPIRY
		);

		expect(storePort.findByCapabilityHash).toHaveBeenCalledWith(capability.tokenHash);
		expect(result).toEqual({
			receipt: {
				envelopeId: 'envelope-1',
				recipientId: 'recipient-1',
				recipientStatus: 'declined',
				envelopeStatus: 'declined',
				declinedAt: DECLINED_AT,
				locale: 'ja'
			},
			locator: locator(capability.tokenHash)
		});
		expect(Object.keys(result?.receipt ?? {}).sort()).toEqual(
			[
				'declinedAt',
				'envelopeId',
				'envelopeStatus',
				'locale',
				'recipientId',
				'recipientStatus'
			].sort()
		);
	});

	it('treats malformed, unknown, and expired capabilities alike', async () => {
		const capability = await issueRecipientCapability();
		const missingStore = store(null);
		const application = new RecipientDeclinedReceiptApplication(missingStore);

		await expect(application.recoverByToken('not-a-capability', BEFORE_EXPIRY)).resolves.toBeNull();
		expect(missingStore.findByCapabilityHash).not.toHaveBeenCalled();
		await expect(application.recoverByToken(capability.token, BEFORE_EXPIRY)).resolves.toBeNull();

		const expired = new RecipientDeclinedReceiptApplication(store(evidence(capability.tokenHash)));
		await expect(
			expired.recoverByToken(capability.token, new Date(EXPIRES_AT))
		).resolves.toBeNull();
	});

	it('resolves only a locator whose identity and derived timestamps exactly match durable evidence', async () => {
		const capability = await issueRecipientCapability();
		const storePort = store(evidence(capability.tokenHash));
		const application = new RecipientDeclinedReceiptApplication(storePort);
		const exact: RecipientDeclinedReceiptLocator = locator(capability.tokenHash);

		await expect(application.resolveLocator(exact, BEFORE_EXPIRY)).resolves.toMatchObject({
			receipt: { recipientStatus: 'declined', envelopeStatus: 'declined' },
			locator: exact
		});
		expect(storePort.findByIdentity).toHaveBeenCalledWith(exact);

		for (const changed of [
			{ ...exact, organizationId: 'org-2' },
			{ ...exact, envelopeId: 'envelope-2' },
			{ ...exact, recipientId: 'recipient-2' },
			{ ...exact, idempotencyKey: 'decline-2' },
			{ ...exact, capabilityHash: 'b'.repeat(64) },
			{ ...exact, declinedAt: '2026-09-12T00:00:00.001Z' },
			{ ...exact, expiresAt: '2026-10-12T00:00:00.001Z' }
		]) {
			await expect(application.resolveLocator(changed, BEFORE_EXPIRY)).resolves.toBeNull();
		}
	});

	it('fails closed on malformed locators and invalid clocks without querying evidence', async () => {
		const capability = await issueRecipientCapability();
		const storePort = store(evidence(capability.tokenHash));
		const application = new RecipientDeclinedReceiptApplication(storePort);

		await expect(
			application.resolveLocator(
				{ ...locator(capability.tokenHash), organizationId: '' },
				BEFORE_EXPIRY
			)
		).resolves.toBeNull();
		expect(storePort.findByIdentity).not.toHaveBeenCalled();
		await expect(
			application.recoverByToken(capability.token, new Date(Number.NaN))
		).resolves.toBeNull();
	});
});
