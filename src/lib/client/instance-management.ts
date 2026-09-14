import type {
	InstanceCallerContext,
	InstanceInvitationMetadata,
	InstanceMemberMetadata,
	InstanceMemberRole,
	InstanceMemberStatus
} from '$lib/ports/instance-store';
import type { ApiKeyMetadata } from '$lib/ports/api-key-store';
import type { ApiKeyScope } from '$lib/security/api-key';

export type {
	InstanceCallerContext,
	InstanceInvitationMetadata,
	InstanceMemberMetadata,
	InstanceMemberRole,
	InstanceMemberStatus,
	ApiKeyMetadata,
	ApiKeyScope
};

export interface ProblemValidationError {
	readonly path: string;
	readonly message: string;
}

export interface InstanceManagementProblem {
	readonly status: number;
	readonly type: string;
	readonly title: string;
	readonly detail: string;
	readonly instance?: string;
	readonly errors?: readonly ProblemValidationError[];
}

export class InstanceManagementApiError extends Error {
	readonly status: number;
	readonly type: string;
	readonly title: string;
	readonly detail: string;
	readonly instance?: string;
	readonly errors?: readonly ProblemValidationError[];
	readonly replayed: boolean;

	constructor(problem: InstanceManagementProblem, replayed = false) {
		super(problem.detail || problem.title || `Request failed with status ${problem.status}`);
		this.name = 'InstanceManagementApiError';
		this.status = problem.status;
		this.type = problem.type;
		this.title = problem.title;
		this.detail = problem.detail;
		this.instance = problem.instance;
		this.errors = problem.errors;
		this.replayed = replayed;
		Object.setPrototypeOf(this, InstanceManagementApiError.prototype);
	}
}

export type IdempotencyKeyGenerator = () => string;

export function defaultNewIdempotencyKey(): string {
	const source: Crypto | undefined = globalThis.crypto;
	if (source === undefined || typeof source.randomUUID !== 'function') {
		throw new Error('crypto.randomUUID() is required to mint an Idempotency-Key');
	}
	return source.randomUUID();
}

export interface RequestOptions {
	fetch?: typeof globalThis.fetch;
	idempotencyKey?: string;
}

export interface ListPaginationParams {
	cursor?: string;
	limit?: number;
}

export interface SetMemberRoleInput {
	userId: string;
	role: InstanceMemberRole;
}

export interface SetMemberStatusInput {
	userId: string;
	status: InstanceMemberStatus;
}

export interface CreateInvitationInput {
	email: string;
	role: InstanceMemberRole;
}

export interface AcceptInvitationInput {
	token: string;
}

export interface CreateApiKeyInput {
	name: string;
	scopes: readonly ApiKeyScope[];
	expiresAt?: string;
}

export interface BootstrapOwnerResponse {
	member: InstanceMemberMetadata;
	bootstrapped: boolean;
	replayed: boolean;
}

export interface ListInstanceMembersResponse {
	members: readonly InstanceMemberMetadata[];
	nextCursor: string | null;
}

export interface SetInstanceMemberRoleResponse {
	member: InstanceMemberMetadata;
	appliedAt: string;
	revokedInvitationCount: number;
	replayed: boolean;
}

export interface SetInstanceMemberStatusResponse {
	member: InstanceMemberMetadata;
	appliedAt: string;
	revokedInvitationCount: number;
	replayed: boolean;
}

export interface CreateInstanceInvitationResponse {
	invitation: InstanceInvitationMetadata;
	token?: string;
	replayed: boolean;
}

export interface ListInstanceInvitationsResponse {
	invitations: readonly InstanceInvitationMetadata[];
	nextCursor: string | null;
}

export interface RevokeInstanceInvitationResponse {
	invitation: InstanceInvitationMetadata;
	replayed: boolean;
}

export interface AcceptInstanceInvitationResponse {
	invitation: InstanceInvitationMetadata;
	member: InstanceMemberMetadata;
	replayed: boolean;
}

export interface CreateApiKeyResponse {
	apiKey: ApiKeyMetadata;
	token?: string;
	secret?: string;
	replayed: boolean;
}

export interface ListApiKeysResponse {
	page: {
		items: readonly ApiKeyMetadata[];
		nextCursor: string | null;
	};
}

export interface RevokeApiKeyResponse {
	apiKey: ApiKeyMetadata;
	replayed: boolean;
}

export interface InstanceManagementClientOptions {
	fetch?: typeof globalThis.fetch;
	newIdempotencyKey?: IdempotencyKeyGenerator;
	baseUrl?: string;
}

export class InstanceManagementClient {
	private readonly fetchFn?: typeof globalThis.fetch;
	private readonly newIdempotencyKeyFn: IdempotencyKeyGenerator;
	private readonly baseUrl: string;

	constructor(options?: InstanceManagementClientOptions) {
		this.fetchFn = options?.fetch;
		this.newIdempotencyKeyFn = options?.newIdempotencyKey ?? defaultNewIdempotencyKey;
		this.baseUrl = (options?.baseUrl ?? '').replace(/\/+$/, '');
	}

	private resolveFetch(customFetch?: typeof globalThis.fetch): typeof globalThis.fetch {
		const fn = customFetch ?? this.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);
		if (!fn) {
			throw new Error('A valid fetch implementation is required.');
		}
		return fn;
	}

	private mintIdempotencyKey(customKey?: string): string {
		if (customKey !== undefined && customKey.length > 0) {
			return customKey;
		}
		return this.newIdempotencyKeyFn();
	}

	private buildUrl(path: string, params?: ListPaginationParams): string {
		const fullPath = `${this.baseUrl}${path}`;
		if (!params) return fullPath;
		const searchParams = new URLSearchParams();
		if (params.cursor !== undefined && params.cursor !== null) {
			searchParams.set('cursor', params.cursor);
		}
		if (params.limit !== undefined && params.limit !== null) {
			searchParams.set('limit', String(params.limit));
		}
		const query = searchParams.toString();
		return query ? `${fullPath}?${query}` : fullPath;
	}

	private async parseErrorResponse(
		response: Response,
		defaultInstance: string
	): Promise<InstanceManagementApiError> {
		const isReplayed = response.headers.get('idempotency-replayed') === 'true';
		let problem: InstanceManagementProblem | null = null;
		const contentType = response.headers.get('content-type') ?? '';

		if (contentType.includes('json')) {
			try {
				const data = (await response.json()) as Record<string, unknown>;
				if (data && typeof data === 'object') {
					const type =
						typeof data.type === 'string'
							? data.type
							: `urn:signkit:problem:http-${response.status}`;
					const title =
						typeof data.title === 'string' ? data.title : response.statusText || 'Error';
					const detail =
						typeof data.detail === 'string'
							? data.detail
							: `Request failed with status ${response.status}`;
					const instance = typeof data.instance === 'string' ? data.instance : defaultInstance;
					let errors: ProblemValidationError[] | undefined;
					if (Array.isArray(data.errors)) {
						errors = data.errors
							.filter(
								(e: unknown): e is Record<string, unknown> => typeof e === 'object' && e !== null
							)
							.map((e: Record<string, unknown>) => ({
								path: typeof e.path === 'string' ? e.path : '$',
								message: typeof e.message === 'string' ? e.message : 'Validation error'
							}));
					}
					problem = {
						status: typeof data.status === 'number' ? data.status : response.status,
						type,
						title,
						detail,
						instance,
						...(errors && errors.length > 0 ? { errors } : {})
					};
				}
			} catch {
				// Malformed JSON on error response: avoid leaking unparsed internal chunks
				problem = null;
			}
		}

		if (!problem) {
			problem = {
				status: response.status,
				type: `urn:signkit:problem:http-${response.status}`,
				title: response.statusText || 'Error',
				detail: `Request failed with status ${response.status}`,
				instance: defaultInstance
			};
		}

		return new InstanceManagementApiError(problem, isReplayed);
	}

	private async request<T>(
		path: string,
		init: RequestInit,
		customFetch?: typeof globalThis.fetch
	): Promise<{ data: T; response: Response }> {
		const fetchFn = this.resolveFetch(customFetch);
		const response = await fetchFn(path, {
			credentials: 'same-origin',
			...init
		});

		if (!response.ok) {
			throw await this.parseErrorResponse(response, path);
		}

		try {
			const data = (await response.json()) as T;
			return { data, response };
		} catch {
			throw new InstanceManagementApiError({
				status: response.status,
				type: 'urn:signkit:problem:invalid-response-json',
				title: 'Invalid response JSON',
				detail: 'The response body could not be parsed as JSON.',
				instance: path
			});
		}
	}

	async getCurrentMember(options?: RequestOptions): Promise<InstanceCallerContext> {
		const url = this.buildUrl('/api/v1/instance/members/me');
		const { data } = await this.request<InstanceCallerContext>(
			url,
			{
				method: 'GET',
				headers: {
					accept: 'application/json, application/problem+json'
				}
			},
			options?.fetch
		);
		return data;
	}

	async getMembersMe(options?: RequestOptions): Promise<InstanceCallerContext> {
		return this.getCurrentMember(options);
	}

	async getMe(options?: RequestOptions): Promise<InstanceCallerContext> {
		return this.getCurrentMember(options);
	}

	async bootstrapOwner(options?: RequestOptions): Promise<BootstrapOwnerResponse> {
		const url = this.buildUrl('/api/v1/instance/bootstrap');
		const idempotencyKey = this.mintIdempotencyKey(options?.idempotencyKey);
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			accept: 'application/json, application/problem+json',
			'idempotency-key': idempotencyKey
		};
		const { data, response } = await this.request<{
			member: InstanceMemberMetadata;
			bootstrapped: boolean;
		}>(
			url,
			{
				method: 'POST',
				headers,
				body: '{}'
			},
			options?.fetch
		);
		const replayed = response.headers.get('idempotency-replayed') === 'true';
		return {
			member: data.member,
			bootstrapped: data.bootstrapped,
			replayed
		};
	}

	async listMembers(
		params?: ListPaginationParams,
		options?: RequestOptions
	): Promise<ListInstanceMembersResponse> {
		const url = this.buildUrl('/api/v1/instance/members', params);
		const { data } = await this.request<ListInstanceMembersResponse>(
			url,
			{
				method: 'GET',
				headers: {
					accept: 'application/json, application/problem+json'
				}
			},
			options?.fetch
		);
		return data;
	}

	setMemberRole(
		userId: string,
		role: InstanceMemberRole,
		options?: RequestOptions
	): Promise<SetInstanceMemberRoleResponse>;
	setMemberRole(
		input: SetMemberRoleInput,
		options?: RequestOptions
	): Promise<SetInstanceMemberRoleResponse>;
	async setMemberRole(
		userIdOrInput: string | SetMemberRoleInput,
		roleOrOptions?: InstanceMemberRole | RequestOptions,
		maybeOptions?: RequestOptions
	): Promise<SetInstanceMemberRoleResponse> {
		let userId: string;
		let role: InstanceMemberRole;
		let options: RequestOptions | undefined;

		if (typeof userIdOrInput === 'object') {
			userId = userIdOrInput.userId;
			role = userIdOrInput.role;
			options = roleOrOptions as RequestOptions | undefined;
		} else {
			userId = userIdOrInput;
			role = roleOrOptions as InstanceMemberRole;
			options = maybeOptions;
		}

		const url = this.buildUrl(`/api/v1/instance/members/${encodeURIComponent(userId)}/role`);
		const idempotencyKey = this.mintIdempotencyKey(options?.idempotencyKey);
		const { data, response } = await this.request<{
			member: InstanceMemberMetadata;
			appliedAt: string;
			revokedInvitationCount: number;
		}>(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': idempotencyKey
				},
				body: JSON.stringify({ role })
			},
			options?.fetch
		);
		const replayed = response.headers.get('idempotency-replayed') === 'true';
		return {
			member: data.member,
			appliedAt: data.appliedAt,
			revokedInvitationCount: data.revokedInvitationCount,
			replayed
		};
	}

	setMemberStatus(
		userId: string,
		status: InstanceMemberStatus,
		options?: RequestOptions
	): Promise<SetInstanceMemberStatusResponse>;
	setMemberStatus(
		input: SetMemberStatusInput,
		options?: RequestOptions
	): Promise<SetInstanceMemberStatusResponse>;
	async setMemberStatus(
		userIdOrInput: string | SetMemberStatusInput,
		statusOrOptions?: InstanceMemberStatus | RequestOptions,
		maybeOptions?: RequestOptions
	): Promise<SetInstanceMemberStatusResponse> {
		let userId: string;
		let status: InstanceMemberStatus;
		let options: RequestOptions | undefined;

		if (typeof userIdOrInput === 'object') {
			userId = userIdOrInput.userId;
			status = userIdOrInput.status;
			options = statusOrOptions as RequestOptions | undefined;
		} else {
			userId = userIdOrInput;
			status = statusOrOptions as InstanceMemberStatus;
			options = maybeOptions;
		}

		const url = this.buildUrl(`/api/v1/instance/members/${encodeURIComponent(userId)}/status`);
		const idempotencyKey = this.mintIdempotencyKey(options?.idempotencyKey);
		const { data, response } = await this.request<{
			member: InstanceMemberMetadata;
			appliedAt: string;
			revokedInvitationCount: number;
		}>(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': idempotencyKey
				},
				body: JSON.stringify({ status })
			},
			options?.fetch
		);
		const replayed = response.headers.get('idempotency-replayed') === 'true';
		return {
			member: data.member,
			appliedAt: data.appliedAt,
			revokedInvitationCount: data.revokedInvitationCount,
			replayed
		};
	}

	async createInvitation(
		input: CreateInvitationInput,
		options?: RequestOptions
	): Promise<CreateInstanceInvitationResponse> {
		const url = this.buildUrl('/api/v1/instance/invitations');
		const idempotencyKey = this.mintIdempotencyKey(options?.idempotencyKey);
		const { data, response } = await this.request<{
			invitation: InstanceInvitationMetadata;
			token?: string;
		}>(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': idempotencyKey
				},
				body: JSON.stringify({ email: input.email, role: input.role })
			},
			options?.fetch
		);
		const replayed = response.headers.get('idempotency-replayed') === 'true';
		return {
			invitation: data.invitation,
			...(data.token ? { token: data.token } : {}),
			replayed
		};
	}

	async listInvitations(
		params?: ListPaginationParams,
		options?: RequestOptions
	): Promise<ListInstanceInvitationsResponse> {
		const url = this.buildUrl('/api/v1/instance/invitations', params);
		const { data } = await this.request<ListInstanceInvitationsResponse>(
			url,
			{
				method: 'GET',
				headers: {
					accept: 'application/json, application/problem+json'
				}
			},
			options?.fetch
		);
		return data;
	}

	async revokeInvitation(
		invitationIdOrInput: string | { invitationId: string },
		options?: RequestOptions
	): Promise<RevokeInstanceInvitationResponse> {
		const invitationId =
			typeof invitationIdOrInput === 'object'
				? invitationIdOrInput.invitationId
				: invitationIdOrInput;
		const url = this.buildUrl(
			`/api/v1/instance/invitations/${encodeURIComponent(invitationId)}/revoke`
		);
		const idempotencyKey = this.mintIdempotencyKey(options?.idempotencyKey);
		const { data, response } = await this.request<{ invitation: InstanceInvitationMetadata }>(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': idempotencyKey
				},
				body: '{}'
			},
			options?.fetch
		);
		const replayed = response.headers.get('idempotency-replayed') === 'true';
		return {
			invitation: data.invitation,
			replayed
		};
	}

	async acceptInvitation(
		tokenOrInput: string | AcceptInvitationInput,
		options?: RequestOptions
	): Promise<AcceptInstanceInvitationResponse> {
		const token = typeof tokenOrInput === 'object' ? tokenOrInput.token : tokenOrInput;
		const url = this.buildUrl('/api/v1/instance/invitations/accept');
		const idempotencyKey = this.mintIdempotencyKey(options?.idempotencyKey);
		const { data, response } = await this.request<{
			invitation: InstanceInvitationMetadata;
			member: InstanceMemberMetadata;
		}>(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': idempotencyKey
				},
				body: JSON.stringify({ token })
			},
			options?.fetch
		);
		const replayed = response.headers.get('idempotency-replayed') === 'true';
		return {
			invitation: data.invitation,
			member: data.member,
			replayed
		};
	}

	async createApiKey(
		input: CreateApiKeyInput,
		options?: RequestOptions
	): Promise<CreateApiKeyResponse> {
		const url = this.buildUrl('/api/v1/api-keys');
		const idempotencyKey = this.mintIdempotencyKey(options?.idempotencyKey);
		const { data, response } = await this.request<{
			apiKey: ApiKeyMetadata;
			token?: string;
		}>(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': idempotencyKey
				},
				body: JSON.stringify({
					name: input.name,
					scopes: input.scopes,
					...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {})
				})
			},
			options?.fetch
		);
		const replayed = response.headers.get('idempotency-replayed') === 'true';
		const secret = data.token;
		return {
			apiKey: data.apiKey,
			...(secret ? { token: secret, secret } : {}),
			replayed
		};
	}

	async listApiKeys(
		params?: ListPaginationParams,
		options?: RequestOptions
	): Promise<ListApiKeysResponse> {
		const url = this.buildUrl('/api/v1/api-keys', params);
		const { data } = await this.request<ListApiKeysResponse>(
			url,
			{
				method: 'GET',
				headers: {
					accept: 'application/json, application/problem+json'
				}
			},
			options?.fetch
		);
		return data;
	}

	async revokeApiKey(
		apiKeyIdOrInput: string | { apiKeyId: string },
		options?: RequestOptions
	): Promise<RevokeApiKeyResponse> {
		const apiKeyId =
			typeof apiKeyIdOrInput === 'object' ? apiKeyIdOrInput.apiKeyId : apiKeyIdOrInput;
		const url = this.buildUrl(`/api/v1/api-keys/${encodeURIComponent(apiKeyId)}/revoke`);
		const idempotencyKey = this.mintIdempotencyKey(options?.idempotencyKey);
		const { data, response } = await this.request<{ apiKey: ApiKeyMetadata }>(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': idempotencyKey
				},
				body: '{}'
			},
			options?.fetch
		);
		const replayed = response.headers.get('idempotency-replayed') === 'true';
		return {
			apiKey: data.apiKey,
			replayed
		};
	}
}

export function createInstanceManagementClient(
	options?: InstanceManagementClientOptions
): InstanceManagementClient {
	return new InstanceManagementClient(options);
}
