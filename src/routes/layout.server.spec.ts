import { isHttpError, isRedirect } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';

const { load } = await import('./+layout.server');

const CONSOLE_URL: string = 'https://console.example.com/signkit/console';

function event(pathname: string, consoleUrl?: string): Parameters<typeof load>[0] {
	return {
		platform: consoleUrl === undefined ? undefined : { env: { SIGNKIT_CONSOLE_URL: consoleUrl } },
		url: new URL(`https://signkit.example${pathname}`)
	} as unknown as Parameters<typeof load>[0];
}

async function outcome(
	result: unknown
): Promise<{ redirect: string } | { status: number } | { data: unknown }> {
	try {
		return { data: await result };
	} catch (caught: unknown) {
		if (isRedirect(caught)) return { redirect: caught.location };
		if (isHttpError(caught)) return { status: caught.status };
		throw caught;
	}
}

describe('root layout', () => {
	it('renders recipient pages on every server', async () => {
		for (const pathname of [
			'/s/token',
			'/sign',
			'/ja/sign/01900000-0000-7000-8000-000000000001',
			'/c/token/view'
		]) {
			expect(await outcome(load(event(pathname, CONSOLE_URL)))).toEqual({ data: {} });
			expect(await outcome(load(event(pathname)))).toEqual({ data: {} });
		}
	});

	it('sends every other page, including old operator links, to the console', async () => {
		for (const pathname of [
			'/',
			'/ja',
			'/envelopes/01900000-0000-7000-8000-000000000001',
			'/settings/api-keys',
			'/setup',
			'/invitations/accept',
			'/signed-out',
			'/no-such-page'
		]) {
			expect(await outcome(load(event(pathname, CONSOLE_URL)))).toEqual({ redirect: CONSOLE_URL });
		}
	});

	it('answers 503 for operator pages when no acceptable console URL is configured', async () => {
		for (const consoleUrl of [undefined, '', '   ', 'http://console.example.com/']) {
			expect(await outcome(load(event('/', consoleUrl)))).toEqual({ status: 503 });
		}
	});
});
