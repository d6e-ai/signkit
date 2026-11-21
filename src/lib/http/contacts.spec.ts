import { describe, expect, it, vi } from 'vitest';
import type {
	ContactApplicationPort,
	CreateContactResult,
	DeleteContactResult,
	ListContactsResult,
	UpdateContactResult
} from '$lib/application/contacts/contact-service';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';
import { createContactHttpHandlers } from './contacts';

const ID = '01900000-0000-7000-8000-000000000701';
const CONTACT = {
	id: ID,
	name: 'Alice',
	email: 'alice@example.com',
	locale: 'ja' as const,
	version: 1,
	createdAt: '2026-09-17T00:00:00.000Z',
	updatedAt: '2026-09-17T00:00:00.000Z'
};

function application(overrides: Partial<ContactApplicationPort> = {}): ContactApplicationPort {
	return {
		create: vi.fn(async (): Promise<CreateContactResult> => ({
			outcome: 'created',
			contact: CONTACT
		})),
		list: vi.fn(async (): Promise<ListContactsResult> => ({
			outcome: 'listed',
			page: { items: [CONTACT], nextCursor: ID }
		})),
		update: vi.fn(async (): Promise<UpdateContactResult> => ({
			outcome: 'updated',
			contact: CONTACT
		})),
		delete: vi.fn(async (): Promise<DeleteContactResult> => ({
			outcome: 'deleted',
			contactId: ID,
			deletedAt: CONTACT.updatedAt
		})),
		...overrides
	};
}

describe('contact HTTP handlers', () => {
	it('returns a flat list and keeps search text in a bounded POST body', async () => {
		const app = application();
		const handlers = createContactHttpHandlers(() => app);
		const list = await handlers.list(
			createHttpRequestEvent({
				pathname: '/api/v1/contacts',
				locals: instanceScopedLocals('active')
			})
		);
		expect(await list.json()).toEqual({ items: [CONTACT], nextCursor: ID });

		const search = await handlers.search(
			createHttpRequestEvent({
				pathname: '/api/v1/contacts/search',
				method: 'POST',
				locals: instanceScopedLocals('active'),
				body: JSON.stringify({ query: 'alice', limit: 10 }),
				jsonBodyContentType: true
			})
		);
		expect(search.status).toBe(200);
		expect(app.list).toHaveBeenLastCalledWith(
			{ id: 'user-1' },
			{ query: 'alice', cursor: null, limit: 10 }
		);
	});

	it('requires an active session and refuses an API key even when a cookie identity is present', async () => {
		const handlers = createContactHttpHandlers(() => application());
		const anonymous = await handlers.list(
			createHttpRequestEvent({
				pathname: '/api/v1/contacts',
				locals: instanceScopedLocals('anonymous')
			})
		);
		expect(anonymous.status).toBe(401);

		const locals = instanceScopedLocals('active');
		locals.apiKeyAuthentication = { state: 'rejected_surface' };
		const rejected = await handlers.list(
			createHttpRequestEvent({ pathname: '/api/v1/contacts', locals })
		);
		expect(rejected.status).toBe(403);
		expect(((await rejected.json()) as { type: string }).type).toBe(
			'urn:signkit:problem:api-key-not-permitted'
		);

		const recipientBearer = await handlers.list(
			createHttpRequestEvent({
				pathname: '/api/v1/contacts',
				locals: instanceScopedLocals('active'),
				headers: { authorization: `Bearer skr1_${'a'.repeat(43)}` }
			})
		);
		expect(recipientBearer.status).toBe(403);
	});

	it('serves a verified operator access token as the member session on every contact route', async () => {
		const app = application();
		const handlers = createContactHttpHandlers(() => app);
		const tokenLocals = (): App.Locals => {
			const locals = instanceScopedLocals('active');
			locals.accessTokenAuthentication = { state: 'verified', observedAt: null };
			return locals;
		};
		const bearer = { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.sig' };

		const list = await handlers.list(
			createHttpRequestEvent({
				pathname: '/api/v1/contacts',
				locals: tokenLocals(),
				headers: bearer
			})
		);
		expect(list.status).toBe(200);
		expect(app.list).toHaveBeenLastCalledWith(
			{ id: 'user-1' },
			{ query: null, cursor: null, limit: 25 }
		);

		const search = await handlers.search(
			createHttpRequestEvent({
				pathname: '/api/v1/contacts/search',
				method: 'POST',
				locals: tokenLocals(),
				headers: bearer,
				body: JSON.stringify({ query: 'alice' }),
				jsonBodyContentType: true
			})
		);
		expect(search.status).toBe(200);

		const create = await handlers.create(
			createHttpRequestEvent({
				pathname: '/api/v1/contacts',
				method: 'POST',
				locals: tokenLocals(),
				headers: { ...bearer, 'idempotency-key': 'contact-create-1' },
				body: JSON.stringify({ name: 'Alice', email: 'alice@example.com', locale: 'ja' }),
				jsonBodyContentType: true
			})
		);
		expect(create.status).toBe(201);

		const update = await handlers.update(
			createHttpRequestEvent({
				pathname: `/api/v1/contacts/${ID}`,
				method: 'PUT',
				locals: tokenLocals(),
				params: { contactId: ID },
				headers: { ...bearer, 'idempotency-key': 'contact-update-1' },
				body: JSON.stringify({
					expectedVersion: 1,
					name: 'Alice',
					email: 'alice@example.com',
					locale: 'ja'
				}),
				jsonBodyContentType: true
			})
		);
		expect(update.status).toBe(200);

		const remove = await handlers.delete(
			createHttpRequestEvent({
				pathname: `/api/v1/contacts/${ID}`,
				method: 'DELETE',
				locals: tokenLocals(),
				params: { contactId: ID },
				headers: { ...bearer, 'idempotency-key': 'contact-delete-1' },
				body: JSON.stringify({ expectedVersion: 1 }),
				jsonBodyContentType: true
			})
		);
		expect(remove.status).toBe(200);
		expect(app.create).toHaveBeenCalledOnce();
		expect(app.update).toHaveBeenCalledOnce();
		expect(app.delete).toHaveBeenCalledOnce();
	});

	it('keeps refusing a bearer that is not a verified access token', async () => {
		const handlers = createContactHttpHandlers(() => application());
		const bearer = { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.sig' };
		const states: App.Locals['accessTokenAuthentication'][] = [
			{ state: 'absent' },
			{ state: 'presented', token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.sig' },
			{ state: 'rejected' },
			{ state: 'unavailable' }
		];
		for (const accessTokenAuthentication of states) {
			const locals = instanceScopedLocals('active');
			locals.accessTokenAuthentication = accessTokenAuthentication;
			const response = await handlers.list(
				createHttpRequestEvent({ pathname: '/api/v1/contacts', locals, headers: bearer })
			);
			expect(response.status).toBe(403);
			expect(((await response.json()) as { type: string }).type).toBe(
				'urn:signkit:problem:credential-not-permitted'
			);
		}

		const apiKeyLocals = instanceScopedLocals('active');
		apiKeyLocals.accessTokenAuthentication = { state: 'verified', observedAt: null };
		apiKeyLocals.apiKeyAuthentication = { state: 'rejected_surface' };
		const apiKey = await handlers.list(
			createHttpRequestEvent({
				pathname: '/api/v1/contacts',
				locals: apiKeyLocals,
				headers: { authorization: `Bearer signkit_${'a'.repeat(43)}` }
			})
		);
		expect(apiKey.status).toBe(403);
		expect(((await apiKey.json()) as { type: string }).type).toBe(
			'urn:signkit:problem:api-key-not-permitted'
		);
	});

	it('enforces strict bounded search and returns the public delete shape', async () => {
		const app = application();
		const handlers = createContactHttpHandlers(() => app);
		const invalid = await handlers.search(
			createHttpRequestEvent({
				pathname: '/api/v1/contacts/search',
				method: 'POST',
				locals: instanceScopedLocals('active'),
				body: JSON.stringify({ query: 'x'.repeat(201) }),
				jsonBodyContentType: true
			})
		);
		expect(invalid.status).toBe(400);

		const overflowingUpdate = await handlers.update(
			createHttpRequestEvent({
				pathname: `/api/v1/contacts/${ID}`,
				method: 'PUT',
				params: { contactId: ID },
				locals: instanceScopedLocals('active'),
				headers: { 'idempotency-key': 'update-overflow' },
				body: JSON.stringify({
					expectedVersion: 2_147_483_647,
					name: 'Alice',
					email: 'alice@example.com',
					locale: 'ja'
				}),
				jsonBodyContentType: true
			})
		);
		expect(overflowingUpdate.status).toBe(400);
		expect(app.update).not.toHaveBeenCalled();

		const removed = await handlers.delete(
			createHttpRequestEvent({
				pathname: `/api/v1/contacts/${ID}`,
				method: 'DELETE',
				params: { contactId: ID },
				locals: instanceScopedLocals('active'),
				headers: { 'idempotency-key': 'delete-1' },
				body: JSON.stringify({ expectedVersion: 2_147_483_647 }),
				jsonBodyContentType: true
			})
		);
		expect(await removed.json()).toEqual({ deleted: { id: ID, deletedAt: CONTACT.updatedAt } });
		expect(app.delete).toHaveBeenCalledWith({ id: 'user-1' }, ID, {
			idempotencyKey: 'delete-1',
			expectedVersion: 2_147_483_647
		});
	});
});
