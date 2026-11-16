import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ setHeaders, locals }) => {
	setHeaders({ 'cache-control': 'private, no-store', 'referrer-policy': 'same-origin' });
	const verified = locals.identityState !== 'anonymous' && locals.identityState !== 'unavailable';
	return {
		signedInAccount:
			verified && locals.principal
				? {
						subject: locals.principal.subject,
						email: locals.principal.email
					}
				: null
	};
};
