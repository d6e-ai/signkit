import type { RequestHandler } from '@sveltejs/kit';
import type { RecipientAccessApplicationPort } from '$lib/application/signing/recipient-access';
import { isRecipientCapability } from '$lib/security/recipient-capability';
import {
	RECIPIENT_SESSION_COOKIE,
	RECIPIENT_SESSION_COOKIE_MAX_AGE_SECONDS,
	RECIPIENT_SESSION_COOKIE_OPTIONS,
	sealRecipientSession
} from '$lib/server/recipient-session';

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type RecipientLinkApplicationResolver = (
	context: ResolverContext
) => RecipientAccessApplicationPort | null | Promise<RecipientAccessApplicationPort | null>;

export type RecipientSessionSealer = (token: string) => Promise<string>;

export function createRecipientLinkHandler(
	resolveApplication: RecipientLinkApplicationResolver,
	sealSession: RecipientSessionSealer = sealRecipientSession,
	now: () => Date = (): Date => new Date()
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
			if (context === null) return cleanRedirect(url, 'invalid');
			const remainingSeconds: number = Math.floor(
				(Date.parse(context.expiresAt) - accessedAt.valueOf()) / 1000
			);
			if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) {
				return cleanRedirect(url, 'invalid');
			}
			const sealed: string = await sealSession(token);
			cookies.set(RECIPIENT_SESSION_COOKIE, sealed, {
				...RECIPIENT_SESSION_COOKIE_OPTIONS,
				secure: url.protocol === 'https:',
				maxAge: Math.min(remainingSeconds, RECIPIENT_SESSION_COOKIE_MAX_AGE_SECONDS)
			});
			return redirectResponse(`/${context.recipientLocale}/sign`);
		} catch {
			console.error(JSON.stringify({ event: 'recipient_link_exchange_failed' }));
			return cleanRedirect(url, 'unavailable');
		}
	};
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
