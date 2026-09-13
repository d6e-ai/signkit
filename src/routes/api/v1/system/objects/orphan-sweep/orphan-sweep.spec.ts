import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { POST } from './+server';

const PATHNAME: string = '/api/v1/system/objects/orphan-sweep';

function event(authorization?: string): RequestEvent {
	const url: URL = new URL(`https://signkit.internal${PATHNAME}`);
	const headers: Headers = new Headers();
	if (authorization !== undefined) headers.set('authorization', authorization);
	return {
		request: new Request(url, { method: 'POST', headers }),
		url
	} as RequestEvent;
}

describe('POST /api/v1/system/objects/orphan-sweep', () => {
	it('is routed and rejects unauthenticated callers before sweeping', async () => {
		const response: Response = await POST(event());
		expect(response.status).toBe(401);
		expect(response.headers.get('content-type')).toContain('application/problem+json');
		const body = (await response.json()) as { instance: string };
		expect(body.instance).toBe(PATHNAME);
	});
});
