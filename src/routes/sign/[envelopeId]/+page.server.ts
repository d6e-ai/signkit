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
import { isUuidV7 } from '$lib/ids/uuid-v7';
import {
	DECLINED_RECEIPT_COOKIE_MAX_AGE_SECONDS,
	DECLINED_RECEIPT_COOKIE_OPTIONS,
	type DeclinedReceiptSessionLocator,
	declinedReceiptCookieName,
	deleteDeclinedReceiptCookie,
	readDeclinedReceiptCookie,
	sealDeclinedReceiptSession,
	unsealDeclinedReceiptSession
} from '$lib/server/declined-receipt-session';
import {
	deleteRecipientSessionCookie,
	readRecipientSessionCookie,
	recipientSessionCookieName,
	unsealRecipientSession
} from '$lib/server/recipient-session';

export const load: PageServerLoad = async ({ cookies, params, platform, setHeaders, url }) => {
	setHeaders({
		'cache-control': 'private, no-store',
		'referrer-policy': 'no-referrer',
		vary: 'Cookie',
		'x-content-type-options': 'nosniff'
	});
	const accessHint: string | null = url.searchParams.get('access');
	if (accessHint === 'invalid') return { state: 'invalid' as const };
	if (accessHint === 'unavailable') return { state: 'unavailable' as const };

	const envelopeId: string | undefined = params.envelopeId;
	if (envelopeId === undefined || !isUuidV7(envelopeId)) return { state: 'invalid' as const };
	if (recipientSessionCookieName(envelopeId) === null) return { state: 'invalid' as const };

	const activeCookie: string | null = readRecipientSessionCookie(cookies, envelopeId) ?? null;
	if (activeCookie !== null) {
		const activePage: RecipientPageState = await resolveRecipientPage(
			{
				accessHint: null,
				envelopeId,
				cookie: activeCookie,
				clearSession: (): void => deleteRecipientSessionCookie(cookies, envelopeId),
				recoverDeclined: async (token, resolvedAt) => {
					const application = await resolveRecipientDeclinedReceiptApplication({ platform });
					if (application === null) return null;
					const authorized = await application.recoverByToken(token, resolvedAt);
					if (authorized === null) return null;
					if (authorized.receipt.envelopeId !== envelopeId) return null;
					const remainingSeconds: number = Math.floor(
						(Date.parse(authorized.locator.expiresAt) - resolvedAt.valueOf()) / 1000
					);
					if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) return null;
					const locator: DeclinedReceiptSessionLocator = {
						version: 1,
						...authorized.locator
					};
					if (locator.envelopeId !== envelopeId) return null;
					const receiptCookieName: string | null = declinedReceiptCookieName(envelopeId);
					if (receiptCookieName === null) return null;
					const sealed: string = await sealDeclinedReceiptSession(locator);
					cookies.set(receiptCookieName, sealed, {
						...DECLINED_RECEIPT_COOKIE_OPTIONS,
						secure: !isInsecureLocalDevelopment(url),
						maxAge: Math.min(remainingSeconds, DECLINED_RECEIPT_COOKIE_MAX_AGE_SECONDS)
					});
					deleteRecipientSessionCookie(cookies, envelopeId);
					return authorized.receipt;
				},
				platform
			},
			resolveRecipientWorkspaceApplication,
			unsealRecipientSession
		);
		if (activePage.state === 'active') {
			deleteDeclinedReceiptCookie(cookies, envelopeId);
		}
		if (activePage.state !== 'invalid') return activePage;
	}

	const page: RecipientPageState = await resolveDeclinedReceiptPage(
		{
			envelopeId,
			cookie: readDeclinedReceiptCookie(cookies, envelopeId) ?? null,
			clearSession: (): void => deleteDeclinedReceiptCookie(cookies, envelopeId),
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
