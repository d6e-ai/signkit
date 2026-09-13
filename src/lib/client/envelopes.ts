import type { Envelope, FieldGeometry, FieldType, RecipientRole } from '$lib/domain/envelope';
import type { PublicEnvelopeDeliveryStatus } from '$lib/application/delivery/delivery-status';

export type { Envelope, FieldGeometry, FieldType, RecipientRole, PublicEnvelopeDeliveryStatus };

export interface ProblemValidationError {
	readonly path: string;
	readonly message: string;
}

export interface EnvelopesProblem {
	readonly status: number;
	readonly type: string;
	readonly title: string;
	readonly detail: string;
	readonly instance?: string;
	readonly errors?: readonly ProblemValidationError[];
}

export class EnvelopesApiError extends Error {
	readonly status: number;
	readonly type: string;
	readonly title: string;
	readonly detail: string;
	readonly instance?: string;
	readonly errors?: readonly ProblemValidationError[];
	readonly replayed: boolean;

	constructor(problem: EnvelopesProblem, replayed = false) {
		super(problem.detail || problem.title || `Request failed with status ${problem.status}`);
		this.name = 'EnvelopesApiError';
		this.status = problem.status;
		this.type = problem.type;
		this.title = problem.title;
		this.detail = problem.detail;
		this.instance = problem.instance;
		this.errors = problem.errors;
		this.replayed = replayed;
		Object.setPrototypeOf(this, EnvelopesApiError.prototype);
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

export interface ListEnvelopesResponse {
	items: readonly Envelope[];
	nextCursor: string | null;
}

export interface CreateEnvelopeResponse {
	envelope: Envelope;
	replayed: boolean;
}

export interface DraftDocumentSnapshot {
	path: `documents/${string}.md`;
	content: string;
}

export interface EnvelopeDetailResponse {
	envelope: Envelope;
	recipients: readonly ReadyRecipientPublic[];
	readyAuditEventId: string | null;
	fields: readonly PublicEnvelopeFieldResponse[];
}

export interface DraftWorkspaceResponse {
	generation: number;
	commitSha: string | null;
	archiveSha256: string | null;
	documents: readonly DraftDocumentSnapshot[];
}

export interface CommitDraftEdit {
	path: `documents/${string}.md`;
	content: string;
}

export interface CommitDraftInput {
	expectedGeneration: number;
	message: string;
	edits: readonly CommitDraftEdit[];
	provenance?: { automationRunId?: string; externalId?: string };
}

export interface CommitDraftResponse {
	revision: { generation: number; commitSha: string; archiveSha256: string };
	replayed: boolean;
}

export interface ReadyRecipientInput {
	email: string;
	name: string;
	role: RecipientRole;
	locale: 'en' | 'ja';
	routingOrder: number;
}

export interface ReadyEnvelopeInput {
	expectedGeneration: number;
	recipients: readonly ReadyRecipientInput[];
}

export interface ReadyRecipientPublic {
	id: string;
	email: string;
	name: string;
	role: RecipientRole;
	locale: 'en' | 'ja';
	routingOrder: number;
	status: string;
}

export interface ReadyEnvelopeResponse {
	ready: {
		envelopeId: string;
		status: 'ready';
		generation: number;
		commitSha: string;
		recipients: readonly ReadyRecipientPublic[];
		updatedAt: string;
		auditEventId: string;
	};
	replayed: boolean;
}

export interface FieldPlacementInput {
	recipientId: string;
	documentPath: `documents/${string}.md`;
	fieldType: FieldType;
	label: string;
	required: boolean;
	position: number;
	geometry?: FieldGeometry | null;
}

export interface PlaceFieldsInput {
	expectedGeneration: number;
	expectedFieldGeneration: number;
	fields: readonly FieldPlacementInput[];
}

export interface PublicEnvelopeFieldResponse {
	id: string;
	recipientId: string;
	documentPath: `documents/${string}.md`;
	fieldType: FieldType;
	required: boolean;
	position: number;
	geometry: FieldGeometry | null;
}

export interface PlaceFieldsResponse {
	fields: {
		envelopeId: string;
		generation: number;
		fieldGeneration: number;
		commitSha: string;
		fields: readonly PublicEnvelopeFieldResponse[];
		updatedAt: string;
		auditEventId: string;
	};
	replayed: boolean;
}

export interface SendEnvelopeInput {
	expectedGeneration: number;
	expectedReadyAuditEventId: string;
}

export interface SendEnvelopeResponse {
	sent: {
		envelopeId: string;
		status: 'sent';
		generation: number;
		commitSha: string;
		readyAuditEventId: string;
		queuedDeliveryCount: number;
		reservedCapabilityCount: number;
		initialCapabilityExpiresAt: string;
		updatedAt: string;
		auditEventId: string;
	};
	replayed: boolean;
}

export type VoidableEnvelopeStatus = 'draft' | 'ready' | 'sent' | 'in_progress';

export interface VoidEnvelopeInput {
	expectedStatus: VoidableEnvelopeStatus;
	expectedGeneration: number;
}

export interface VoidEnvelopeResponse {
	voided: {
		envelopeId: string;
		status: 'voided';
		previousStatus: VoidableEnvelopeStatus;
		generation: number;
		voidedAt: string;
		revokedCapabilityCount: number;
		auditEventId: string;
	};
	replayed: boolean;
}

export interface EnvelopesClientOptions {
	fetch?: typeof globalThis.fetch;
	newIdempotencyKey?: IdempotencyKeyGenerator;
	baseUrl?: string;
}

export class EnvelopesClient {
	private readonly fetchFn?: typeof globalThis.fetch;
	private readonly newIdempotencyKeyFn: IdempotencyKeyGenerator;
	private readonly baseUrl: string;

	constructor(options?: EnvelopesClientOptions) {
		this.fetchFn = options?.fetch;
		this.newIdempotencyKeyFn = options?.newIdempotencyKey ?? defaultNewIdempotencyKey;
		this.baseUrl = (options?.baseUrl ?? '').replace(/\/+$/, '');
	}

	private resolveFetch(customFetch?: typeof globalThis.fetch): typeof globalThis.fetch {
		const fn = customFetch ?? this.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);
		if (!fn) throw new Error('A valid fetch implementation is required.');
		return fn;
	}

	private mintIdempotencyKey(customKey?: string): string {
		if (customKey !== undefined && customKey.length > 0) return customKey;
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
	): Promise<EnvelopesApiError> {
		const isReplayed = response.headers.get('idempotency-replayed') === 'true';
		let problem: EnvelopesProblem | null = null;
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

		return new EnvelopesApiError(problem, isReplayed);
	}

	private async request<T>(
		path: string,
		init: RequestInit,
		customFetch?: typeof globalThis.fetch
	): Promise<{ data: T; response: Response }> {
		const fetchFn = this.resolveFetch(customFetch);
		const response = await fetchFn(path, { credentials: 'same-origin', ...init });
		if (!response.ok) throw await this.parseErrorResponse(response, path);
		try {
			const data = (await response.json()) as T;
			return { data, response };
		} catch {
			throw new EnvelopesApiError({
				status: response.status,
				type: 'urn:signkit:problem:invalid-response-json',
				title: 'Invalid response JSON',
				detail: 'The response body could not be parsed as JSON.',
				instance: path
			});
		}
	}

	async create(title: string, options?: RequestOptions): Promise<CreateEnvelopeResponse> {
		const url = this.buildUrl('/api/v1/envelopes');
		const idempotencyKey = this.mintIdempotencyKey(options?.idempotencyKey);
		const { data, response } = await this.request<{ envelope: Envelope }>(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': idempotencyKey
				},
				body: JSON.stringify({ title })
			},
			options?.fetch
		);
		return {
			envelope: data.envelope,
			replayed: response.headers.get('idempotency-replayed') === 'true'
		};
	}

	async get(envelopeId: string, options?: RequestOptions): Promise<Envelope> {
		const detail = await this.getDetail(envelopeId, options);
		return detail.envelope;
	}

	async getDetail(envelopeId: string, options?: RequestOptions): Promise<EnvelopeDetailResponse> {
		const url = this.buildUrl(`/api/v1/envelopes/${encodeURIComponent(envelopeId)}`);
		const { data } = await this.request<EnvelopeDetailResponse>(
			url,
			{ method: 'GET', headers: { accept: 'application/json, application/problem+json' } },
			options?.fetch
		);
		return {
			envelope: data.envelope,
			recipients: data.recipients ?? [],
			readyAuditEventId: data.readyAuditEventId ?? null,
			fields: data.fields ?? []
		};
	}

	async list(
		params?: ListPaginationParams,
		options?: RequestOptions
	): Promise<ListEnvelopesResponse> {
		const url = this.buildUrl('/api/v1/envelopes', params);
		const { data } = await this.request<ListEnvelopesResponse>(
			url,
			{ method: 'GET', headers: { accept: 'application/json, application/problem+json' } },
			options?.fetch
		);
		return data;
	}

	async getDraft(envelopeId: string, options?: RequestOptions): Promise<DraftWorkspaceResponse> {
		const url = this.buildUrl(`/api/v1/envelopes/${encodeURIComponent(envelopeId)}/draft`);
		const { data } = await this.request<DraftWorkspaceResponse>(
			url,
			{ method: 'GET', headers: { accept: 'application/json, application/problem+json' } },
			options?.fetch
		);
		return data;
	}

	async commitDraft(
		envelopeId: string,
		input: CommitDraftInput,
		options?: RequestOptions
	): Promise<CommitDraftResponse> {
		const url = this.buildUrl(`/api/v1/envelopes/${encodeURIComponent(envelopeId)}/draft/commits`);
		const idempotencyKey = this.mintIdempotencyKey(options?.idempotencyKey);
		const { data, response } = await this.request<{
			revision: { generation: number; commitSha: string; archiveSha256: string };
		}>(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': idempotencyKey
				},
				body: JSON.stringify(input)
			},
			options?.fetch
		);
		return {
			revision: data.revision,
			replayed: response.headers.get('idempotency-replayed') === 'true'
		};
	}

	async importDocx(
		envelopeId: string,
		input: { expectedGeneration: number; targetPath: `documents/${string}.md`; file: Blob },
		options?: RequestOptions
	): Promise<CommitDraftResponse> {
		const url = this.buildUrl(`/api/v1/envelopes/${encodeURIComponent(envelopeId)}/draft/docx`);
		const idempotencyKey = this.mintIdempotencyKey(options?.idempotencyKey);
		const body = new FormData();
		body.set('expectedGeneration', String(input.expectedGeneration));
		body.set('targetPath', input.targetPath);
		body.set('file', input.file, 'upload.docx');
		const { data, response } = await this.request<{
			revision: { generation: number; commitSha: string; archiveSha256: string };
		}>(
			url,
			{
				method: 'POST',
				headers: {
					accept: 'application/json, application/problem+json',
					'idempotency-key': idempotencyKey
				},
				body
			},
			options?.fetch
		);
		return {
			revision: data.revision,
			replayed: response.headers.get('idempotency-replayed') === 'true'
		};
	}

	async exportDocx(
		envelopeId: string,
		options?: RequestOptions
	): Promise<{ bytes: Uint8Array; commitSha: string | null; filename: string }> {
		const url = this.buildUrl(`/api/v1/envelopes/${encodeURIComponent(envelopeId)}/docx`);
		const fetchFn = this.resolveFetch(options?.fetch);
		const response = await fetchFn(url, {
			credentials: 'same-origin',
			method: 'GET',
			headers: {
				accept:
					'application/vnd.openxmlformats-officedocument.wordprocessingml.document, application/problem+json'
			}
		});
		if (!response.ok) throw await this.parseErrorResponse(response, url);
		const buffer = await response.arrayBuffer();
		const disposition = response.headers.get('content-disposition');
		const filenameMatch = disposition?.match(/filename="([^"]+)"/);
		return {
			bytes: new Uint8Array(buffer),
			commitSha: response.headers.get('x-signkit-commit-sha'),
			filename: filenameMatch?.[1] ?? `envelope-${envelopeId}.docx`
		};
	}

	async ready(
		envelopeId: string,
		input: ReadyEnvelopeInput,
		options?: RequestOptions
	): Promise<ReadyEnvelopeResponse> {
		const url = this.buildUrl(`/api/v1/envelopes/${encodeURIComponent(envelopeId)}/ready`);
		const idempotencyKey = this.mintIdempotencyKey(options?.idempotencyKey);
		const { data, response } = await this.request<{ ready: ReadyEnvelopeResponse['ready'] }>(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': idempotencyKey
				},
				body: JSON.stringify(input)
			},
			options?.fetch
		);
		return {
			ready: data.ready,
			replayed: response.headers.get('idempotency-replayed') === 'true'
		};
	}

	async placeFields(
		envelopeId: string,
		input: PlaceFieldsInput,
		options?: RequestOptions
	): Promise<PlaceFieldsResponse> {
		const url = this.buildUrl(`/api/v1/envelopes/${encodeURIComponent(envelopeId)}/fields`);
		const idempotencyKey = this.mintIdempotencyKey(options?.idempotencyKey);
		const { data, response } = await this.request<{ fields: PlaceFieldsResponse['fields'] }>(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': idempotencyKey
				},
				body: JSON.stringify(input)
			},
			options?.fetch
		);
		return {
			fields: data.fields,
			replayed: response.headers.get('idempotency-replayed') === 'true'
		};
	}

	async send(
		envelopeId: string,
		input: SendEnvelopeInput,
		options?: RequestOptions
	): Promise<SendEnvelopeResponse> {
		const url = this.buildUrl(`/api/v1/envelopes/${encodeURIComponent(envelopeId)}/send`);
		const idempotencyKey = this.mintIdempotencyKey(options?.idempotencyKey);
		const { data, response } = await this.request<{ sent: SendEnvelopeResponse['sent'] }>(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': idempotencyKey
				},
				body: JSON.stringify(input)
			},
			options?.fetch
		);
		return {
			sent: data.sent,
			replayed: response.headers.get('idempotency-replayed') === 'true'
		};
	}

	async voidEnvelope(
		envelopeId: string,
		input: VoidEnvelopeInput,
		options?: RequestOptions
	): Promise<VoidEnvelopeResponse> {
		const url = this.buildUrl(`/api/v1/envelopes/${encodeURIComponent(envelopeId)}/void`);
		const idempotencyKey = this.mintIdempotencyKey(options?.idempotencyKey);
		const { data, response } = await this.request<{ voided: VoidEnvelopeResponse['voided'] }>(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, application/problem+json',
					'idempotency-key': idempotencyKey
				},
				body: JSON.stringify(input)
			},
			options?.fetch
		);
		return {
			voided: data.voided,
			replayed: response.headers.get('idempotency-replayed') === 'true'
		};
	}

	async deliveries(
		envelopeId: string,
		options?: RequestOptions
	): Promise<PublicEnvelopeDeliveryStatus> {
		const url = this.buildUrl(`/api/v1/envelopes/${encodeURIComponent(envelopeId)}/deliveries`);
		const { data } = await this.request<{ delivery: PublicEnvelopeDeliveryStatus }>(
			url,
			{ method: 'GET', headers: { accept: 'application/json, application/problem+json' } },
			options?.fetch
		);
		return data.delivery;
	}
}

export function createEnvelopesClient(options?: EnvelopesClientOptions): EnvelopesClient {
	return new EnvelopesClient(options);
}
