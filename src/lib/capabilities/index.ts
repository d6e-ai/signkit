import { authoringCapabilities } from './authoring';
import { evidenceCapabilities } from './evidence';
import { integrationCapabilities } from './integration';
import { SIGNKIT_VERSION } from './version';

export type SignKitRuntime = 'node' | 'cloudflare' | 'vercel';

export function resolveSignKitRuntime(input: {
	hasCloudflareDb: boolean;
	isVercel: boolean;
}): SignKitRuntime {
	if (input.hasCloudflareDb) return 'cloudflare';
	if (input.isVercel) return 'vercel';
	return 'node';
}

/**
 * The public origin this deployment advertises: the configured
 * `SIGNKIT_PUBLIC_ORIGIN` in canonical origin form, or `null` when it is unset,
 * blank, or not an HTTP(S) URL. It is the origin recipient links are built
 * from, which a console uses to confirm it is talking to the deployment it
 * registered.
 */
export function advertisedPublicOrigin(raw: string | undefined): string | null {
	if (raw === undefined || raw.trim().length === 0) return null;
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	return url.origin;
}

export function systemCapabilities(input: {
	runtime: SignKitRuntime;
	publicOrigin: string | null;
	/**
	 * The d6e console that operates this server (`SIGNKIT_CONSOLE_URL`), or null
	 * when it is missing or unacceptable: such a server cannot be operated.
	 */
	consoleUrl?: string | null;
}) {
	return {
		name: 'SignKit',
		apiVersion: 'v1',
		version: SIGNKIT_VERSION,
		runtime: input.runtime,
		publicOrigin: input.publicOrigin,
		consoleUrl: input.consoleUrl ?? null,
		supportedProfiles: {
			node: { database: 'postgresql', objects: 's3-compatible', status: 'scaffolded' },
			cloudflare: { database: 'd1', objects: 'r2', status: 'scaffolded' },
			vercel: { database: 'postgresql', objects: 's3-compatible', status: 'planned' }
		},
		...authoringCapabilities,
		...evidenceCapabilities,
		...integrationCapabilities
	};
}

export { authoringCapabilities } from './authoring';
export { evidenceCapabilities } from './evidence';
export {
	API_KEY_RATE_WINDOW_MAX_REQUESTS,
	API_KEY_RATE_WINDOW_SECONDS,
	integrationCapabilities
} from './integration';
