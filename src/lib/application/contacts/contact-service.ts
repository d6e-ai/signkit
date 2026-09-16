import {
	isValidRecipientEmail,
	isValidRecipientName,
	normalizeRecipientEmail,
	normalizeRecipientName
} from '$lib/domain/recipient-identity';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import {
	boundContactListLimit,
	isContactId,
	isContactIdempotencyKey,
	MAX_CONTACT_UPDATE_EXPECTED_VERSION,
	MAX_CONTACT_VERSION,
	type ContactListPage,
	type ContactStore,
	type CreateContactStoreResult,
	type DeleteContactStoreResult,
	type UpdateContactStoreResult
} from '$lib/ports/contact-store';

const MAX_ID_ATTEMPTS: number = 3;
// Matches the contact_name_search_bound CHECK constraint. Lower-casing can
// grow a name's character count (e.g. U+0130 -> "i" + combining dot above),
// so a 200-character name is truncated after folding rather than before.
const MAX_CONTACT_NAME_SEARCH_LENGTH: number = 200;

export interface ContactRequestActor {
	id: string;
}

export interface ContactInput {
	name: string;
	email: string;
	locale: 'en' | 'ja';
}

export interface CreateContactInput extends ContactInput {
	idempotencyKey: string;
}

export interface UpdateContactInput extends CreateContactInput {
	expectedVersion: number;
}

export interface DeleteContactInput {
	idempotencyKey: string;
	expectedVersion: number;
}

export interface ContactListInput {
	cursor: string | null;
	limit: number;
	query?: string | null;
}

export type CreateContactResult = CreateContactStoreResult;
export type UpdateContactResult = UpdateContactStoreResult;
export type DeleteContactResult = DeleteContactStoreResult;
export type ListContactsResult =
	{ outcome: 'listed'; page: ContactListPage } | { outcome: 'owner_not_active' };

export interface ContactApplicationPort {
	create(actor: ContactRequestActor, input: CreateContactInput): Promise<CreateContactResult>;
	list(actor: ContactRequestActor, input: ContactListInput): Promise<ListContactsResult>;
	update(
		actor: ContactRequestActor,
		contactId: string,
		input: UpdateContactInput
	): Promise<UpdateContactResult>;
	delete(
		actor: ContactRequestActor,
		contactId: string,
		input: DeleteContactInput
	): Promise<DeleteContactResult>;
}

export class InvalidContactRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidContactRequestError';
	}
}

export class ContactApplication implements ContactApplicationPort {
	constructor(
		private readonly store: ContactStore,
		private readonly now: () => Date = (): Date => new Date(),
		private readonly newId: UuidV7Generator = newUuidV7
	) {}

	async create(
		actor: ContactRequestActor,
		input: CreateContactInput
	): Promise<CreateContactResult> {
		const canonical: ContactInput = canonicalContact(input);
		const idempotencyKey: string = requireIdempotencyKey(input.idempotencyKey);
		const requestFingerprint: string = await fingerprint(canonical);
		const commandMarker: string = await fingerprint({
			actorId: actor.id,
			idempotencyKey,
			requestFingerprint
		});
		const occurredAt: string = this.now().toISOString();
		for (let attempt: number = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
			const contactId: string = this.newId();
			if (!isContactId(contactId)) throw new Error('Generated contact id is not a UUIDv7');
			const result: CreateContactStoreResult = await this.store.createContact({
				actor,
				idempotencyKey,
				requestFingerprint,
				commandMarker,
				contactId,
				...canonical,
				nameSearch: boundedNameSearch(canonical.name),
				occurredAt
			});
			if (result.outcome !== 'id_conflict') return result;
		}
		throw new Error('Contact id generation exhausted its collision retries');
	}

	async list(actor: ContactRequestActor, input: ContactListInput): Promise<ListContactsResult> {
		const query: string | null = normalizeQuery(input.query ?? null);
		return await this.store.listContacts(actor, {
			cursor: input.cursor,
			limit: boundContactListLimit(input.limit),
			query
		});
	}

	async update(
		actor: ContactRequestActor,
		contactId: string,
		input: UpdateContactInput
	): Promise<UpdateContactResult> {
		if (!isContactId(contactId)) return { outcome: 'not_found' };
		const expectedVersion: number = requireVersion(
			input.expectedVersion,
			MAX_CONTACT_UPDATE_EXPECTED_VERSION
		);
		const canonical: ContactInput = canonicalContact(input);
		const idempotencyKey: string = requireIdempotencyKey(input.idempotencyKey);
		const requestFingerprint: string = await fingerprint({
			contactId,
			expectedVersion,
			...canonical
		});
		return await this.store.updateContact({
			actor,
			idempotencyKey,
			requestFingerprint,
			commandMarker: await fingerprint({
				actorId: actor.id,
				idempotencyKey,
				requestFingerprint
			}),
			contactId,
			expectedVersion,
			...canonical,
			nameSearch: boundedNameSearch(canonical.name),
			occurredAt: this.now().toISOString()
		});
	}

	async delete(
		actor: ContactRequestActor,
		contactId: string,
		input: DeleteContactInput
	): Promise<DeleteContactResult> {
		if (!isContactId(contactId)) return { outcome: 'not_found' };
		const expectedVersion: number = requireVersion(input.expectedVersion, MAX_CONTACT_VERSION);
		const idempotencyKey: string = requireIdempotencyKey(input.idempotencyKey);
		const requestFingerprint: string = await fingerprint({ contactId, expectedVersion });
		return await this.store.deleteContact({
			actor,
			idempotencyKey,
			requestFingerprint,
			commandMarker: await fingerprint({
				actorId: actor.id,
				idempotencyKey,
				requestFingerprint
			}),
			contactId,
			expectedVersion,
			occurredAt: this.now().toISOString()
		});
	}
}

function canonicalContact(input: ContactInput): ContactInput {
	const email: string = normalizeRecipientEmail(input.email);
	const name: string = normalizeRecipientName(input.name);
	if (!isValidRecipientEmail(email))
		throw new InvalidContactRequestError('Contact email is invalid');
	if (!isValidRecipientName(name)) throw new InvalidContactRequestError('Contact name is invalid');
	if (input.locale !== 'en' && input.locale !== 'ja') {
		throw new InvalidContactRequestError('Contact locale is invalid');
	}
	return { email, name, locale: input.locale };
}

function boundedNameSearch(name: string): string {
	return name.toLowerCase().slice(0, MAX_CONTACT_NAME_SEARCH_LENGTH);
}

function normalizeQuery(value: string | null): string | null {
	if (value === null) return null;
	const query: string = value.trim().toLowerCase();
	if (query.length < 1 || query.length > 200) {
		throw new InvalidContactRequestError('Contact search query is invalid');
	}
	return query;
}

function requireVersion(value: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new InvalidContactRequestError('Contact version is invalid');
	}
	return value;
}

function requireIdempotencyKey(value: string): string {
	if (!isContactIdempotencyKey(value)) {
		throw new InvalidContactRequestError('Contact idempotency key is invalid');
	}
	return value;
}

async function fingerprint(value: unknown): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(JSON.stringify(value))
	);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
