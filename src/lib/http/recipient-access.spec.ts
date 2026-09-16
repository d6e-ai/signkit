import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { RecipientAccessApplicationPort } from '$lib/application/signing/recipient-access';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import {
	createRecipientAccessHandler,
	type RecipientAccessApplicationResolver
} from './recipient-access';

const token: string = `skr1_${'A'.repeat(43)}`;
const context: RecipientSigningContext = {
	envelopeId: 'env-1',
	recipientId: 'recipient-1',
	recipientName: 'Private Recipient',
	recipientLocale: 'ja',
	recipientRole: 'signer',
	recipientStatus: 'pending',
	envelopeTitle: 'Agreement',
	envelopeStatus: 'sent',
	expiresAt: '2026-09-12T00:00:00.000Z',
	sentRevision: {
		commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		archiveKey: 'private/archive.git.gz',
		archiveSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	}
};

function event(authorization?: string): RequestEvent {
	const url: URL = new URL('https://signkit.example/api/v1/signing/context');
	const headers: Headers = new Headers();
	if (authorization !== undefined) headers.set('authorization', authorization);
	return {
		locals: {
			apiKeyAuthentication: { state: 'absent' },
			identityState: 'unavailable',
			memberships: [],
			principal: null
		},
		params: {},
		platform: { env: { DB: {} as D1Database } },
		request: new Request(url, { headers }),
		url
	} as unknown as RequestEvent;
}

function application(
	result: RecipientSigningContext | null = context
): RecipientAccessApplicationPort {
	return { resolve: vi.fn(async (): Promise<RecipientSigningContext | null> => result) };
}

describe('recipient access HTTP handler', () => {
	it.each([
		undefined,
		'Basic abc',
		'Bearer malformed',
		`Bearer  ${token}`,
		`Bearer ${token} extra`
	])(
		'returns the same 404 and avoids persistence for an invalid credential: %s',
		async (authorization) => {
			const resolver: RecipientAccessApplicationResolver = vi.fn(() => application());
			const response: Response = await createRecipientAccessHandler(resolver)(event(authorization));
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({
				type: 'urn:signkit:problem:recipient-access-not-found',
				title: 'Recipient access not found',
				status: 404,
				detail: 'No active recipient access was found.',
				instance: '/api/v1/signing/context'
			});
			expect(resolver).not.toHaveBeenCalled();
		}
	);

	it('passes one server timestamp and returns an allowlisted secret-free context', async () => {
		const app: RecipientAccessApplicationPort = application();
		const response: Response = await createRecipientAccessHandler(
			() => app,
			() => new Date('2026-09-11T00:00:00.000Z')
		)(event(`bEaReR ${token}`));

		expect(app.resolve).toHaveBeenCalledWith(token, '2026-09-11T00:00:00.000Z');
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		expect(response.headers.get('vary')).toBe('authorization');
		const text: string = await response.text();
		expect(JSON.parse(text)).toEqual({
			access: {
				envelopeId: 'env-1',
				recipientId: 'recipient-1',
				recipientName: 'Private Recipient',
				role: 'signer',
				locale: 'ja',
				recipientStatus: 'pending',
				envelopeTitle: 'Agreement',
				envelopeStatus: 'sent',
				expiresAt: '2026-09-12T00:00:00.000Z'
			}
		});
		expect(text).not.toMatch(/org-secret|skr1_|token|hash|email/i);
	});

	it('uses the same 404 for a well-formed capability with no active context', async () => {
		const response: Response = await createRecipientAccessHandler(() => application(null))(
			event(`Bearer ${token}`)
		);
		expect(response.status).toBe(404);
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('returns a secret-free 503 when persistence is unavailable', async () => {
		const response: Response = await createRecipientAccessHandler(() => null)(
			event(`Bearer ${token}`)
		);
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain(token);
	});
});
