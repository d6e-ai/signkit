import { env } from '$env/dynamic/private';
import type { ConsoleCorsSurface } from '$lib/navigation/operator-api-surface';
import {
	CONSOLE_ORIGINS_ENV_VAR,
	ConsoleOriginsPolicyError,
	parseConsoleOrigins
} from '$lib/security/console-origins';

/**
 * Methods the operator surface uses. The discovery surface is narrower
 * ({@link DISCOVERY_METHODS}).
 */
export const CONSOLE_CORS_ALLOWED_METHODS: readonly string[] = [
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE'
];
const DISCOVERY_METHODS: readonly string[] = ['GET'];

/**
 * Request headers a console may send. `authorization` carries the d6e-auth
 * access token; there is deliberately no cookie, since credentialed CORS is
 * never allowed.
 */
export const CONSOLE_CORS_ALLOWED_HEADERS: readonly string[] = [
	'authorization',
	'content-type',
	'accept',
	'idempotency-key',
	'x-signkit-expected-subject'
];

/** Non-safelisted response headers a console needs to read. */
export const CONSOLE_CORS_EXPOSED_HEADERS: readonly string[] = [
	'content-disposition',
	'idempotency-replayed',
	'location',
	'www-authenticate'
];

export const CONSOLE_CORS_MAX_AGE_SECONDS: number = 600;

/**
 * The last parsed configuration, keyed by its raw value. Only deployer
 * configuration lives here -- never anything request-, origin-, or
 * token-specific -- so an invalid value is reported once per isolate instead
 * of on every API request, and a changed value is picked up immediately.
 */
let parsedConfiguration: { raw: string; origins: ReadonlySet<string> } | null = null;

/**
 * Resolves the allowed console origins from the platform env (Cloudflare) or
 * the process env (Node/Vercel). An absent, blank, or invalid value yields an
 * empty set: the feature is off and no CORS header is ever emitted.
 */
export function resolveConsoleOrigins(platform?: Readonly<App.Platform>): ReadonlySet<string> {
	const raw: string =
		platform?.env?.[CONSOLE_ORIGINS_ENV_VAR] ?? env[CONSOLE_ORIGINS_ENV_VAR] ?? '';
	if (parsedConfiguration !== null && parsedConfiguration.raw === raw) {
		return parsedConfiguration.origins;
	}
	let origins: ReadonlySet<string>;
	try {
		origins = parseConsoleOrigins(raw);
	} catch (error: unknown) {
		// Never echo the configured value: only the failure shape.
		console.error(
			JSON.stringify({
				event: 'console_origins_invalid',
				message:
					error instanceof ConsoleOriginsPolicyError ? error.message : 'invalid configuration'
			})
		);
		origins = new Set();
	}
	parsedConfiguration = { raw, origins };
	return origins;
}

function allowedMethods(surface: Exclude<ConsoleCorsSurface, null>): readonly string[] {
	return surface === 'operator' ? CONSOLE_CORS_ALLOWED_METHODS : DISCOVERY_METHODS;
}

/**
 * Whether a request (or, for a preflight, its `Access-Control-Request-Method`)
 * may be shared with an allowed console origin on `surface`. `HEAD` follows
 * `GET`, which SvelteKit derives it from.
 */
export function isConsoleCorsMethod(
	surface: Exclude<ConsoleCorsSurface, null>,
	method: string
): boolean {
	const normalized: string = method === 'HEAD' ? 'GET' : method;
	return allowedMethods(surface).includes(normalized);
}

/**
 * Appends `Origin` to `Vary` without disturbing tokens a handler already set.
 * A response with `Vary: *` already varies on everything.
 */
function appendVaryOrigin(headers: Headers): void {
	const current: string | null = headers.get('vary');
	if (current === null || current.trim().length === 0) {
		headers.set('vary', 'Origin');
		return;
	}
	const tokens: string[] = current.split(',').map((token: string): string => token.trim());
	if (tokens.includes('*')) return;
	if (tokens.some((token: string): boolean => token.toLowerCase() === 'origin')) return;
	headers.set('vary', `${current}, Origin`);
}

/**
 * Applies `mutate` to the response headers, copying the response first when
 * its headers are immutable (for example a `Response.redirect`).
 */
function withMutableHeaders(response: Response, mutate: (headers: Headers) => void): Response {
	try {
		mutate(response.headers);
		return response;
	} catch {
		const copy: Response = new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: new Headers(response.headers)
		});
		mutate(copy.headers);
		return copy;
	}
}

/**
 * The answer to an allowed preflight. It carries no body and never
 * `Access-Control-Allow-Credentials`: the console authenticates with an
 * explicit bearer, so a browser cookie is never part of a cross-origin call.
 */
export function consoleCorsPreflightResponse(
	origin: string,
	surface: Exclude<ConsoleCorsSurface, null>
): Response {
	return new Response(null, {
		status: 204,
		headers: {
			'access-control-allow-origin': origin,
			'access-control-allow-methods': allowedMethods(surface).join(', '),
			'access-control-allow-headers': CONSOLE_CORS_ALLOWED_HEADERS.join(', '),
			'access-control-max-age': String(CONSOLE_CORS_MAX_AGE_SECONDS),
			'cache-control': 'no-store',
			vary: 'Origin'
		}
	});
}

/**
 * Decorates an actual response on a console CORS surface.
 *
 * `Vary: Origin` is added whenever the feature is enabled, because the
 * response differs by origin whether or not this particular request was
 * allowed. The sharing headers are added only for an allowed origin; any
 * `Access-Control-Allow-Credentials` a handler might have set is removed.
 */
export function withConsoleCorsHeaders(response: Response, allowedOrigin: string | null): Response {
	return withMutableHeaders(response, (headers: Headers): void => {
		appendVaryOrigin(headers);
		if (allowedOrigin === null) return;
		headers.set('access-control-allow-origin', allowedOrigin);
		headers.set('access-control-expose-headers', CONSOLE_CORS_EXPOSED_HEADERS.join(', '));
		headers.delete('access-control-allow-credentials');
	});
}
