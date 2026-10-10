import type { RequestHandler } from '@sveltejs/kit';
import {
	toPublicRecipientAccess,
	type RecipientAccessApplicationPort
} from '$lib/application/signing/recipient-access';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import { isRecipientCapability } from '$lib/security/recipient-capability';
import { problemResponse } from './problem';
import { recipientBearerToken, type RecipientHttpMode } from './recipient-bearer';

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type RecipientAccessApplicationResolver = (
	context: ResolverContext
) => RecipientAccessApplicationPort | null | Promise<RecipientAccessApplicationPort | null>;

export function createRecipientAccessHandler(
	resolveApplication: RecipientAccessApplicationResolver,
	now: () => Date = (): Date => new Date(),
	mode: RecipientHttpMode = 'browser'
): RequestHandler {
	return async ({ platform, request, url }): Promise<Response> => {
		const token: string | null =
			mode === 'bearer'
				? recipientBearerToken(request)
				: bearerToken(request.headers.get('authorization'));
		if (token === null || !isRecipientCapability(token)) return accessNotFound(url.pathname);

		let application: RecipientAccessApplicationPort | null;
		try {
			application = await resolveApplication({ platform });
		} catch {
			console.error(JSON.stringify({ event: 'recipient_access_resolution_failed' }));
			application = null;
		}
		if (application === null)
			return problemResponse(
				{
					type: 'urn:signkit:problem:persistence-unavailable',
					title: 'Recipient access unavailable',
					status: 503,
					detail: 'Recipient access cannot be resolved at this time.',
					instance: url.pathname
				},
				securityHeaders()
			);

		try {
			const context: RecipientSigningContext | null = await application.resolve(
				token,
				now().toISOString()
			);
			if (context === null) return accessNotFound(url.pathname);
			return new Response(
				JSON.stringify({
					access: toPublicRecipientAccess(context)
				}),
				{ status: 200, headers: securityHeaders({ 'content-type': 'application/json' }) }
			);
		} catch {
			console.error(JSON.stringify({ event: 'recipient_access_failed' }));
			return problemResponse(
				{
					type: 'urn:signkit:problem:service-unavailable',
					title: 'Recipient access unavailable',
					status: 503,
					detail: 'Recipient access cannot be resolved at this time.',
					instance: url.pathname
				},
				securityHeaders()
			);
		}
	};
}

function bearerToken(authorization: string | null): string | null {
	if (authorization === null) return null;
	const match: RegExpMatchArray | null = authorization.match(/^Bearer ([^\s]+)$/i);
	return match?.[1] ?? null;
}

function accessNotFound(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:recipient-access-not-found',
			title: 'Recipient access not found',
			status: 404,
			detail: 'No active recipient access was found.',
			instance
		},
		securityHeaders()
	);
}

function securityHeaders(initial?: HeadersInit): Headers {
	const headers: Headers = new Headers(initial);
	headers.set('cache-control', 'no-store');
	headers.set('referrer-policy', 'no-referrer');
	headers.set('vary', 'authorization');
	headers.set('x-content-type-options', 'nosniff');
	return headers;
}
