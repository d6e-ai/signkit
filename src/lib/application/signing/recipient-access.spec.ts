import { describe, expect, it } from 'vitest';
import type {
	RecipientAccessStore,
	RecipientSigningContext
} from '$lib/ports/recipient-access-store';
import { issueRecipientCapability } from '$lib/security/recipient-capability';
import { RecipientAccessService, toPublicRecipientAccess } from './recipient-access';

class StubRecipientAccessStore implements RecipientAccessStore {
	constructor(private readonly context: RecipientSigningContext | null) {}

	async findActiveByTokenHash(): Promise<RecipientSigningContext | null> {
		return this.context;
	}
}

const activeContext: RecipientSigningContext = {
	envelopeId: 'env_1',
	recipientId: 'recipient_1',
	recipientName: 'Recipient',
	recipientLocale: 'ja',
	recipientRole: 'signer',
	recipientStatus: 'pending',
	envelopeTitle: 'Agreement',
	envelopeStatus: 'sent',
	expiresAt: '2026-09-12T00:00:00.000Z',
	sentRevision: {
		commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		archiveKey: 'private/archive.git.gz',
		archiveSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	}
};

describe('RecipientAccessService', () => {
	it('resolves an active recipient without accepting an organization identifier from the caller', async () => {
		const capability = await issueRecipientCapability();
		const service = new RecipientAccessService(new StubRecipientAccessStore(activeContext));

		await expect(service.resolve(capability.token, '2026-09-11T00:00:00.000Z')).resolves.toEqual(
			activeContext
		);
	});

	it('returns the same not-found result for malformed, unknown, and expired capabilities', async () => {
		const capability = await issueRecipientCapability();
		const unknown = new RecipientAccessService(new StubRecipientAccessStore(null));
		const expired = new RecipientAccessService(
			new StubRecipientAccessStore({ ...activeContext, expiresAt: '2026-09-10T00:00:00.000Z' })
		);

		await expect(unknown.resolve('malformed', '2026-09-11T00:00:00.000Z')).resolves.toBeNull();
		await expect(unknown.resolve(capability.token, '2026-09-11T00:00:00.000Z')).resolves.toBeNull();
		await expect(expired.resolve(capability.token, '2026-09-11T00:00:00.000Z')).resolves.toBeNull();
	});

	it('fails closed at the exact expiry boundary and for an invalid server timestamp', async () => {
		const capability = await issueRecipientCapability();
		const service = new RecipientAccessService(new StubRecipientAccessStore(activeContext));

		await expect(service.resolve(capability.token, activeContext.expiresAt)).resolves.toBeNull();
		await expect(service.resolve(capability.token, 'invalid')).resolves.toBeNull();
	});

	it('fails closed for envelopes and recipients that can no longer act', async () => {
		const capability = await issueRecipientCapability();
		const completedEnvelope = new RecipientAccessService(
			new StubRecipientAccessStore({ ...activeContext, envelopeStatus: 'completed' })
		);
		const completedRecipient = new RecipientAccessService(
			new StubRecipientAccessStore({ ...activeContext, recipientStatus: 'completed' })
		);

		await expect(
			completedEnvelope.resolve(capability.token, '2026-09-11T00:00:00.000Z')
		).resolves.toBeNull();
		await expect(
			completedRecipient.resolve(capability.token, '2026-09-11T00:00:00.000Z')
		).resolves.toBeNull();
	});
});

describe('toPublicRecipientAccess', () => {
	it('exposes the sender-provided name only on the capability-bound public context', () => {
		const access = toPublicRecipientAccess(activeContext);
		expect(access).toEqual({
			envelopeId: 'env_1',
			recipientId: 'recipient_1',
			recipientName: 'Recipient',
			role: 'signer',
			locale: 'ja',
			recipientStatus: 'pending',
			envelopeTitle: 'Agreement',
			envelopeStatus: 'sent',
			expiresAt: '2026-09-12T00:00:00.000Z'
		});
		expect(Object.keys(access).sort()).toEqual(
			[
				'envelopeId',
				'envelopeStatus',
				'envelopeTitle',
				'expiresAt',
				'locale',
				'recipientId',
				'recipientName',
				'recipientStatus',
				'role'
			].sort()
		);
		expect(JSON.stringify(access)).not.toMatch(/org_1|email|archive|token|hash/i);
	});
});
