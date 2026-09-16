import { describe, expect, it, vi } from 'vitest';
import {
	ContactApplication,
	InvalidContactRequestError
} from '$lib/application/contacts/contact-service';
import type {
	CreateContactCommand,
	CreateContactStoreResult,
	ContactStore,
	DeleteContactStoreResult,
	UpdateContactStoreResult
} from '$lib/ports/contact-store';

const CONTACT_ID = '01900000-0000-7000-8000-000000000701';

describe('ContactApplication version bounds', () => {
	it('accepts a 200-character name whose lowercase search key expands to 400 code points', async () => {
		const createContact = vi.fn(
			async (command: CreateContactCommand): Promise<CreateContactStoreResult> => {
				void command;
				return { outcome: 'integrity_error' };
			}
		);
		const listContacts = vi.fn(async () => ({
			outcome: 'listed' as const,
			page: { items: [], nextCursor: null }
		}));
		const store: ContactStore = {
			createContact,
			listContacts,
			updateContact: async () => ({ outcome: 'integrity_error' }),
			deleteContact: async () => ({ outcome: 'integrity_error' })
		};
		const application = new ContactApplication(
			store,
			(): Date => new Date('2026-09-17T00:00:00.000Z'),
			(): string => CONTACT_ID
		);
		const expandingName: string = '\u0130'.repeat(200);

		await expect(
			application.create(
				{ id: 'owner-1' },
				{
					idempotencyKey: 'expanding-name',
					name: expandingName,
					email: 'unicode@example.com',
					locale: 'en'
				}
			)
		).resolves.toEqual({ outcome: 'integrity_error' });
		expect(createContact).toHaveBeenCalledWith(
			expect.objectContaining({
				name: expandingName,
				nameSearch: expandingName.toLowerCase()
			})
		);
		expect(expandingName.toLowerCase()).toHaveLength(400);
		await expect(
			application.list({ id: 'owner-1' }, { cursor: null, limit: 25, query: expandingName })
		).resolves.toMatchObject({ outcome: 'listed' });
		expect(listContacts).toHaveBeenCalledWith(
			{ id: 'owner-1' },
			expect.objectContaining({ query: expandingName.toLowerCase() })
		);
	});

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
