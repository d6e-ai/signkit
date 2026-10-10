import { isRecipientCapability } from '$lib/security/recipient-capability';

export type RecipientHttpMode = 'browser' | 'bearer';

/**
 * The non-browser recipient surface accepts one explicit capability header and
 * no ambient browser authority. A malformed/foreign bearer never falls back to
 * a cookie, and a browser request cannot use this surface to evade its Origin
 * check. The capability itself is never copied into a URL or a diagnostic.
 */
export function recipientBearerToken(request: Request): string | null {
	if (request.headers.has('cookie') || request.headers.has('origin')) return null;
	const authorization: string | null = request.headers.get('authorization');
	if (authorization === null || authorization.includes(',')) return null;
	const match: RegExpMatchArray | null = authorization.match(/^Bearer (\S+)$/i);
	const token: string | undefined = match?.[1];
	return token !== undefined && isRecipientCapability(token) ? token : null;
}
