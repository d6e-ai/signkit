import { z, type ZodIssue } from 'zod';
import {
	authorizeInstanceRequest,
	type AuthorizedInstanceActor
} from '$lib/http/instance-authorization';
import { problemResponse, type ProblemValidationError } from '$lib/http/problem';
import { validationErrors } from '$lib/http/bounded-json-body';
import { resolveDashboardApplication } from '$lib/application/dashboard/dashboard-runtime';
import {
	InvalidDashboardCursorError,
	type DashboardApplicationPort
} from '$lib/application/dashboard/dashboard-service';
import {
	DASHBOARD_VIEWS,
	type DashboardPage,
	type DashboardQuery,
	type DashboardView
} from '$lib/application/dashboard/model';
import { DEFAULT_DASHBOARD_LIMIT, MAX_DASHBOARD_LIMIT } from '$lib/ports/dashboard-store';

export interface DashboardWorklistOk {
	outcome: 'ok';
	query: DashboardQuery;
	page: DashboardPage;
}

export type DashboardWorklistFailureKind = 'authorization' | 'validation' | 'store';

export interface DashboardWorklistFailure {
	outcome: 'error';
	query: DashboardQuery;
	response: Response;
	kind: DashboardWorklistFailureKind;
}

export type DashboardWorklistOutcome = DashboardWorklistOk | DashboardWorklistFailure;

const DEFAULT_QUERY: DashboardQuery = {
	view: 'all',
	query: '',
	cursor: null,
	limit: DEFAULT_DASHBOARD_LIMIT
};

const VIEW_VALUES = DASHBOARD_VIEWS as readonly [DashboardView, ...DashboardView[]];

/** Query parameters this endpoint ever accepts; everything else is rejected. */
const ALLOWED_PARAM_NAMES: ReadonlySet<string> = new Set(['view', 'q', 'cursor', 'limit']);

/**
 * Deliberately `.strict()`: an unrecognized query parameter and a duplicate
 * occurrence of a known one must both be rejected rather than silently
 * ignored or silently resolved to whichever occurrence `URLSearchParams`
 * happened to keep.
 */
const MAX_ENCODED_CURSOR_PARAM_LENGTH: number = 2000;

/**
 * The cursor is an opaque, self-contained base64url blob (see
 * `application/dashboard/cursor.ts`), never a SignKit UUID: this is only a
 * cheap shape/length bound at the HTTP boundary, not the cursor's actual
 * validity, which is decided later by `decodeDashboardCursor` against the
 * requested `(view, query)` context.
 */
const cursorParamSchema = z
	.string()
	.min(1)
	.max(MAX_ENCODED_CURSOR_PARAM_LENGTH)
	.regex(/^[A-Za-z0-9_-]+$/);

const querySchema = z
	.object({
		view: z.enum(VIEW_VALUES).default('all'),
		q: z.string().max(200).default(''),
		cursor: cursorParamSchema.nullable().default(null),
		limit: z.coerce.number().int().min(1).max(MAX_DASHBOARD_LIMIT).default(DEFAULT_DASHBOARD_LIMIT)
	})
	.strict();

/**
 * Builds the schema candidate on a null-prototype object via `Object.create(null)`,
 * so a key like `__proto__` or `constructor` can only ever land as an inert own
 * property, never reinterpreted as a prototype or constructor reference. Any
 * key outside the fixed allow-list, or any key occurring more than once, is
 * rejected outright rather than silently dropped or silently resolved to
 * whichever occurrence `URLSearchParams` happened to keep.
 */
function rawParamsOrIssues(
	searchParams: URLSearchParams
): { ok: true; value: Record<string, string> } | { ok: false; issues: readonly ZodIssue[] } {
	const seen: Set<string> = new Set();
	const rejected: ZodIssue[] = [];
	const candidate: Record<string, string> = Object.create(null) as Record<string, string>;
	for (const key of searchParams.keys()) {
		if (!ALLOWED_PARAM_NAMES.has(key)) {
			rejected.push({
				code: 'custom',
				path: [key],
				message: `${key} is not a recognized parameter.`
			});
			continue;
		}
		if (seen.has(key)) {
			rejected.push({ code: 'custom', path: [key], message: `${key} must not be repeated.` });
			continue;
		}
		seen.add(key);
		Object.defineProperty(candidate, key, {
			value: searchParams.get(key) ?? '',
			enumerable: true,
			writable: false,
			configurable: true
		});
	}
	if (rejected.length > 0) return { ok: false, issues: rejected };
	return { ok: true, value: candidate };
}

function parseDashboardQuery(
	searchParams: URLSearchParams
): { ok: true; value: DashboardQuery } | { ok: false; issues: readonly ZodIssue[] } {
	const rawParams = rawParamsOrIssues(searchParams);
	if (!rawParams.ok) return rawParams;
	const candidate: Record<string, string> = rawParams.value;
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

function invalidCursor(instance: string, error: InvalidDashboardCursorError): Response {
	return problemResponse({
		type: 'urn:signkit:problem:dashboard-cursor-invalid',
		title: 'Invalid dashboard cursor',
		status: 400,
		detail: error.message,
		instance
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
 * Authorization is derived *before* the query is parsed: an unauthorized
 * caller must always see 401/403/503, never a 400 that leaks the fact that
 * their query string also happened to be malformed.
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
	const authorized: AuthorizedInstanceActor | Response = authorizeInstanceRequest(locals, instance);
	if (authorized instanceof Response) {
		return { outcome: 'error', query: DEFAULT_QUERY, response: authorized, kind: 'authorization' };
	}

	const parsedQuery = parseDashboardQuery(searchParams);
	if (!parsedQuery.ok) {
		return {
			outcome: 'error',
			query: DEFAULT_QUERY,
			response: validationFailure(instance, parsedQuery.issues),
			kind: 'validation'
		};
	}
	const query: DashboardQuery = parsedQuery.value;

	const application: DashboardApplicationPort | Response = await resolveApplicationOrProblem(
		platform,
		instance
	);
	if (application instanceof Response) {
		return { outcome: 'error', query, response: application, kind: 'store' };
	}

	try {
		const page: DashboardPage = await application.read({ email: authorized.email }, query);
		return { outcome: 'ok', query, page };
	} catch (error: unknown) {
		if (error instanceof InvalidDashboardCursorError) {
			return {
				outcome: 'error',
				query,
				response: invalidCursor(instance, error),
				kind: 'validation'
			};
		}
		console.error(
			JSON.stringify({
				event: 'dashboard_worklist_read_failed',
				message: error instanceof Error ? error.name : 'UnknownError'
			})
		);
		return { outcome: 'error', query, response: failed(instance), kind: 'store' };
	}
}
