import { authoringCapabilities } from './authoring';
import { evidenceCapabilities } from './evidence';
import { integrationCapabilities } from './integration';

export type SignKitRuntime = 'node' | 'cloudflare' | 'vercel';

export function resolveSignKitRuntime(input: {
	hasCloudflareDb: boolean;
	isVercel: boolean;
}): SignKitRuntime {
	if (input.hasCloudflareDb) return 'cloudflare';
	if (input.isVercel) return 'vercel';
	return 'node';
}

export function systemCapabilities(runtime: SignKitRuntime) {
	return {
		name: 'SignKit',
		apiVersion: 'v1',
		runtime,
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
