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
		draftHistory: {
			format: 'git',
			archive: 'gzip',
			trackedFiles: ['documents/*.md'],
			commitEndpoint: '/api/v1/envelopes/{envelopeId}/draft/commits',
			concurrency: 'expected-generation',
			idempotency: 'required'
		},
		readiness: {
			endpoint: '/api/v1/envelopes/{envelopeId}/ready',
			recipients: 'complete-graph',
			concurrency: 'expected-generation',
			idempotency: 'required'
		},
		sending: {
			endpoint: '/api/v1/envelopes/{envelopeId}/send',
			concurrency: 'expected-generation-and-ready-audit-event',
			delivery: 'durable-outbox',
			idempotency: 'required'
		},
		recipientAccess: {
			endpoint: '/api/v1/signing/context',
			documentsEndpoint: '/api/v1/signing/documents',
			linkExchange: '/s/{capability}',
			webSurface: '/{locale}/sign',
			authentication: 'bearer-capability',
			browserSession: 'encrypted-http-only-cookie',
			states: ['sent', 'in_progress'],
			cache: 'no-store'
		},
		automation: { idempotencyKeys: true, actorProvenance: true, webhooks: 'planned' }
	});
};
