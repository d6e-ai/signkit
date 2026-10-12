import { requestJson, type Problem, type ProblemValidationError } from './http-problem';
import type {
	DashboardItem,
	DashboardPage,
	DashboardQuery,
	DashboardView
} from '$lib/application/dashboard/model';

export type { DashboardItem, DashboardPage, DashboardQuery, DashboardView };

export type DashboardProblemValidationError = ProblemValidationError;

export type DashboardProblem = Problem;

export class DashboardApiError extends Error {
	readonly status: number;
	readonly type: string;
	readonly title: string;
	readonly detail: string;
	readonly instance?: string;
	readonly errors?: readonly DashboardProblemValidationError[];

	constructor(problem: DashboardProblem) {
		super(problem.detail || problem.title || `Request failed with status ${problem.status}`);
		this.name = 'DashboardApiError';
		this.status = problem.status;
		this.type = problem.type;
		this.title = problem.title;
		this.detail = problem.detail;
		this.instance = problem.instance;
		this.errors = problem.errors;
		Object.setPrototypeOf(this, DashboardApiError.prototype);
	}
}

export interface DashboardWorklistParams {
	view?: DashboardView;
	q?: string;
	cursor?: string;
	limit?: number;
}

export interface DashboardRequestOptions {
	fetch?: typeof globalThis.fetch;
}

export interface DashboardClientOptions {
	fetch?: typeof globalThis.fetch;
	baseUrl?: string;
}

export class DashboardClient {
	private readonly fetchFn?: typeof globalThis.fetch;
	private readonly baseUrl: string;

	constructor(options?: DashboardClientOptions) {
		this.fetchFn = options?.fetch;
		this.baseUrl = (options?.baseUrl ?? '').replace(/\/+$/, '');
	}

	private resolveFetch(customFetch?: typeof globalThis.fetch): typeof globalThis.fetch {
		const fn: typeof globalThis.fetch | undefined =
			customFetch ?? this.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);
		if (fn === undefined) throw new Error('A valid fetch implementation is required.');
		return fn;
	}

	private buildUrl(params?: DashboardWorklistParams): string {
		const url: string = `${this.baseUrl}/api/v1/dashboard`;
		if (params === undefined) return url;
		const searchParams: URLSearchParams = new URLSearchParams();
		if (params.view !== undefined) searchParams.set('view', params.view);
		if (params.q !== undefined && params.q.length > 0) searchParams.set('q', params.q);
		if (params.cursor !== undefined) searchParams.set('cursor', params.cursor);
		if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
		const query: string = searchParams.toString();
		return query.length > 0 ? `${url}?${query}` : url;
	}

	async worklist(
		params?: DashboardWorklistParams,
		options?: DashboardRequestOptions
	): Promise<DashboardPage> {
		const url: string = this.buildUrl(params);
		const { data } = await requestJson<DashboardPage>(
			this.resolveFetch(options?.fetch),
			url,
			{ method: 'GET', headers: { accept: 'application/json, application/problem+json' } },
			(problem: Problem): Error => new DashboardApiError(problem)
		);
		return data;
	}
}

export function createDashboardClient(options?: DashboardClientOptions): DashboardClient {
	return new DashboardClient(options);
}
