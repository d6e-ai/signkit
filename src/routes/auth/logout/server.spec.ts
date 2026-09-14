import { isRedirect } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { ORGANIZATION_COOKIE, SESSION_COOKIE } from '$lib/server/session';
import { POST } from './+server';

interface CookieJar {
	deleted: Array<{ name: string; opts: unknown }>;
}

function event(): { cookies: { delete: (name: string, opts: unknown) => void } } & CookieJar {
	const deleted: Array<{ name: string; opts: unknown }> = [];
	return {
		deleted,
		cookies: {
			delete: (name: string, opts: unknown): void => {
				deleted.push({ name, opts });
			}
		}
	};
}

/**
 * Accepts a thunk rather than a bare result: unlike `load`, `POST` here is
 * synchronous and throws the redirect the instant it's invoked, so the call
 * itself must happen inside the `try` rather than as an argument expression
 * evaluated before `captureRedirect` runs.
 */
async function captureRedirect(fn: () => unknown): Promise<{ status: number; location: string }> {
	try {
		await fn();
	} catch (error: unknown) {
		if (isRedirect(error)) return { status: error.status, location: error.location };
		throw error;
	}
	throw new Error('expected a redirect to be thrown');
}

describe('POST /auth/logout', () => {
	it('clears the session and organization cookies', async () => {
		const evt = event();
		await captureRedirect(() => POST(evt as unknown as Parameters<typeof POST>[0]));

		expect(evt.deleted.map((entry) => entry.name)).toEqual([SESSION_COOKIE, ORGANIZATION_COOKIE]);
	});

	/**
	 * Not `/`: the root layout gate redirects an anonymous caller straight into
	 * `/auth/login`, which would restart OAuth the instant logout finishes.
	 * `/signed-out` is a public page exempt from that gate.
	 */
	it('redirects to the public signed-out page, never back into the login gate', async () => {
		const redirected = await captureRedirect(() =>
			POST(event() as unknown as Parameters<typeof POST>[0])
		);

		expect(redirected.status).toBe(302);
		expect(redirected.location).toMatch(/\/signed-out$/);
		expect(redirected.location).not.toBe('/');
		expect(redirected.location).not.toMatch(/\/auth\/login/);
	});
});
