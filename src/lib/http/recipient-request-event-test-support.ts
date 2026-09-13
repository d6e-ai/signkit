import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { vi } from 'vitest';
import { RECIPIENT_SESSION_COOKIE } from '$lib/server/recipient-session';

export interface RecipientRequestEventInput {
	/** The signing-action endpoint under test; every handler spec has its own. */
	pathname: string;
	/** The valid command body for this endpoint, used unless `body` overrides it. */
	defaultBody: unknown;
	origin?: string | null;
	idempotencyKey?: string;
	body?: unknown;
	cookie?: string;
}

export interface RecipientRequestEventResult {
	event: RequestEvent;
	deleted: ReturnType<typeof vi.fn>;
	cookies: Cookies;
}

/**
 * Builds a `RequestEvent` for a recipient signing-action POST handler spec.
 * `pathname` and `defaultBody` are required so each spec states its own
 * endpoint and expected command shape rather than inheriting one silently
 * from this shared helper.
 */
export function createRecipientRequestEvent(
	input: RecipientRequestEventInput
): RecipientRequestEventResult {
	const headers: Headers = new Headers({ 'content-type': 'application/json' });
	if (input.origin !== null) {
		headers.set('origin', input.origin ?? 'https://signkit.example');
	}
	if (input.idempotencyKey !== undefined) {
		headers.set('idempotency-key', input.idempotencyKey);
	}
	const deleted = vi.fn();
	const cookie: string | undefined = input.cookie ?? 'sealed-session';
	const cookies = {
		get: vi.fn((name: string): string | undefined =>
			name === RECIPIENT_SESSION_COOKIE ? cookie : undefined
		),
		delete: deleted
	} as unknown as Cookies;
	const request = new Request(`https://signkit.example${input.pathname}`, {
		method: 'POST',
		headers,
		body: JSON.stringify(input.body ?? input.defaultBody)
	});
	return {
		event: {
			cookies,
			platform: { env: { DB: {} as D1Database } },
			request,
			url: new URL(request.url)
		} as unknown as RequestEvent,
		deleted,
		cookies
	};
}
