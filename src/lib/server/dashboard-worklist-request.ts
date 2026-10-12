import { z, type ZodIssue } from 'zod';
import {
	authorizeInstanceRequest,
	type AuthorizedInstanceActor
} from '$lib/http/instance-authorization';
import { signkitIdentifierSchema } from '$lib/http/identifier-schema';
import { problemResponse, type ProblemValidationError } from '$lib/http/problem';
import { validationErrors } from '$lib/http/bounded-json-body';
import { resolveDashboardApplication } from '$lib/application/dashboard/dashboard-runtime';
import type { DashboardApplicationPort } from '$lib/application/dashboard/dashboard-service';
import {
	DASHBOARD_VIEWS,
	type DashboardPage,
	type DashboardQuery,
	type DashboardView
} from '$lib/application/dashboard/model';
import { DEFAULT_DASHBOARD_LIMIT, MAX_DASHBOARD_LIMIT } from '$lib/ports/dashboard-store';

type WorklistOkTag = 'ok';
type WorklistErrorTag = 'error';

export interface DashboardWorklistOk {
	outcome: WorklistOkTag;
	query: DashboardQuery;
	page: DashboardPage;
}

export interface DashboardWorklistFailure {
	outcome: WorklistErrorTag;
	query: DashboardQuery;
	response: Response;
}

export type DashboardWorklistOutcome = DashboardWorklistOk | DashboardWorklistFailure;
const ALL_VIEW: DashboardQuery['view'] = 'all';
const EMPTY_QUERY_TEXT: string = '';

const DEFAULT_QUERY: DashboardQuery = {
	view: ALL_VIEW,
	query: EMPTY_QUERY_TEXT,
	cursor: null,
	limit: DEFAULT_DASHBOARD_LIMIT
};

const OK_OUTCOME: WorklistOkTag = 'ok';
const ERROR_OUTCOME: WorklistErrorTag = 'error';

const VIEW_VALUES = DASHBOARD_VIEWS as readonly [DashboardView, ...DashboardView[]];

/**
 * Deliberately `.strict()`: an unrecognized query parameter and a duplicate
 * occurrence of a known one must both be rejected rather than silently
 * ignored or silently resolved to whichever occurrence `URLSearchParams`
 * happened to keep.
 */
const querySchema = z
	.object({
		view: z.enum(VIEW_VALUES).default(ALL_VIEW),
		q: z.string().max(200).default(EMPTY_QUERY_TEXT),
		cursor: signkitIdentifierSchema.nullable().default(null),
		limit: z.coerce.number().int().min(1).max(MAX_DASHBOARD_LIMIT).default(DEFAULT_DASHBOARD_LIMIT)
	})
	.strict();

function duplicateParamIssues(searchParams: URLSearchParams): readonly ZodIssue[] {
	const seen: Set<string> = new Set();
	const duplicates: Set<string> = new Set();
	for (const key of searchParams.keys()) {
		if (seen.has(key)) duplicates.add(key);
		seen.add(key);
	}
	return [...duplicates].map((key: string): ZodIssue => ({
		code: 'custom',
		path: [key],
		message: `${key} must not be repeated.`
	}));
}

function rawParams(searchParams: URLSearchParams): Record<string, string> {
	const values: Record<string, string> = {};
	for (const key of searchParams.keys()) values[key] = searchParams.get(key) ?? '';
	if (!('cursor' in values)) values.cursor = '';
	return values;
}

function parseDashboardQuery(
	searchParams: URLSearchParams
): { ok: true; value: DashboardQuery } | { ok: false; issues: readonly ZodIssue[] } {
	const duplicateIssues: readonly ZodIssue[] = duplicateParamIssues(searchParams);
	if (duplicateIssues.length > 0) return { ok: false, issues: duplicateIssues };
	const candidate: Record<string, string> = rawParams(searchParams);
	if (candidate.cursor === '') delete candidate.cursor;
	const parsed = querySchema.safeParse(candidate);
	if (!parsed.success) return { ok: false, issues: parsed.error.issues };
	return {
		ok: true,
		value: {
			view: parsed.data.view,
			query: parsed.data.q,
			cursor: parsed.data.cursor,
			limit: parsed.data.limit
		}
	};
}

function validationFailure(instance: string, issues: readonly ZodIssue[]): Response {
	return problemResponse({
		type: 'urn:signkit:problem:validation',
		title: 'The dashboard worklist query did not match the required schema.',
		status: 400,
		detail: 'The dashboard worklist query did not match the required schema.',
		instance,
		errors: validationErrors(issues) as readonly ProblemValidationError[]
	});
}

function unavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:persistence-unavailable',
		title: 'Dashboard persistence unavailable',
		status: 503,
		detail: 'The durable dashboard store is not configured for this deployment.',
		instance
	});
}

function failed(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:dashboard-worklist-failed',
		title: 'Dashboard worklist read failed',
		status: 502,
		detail: 'The dashboard worklist could not be read.',
		instance
	});
}

async function resolveApplicationOrProblem(
	platform: Readonly<App.Platform> | undefined,
	instance: string
): Promise<DashboardApplicationPort | Response> {
	try {
		const application: DashboardApplicationPort | null = await resolveDashboardApplication({
			platform
		});
		if (application !== null) return application;
	} catch (error: unknown) {
		console.error(
			JSON.stringify({
				event: 'dashboard_worklist_resolution_failed',
				message: error instanceof Error ? error.name : 'UnknownError'
			})
		);
	}
	return unavailable(instance);
}

/**
 * Session-only instance authorization plus bounded query parsing shared by
 * both `GET /api/v1/dashboard` and the root `+page.server.ts` SSR loader, so
 * the two surfaces cannot drift in what they accept or how they classify a
 * caller. Each still calls this independently -- the SSR loader never issues
 * an HTTP self-fetch against the API route -- so a failure here is always a
 * freshly derived authorization decision, never one cached or passed in from
 * elsewhere.
 *
 * Any failure (authorization, validation, persistence unavailability) is
 * reported through `DashboardWorklistFailure`, never folded into an empty
 * `DashboardPage`: a caller who cannot be authorized or whose store is down
 * must never look identical to a member who legitimately has nothing in
 * their worklist.
 */
export async function resolveDashboardWorklist(
	locals: App.Locals,
	platform: Readonly<App.Platform> | undefined,
	instance: string,
	searchParams: URLSearchParams
): Promise<DashboardWorklistOutcome> {
	const parsedQuery = parseDashboardQuery(searchParams);
	if (!parsedQuery.ok) {
		return {
			outcome: ERROR_OUTCOME,
			query: DEFAULT_QUERY,
			response: validationFailure(instance, parsedQuery.issues)
		};
	}
	const query: DashboardQuery = parsedQuery.value;

	const authorized: AuthorizedInstanceActor | Response = authorizeInstanceRequest(locals, instance);
	if (authorized instanceof Response) {
		return { outcome: ERROR_OUTCOME, query, response: authorized };
	}

	const application: DashboardApplicationPort | Response = await resolveApplicationOrProblem(
		platform,
		instance
	);
	if (application instanceof Response) {
		return { outcome: ERROR_OUTCOME, query, response: application };
	}

	try {
		const page: DashboardPage = await application.read({ email: authorized.email }, query);
		return { outcome: OK_OUTCOME, query, page };
	} catch (error: unknown) {
		console.error(
			JSON.stringify({
				event: 'dashboard_worklist_read_failed',
				message: error instanceof Error ? error.name : 'UnknownError'
			})
		);
		return { outcome: ERROR_OUTCOME, query, response: failed(instance) };
	}
}
