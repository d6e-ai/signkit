import { describe, expect, it, vi } from 'vitest';
import type { Envelope } from '$lib/domain/envelope';
import type { EnvelopeApplicationStore } from './model';
import { EnvelopeApplication } from './service';

const envelope: Envelope = {
	id: '01900000-0000-7000-8000-000000000001',
	organizationId: '01900000-0000-7000-8000-000000000002',
	title: 'Agreement',
	status: 'draft',
	repositoryGeneration: 0,
	repositoryHead: null,
	repositoryArchiveKey: null,
	repositoryArchiveSha256: null,
	sentCommitSha: null,
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
		findForOrganization: vi.fn(async (): Promise<Envelope | null> => envelope),
		listForOrganization: vi.fn(async () => ({
			items: [envelope],
			nextCursor: null
		})),
		transition: vi.fn(async (): Promise<boolean> => true)
	};
}

describe('EnvelopeApplication', () => {
	it('derives tenant scope exclusively from the authenticated actor', async () => {
		const store: EnvelopeApplicationStore = createStore();
		const application: EnvelopeApplication = new EnvelopeApplication(store);

		await application.create(
			{ id: 'user-1', organizationId: envelope.organizationId, organizationName: 'Workspace' },
			{ idempotencyKey: 'request-1', title: 'Agreement' }
		);

		expect(store.createIdempotently).toHaveBeenCalledWith({
			actor: { id: 'user-1', type: 'user' },
			auditEventHash: expect.stringMatching(/^[0-9a-f]{64}$/),
			auditEventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			createdAt: expect.any(String),
			envelopeId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			idempotencyKey: 'request-1',
			organizationId: envelope.organizationId,
			organizationName: 'Workspace',
			requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
			title: 'Agreement'
		});
	});

	it('uses the organization scope for list and get operations', async () => {
		const store: EnvelopeApplicationStore = createStore();
		const application: EnvelopeApplication = new EnvelopeApplication(store);
		const actor = {
			id: 'user-1',
			organizationId: envelope.organizationId,
			organizationName: 'Workspace'
		} as const;

		await application.list(actor, { cursor: null, limit: 25 });
		await application.get(actor, envelope.id);

		expect(store.listForOrganization).toHaveBeenCalledWith(envelope.organizationId, {
			cursor: null,
			limit: 25
		});
		expect(store.findForOrganization).toHaveBeenCalledWith(envelope.organizationId, envelope.id);
	});
});
