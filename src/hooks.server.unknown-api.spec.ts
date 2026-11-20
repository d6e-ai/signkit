import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

const { handleConsoleCors, handleUnknownApiRoute } = await import('./hooks.server');

const CONSOLE: string = 'https://console.example.com';

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

function requestEvent(pathname: string, routeId: string | null): RequestEvent {
	const url: URL = new URL(`https://signkit.example${pathname}`);
	return {
		url,
		route: { id: routeId },
		request: new Request(url, { method: 'POST', headers: { origin: CONSOLE } }),
		platform: { env: { SIGNKIT_CONSOLE_ORIGINS: CONSOLE } }
	} as unknown as RequestEvent;
}

async function unknownApi(
	pathname: string,
	routeId: string | null
): Promise<{ response: Response; resolved: boolean }> {
	let resolved: boolean = false;
	const response: Response = (await handleUnknownApiRoute({
		event: requestEvent(pathname, routeId),
		resolve: async (): Promise<Response> => {
			resolved = true;
			return new Response('page', { status: 200 });
		}
	} as unknown as Parameters<typeof handleUnknownApiRoute>[0])) as Response;
	return { response, resolved };
}

describe('unknown API routes', () => {
	it('answers an API path without a route with a JSON 404, not the sign-in redirect', async () => {
		const { response, resolved } = await unknownApi(
			'/api/v1/instance/invitations/01900000-0000-7000-8000-000000000001/unknown',
			null
		);
		expect(resolved).toBe(false);
		expect(response.status).toBe(404);
		expect(response.headers.get('content-type')).toBe('application/problem+json');
		expect(await response.json()).toMatchObject({
			type: 'urn:signkit:problem:route-not-found',
			status: 404
		});
	});

	it('leaves matched API routes and unknown page paths to normal routing', async () => {
		expect((await unknownApi('/api/v1/dashboard', '/api/v1/dashboard')).resolved).toBe(true);
		expect((await unknownApi('/no-such-page', null)).resolved).toBe(true);
		expect((await unknownApi('/apix', null)).resolved).toBe(true);
	});

	it('lets an allowed console read the 404 through the CORS hook', async () => {
		const event: RequestEvent = requestEvent('/api/v1/instance/no-such-endpoint', null);
		const response: Response = (await handleConsoleCors({
			event,
			resolve: async (resolvedEvent: RequestEvent): Promise<Response> =>
				(await handleUnknownApiRoute({
					event: resolvedEvent,
					resolve: async (): Promise<Response> => new Response('page')
				} as unknown as Parameters<typeof handleUnknownApiRoute>[0])) as Response
		} as unknown as Parameters<typeof handleConsoleCors>[0])) as Response;
		expect(response.status).toBe(404);
		expect(response.headers.get('access-control-allow-origin')).toBe(CONSOLE);
	});
});
