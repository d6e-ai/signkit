import { redirect } from '@sveltejs/kit';
import { localizeHref } from '$lib/paraglide/runtime';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, setHeaders, url }) => {
	await parent();
	setHeaders({ 'cache-control': 'private, no-store' });
	redirect(308, localizeHref(`/${url.search}`));
};
