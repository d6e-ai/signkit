import { describe, expect, it, vi } from 'vitest';
import type { RecipientAccessApplicationPort } from './recipient-access';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import { resolveRecipientPage } from './recipient-page';

const context: RecipientSigningContext = {
	organizationId: 'org-secret',
	envelopeId: 'env-1',
	recipientId: 'recipient-1',
	recipientName: 'Private Recipient',
	recipientLocale: 'en',
	recipientRole: 'approver',
	recipientStatus: 'viewed',
	envelopeTitle: 'Agreement',
	envelopeStatus: 'in_progress',
	expiresAt: '2026-09-12T00:00:00.000Z'
};

function application(
	result: RecipientSigningContext | null = context
): RecipientAccessApplicationPort {
	return { resolve: vi.fn(async (): Promise<RecipientSigningContext | null> => result) };
}

describe('recipient signing page resolution', () => {
	it('honors a clean redirect failure hint without reading a stale cookie', async () => {
		const unseal = vi.fn(async (): Promise<string | null> => 'token');
		await expect(
			resolveRecipientPage(
				{ accessHint: 'invalid', cookie: 'old', clearSession: vi.fn() },
				() => application(),
				unseal
			)
		).resolves.toEqual({ state: 'invalid' });
		expect(unseal).not.toHaveBeenCalled();
	});

	it('deletes an unreadable cookie', async () => {
		const clearSession = vi.fn();
		await expect(
			resolveRecipientPage(
				{ accessHint: null, cookie: 'bad', clearSession },
				() => application(),
				async (): Promise<null> => null
			)
		).resolves.toEqual({ state: 'invalid' });
		expect(clearSession).toHaveBeenCalledOnce();
	});

	it('revalidates the decrypted capability and returns only public fields', async () => {
		const app: RecipientAccessApplicationPort = application();
		const result = await resolveRecipientPage(
			{ accessHint: null, cookie: 'sealed', clearSession: vi.fn() },
			() => app,
			async (): Promise<string> => 'raw-token',
			() => new Date('2026-09-11T00:00:00.000Z')
		);

		expect(app.resolve).toHaveBeenCalledWith('raw-token', '2026-09-11T00:00:00.000Z');
		expect(result).toEqual({
			state: 'active',
			access: {
				envelopeId: 'env-1',
				recipientId: 'recipient-1',
				role: 'approver',
				locale: 'en',
				recipientStatus: 'viewed',
				envelopeTitle: 'Agreement',
				envelopeStatus: 'in_progress',
				expiresAt: '2026-09-12T00:00:00.000Z'
			}
		});
		expect(JSON.stringify(result)).not.toMatch(/org-secret|Private Recipient/);
	});

	it('deletes the cookie when durable state no longer authorizes the recipient', async () => {
		const clearSession = vi.fn();
		await expect(
			resolveRecipientPage(
				{ accessHint: null, cookie: 'sealed', clearSession },
				() => application(null),
				async (): Promise<string> => 'raw-token'
			)
		).resolves.toEqual({ state: 'invalid' });
		expect(clearSession).toHaveBeenCalledOnce();
	});

	it('preserves the session during a transient persistence outage', async () => {
		const clearSession = vi.fn();
		await expect(
			resolveRecipientPage(
				{ accessHint: null, cookie: 'sealed', clearSession },
				() => null,
				async (): Promise<string> => 'raw-token'
			)
		).resolves.toEqual({ state: 'unavailable' });
		expect(clearSession).not.toHaveBeenCalled();
	});
});
