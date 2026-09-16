import { describe, expect, it, vi } from 'vitest';
import {
	ContactApplication,
	InvalidContactRequestError
} from '$lib/application/contacts/contact-service';
import type {
	ContactStore,
	DeleteContactStoreResult,
	UpdateContactStoreResult
} from '$lib/ports/contact-store';

const CONTACT_ID = '01900000-0000-7000-8000-000000000701';

describe('ContactApplication version bounds', () => {
	it('rejects an update that would overflow while allowing the maximum delete version', async () => {
		const updateContact = vi.fn(async (): Promise<UpdateContactStoreResult> => ({
			outcome: 'integrity_error'
		}));
		const deleteContact = vi.fn(async (): Promise<DeleteContactStoreResult> => ({
			outcome: 'version_conflict'
		}));
		const store: ContactStore = {
			createContact: async () => ({ outcome: 'integrity_error' }),
			listContacts: async () => ({
				outcome: 'listed',
				page: { items: [], nextCursor: null }
			}),
			updateContact,
			deleteContact
		};
		const application = new ContactApplication(
			store,
			(): Date => new Date('2026-09-17T00:00:00.000Z')
		);

		await expect(
			application.update({ id: 'owner-1' }, CONTACT_ID, {
				idempotencyKey: 'update-overflow',
				expectedVersion: 2_147_483_647,
				name: 'Alice',
				email: 'alice@example.com',
				locale: 'en'
			})
		).rejects.toBeInstanceOf(InvalidContactRequestError);
		expect(updateContact).not.toHaveBeenCalled();

		await expect(
			application.delete({ id: 'owner-1' }, CONTACT_ID, {
				idempotencyKey: 'delete-max',
				expectedVersion: 2_147_483_647
			})
		).resolves.toEqual({ outcome: 'version_conflict' });
		expect(deleteContact).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedVersion: 2_147_483_647,
				commandMarker: expect.stringMatching(/^[0-9a-f]{64}$/)
			})
		);
	});
});
