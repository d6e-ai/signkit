import type { RequestEvent } from '@sveltejs/kit';

export function createDrainRequestEvent(
	pathname: string,
	authorization?: string,
	platform?: App.Platform
): RequestEvent {
	const url: URL = new URL(`https://signkit.internal${pathname}`);
	const headers: Headers = new Headers();
	if (authorization !== undefined) headers.set('authorization', authorization);
	return {
		platform,
		request: new Request(url, { method: 'POST', headers }),
		url
	} as RequestEvent;
}
