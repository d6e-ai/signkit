import {
	defaultNewIdempotencyKey as defaultNewContactIdempotencyKey,
	requestJson,
	type Problem,
	type ProblemValidationError
} from './http-problem';
export { defaultNewContactIdempotencyKey };

export type ContactLocale = 'en' | 'ja';

export interface Contact {
	id: string;
	name: string;
	email: string;
	locale: ContactLocale;
	version: number;
	createdAt: string;
	updatedAt: string;
}

export interface ContactListPage {
	items: readonly Contact[];
	nextCursor: string | null;
}

export interface ContactListParams {
	cursor?: string;
	limit?: number;
}

export interface ContactSearchParams extends ContactListParams {
	query: string;
}

export interface SaveContactInput {
	name: string;
	email: string;
	locale: ContactLocale;
}

export interface UpdateContactInput extends SaveContactInput {
	expectedVersion: number;
}

export type ContactProblemValidationError = ProblemValidationError;

export type ContactProblem = Problem;

export class ContactsApiError extends Error {
	readonly status: number;
	readonly type: string;
	readonly title: string;
	readonly detail: string;
	readonly instance?: string;
	readonly errors?: readonly ContactProblemValidationError[];
	readonly replayed: boolean;

	constructor(problem: ContactProblem, replayed = false) {
		super(problem.detail || problem.title || `Request failed with status ${problem.status}`);
		this.name = 'ContactsApiError';
		this.status = problem.status;
		this.type = problem.type;
		this.title = problem.title;
		this.detail = problem.detail;
		this.instance = problem.instance;
		this.errors = problem.errors;
		this.replayed = replayed;
		Object.setPrototypeOf(this, ContactsApiError.prototype);
	}
}

export interface ContactsRequestOptions {
	fetch?: typeof globalThis.fetch;
	idempotencyKey?: string;
}

export interface ContactsClientOptions {
	fetch?: typeof globalThis.fetch;
	newIdempotencyKey?: () => string;
	baseUrl?: string;
}

export interface SaveContactResponse {
	contact: Contact;
	replayed: boolean;
}

export interface DeleteContactResponse {
	deleted: { id: string; deletedAt: string };
	replayed: boolean;
}

/**
 * A response can be lost after the server commits a mutation. Keep one key for
 * that logical attempt until success, a definitive rejection, or an explicit
 * input/target change makes it a different operation.
 */
export function isAmbiguousContactMutationFailure(cause: unknown): boolean {
	if (!(cause instanceof ContactsApiError)) return true;
	return (
		cause.type === 'urn:signkit:problem:invalid-response-json' ||
		cause.status === 408 ||
		cause.status === 429 ||
		cause.status >= 500
	);
}

export class ContactMutationAttempt {
	private readonly newIdempotencyKey: () => string;
	private currentKey: string | null = null;

	constructor(newIdempotencyKey: () => string = defaultNewContactIdempotencyKey) {
		this.newIdempotencyKey = newIdempotencyKey;
	}

	key(): string {
		this.currentKey ??= this.newIdempotencyKey();
		return this.currentKey;
	}

	succeeded(): void {
		this.currentKey = null;
	}

	failed(cause: unknown): void {
		if (!isAmbiguousContactMutationFailure(cause)) this.currentKey = null;
	}

	invalidate(): void {
		this.currentKey = null;
	}
}

export function createContactMutationAttempt(
	newIdempotencyKey?: () => string
): ContactMutationAttempt {
	return new ContactMutationAttempt(newIdempotencyKey);
}

export class ContactsClient {
	private readonly fetchFn?: typeof globalThis.fetch;
	private readonly newIdempotencyKeyFn: () => string;
	private readonly baseUrl: string;

	constructor(options?: ContactsClientOptions) {
		this.fetchFn = options?.fetch;
		this.newIdempotencyKeyFn = options?.newIdempotencyKey ?? defaultNewContactIdempotencyKey;
		this.baseUrl = (options?.baseUrl ?? '').replace(/\/+$/, '');
	}

	private resolveFetch(customFetch?: typeof globalThis.fetch): typeof globalThis.fetch {
		const fn: typeof globalThis.fetch | undefined =
			customFetch ?? this.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);
		if (fn === undefined) throw new Error('A valid fetch implementation is required.');
		return fn;
	}

	private mintIdempotencyKey(customKey?: string): string {
		return customKey && customKey.length > 0 ? customKey : this.newIdempotencyKeyFn();
	}

	private buildListUrl(params?: ContactListParams): string {
		const url: string = `${this.baseUrl}/api/v1/contacts`;
		if (params === undefined) return url;
		const searchParams: URLSearchParams = new URLSearchParams();
		if (params.cursor !== undefined) searchParams.set('cursor', params.cursor);
		if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
		const query: string = searchParams.toString();
		return query.length > 0 ? `${url}?${query}` : url;
	}

	private async request<T>(
		path: string,
		init: RequestInit,
		customFetch?: typeof globalThis.fetch
	): Promise<{ data: T; response: Response }> {
		return requestJson<T>(
			this.resolveFetch(customFetch),
			path,
			init,
			(problem, replayed) => new ContactsApiError(problem, replayed)
		);
	}

	async list(
		params?: ContactListParams,
		options?: ContactsRequestOptions
	): Promise<ContactListPage> {
		const url: string = this.buildListUrl(params);
		const { data } = await this.request<ContactListPage>(
			url,
			{ method: 'GET', headers: { accept: 'application/json, application/problem+json' } },
			options?.fetch
		);
		return data;
	}

	async search(
		params: ContactSearchParams,
		options?: ContactsRequestOptions
	): Promise<ContactListPage> {
		const url: string = `${this.baseUrl}/api/v1/contacts/search`;
		const { data } = await this.request<ContactListPage>(
			url,
			{
				method: 'POST',
				headers: {
					accept: 'application/json, application/problem+json',
					'content-type': 'application/json'
				},
				body: JSON.stringify(params)
			},
			options?.fetch
		);
		return data;
	}

	async create(
		input: SaveContactInput,
		options?: ContactsRequestOptions
	): Promise<SaveContactResponse> {
		return this.save('/api/v1/contacts', 'POST', input, options);
	}

	async update(
		contactId: string,
		input: UpdateContactInput,
		options?: ContactsRequestOptions
	): Promise<SaveContactResponse> {
		return this.save(`/api/v1/contacts/${encodeURIComponent(contactId)}`, 'PUT', input, options);
	}

	private async save(
		path: string,
		method: 'POST' | 'PUT',
		input: SaveContactInput | UpdateContactInput,
		options?: ContactsRequestOptions
	): Promise<SaveContactResponse> {
		const url: string = `${this.baseUrl}${path}`;
		const { data, response } = await this.request<{ contact: Contact }>(
			url,
			{
				method,
				headers: {
					accept: 'application/json, application/problem+json',
					'content-type': 'application/json',
					'idempotency-key': this.mintIdempotencyKey(options?.idempotencyKey)
				},
				body: JSON.stringify(input)
			},
			options?.fetch
		);
		return {
			contact: data.contact,
			replayed: response.headers.get('idempotency-replayed') === 'true'
		};
	}

	async delete(
		contactId: string,
		expectedVersion: number,
		options?: ContactsRequestOptions
	): Promise<DeleteContactResponse> {
		const url: string = `${this.baseUrl}/api/v1/contacts/${encodeURIComponent(contactId)}`;
		const { data, response } = await this.request<{
			deleted: { id: string; deletedAt: string };
		}>(
			url,
			{
				method: 'DELETE',
				headers: {
					accept: 'application/json, application/problem+json',
					'content-type': 'application/json',
					'idempotency-key': this.mintIdempotencyKey(options?.idempotencyKey)
				},
				body: JSON.stringify({ expectedVersion })
			},
			options?.fetch
		);
		return {
			deleted: data.deleted,
			replayed: response.headers.get('idempotency-replayed') === 'true'
		};
	}
}

export function createContactsClient(options?: ContactsClientOptions): ContactsClient {
	return new ContactsClient(options);
}
