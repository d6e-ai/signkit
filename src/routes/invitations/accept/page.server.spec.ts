import { expect, it } from 'vitest';
import { identityOnlyLocals } from '$lib/http/http-handler-test-support';
import { load } from './+page.server';
it.each(['active', 'no_membership', 'suspended', 'anonymous', 'unavailable'] as const)(
	'exposes only the caller identity after verification (%s)',
	async (state) => {
		const locals = identityOnlyLocals('active');
		locals.identityState = state;
		const headers: Record<string, string> = {};
		const result = await load({
			locals,
			setHeaders: (value: Record<string, string>) => Object.assign(headers, value)
		} as unknown as Parameters<typeof load>[0]);
		expect(result).toEqual({
			signedInAccount:
				state === 'anonymous' || state === 'unavailable'
					? null
					: { subject: 'user-1', email: 'user@example.com' }
		});
		expect(headers).toMatchObject({
			'cache-control': 'private, no-store',
			'referrer-policy': 'no-referrer'
		});
	}
);
