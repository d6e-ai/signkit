import type { RequestHandler } from './$types';

export const GET: RequestHandler = (): Response =>
	new Response(null, {
		status: 308,
		headers: {
			location: '/favicon.svg',
			'cache-control': 'public, max-age=86400'
		}
	});
