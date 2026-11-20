import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

const { handleConsoleCors } = await import('./hooks.server');

const CONSOLE: string = 'https://console.example.com';
const OTHER: string = 'https://attacker.example';
const ORIGINS: string = `${CONSOLE}, http://localhost:5173`;

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
	vi.restoreAllMocks();
});

interface Run {
	response: Response;
	resolved: boolean;
}

async function run(input: {
	pathname: string;
	method?: string;
	origin?: string;
	headers?: Record<string, string>;
	consoleOrigins?: string | null;
	respond?: () => Response;
}): Promise<Run> {
	const url: URL = new URL(`https://signkit.example${input.pathname}`);
	const headers: Headers = new Headers(input.headers);
	if (input.origin !== undefined) headers.set('origin', input.origin);
	let resolved: boolean = false;
	const event = {
		url,
		request: new Request(url, { method: input.method ?? 'GET', headers }),
		platform:
			input.consoleOrigins === null
				? undefined
				: { env: { SIGNKIT_CONSOLE_ORIGINS: input.consoleOrigins ?? ORIGINS } }
	} as unknown as RequestEvent;
	const response: Response = (await handleConsoleCors({
		event,
		resolve: async (): Promise<Response> => {
			resolved = true;
			return input.respond?.() ?? Response.json({ ok: true });
		}
	} as unknown as Parameters<typeof handleConsoleCors>[0])) as Response;
	return { response, resolved };
}

function preflight(origin: string, method: string = 'POST'): Record<string, string> {
	return {
		'access-control-request-method': method,
		'access-control-request-headers': 'authorization, content-type, idempotency-key',
		origin
	};
}

function corsHeaderNames(response: Response): string[] {
	return [...response.headers.keys()].filter((name: string): boolean =>
		name.startsWith('access-control-')
	);
}

describe('console CORS preflight', () => {
	it.each([
		'/api/v1/envelopes',
		'/api/v1/envelopes/01900000-0000-7000-8000-000000000001/documents/pdf',
		'/api/v1/instance/bootstrap',
		'/api/v1/dashboard'
	])('answers an allowed origin on %s with 204 before routing', async (pathname) => {
		const { response, resolved } = await run({
			pathname,
			method: 'OPTIONS',
			headers: preflight(CONSOLE)
		});

		expect(resolved).toBe(false);
		expect(response.status).toBe(204);
		expect(response.headers.get('access-control-allow-origin')).toBe(CONSOLE);
		expect(response.headers.get('access-control-allow-methods')).toBe(
			'GET, POST, PUT, PATCH, DELETE'
		);
		expect(response.headers.get('access-control-allow-headers')).toBe(
			'authorization, content-type, accept, idempotency-key, x-signkit-expected-subject'
		);
		expect(response.headers.get('access-control-max-age')).toBe('600');
		expect(response.headers.get('vary')).toBe('Origin');
		expect(response.headers.has('access-control-allow-credentials')).toBe(false);
	});

	it('accepts a configured loopback development origin', async () => {
		const { response } = await run({
			pathname: '/api/v1/envelopes',
			method: 'OPTIONS',
			headers: preflight('http://localhost:5173', 'PATCH')
		});
		expect(response.status).toBe(204);
		expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
	});

	it.each([
		['an unlisted origin', OTHER],
		['the null origin', 'null'],
		['a scheme downgrade of the console', 'http://console.example.com'],
		['a sibling subdomain', 'https://evil.console.example.com'],
		['a trailing-slash spelling', `${CONSOLE}/`]
	])('refuses %s: routing answers and no CORS header is added', async (_name, origin) => {
		const { response, resolved } = await run({
			pathname: '/api/v1/envelopes',
			method: 'OPTIONS',
			headers: preflight(origin),
			respond: () => new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
		});

		expect(resolved).toBe(true);
		expect(response.status).toBe(405);
		expect(corsHeaderNames(response)).toEqual([]);
		expect(response.headers.get('vary')).toBe('Origin');
	});

	it.each([
		['feature off (unset)', null],
		['feature off (blank)', ''],
		['an invalid configuration', 'https://console.example.com/path']
	])('never answers a preflight with %s', async (_name, consoleOrigins) => {
		vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const { response, resolved } = await run({
			pathname: '/api/v1/envelopes',
			method: 'OPTIONS',
			headers: preflight(CONSOLE),
			consoleOrigins,
			respond: () => new Response(null, { status: 405 })
		});

		expect(resolved).toBe(true);
		expect(response.status).toBe(405);
		expect(corsHeaderNames(response)).toEqual([]);
	});

	it('logs an invalid configuration without echoing it', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		await run({
			pathname: '/api/v1/envelopes',
			origin: CONSOLE,
			consoleOrigins: 'https://hidden-console.example.com/console'
		});

		expect(errorSpy).toHaveBeenCalled();
		expect(JSON.stringify(errorSpy.mock.calls)).toContain('console_origins_invalid');
		expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('hidden-console');
	});

	it.each([
		'/api/v1/signing/sign',
		'/api/v1/signing/signature-assets',
		'/api/v1/recipient/sign',
		'/api/v1/completion-artifacts',
		'/api/v1/system/deliveries/drain',
		'/api/v1/system/maintenance/health',
		'/s/skr1_token',
		'/envelopes'
	])('never opens excluded path %s, even to an allowed origin', async (pathname) => {
		const { response, resolved } = await run({
			pathname,
			method: 'OPTIONS',
			headers: preflight(CONSOLE),
			respond: () => new Response(null, { status: 405 })
		});

		expect(resolved).toBe(true);
		expect(response.status).toBe(405);
		expect(corsHeaderNames(response)).toEqual([]);
		expect(response.headers.has('vary')).toBe(false);
	});

	it.each(['/api/v1/system/capabilities', '/api/v1/openapi.json'])(
		'opens discovery path %s for GET only',
		async (pathname) => {
			const get = await run({
				pathname,
				method: 'OPTIONS',
				headers: preflight(CONSOLE, 'GET')
			});
			expect(get.response.status).toBe(204);
			expect(get.response.headers.get('access-control-allow-methods')).toBe('GET');

			const post = await run({
				pathname,
				method: 'OPTIONS',
				headers: preflight(CONSOLE, 'POST'),
				respond: () => new Response(null, { status: 405 })
			});
			expect(post.response.status).toBe(405);
			expect(corsHeaderNames(post.response)).toEqual([]);
		}
	);
});

describe('console CORS on actual responses', () => {
	it('shares a response with an allowed origin and exposes the API headers', async () => {
		const { response } = await run({
			pathname: '/api/v1/envelopes/01900000-0000-7000-8000-000000000001/pdf',
			origin: CONSOLE,
			respond: () =>
				new Response('pdf', {
					headers: {
						'content-type': 'application/pdf',
						'content-disposition': 'attachment; filename="a.pdf"'
					}
				})
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('pdf');
		expect(response.headers.get('access-control-allow-origin')).toBe(CONSOLE);
		expect(response.headers.get('access-control-expose-headers')).toBe(
			'content-disposition, idempotency-replayed, location, www-authenticate'
		);
		expect(response.headers.get('vary')).toBe('Origin');
		expect(response.headers.has('access-control-allow-credentials')).toBe(false);
	});

	it('shares error responses too, so the console can read a 401 challenge', async () => {
		const { response } = await run({
			pathname: '/api/v1/dashboard',
			origin: CONSOLE,
			respond: () =>
				new Response(JSON.stringify({ type: 'urn:signkit:problem:authentication-required' }), {
					status: 401,
					headers: { 'content-type': 'application/problem+json', 'www-authenticate': 'Bearer' }
				})
		});

		expect(response.status).toBe(401);
		expect(response.headers.get('access-control-allow-origin')).toBe(CONSOLE);
		expect(response.headers.get('www-authenticate')).toBe('Bearer');
	});

	it('merges Origin into an existing Vary and strips any credentials grant', async () => {
		const { response } = await run({
			pathname: '/api/v1/envelopes',
			origin: CONSOLE,
			respond: () =>
				new Response('{}', {
					headers: { vary: 'Accept', 'access-control-allow-credentials': 'true' }
				})
		});

		expect(response.headers.get('vary')).toBe('Accept, Origin');
		expect(response.headers.has('access-control-allow-credentials')).toBe(false);
	});

	it('decorates a response whose headers are immutable', async () => {
		const { response } = await run({
			pathname: '/api/v1/envelopes',
			origin: CONSOLE,
			respond: () => Response.redirect('https://signkit.example/api/v1/envelopes?page=2', 303)
		});

		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe(
			'https://signkit.example/api/v1/envelopes?page=2'
		);
		expect(response.headers.get('access-control-allow-origin')).toBe(CONSOLE);
	});

	it('varies but does not share with an unlisted or absent origin', async () => {
		for (const origin of [OTHER, undefined]) {
			const { response } = await run({ pathname: '/api/v1/envelopes', origin });
			expect(corsHeaderNames(response)).toEqual([]);
			expect(response.headers.get('vary')).toBe('Origin');
		}
	});

	it('does not share a discovery path for a method other than GET', async () => {
		const get = await run({ pathname: '/api/v1/system/capabilities', origin: CONSOLE });
		expect(get.response.headers.get('access-control-allow-origin')).toBe(CONSOLE);

		const post = await run({
			pathname: '/api/v1/system/capabilities',
			method: 'POST',
			origin: CONSOLE,
			respond: () => new Response(null, { status: 405 })
		});
		expect(corsHeaderNames(post.response)).toEqual([]);
	});

	it('leaves responses untouched when the feature is off', async () => {
		const { response } = await run({
			pathname: '/api/v1/envelopes',
			origin: CONSOLE,
			consoleOrigins: null
		});
		expect(corsHeaderNames(response)).toEqual([]);
		expect(response.headers.has('vary')).toBe(false);
	});

	it('reads the process environment when the platform has no value', async () => {
		privateEnv.SIGNKIT_CONSOLE_ORIGINS = CONSOLE;
		const { response } = await run({
			pathname: '/api/v1/envelopes',
			origin: CONSOLE,
			consoleOrigins: null
		});
		expect(response.headers.get('access-control-allow-origin')).toBe(CONSOLE);
	});
});
