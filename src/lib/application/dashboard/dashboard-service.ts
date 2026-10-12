import {
	boundDashboardLimit,
	MAX_DASHBOARD_QUERY_LENGTH,
	type DashboardActor,
	type DashboardStore
} from '$lib/ports/dashboard-store';
import { normalizeRecipientEmail } from '$lib/domain/recipient-identity';
import { DASHBOARD_VIEWS, isDashboardView, type DashboardPage, type DashboardQuery } from './model';

export interface DashboardRequestActor {
	email: string;
}

export interface DashboardApplicationPort {
	read(actor: DashboardRequestActor, query: DashboardQuery): Promise<DashboardPage>;
}

/**
 * Thin normalization layer in front of the store. The HTTP handler and the
 * SSR loader both validate `view`/`q`/`cursor`/`limit` with the same schema
 * before calling this, so this layer only re-clamps defensively (an unknown
 * view falls back to `all` rather than throwing) and derives the one value
 * neither caller passes in: the normalized caller email that decides
 * `actionRequired`.
 */
export class DashboardApplication implements DashboardApplicationPort {
	constructor(private readonly store: DashboardStore) {}

	async read(actor: DashboardRequestActor, query: DashboardQuery): Promise<DashboardPage> {
		const trimmedQuery: string = query.query.trim().slice(0, MAX_DASHBOARD_QUERY_LENGTH);
		const dashboardActor: DashboardActor = { email: normalizeRecipientEmail(actor.email) };
		return await this.store.readDashboard(dashboardActor, {
			view: isDashboardView(query.view) ? query.view : DASHBOARD_VIEWS[0],
			query: trimmedQuery.length === 0 ? null : trimmedQuery,
			cursor: query.cursor,
			limit: boundDashboardLimit(query.limit)
		});
	}
}
