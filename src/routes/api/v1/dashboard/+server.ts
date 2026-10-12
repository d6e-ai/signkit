import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { resolveDashboardWorklist } from '$lib/server/dashboard-worklist-request';

export const GET: RequestHandler = async ({ locals, platform, url }): Promise<Response> => {
	const outcome = await resolveDashboardWorklist(locals, platform, url.pathname, url.searchParams);
	if (outcome.outcome === 'error') return outcome.response;
	const headers: Headers = new Headers({ 'cache-control': 'no-store' });
	return json(outcome.page, { headers });
};
