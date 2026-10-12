import { resolveDashboardWorklist } from '$lib/server/dashboard-worklist-request';
import type { DashboardPage, DashboardQuery } from '$lib/application/dashboard/model';
import type { PageServerLoad } from './$types';

export interface DashboardWorklistError {
	status: number;
	message: string;
}

async function toWorklistError(response: Response): Promise<DashboardWorklistError> {
	try {
		const body: unknown = await response.json();
		const detail: string | null =
			typeof body === 'object' &&
			body !== null &&
			typeof (body as { detail?: unknown }).detail === 'string'
				? (body as { detail: string }).detail
				: null;
		return {
			status: response.status,
			message: detail ?? (response.statusText || 'Request failed.')
		};
	} catch {
		return { status: response.status, message: response.statusText || 'Request failed.' };
	}
}

/**
 * SSR queries the dashboard worklist directly through the same server-only
 * helper the API route uses, rather than issuing an HTTP self-fetch against
 * `/api/v1/dashboard`: both surfaces derive their own authorization
 * independently, but neither should pay for a loopback request to reach the
 * same process. A failure here is surfaced as `worklistError`, never folded
 * into an empty `worklist`, so the page can distinguish "nothing in your
 * worklist" from "the worklist could not be read right now".
 */
export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const outcome = await resolveDashboardWorklist(locals, platform, url.pathname, url.searchParams);
	const worklistQuery: DashboardQuery = outcome.query;
	if (outcome.outcome === 'error') {
		return {
			worklist: null as DashboardPage | null,
			worklistQuery,
			worklistError: await toWorklistError(outcome.response)
		};
	}
	return {
		worklist: outcome.page as DashboardPage | null,
		worklistQuery,
		worklistError: null as DashboardWorklistError | null
	};
};
