import type { PageServerLoad } from './$types';
import { resolveRecipientWorkspaceApplication } from '$lib/application/signing/runtime';
import { resolveRecipientPage } from '$lib/application/signing/recipient-page';
import {
	RECIPIENT_SESSION_COOKIE,
	RECIPIENT_SESSION_COOKIE_PATH,
	unsealRecipientSession
} from '$lib/server/recipient-session';

export const load: PageServerLoad = async ({ cookies, platform, setHeaders, url }) => {
	setHeaders({
		'cache-control': 'private, no-store',
		'referrer-policy': 'no-referrer',
		vary: 'Cookie',
		'x-content-type-options': 'nosniff'
	});
	return resolveRecipientPage(
		{
			accessHint: url.searchParams.get('access'),
			cookie: cookies.get(RECIPIENT_SESSION_COOKIE) ?? null,
			clearSession: (): void =>
				cookies.delete(RECIPIENT_SESSION_COOKIE, { path: RECIPIENT_SESSION_COOKIE_PATH }),
			platform
		},
		resolveRecipientWorkspaceApplication,
		unsealRecipientSession
	);
};
