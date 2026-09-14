import type { PageServerLoad } from './$types';
import { dev } from '$app/environment';
import {
	resolveRecipientDeclinedReceiptApplication,
	resolveRecipientWorkspaceApplication
} from '$lib/application/signing/runtime';
import {
	resolveDeclinedReceiptPage,
	resolveRecipientPage,
	type RecipientPageState
} from '$lib/application/signing/recipient-page';
import {
	DECLINED_RECEIPT_COOKIE,
	DECLINED_RECEIPT_COOKIE_MAX_AGE_SECONDS,
	DECLINED_RECEIPT_COOKIE_OPTIONS,
	type DeclinedReceiptSessionLocator,
	sealDeclinedReceiptSession,
	unsealDeclinedReceiptSession
} from '$lib/server/declined-receipt-session';
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
	const accessHint: string | null = url.searchParams.get('access');
	if (accessHint === 'invalid') return { state: 'invalid' as const };
	if (accessHint === 'unavailable') return { state: 'unavailable' as const };

	const activeCookie: string | null = cookies.get(RECIPIENT_SESSION_COOKIE) ?? null;
	if (activeCookie !== null) {
		const activePage: RecipientPageState = await resolveRecipientPage(
			{
				accessHint: null,
				cookie: activeCookie,
				clearSession: (): void =>
					cookies.delete(RECIPIENT_SESSION_COOKIE, { path: RECIPIENT_SESSION_COOKIE_PATH }),
				recoverDeclined: async (token, resolvedAt) => {
					const application = await resolveRecipientDeclinedReceiptApplication({ platform });
					if (application === null) return null;
					const authorized = await application.recoverByToken(token, resolvedAt);
					if (authorized === null) return null;
					const remainingSeconds: number = Math.floor(
						(Date.parse(authorized.locator.expiresAt) - resolvedAt.valueOf()) / 1000
					);
					if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) return null;
					const locator: DeclinedReceiptSessionLocator = {
						version: 1,
						...authorized.locator
					};
					const sealed: string = await sealDeclinedReceiptSession(locator);
					cookies.set(DECLINED_RECEIPT_COOKIE, sealed, {
						...DECLINED_RECEIPT_COOKIE_OPTIONS,
						secure: !isInsecureLocalDevelopment(url),
						maxAge: Math.min(remainingSeconds, DECLINED_RECEIPT_COOKIE_MAX_AGE_SECONDS)
					});
					cookies.delete(RECIPIENT_SESSION_COOKIE, { path: RECIPIENT_SESSION_COOKIE_PATH });
					return authorized.receipt;
				},
				platform
			},
			resolveRecipientWorkspaceApplication,
			unsealRecipientSession
		);
		if (activePage.state === 'active') {
			cookies.delete(DECLINED_RECEIPT_COOKIE, { path: DECLINED_RECEIPT_COOKIE_OPTIONS.path });
		}
		if (activePage.state !== 'invalid') return activePage;
	}

	const page: RecipientPageState = await resolveDeclinedReceiptPage(
		{
			cookie: cookies.get(DECLINED_RECEIPT_COOKIE) ?? null,
			clearSession: (): void =>
				cookies.delete(DECLINED_RECEIPT_COOKIE, {
					path: DECLINED_RECEIPT_COOKIE_OPTIONS.path
				}),
			platform
		},
		resolveRecipientDeclinedReceiptApplication,
		unsealDeclinedReceiptSession
	);
	return page;
};

function isInsecureLocalDevelopment(url: URL): boolean {
	if (!dev || url.protocol !== 'http:') return false;
	return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}
