import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { RecipientAccessApplicationPort } from '$lib/application/signing/recipient-access';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import {
	RECIPIENT_SESSION_COOKIE,
	RECIPIENT_SESSION_COOKIE_MAX_AGE_SECONDS
} from '$lib/server/recipient-session';
import {
	createRecipientLinkHandler,
	type RecipientLinkApplicationResolver
} from './recipient-link';

const token: string = `skr1_${'A'.repeat(43)}`;
const context: RecipientSigningContext = {
	organizationId: 'org-secret',
	envelopeId: 'env-1',
	recipientId: 'recipient-1',
	recipientName: 'Private Recipient',
	recipientLocale: 'ja',
	recipientRole: 'signer',
	recipientStatus: 'pending',
	envelopeTitle: 'Agreement',
	envelopeStatus: 'sent',
	expiresAt: '2026-11-11T00:00:00.000Z'
};

interface TestEvent {
	cookieDelete: ReturnType<typeof vi.fn>;
	cookieSet: ReturnType<typeof vi.fn>;
	event: RequestEvent;
}

function testEvent(value: string = token, protocol: 'http:' | 'https:' = 'https:'): TestEvent {
	const cookieDelete = vi.fn();
	const cookieSet = vi.fn();
	const url: URL = new URL(`${protocol}//signkit.example/s/${value}`);
	return {
		cookieDelete,
		cookieSet,
		event: {
			cookies: { delete: cookieDelete, set: cookieSet },
			params: { token: value },
			platform: { env: { DB: {} as D1Database } },
			url
		} as unknown as RequestEvent
	};
}

function application(
	result: RecipientSigningContext | null = context
): RecipientAccessApplicationPort {
	return { resolve: vi.fn(async (): Promise<RecipientSigningContext | null> => result) };
}

describe('recipient link exchange', () => {
	it('rejects malformed path capabilities before resolving persistence', async () => {
		const input: TestEvent = testEvent('malformed');
		const resolver: RecipientLinkApplicationResolver = vi.fn(() => application());
		const response: Response = await createRecipientLinkHandler(resolver)(input.event);

		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/sign?access=invalid');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		expect(resolver).not.toHaveBeenCalled();
		expect(input.cookieDelete).not.toHaveBeenCalled();
	});

	it('exchanges an active capability for a bounded HttpOnly cookie and clean locale URL', async () => {
		const input: TestEvent = testEvent();
		const app: RecipientAccessApplicationPort = application();
		const sealer = vi.fn(async (): Promise<string> => 'sealed-cookie');
		const response: Response = await createRecipientLinkHandler(
			() => app,
			sealer,
			() => new Date('2026-09-11T00:00:00.000Z')
		)(input.event);

		expect(app.resolve).toHaveBeenCalledWith(token, '2026-09-11T00:00:00.000Z');
		expect(sealer).toHaveBeenCalledWith(token);
		expect(input.cookieSet).toHaveBeenCalledWith(RECIPIENT_SESSION_COOKIE, 'sealed-cookie', {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: true,
			maxAge: RECIPIENT_SESSION_COOKIE_MAX_AGE_SECONDS
		});
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/ja/sign');
		expect(response.headers.get('location')).not.toContain(token);
	});

	it('uses a non-secure cookie only for local HTTP development', async () => {
		const input: TestEvent = testEvent(token, 'http:');
		await createRecipientLinkHandler(
			() => application(),
			async (): Promise<string> => 'sealed-cookie',
			() => new Date('2026-09-11T00:00:00.000Z')
		)(input.event);
		expect(input.cookieSet).toHaveBeenCalledWith(
			RECIPIENT_SESSION_COOKIE,
			'sealed-cookie',
			expect.objectContaining({ secure: false })
		);
	});

	it('uses the recipient expiry when it is earlier than the cookie lifetime cap', async () => {
		const input: TestEvent = testEvent();
		await createRecipientLinkHandler(
			() =>
				application({
					...context,
					recipientLocale: 'en',
					expiresAt: '2026-09-11T01:00:00.000Z'
				}),
			async (): Promise<string> => 'sealed-cookie',
			() => new Date('2026-09-11T00:00:00.000Z')
		)(input.event);
		expect(input.cookieSet).toHaveBeenCalledWith(
			RECIPIENT_SESSION_COOKIE,
			'sealed-cookie',
			expect.objectContaining({ maxAge: 3600 })
		);
	});

	it.each([
		['exact expiry', '2026-09-11T00:00:00.000Z'],
		['sub-second remainder', '2026-09-11T00:00:00.500Z'],
		['invalid expiry', 'not-a-timestamp']
	])('does not create a cookie for %s', async (_name, expiresAt) => {
		const input: TestEvent = testEvent();
		const response: Response = await createRecipientLinkHandler(
			() => application({ ...context, expiresAt }),
			async (): Promise<string> => 'sealed-cookie',
			() => new Date('2026-09-11T00:00:00.000Z')
		)(input.event);
		expect(response.headers.get('location')).toBe('/sign?access=invalid');
		expect(input.cookieSet).not.toHaveBeenCalled();
	});

	it('does not destroy an existing session when sealing fails', async () => {
		const input: TestEvent = testEvent();
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const response: Response = await createRecipientLinkHandler(
			() => application(),
			async (): Promise<string> => {
				throw new Error('secret material that must not be logged');
			}
		)(input.event);
		expect(response.headers.get('location')).toBe('/sign?access=unavailable');
		expect(input.cookieDelete).not.toHaveBeenCalled();
		expect(input.cookieSet).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'recipient_link_exchange_failed' }));
		expect(error).not.toHaveBeenCalledWith(expect.stringContaining('secret material'));
		error.mockRestore();
	});

	it.each([
		['missing persistence', null, '/sign?access=unavailable'],
		['inactive capability', application(null), '/sign?access=invalid']
	] as const)('preserves an existing session for %s', async (_name, resolved, location) => {
		const input: TestEvent = testEvent();
		const response: Response = await createRecipientLinkHandler(() => resolved)(input.event);
		expect(response.headers.get('location')).toBe(location);
		expect(input.cookieDelete).not.toHaveBeenCalled();
		expect(input.cookieSet).not.toHaveBeenCalled();
	});
});
