import type { DashboardPage, DashboardQuery } from '$lib/application/dashboard/model';

export const DEFAULT_DASHBOARD_LIMIT: number = 25;
export const MAX_DASHBOARD_LIMIT: number = 100;
export const MAX_DASHBOARD_QUERY_LENGTH: number = 200;

/**
 * The worklist owner, resolved from the verified browser session. Only the
 * normalized email is needed: it is the sole key used to decide whether the
 * caller currently holds the active turn on a sent/in_progress envelope.
 * There is no caller id/email request parameter anywhere in this feature --
 * this is always the authenticated caller, never a value chosen by the
 * request.
 */
export interface DashboardActor {
	email: string;
}

/**
 * Store-level query. `query` is `null` rather than an empty string so every
 * adapter branches on presence once, at the SQL level, instead of each
 * re-deriving "no search" from an empty string.
 */
export interface DashboardStoreQuery extends Omit<DashboardQuery, 'query'> {
	query: string | null;
}

/**
 * Dedicated read port for the dashboard worklist. Deliberately not an
 * extension of `EnvelopeApplicationPort`: that port's mocks model a single
 * envelope's authoring/send lifecycle, not a cross-envelope UI aggregate, and
 * growing it to also carry this read model would force every existing mock
 * and adapter to grow an unrelated method. The store computes recipient
 * aggregates and the active-turn lookup directly in SQL; callers never issue
 * a `getDetail`-style call per row.
 */
export interface DashboardStore {
	readDashboard(actor: DashboardActor, query: DashboardStoreQuery): Promise<DashboardPage>;
}

export function boundDashboardLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_DASHBOARD_LIMIT);
}
