import { describe, expect, it, vi } from 'vitest';
import {
	ContactMutationAttempt,
	ContactsApiError,
	createContactsClient,
	type Contact
} from './contacts';

const contact: Contact = {
	id: '01900000-0000-7000-8000-000000000001',
	name: 'Alice Example',
	email: 'alice@example.com',
	locale: 'en',
	version: 1,
	createdAt: '2026-09-17T00:00:00.000Z',
	updatedAt: '2026-09-17T00:00:00.000Z'
};

function jsonResponse(data: unknown, status = 200, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});
}

describe('ContactsClient', () => {
	it('retains one mutation key across ambiguous failures and invalidates it at logical boundaries', () => {
		let sequence = 0;
		const attempt = new ContactMutationAttempt(() => `key-${++sequence}`);
		const firstKey = attempt.key();

		attempt.failed(new TypeError('network connection closed'));
		expect(attempt.key()).toBe(firstKey);
		attempt.failed(
			new ContactsApiError({
				status: 503,
				type: 'urn:signkit:problem:unavailable',
				title: 'Unavailable',
				detail: 'Try again.'
			})
		);
		expect(attempt.key()).toBe(firstKey);

		attempt.failed(
			new ContactsApiError({
				status: 409,
				type: 'urn:signkit:problem:contact-version-conflict',
				title: 'Conflict',
				detail: 'The contact changed.'
			})
		);
		expect(attempt.key()).toBe('key-2');
		attempt.invalidate();
		expect(attempt.key()).toBe('key-3');
		attempt.succeeded();
		expect(attempt.key()).toBe('key-4');
	});

	it('lists contacts with cursor pagination and same-origin credentials', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse({ items: [contact], nextCursor: 'next' })
		);
		const client = createContactsClient({ fetch: fetchMock });

		await expect(client.list({ cursor: 'opaque', limit: 25 })).resolves.toEqual({
			items: [contact],
			nextCursor: 'next'
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/v1/contacts?cursor=opaque&limit=25',
			expect.objectContaining({ method: 'GET', credentials: 'same-origin' })
		);
	});

	it('posts bounded search input in JSON and never exposes personal search text in the URL', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse({ items: [contact], nextCursor: null })
		);
		const client = createContactsClient({ fetch: fetchMock });

		await client.search({ query: 'alice@example.com', cursor: 'opaque', limit: 25 });

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/contacts/search');
		expect(String(url)).not.toContain('alice');
		expect(init?.method).toBe('POST');
		expect(init?.headers).not.toHaveProperty('idempotency-key');
		expect(JSON.parse(init?.body as string)).toEqual({
			query: 'alice@example.com',
			cursor: 'opaque',
			limit: 25
		});
	});

	it('creates, updates, and deletes without accepting owner or organization selectors', async () => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(jsonResponse({ contact }, 201))
			.mockResolvedValueOnce(
				jsonResponse({ contact: { ...contact, version: 2 } }, 200, {
					'idempotency-replayed': 'true'
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({ deleted: { id: contact.id, deletedAt: contact.updatedAt } })
			);
		const client = createContactsClient({
			fetch: fetchMock,
			newIdempotencyKey: () => 'fixed-idempotency-key'
		});

		await client.create({ name: contact.name, email: contact.email, locale: contact.locale });
		const updated = await client.update(contact.id, {
			name: 'Alice Updated',
			email: contact.email,
			locale: 'ja',
			expectedVersion: 1
		});
		await client.delete(contact.id, 2);

		expect(updated.replayed).toBe(true);
		for (const [, init] of fetchMock.mock.calls) {
			const body = JSON.parse(init?.body as string) as Record<string, unknown>;
			expect(body).not.toHaveProperty('owner');
			expect(body).not.toHaveProperty('ownerId');
			expect(body).not.toHaveProperty('organizationId');
			expect(init?.headers).toMatchObject({ 'idempotency-key': 'fixed-idempotency-key' });
		}
		expect(fetchMock.mock.calls.map((call) => [call[0], call[1]?.method])).toEqual([
			['/api/v1/contacts', 'POST'],
			[`/api/v1/contacts/${contact.id}`, 'PUT'],
			[`/api/v1/contacts/${contact.id}`, 'DELETE']
		]);
	});

	it('exposes RFC 9457 validation details and replay state', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse(
				{
					type: 'urn:signkit:problem:validation',
					title: 'Invalid request',
					status: 422,
					detail: 'The request body is invalid.',
					instance: '/api/v1/contacts',
					errors: [{ path: '$.email', message: 'Invalid email address.' }]
				},
				422,
				{ 'idempotency-replayed': 'true' }
			)
		);
		const client = createContactsClient({ fetch: fetchMock });

		const error = await client
			.create({ name: 'Alice', email: 'invalid', locale: 'en' })
			.catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ContactsApiError);
		expect(error).toMatchObject({
			status: 422,
			type: 'urn:signkit:problem:validation',
			replayed: true,
			errors: [{ path: '$.email', message: 'Invalid email address.' }]
		});
	});
});
