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

export interface ContactProblemValidationError {
	readonly path: string;
	readonly message: string;
}

export interface ContactProblem {
	readonly status: number;
	readonly type: string;
	readonly title: string;
	readonly detail: string;
	readonly instance?: string;
	readonly errors?: readonly ContactProblemValidationError[];
}

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

export function defaultNewContactIdempotencyKey(): string {
	const source: Crypto | undefined = globalThis.crypto;
	if (source === undefined || typeof source.randomUUID !== 'function') {
		throw new Error('crypto.randomUUID() is required to mint an Idempotency-Key');
	}
	return source.randomUUID();
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

	private async parseErrorResponse(
		response: Response,
		instance: string
	): Promise<ContactsApiError> {
		const replayed: boolean = response.headers.get('idempotency-replayed') === 'true';
		const contentType: string = response.headers.get('content-type') ?? '';
		if (contentType.includes('json')) {
			try {
				const data: Record<string, unknown> = (await response.json()) as Record<string, unknown>;
				const errors: ContactProblemValidationError[] | undefined = Array.isArray(data.errors)
					? data.errors
							.filter(
								(error: unknown): error is Record<string, unknown> =>
									typeof error === 'object' && error !== null
							)
							.map((error: Record<string, unknown>) => ({
								path: typeof error.path === 'string' ? error.path : '$',
								message: typeof error.message === 'string' ? error.message : 'Validation error'
							}))
					: undefined;
				return new ContactsApiError(
					{
						status: typeof data.status === 'number' ? data.status : response.status,
						type:
							typeof data.type === 'string'
								? data.type
								: `urn:signkit:problem:http-${response.status}`,
						title: typeof data.title === 'string' ? data.title : response.statusText || 'Error',
						detail:
							typeof data.detail === 'string'
								? data.detail
								: `Request failed with status ${response.status}`,
						instance: typeof data.instance === 'string' ? data.instance : instance,
						...(errors && errors.length > 0 ? { errors } : {})
					},
					replayed
				);
			} catch {
				// Fall through to the bounded generic problem below.
			}
		}
		return new ContactsApiError(
			{
				status: response.status,
				type: `urn:signkit:problem:http-${response.status}`,
				title: response.statusText || 'Error',
				detail: `Request failed with status ${response.status}`,
				instance
			},
			replayed
		);
	}

	private async request<T>(
		path: string,
		init: RequestInit,
		customFetch?: typeof globalThis.fetch
	): Promise<{ data: T; response: Response }> {
		const response: Response = await this.resolveFetch(customFetch)(path, {
			credentials: 'same-origin',
			...init
		});
		if (!response.ok) throw await this.parseErrorResponse(response, path);
		try {
			return { data: (await response.json()) as T, response };
		} catch {
			throw new ContactsApiError({
				status: response.status,
				type: 'urn:signkit:problem:invalid-response-json',
				title: 'Invalid response JSON',
				detail: 'The response body could not be parsed as JSON.',
				instance: path
			});
		}
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
