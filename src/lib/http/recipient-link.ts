import type { Cookies, RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RecipientAccessApplicationPort } from '$lib/application/signing/recipient-access';
import type {
	AuthorizedRecipientDeclinedReceipt,
	RecipientDeclinedReceiptApplicationPort
} from '$lib/application/signing/recipient-declined-receipt';
import { isUuidV7 } from '$lib/ids/uuid-v7';
import { isRecipientCapability } from '$lib/security/recipient-capability';
import {
	DECLINED_RECEIPT_COOKIE_MAX_AGE_SECONDS,
	DECLINED_RECEIPT_COOKIE_OPTIONS,
	type DeclinedReceiptSessionLocator,
	declinedReceiptCookieName,
	sealDeclinedReceiptSession
} from '$lib/server/declined-receipt-session';
import {
	RECIPIENT_SESSION_COOKIE_MAX_AGE_SECONDS,
	RECIPIENT_SESSION_COOKIE_OPTIONS,
	deleteRecipientSessionCookie,
	readRecipientSessionCookie,
	recipientSessionCookieName,
	sealRecipientSession,
	unsealRecipientSession
} from '$lib/server/recipient-session';

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type RecipientLinkApplicationResolver = (
	context: ResolverContext
) => RecipientAccessApplicationPort | null | Promise<RecipientAccessApplicationPort | null>;

export type RecipientSessionSealer = (token: string, envelopeId: string) => Promise<string>;
export type RecipientSessionUnsealer = (
	cookie: string,
	envelopeId: string
) => Promise<string | null>;

export type RecipientDeclinedReceiptApplicationResolver = (
	context: ResolverContext
) =>
	| RecipientDeclinedReceiptApplicationPort
	| null
	| Promise<RecipientDeclinedReceiptApplicationPort | null>;

export type DeclinedReceiptSessionSealer = (
	locator: DeclinedReceiptSessionLocator
) => Promise<string>;

export interface RecipientLinkReceiptOptions {
	resolveApplication: RecipientDeclinedReceiptApplicationResolver;
	sealSession?: DeclinedReceiptSessionSealer;
	unsealActiveSession?: RecipientSessionUnsealer;
}

export function createRecipientLinkHandler(
	resolveApplication: RecipientLinkApplicationResolver,
	sealSession: RecipientSessionSealer = sealRecipientSession,
	now: () => Date = (): Date => new Date(),
	allowInsecureLocalDevelopment: boolean = dev,
	receiptOptions?: RecipientLinkReceiptOptions
): RequestHandler {
	return async ({ cookies, params, platform, url }): Promise<Response> => {
		const token: string | undefined = params.token;
		if (token === undefined || !isRecipientCapability(token)) return cleanRedirect(url, 'invalid');

		try {
			const application: RecipientAccessApplicationPort | null = await resolveApplication({
				platform
			});
			if (application === null) return cleanRedirect(url, 'unavailable');
			const accessedAt: Date = now();
			const context = await application.resolve(token, accessedAt.toISOString());
			if (context === null) {
				return await exchangeDeclinedReceipt(
					token,
					accessedAt,
					url,
					platform,
					cookies,
					allowInsecureLocalDevelopment,
					receiptOptions
				);
			}
			if (!isUuidV7(context.envelopeId)) return cleanRedirect(url, 'invalid');
			const remainingSeconds: number = Math.floor(
				(Date.parse(context.expiresAt) - accessedAt.valueOf()) / 1000
			);
			if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) {
				return cleanRedirect(url, 'invalid');
			}
			const cookieName: string | null = recipientSessionCookieName(context.envelopeId);
			if (cookieName === null) return cleanRedirect(url, 'invalid');
			const sealed: string = await sealSession(token, context.envelopeId);
			cookies.set(cookieName, sealed, {
				...RECIPIENT_SESSION_COOKIE_OPTIONS,
				secure: !isInsecureLocalDevelopment(url, allowInsecureLocalDevelopment),
				maxAge: Math.min(remainingSeconds, RECIPIENT_SESSION_COOKIE_MAX_AGE_SECONDS)
			});
			// Do not delete a same-envelope declined receipt. Terminal decline is
			// irreversible; a late live /s that resolved before the decline must
			// not wipe the receipt. The page prefers active durable authorization
			// and falls back to the receipt if that cookie is invalid.
			return redirectResponse(`/${context.recipientLocale}/sign/${context.envelopeId}`);
		} catch {
			console.error(JSON.stringify({ event: 'recipient_link_exchange_failed' }));
			return cleanRedirect(url, 'unavailable');
		}
	};
}

async function exchangeDeclinedReceipt(
	token: string,
	accessedAt: Date,
	url: URL,
	platform: Readonly<App.Platform> | undefined,
	cookies: Cookies,
	allowInsecureLocalDevelopment: boolean,
	options: RecipientLinkReceiptOptions | undefined
): Promise<Response> {
	if (options === undefined) return cleanRedirect(url, 'invalid');
	const application: RecipientDeclinedReceiptApplicationPort | null =
		await options.resolveApplication({ platform });
	if (application === null) return cleanRedirect(url, 'unavailable');
	const authorized: AuthorizedRecipientDeclinedReceipt | null = await application.recoverByToken(
		token,
		accessedAt
	);
	if (authorized === null) return cleanRedirect(url, 'invalid');
	if (!isUuidV7(authorized.receipt.envelopeId)) return cleanRedirect(url, 'invalid');
	const remainingSeconds: number = remainingReceiptSeconds(
		authorized.locator.expiresAt,
		accessedAt
	);
	if (remainingSeconds <= 0) return cleanRedirect(url, 'invalid');
	const locator: DeclinedReceiptSessionLocator = {
		...authorized.locator,
		version: 1
	};
	if (locator.envelopeId !== authorized.receipt.envelopeId) return cleanRedirect(url, 'invalid');
	const receiptCookieName: string | null = declinedReceiptCookieName(locator.envelopeId);
	if (receiptCookieName === null) return cleanRedirect(url, 'invalid');
	const seal: DeclinedReceiptSessionSealer = options.sealSession ?? sealDeclinedReceiptSession;
	const sealed: string = await seal(locator);
	cookies.set(receiptCookieName, sealed, {
		...DECLINED_RECEIPT_COOKIE_OPTIONS,
		secure: !isInsecureLocalDevelopment(url, allowInsecureLocalDevelopment),
		maxAge: remainingSeconds
	});
	const activeCookie: string | undefined = readRecipientSessionCookie(cookies, locator.envelopeId);
	if (activeCookie !== undefined) {
		const unsealActive: RecipientSessionUnsealer =
			options.unsealActiveSession ?? unsealRecipientSession;
		try {
			if ((await unsealActive(activeCookie, locator.envelopeId)) === token) {
				// Same-token exchange only: a different live cookie for this
				// envelope is left untouched, so a concurrent /s cannot be wiped.
				deleteRecipientSessionCookie(cookies, locator.envelopeId);
			}
		} catch {
			// A declined link must never destroy an unreadable or unrelated live session.
		}
	}
	return redirectResponse(`/${authorized.receipt.locale}/sign/${locator.envelopeId}`);
}

function remainingReceiptSeconds(expiresAt: string, now: Date): number {
	const remainingSeconds: number = Math.floor((Date.parse(expiresAt) - now.valueOf()) / 1000);
	if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) return 0;
	return Math.min(remainingSeconds, DECLINED_RECEIPT_COOKIE_MAX_AGE_SECONDS);
}

function isInsecureLocalDevelopment(url: URL, allowed: boolean): boolean {
	if (!allowed || url.protocol !== 'http:') return false;
	return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

function cleanRedirect(url: URL, access: 'invalid' | 'unavailable'): Response {
	const destination: URL = new URL('/sign', url);
	destination.searchParams.set('access', access);
	return redirectResponse(`${destination.pathname}${destination.search}`);
}

function redirectResponse(location: string): Response {
	return new Response(null, {
		status: 303,
		headers: {
			'cache-control': 'no-store',
			location,
			'referrer-policy': 'no-referrer',
			'x-content-type-options': 'nosniff'
		}
	});
}
