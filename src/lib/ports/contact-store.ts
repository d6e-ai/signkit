import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';

export const DEFAULT_CONTACT_LIST_LIMIT: number = 25;
export const MAX_CONTACT_LIST_LIMIT: number = 100;
export const MAX_CONTACT_VERSION: number = 2_147_483_647;
export const MAX_CONTACT_UPDATE_EXPECTED_VERSION: number = MAX_CONTACT_VERSION - 1;
// ECMAScript lowercasing can expand one UTF-16 code unit into two Unicode
// code points (for example, U+0130 becomes `i` plus a combining dot). Contact
// display names remain capped at 200 UTF-16 code units, so 400 safely bounds
// the derived, non-user-visible search key.
export const MAX_CONTACT_NAME_SEARCH_LENGTH: number = 400;
export const CONTACT_IDEMPOTENCY_KEY_PATTERN: RegExp = /^[!-~]{1,200}$/;

export interface ContactActor {
	id: string;
}

export interface ContactMetadata {
	id: string;
	name: string;
	email: string;
	locale: 'en' | 'ja';
	version: number;
	createdAt: string;
	updatedAt: string;
}

export interface ContactListQuery {
	cursor: string | null;
	limit: number;
	query: string | null;
}

export interface ContactListPage {
	items: readonly ContactMetadata[];
	nextCursor: string | null;
}

export interface ContactCommandBase {
	actor: ContactActor;
	idempotencyKey: string;
	requestFingerprint: string;
	commandMarker: string;
	contactId: string;
	occurredAt: string;
}

export interface CreateContactCommand extends ContactCommandBase {
	name: string;
	nameSearch: string;
	email: string;
	locale: 'en' | 'ja';
}

export interface UpdateContactCommand extends CreateContactCommand {
	expectedVersion: number;
}

export interface DeleteContactCommand extends ContactCommandBase {
	expectedVersion: number;
}

export type CreateContactStoreResult =
	| { outcome: 'created' | 'replayed'; contact: ContactMetadata }
	| { outcome: 'email_conflict' | 'idempotency_conflict' | 'owner_not_active' | 'integrity_error' }
	| { outcome: 'id_conflict' };

export type UpdateContactStoreResult =
	| { outcome: 'updated' | 'replayed'; contact: ContactMetadata }
	| {
			outcome:
				| 'not_found'
				| 'email_conflict'
				| 'version_conflict'
				| 'idempotency_conflict'
				| 'owner_not_active'
				| 'integrity_error';
	  };

export type DeleteContactStoreResult =
	| { outcome: 'deleted' | 'replayed'; contactId: string; deletedAt: string }
	| {
			outcome:
				| 'not_found'
				| 'version_conflict'
				| 'idempotency_conflict'
				| 'owner_not_active'
				| 'integrity_error';
	  };

export type ListContactsStoreResult =
	{ outcome: 'listed'; page: ContactListPage } | { outcome: 'owner_not_active' };

export interface ContactStore {
	createContact(command: CreateContactCommand): Promise<CreateContactStoreResult>;
	listContacts(actor: ContactActor, query: ContactListQuery): Promise<ListContactsStoreResult>;
	updateContact(command: UpdateContactCommand): Promise<UpdateContactStoreResult>;
	deleteContact(command: DeleteContactCommand): Promise<DeleteContactStoreResult>;
}

export function isContactId(value: string): boolean {
	return UUID_V7_PATTERN.test(value);
}

export function isContactIdempotencyKey(value: string): boolean {
	return CONTACT_IDEMPOTENCY_KEY_PATTERN.test(value);
}

export function boundContactListLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_CONTACT_LIST_LIMIT);
}
