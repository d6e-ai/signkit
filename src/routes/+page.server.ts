import { error, redirect } from '@sveltejs/kit';
import { resolveDashboardWorklist } from '$lib/server/dashboard-worklist-request';
import type { DashboardPage, DashboardQuery } from '$lib/application/dashboard/model';
import { localizeHref } from '$lib/paraglide/runtime';
import type { PageServerLoad } from './$types';

export interface DashboardWorklistError {
	status: number;
	message: string;
}

async function worklistErrorMessage(response: Response): Promise<string> {
	try {
		const body: unknown = await response.json();
		if (
			typeof body === 'object' &&
			body !== null &&
			typeof (body as { detail?: unknown }).detail === 'string'
		) {
			return (body as { detail: string }).detail;
		}
	} catch {
		// Malformed or missing JSON body: fall through to the status text below.
	}
	return response.statusText || 'Request failed.';
}

/**
 * SSR queries the dashboard worklist directly through the same server-only
 * helper the API route uses, rather than issuing an HTTP self-fetch against
 * `/api/v1/dashboard`: both surfaces derive their own authorization
 * independently, but neither should pay for a loopback request to reach the
 * same process.
 *
 * `await parent()` first, so `+layout.server.ts`'s own redirect/error (for an
 * anonymous caller, an unbootstrapped instance, or a non-active member) takes
 * effect before this load does any work of its own -- but authority for the
 * worklist read itself still comes from `resolveDashboardWorklist` reading
 * `locals` directly, never from the parent's already-resolved
 * `instanceMemberRole`, so a bug or a future change in the layout's gate
 * cannot silently widen who this page serves data to.
 *
 * An authorization or validation failure here independently fails the whole
 * render closed (redirect or `error()`), mirroring the layout's own
 * fail-closed behavior, rather than being folded into a successful page with
 * an empty worklist. Only a genuine storage-layer failure (the durable store
 * unresolvable, or the read itself failing) renders as a retryable
 * `worklistError` with `worklist: null` -- the one case where the page itself
 * is allowed to render normally and let the UI offer a retry.
 */
export const load: PageServerLoad = async ({ locals, parent, platform, setHeaders, url }) => {
	await parent();
	setHeaders({ 'cache-control': 'private, no-store' });

	const outcome = await resolveDashboardWorklist(locals, platform, url.pathname, url.searchParams);
	const worklistQuery: DashboardQuery = outcome.query;

	if (outcome.outcome === 'error') {
		if (outcome.kind === 'authorization') {
			if (outcome.response.status === 401) {
				const returnTo: string = `${url.pathname}${url.search}`;
				redirect(302, localizeHref(`/auth/login?return=${encodeURIComponent(returnTo)}`));
			}
			if (outcome.response.status === 503) {
				error(503, await worklistErrorMessage(outcome.response));
			}
			redirect(302, localizeHref('/settings'));
		}
		if (outcome.kind === 'validation') {
			error(outcome.response.status, await worklistErrorMessage(outcome.response));
		}
		return {
			worklist: null as DashboardPage | null,
			worklistQuery,
			worklistError: {
				status: outcome.response.status,
				message: await worklistErrorMessage(outcome.response)
			} as DashboardWorklistError | null
		};
	}
	return {
		worklist: outcome.page as DashboardPage | null,
		worklistQuery,
		worklistError: null as DashboardWorklistError | null
	};
};
