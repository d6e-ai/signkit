import { env } from '$env/dynamic/private';
import { json, type RequestHandler } from '@sveltejs/kit';

export const GET: RequestHandler = ({ platform }) => {
	const runtime = platform?.env?.DB ? 'cloudflare' : env.VERCEL ? 'vercel' : 'node';
	return json({
		name: 'SignKit',
		apiVersion: 'v1',
		runtime,
		supportedProfiles: {
			node: { database: 'postgresql', objects: 's3-compatible', status: 'scaffolded' },
			cloudflare: { database: 'd1', objects: 'r2', status: 'scaffolded' },
			vercel: { database: 'postgresql', objects: 's3-compatible', status: 'planned' }
		},
		draftHistory: { format: 'git', archive: 'gzip', trackedFiles: ['documents/*.md'] },
		automation: { idempotencyKeys: true, actorProvenance: true, webhooks: 'planned' }
	});
};
