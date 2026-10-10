import type { Cookies, RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RecipientAccessApplicationPort } from '$lib/application/signing/recipient-access';
import type {
	AuthorizedRecipientDeclinedReceipt,
	RecipientDeclinedReceiptApplicationPort
} from '$lib/application/signing/recipient-declined-receipt';
import type {
	AuthorizedRecipientCompletedReceipt,
	RecipientCompletedReceiptApplicationPort
} from '$lib/application/signing/recipient-completed-receipt';
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
	COMPLETED_RECEIPT_COOKIE_MAX_AGE_SECONDS,
	COMPLETED_RECEIPT_COOKIE_OPTIONS,
	type CompletedReceiptSessionLocator,
	completedReceiptCookieName,
	sealCompletedReceiptSession
} from '$lib/server/completed-receipt-session';
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

export type RecipientCompletedReceiptApplicationResolver = (
	context: ResolverContext
) =>
	| RecipientCompletedReceiptApplicationPort
	| null
	| Promise<RecipientCompletedReceiptApplicationPort | null>;

export type DeclinedReceiptSessionSealer = (
	locator: DeclinedReceiptSessionLocator
) => Promise<string>;

export type CompletedReceiptSessionSealer = (
	locator: CompletedReceiptSessionLocator
) => Promise<string>;

export interface RecipientLinkReceiptOptions {
	resolveApplication: RecipientDeclinedReceiptApplicationResolver;
	sealSession?: DeclinedReceiptSessionSealer;
	unsealActiveSession?: RecipientSessionUnsealer;
	resolveCompletedApplication?: RecipientCompletedReceiptApplicationResolver;
	sealCompletedSession?: CompletedReceiptSessionSealer;
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
				return await exchangeTerminalReceipt(
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

/**
 * A capability the access application will no longer resolve is either revoked
 * by this recipient's own terminal action or genuinely unusable. Declined
 * evidence is tried first — it is the pre-existing behavior and the two command
 * tables are mutually exclusive for one recipient — then completed evidence.
 * Anything else stays the generic invalid response.
 */
async function exchangeTerminalReceipt(
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
	if (authorized === null) {
		return await exchangeCompletedReceipt(
			token,
			accessedAt,
			url,
			platform,
			cookies,
			allowInsecureLocalDevelopment,
			options
		);
	}
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
	await retireSameTokenSession(token, locator.envelopeId, cookies, options);
	return redirectResponse(`/${authorized.receipt.locale}/sign/${locator.envelopeId}`);
}

async function exchangeCompletedReceipt(
	token: string,
	accessedAt: Date,
	url: URL,
	platform: Readonly<App.Platform> | undefined,
	cookies: Cookies,
	allowInsecureLocalDevelopment: boolean,
	options: RecipientLinkReceiptOptions
): Promise<Response> {
	if (options.resolveCompletedApplication === undefined) return cleanRedirect(url, 'invalid');
	const application: RecipientCompletedReceiptApplicationPort | null =
		await options.resolveCompletedApplication({ platform });
	if (application === null) return cleanRedirect(url, 'unavailable');
	const authorized: AuthorizedRecipientCompletedReceipt | null = await application.recoverByToken(
		token,
		accessedAt
	);
	if (authorized === null) return cleanRedirect(url, 'invalid');
	if (!isUuidV7(authorized.receipt.envelopeId)) return cleanRedirect(url, 'invalid');
	const remainingSeconds: number = remainingCompletedReceiptSeconds(
		authorized.locator.expiresAt,
		accessedAt
	);
	if (remainingSeconds <= 0) return cleanRedirect(url, 'invalid');
	const locator: CompletedReceiptSessionLocator = {
		...authorized.locator,
		version: 1
	};
	if (locator.envelopeId !== authorized.receipt.envelopeId) return cleanRedirect(url, 'invalid');
	const receiptCookieName: string | null = completedReceiptCookieName(locator.envelopeId);
	if (receiptCookieName === null) return cleanRedirect(url, 'invalid');
	const seal: CompletedReceiptSessionSealer =
		options.sealCompletedSession ?? sealCompletedReceiptSession;
	const sealed: string = await seal(locator);
	cookies.set(receiptCookieName, sealed, {
		...COMPLETED_RECEIPT_COOKIE_OPTIONS,
		secure: !isInsecureLocalDevelopment(url, allowInsecureLocalDevelopment),
		maxAge: remainingSeconds
	});
	await retireSameTokenSession(token, locator.envelopeId, cookies, options);
	return redirectResponse(`/${authorized.receipt.locale}/sign/${locator.envelopeId}`);
}

/**
 * Drops the live session cookie only when it seals this exact token. A different
 * live cookie for the same envelope is left untouched, so a concurrent `/s`
 * exchange cannot be wiped, and an unreadable cookie is never destroyed.
 */
async function retireSameTokenSession(
	token: string,
	envelopeId: string,
	cookies: Cookies,
	options: RecipientLinkReceiptOptions
): Promise<void> {
	const activeCookie: string | undefined = readRecipientSessionCookie(cookies, envelopeId);
	if (activeCookie === undefined) return;
	const unsealActive: RecipientSessionUnsealer =
		options.unsealActiveSession ?? unsealRecipientSession;
	try {
		if ((await unsealActive(activeCookie, envelopeId)) === token) {
			deleteRecipientSessionCookie(cookies, envelopeId);
		}
	} catch {
		// A terminal link must never destroy an unreadable or unrelated live session.
	}
}

function remainingReceiptSeconds(expiresAt: string, now: Date): number {
	const remainingSeconds: number = Math.floor((Date.parse(expiresAt) - now.valueOf()) / 1000);
	if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) return 0;
	return Math.min(remainingSeconds, DECLINED_RECEIPT_COOKIE_MAX_AGE_SECONDS);
}

function remainingCompletedReceiptSeconds(expiresAt: string, now: Date): number {
	const remainingSeconds: number = Math.floor((Date.parse(expiresAt) - now.valueOf()) / 1000);
	if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) return 0;
	return Math.min(remainingSeconds, COMPLETED_RECEIPT_COOKIE_MAX_AGE_SECONDS);
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
