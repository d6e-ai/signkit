import { env } from '$env/dynamic/private';
import { json, type RequestHandler } from '@sveltejs/kit';
import {
	advertisedPublicOrigin,
	resolveSignKitRuntime,
	systemCapabilities
} from '$lib/capabilities';
import { resolveConsoleUrl } from '$lib/server/console-url';

export const GET: RequestHandler = ({ platform }) => {
	const runtime = resolveSignKitRuntime({
		hasCloudflareDb: Boolean(platform?.env?.DB),
		isVercel: Boolean(env.VERCEL)
	});
	const publicOrigin: string | null = advertisedPublicOrigin(
		platform?.env?.SIGNKIT_PUBLIC_ORIGIN ?? env.SIGNKIT_PUBLIC_ORIGIN
	);
	return json(
		systemCapabilities({ runtime, publicOrigin, consoleUrl: resolveConsoleUrl(platform) })
	);
};
