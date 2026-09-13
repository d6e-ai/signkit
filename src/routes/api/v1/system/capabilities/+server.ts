import { env } from '$env/dynamic/private';
import { json, type RequestHandler } from '@sveltejs/kit';
import { resolveSignKitRuntime, systemCapabilities } from '$lib/capabilities';

export const GET: RequestHandler = ({ platform }) => {
	const runtime = resolveSignKitRuntime({
		hasCloudflareDb: Boolean(platform?.env?.DB),
		isVercel: Boolean(env.VERCEL)
	});
	return json(systemCapabilities(runtime));
};
