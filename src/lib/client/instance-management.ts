import type {
	InstanceCallerContext,
	InstanceInvitationMetadata,
	InstanceMemberMetadata,
	InstanceMemberRole,
	InstanceMemberStatus
} from '$lib/ports/instance-store';
import type { ApiKeyMetadata } from '$lib/ports/api-key-store';
import type { ApiKeyScope } from '$lib/security/api-key';
import {
	defaultNewIdempotencyKey,
	requestJson,
	type Problem,
	type ProblemValidationError
} from './http-problem';

export type {
	InstanceCallerContext,
	InstanceInvitationMetadata,
	InstanceMemberMetadata,
	InstanceMemberRole,
	InstanceMemberStatus,
	ApiKeyMetadata,
	ApiKeyScope,
	ProblemValidationError
};
export { defaultNewIdempotencyKey };

export type InstanceManagementProblem = Problem;

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
	locale?: 'en' | 'ja';
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
	delivery: InstanceInvitationDelivery;
	replayed: boolean;
}

export interface InstanceInvitationDelivery {
	readonly status: 'scheduled';
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

	private async request<T>(
		path: string,
		init: RequestInit,
		customFetch?: typeof globalThis.fetch
	): Promise<{ data: T; response: Response }> {
		return requestJson<T>(
			this.resolveFetch(customFetch),
			path,
			init,
			(problem, replayed) => new InstanceManagementApiError(problem, replayed)
		);
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
			delivery: InstanceInvitationDelivery;
		}>(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': idempotencyKey
				},
				body: JSON.stringify({ email: input.email, role: input.role, locale: input.locale })
			},
			options?.fetch
		);
		const replayed = response.headers.get('idempotency-replayed') === 'true';
		return {
			invitation: data.invitation,
			delivery: data.delivery,
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
