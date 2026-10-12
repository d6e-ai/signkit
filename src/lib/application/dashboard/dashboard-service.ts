import {
	boundDashboardLimit,
	MAX_DASHBOARD_QUERY_LENGTH,
	type DashboardActor,
	type DashboardStore,
	type DashboardStoreQuery
} from '$lib/ports/dashboard-store';
import { normalizeRecipientEmail } from '$lib/domain/recipient-identity';
import {
	decodeDashboardCursor,
	type DashboardCursorFailureReason,
	type DashboardCursorPosition
} from './cursor';
import { DASHBOARD_VIEWS, isDashboardView, type DashboardPage, type DashboardQuery } from './model';

export interface DashboardRequestActor {
	email: string;
}

export interface DashboardApplicationPort {
	read(actor: DashboardRequestActor, query: DashboardQuery): Promise<DashboardPage>;
}

/** Thrown instead of reaching the store when the cursor cannot be trusted as-is. */
export class InvalidDashboardCursorError extends Error {
	readonly reason: DashboardCursorFailureReason;

	constructor(reason: DashboardCursorFailureReason) {
		super(
			reason === 'context_mismatch'
				? 'The cursor does not match the requested view and search text.'
				: 'The cursor is malformed.'
		);
		this.name = 'InvalidDashboardCursorError';
		this.reason = reason;
	}
}

/**
 * Thin normalization layer in front of the store. The HTTP handler and the
 * SSR loader both validate `view`/`q`/`cursor`/`limit` with the same schema
 * before calling this, so this layer only re-clamps defensively (an unknown
 * view falls back to `all` rather than throwing) and derives the one value
 * neither caller passes in: the normalized caller email that decides
 * `actionRequired`.
 *
 * The opaque cursor is decoded here, against the exact post-normalization
 * `(view, query)` the store is about to be called with, so a cursor minted
 * under a different filter is rejected before any query runs.
 */
export class DashboardApplication implements DashboardApplicationPort {
	constructor(private readonly store: DashboardStore) {}

	async read(actor: DashboardRequestActor, query: DashboardQuery): Promise<DashboardPage> {
		const trimmedQuery: string = query.query.trim().slice(0, MAX_DASHBOARD_QUERY_LENGTH);
		const normalizedQuery: string | null = trimmedQuery.length === 0 ? null : trimmedQuery;
		const normalizedView: DashboardQuery['view'] = isDashboardView(query.view)
			? query.view
			: DASHBOARD_VIEWS[0];
		const dashboardActor: DashboardActor = { email: normalizeRecipientEmail(actor.email) };

		let cursor: DashboardCursorPosition | null = null;
		if (query.cursor !== null) {
			const decoded = decodeDashboardCursor(query.cursor, {
				view: normalizedView,
				query: normalizedQuery
			});
			if (!decoded.ok) throw new InvalidDashboardCursorError(decoded.reason);
			cursor = decoded.value;
		}

		const storeQuery: DashboardStoreQuery = {
			view: normalizedView,
			query: normalizedQuery,
			cursor,
			limit: boundDashboardLimit(query.limit)
		};
		return await this.store.readDashboard(dashboardActor, storeQuery);
	}
}
