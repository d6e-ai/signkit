import { describe, expect, it, vi } from 'vitest';
import type { Envelope } from '$lib/domain/envelope';
import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';
import type { EnvelopeApplicationStore } from './model';
import { EnvelopeApplication } from './service';

const envelope: Envelope = {
	id: '01900000-0000-7000-8000-000000000001',
	createdByUserId: 'user-1',
	title: 'Agreement',
	status: 'draft',
	repositoryGeneration: 0,
	repositoryHead: null,
	repositoryArchiveKey: null,
	repositoryArchiveSha256: null,
	sentCommitSha: null,
	fieldGeneration: 0,
	createdAt: '2026-09-11T00:00:00.000Z',
	updatedAt: '2026-09-11T00:00:00.000Z'
};

function createStore(): EnvelopeApplicationStore {
	return {
		compareAndSetDraftPointer: vi.fn(async (): Promise<boolean> => true),
		createIdempotently: vi.fn(async (): Promise<{ outcome: 'created'; envelope: Envelope }> => ({
			outcome: 'created',
			envelope
		})),
		findEnvelope: vi.fn(async (): Promise<Envelope | null> => envelope),
		readDetail: vi.fn(async () => ({
			envelope,
			recipients: [],
			readyAuditEventId: null,
			fields: []
		})),
		listEnvelopes: vi.fn(async () => ({
			items: [envelope],
			nextCursor: null
		})),
		transition: vi.fn(async (): Promise<boolean> => true)
	};
}

describe('EnvelopeApplication', () => {
	it('attributes creation to the authenticated actor', async () => {
		const store: EnvelopeApplicationStore = createStore();
		const application: EnvelopeApplication = new EnvelopeApplication(store);

		await application.create(
			{ id: 'user-1', createdByUserId: 'user-1' },
			{ idempotencyKey: 'request-1', title: 'Agreement' }
		);

		expect(store.createIdempotently).toHaveBeenCalledWith({
			actor: { id: 'user-1', type: 'user' },
			auditEventHash: expect.stringMatching(/^[0-9a-f]{64}$/),
			auditEventId: expect.stringMatching(UUID_V7_PATTERN),
			createdAt: expect.any(String),
			createdByUserId: 'user-1',
			envelopeId: expect.stringMatching(UUID_V7_PATTERN),
			idempotencyKey: 'request-1',
			requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
			title: 'Agreement'
		});
	});

	it('mints a distinct envelope and audit event identifier from the injected generator', async () => {
		const store: EnvelopeApplicationStore = createStore();
		const minted: string[] = [
			'01900000-0000-7000-8000-0000000000a1',
			'01900000-0000-7000-8000-0000000000a2'
		];
		const application: EnvelopeApplication = new EnvelopeApplication(
			store,
			(): string => minted.shift() ?? 'exhausted'
		);

		await application.create(
			{ id: 'user-1', createdByUserId: 'user-1' },
			{ idempotencyKey: 'request-1', title: 'Agreement' }
		);

		expect(store.createIdempotently).toHaveBeenCalledWith(
			expect.objectContaining({
				envelopeId: '01900000-0000-7000-8000-0000000000a1',
				auditEventId: '01900000-0000-7000-8000-0000000000a2'
			})
		);
	});

	it('does not derive the envelope identifier from the idempotency key', async () => {
		const store: EnvelopeApplicationStore = createStore();
		const actor = {
			id: 'user-1',
			createdByUserId: 'user-1'
		} as const;
		const application: EnvelopeApplication = new EnvelopeApplication(store);

		await application.create(actor, { idempotencyKey: 'request-1', title: 'Agreement' });
		await application.create(actor, { idempotencyKey: 'request-1', title: 'Agreement' });

		const calls = vi.mocked(store.createIdempotently).mock.calls;
		expect(calls[0][0].requestFingerprint).toBe(calls[1][0].requestFingerprint);
		expect(calls[0][0].envelopeId).not.toBe(calls[1][0].envelopeId);
		expect(calls[1][0].envelopeId > calls[0][0].envelopeId).toBe(true);
	});

	it('reads instance-wide for list and get operations', async () => {
		const store: EnvelopeApplicationStore = createStore();
		const application: EnvelopeApplication = new EnvelopeApplication(store);
		const actor = {
			id: 'user-1',
			createdByUserId: 'user-1'
		} as const;

		await application.list(actor, { cursor: null, limit: 25 });
		await application.get(actor, envelope.id);
		await application.getDetail(actor, envelope.id);

		expect(store.listEnvelopes).toHaveBeenCalledWith({
			cursor: null,
			limit: 25
		});
		expect(store.findEnvelope).toHaveBeenCalledWith(envelope.id);
		expect(store.readDetail).toHaveBeenCalledWith(envelope.id);
	});
});
