import type { PageServerLoad } from './$types';

/**
 * Bare `/sign` is not a signing surface. It never inspects recipient or
 * declined-receipt cookies, so it cannot guess which envelope a tab belongs
 * to. Failed `/s/{token}` exchanges land here with an explicit access hint.
 */
export const load: PageServerLoad = async ({ setHeaders, url }) => {
	setHeaders({
		'cache-control': 'private, no-store',
		'referrer-policy': 'no-referrer',
		'x-content-type-options': 'nosniff'
	});
	const accessHint: string | null = url.searchParams.get('access');
	if (accessHint === 'unavailable') return { state: 'unavailable' as const };
	return { state: 'invalid' as const };
};
