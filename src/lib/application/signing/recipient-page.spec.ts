import { describe, expect, it, vi } from 'vitest';
import type { RecipientWorkspace, RecipientWorkspaceApplicationPort } from './recipient-workspace';
import type { RecipientDeclinedReceiptApplicationPort } from './recipient-declined-receipt';
import { RecipientWorkspaceIntegrityError } from './recipient-workspace';
import { resolveDeclinedReceiptPage, resolveRecipientPage } from './recipient-page';
import type { DeclinedReceiptSessionLocator } from '$lib/server/declined-receipt-session';

const workspace: RecipientWorkspace = {
	access: {
		envelopeId: 'env-1',
		recipientId: 'recipient-1',
		recipientName: 'Alex Rivera',
		role: 'approver',
		locale: 'en',
		recipientStatus: 'viewed',
		envelopeTitle: 'Agreement',
		envelopeStatus: 'in_progress',
		expiresAt: '2026-09-12T00:00:00.000Z'
	},
	documents: [{ path: 'documents/agreement.md', content: '# Agreement\n' }],
	fields: [],
	fieldGeneration: 1
};

function application(
	result: RecipientWorkspace | null = workspace
): RecipientWorkspaceApplicationPort {
	return { resolve: vi.fn(async (): Promise<RecipientWorkspace | null> => result) };
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

	it('revalidates the decrypted capability and returns the public workspace', async () => {
		const app: RecipientWorkspaceApplicationPort = application();
		const result = await resolveRecipientPage(
			{ accessHint: null, cookie: 'sealed', clearSession: vi.fn() },
			() => app,
			async (): Promise<string> => 'raw-token',
			() => new Date('2026-09-11T00:00:00.000Z')
		);

		expect(app.resolve).toHaveBeenCalledWith('raw-token', '2026-09-11T00:00:00.000Z');
		expect(result).toEqual({ state: 'active', ...workspace });
		expect(JSON.stringify(result)).not.toMatch(/organization|archive/);
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

	it('recovers a durable decline receipt without returning the document workspace', async () => {
		const clearSession = vi.fn();
		const recoverDeclined = vi.fn(async () => ({
			envelopeId: 'env-1',
			recipientId: 'recipient-1',
			recipientStatus: 'declined' as const,
			envelopeStatus: 'declined' as const,
			declinedAt: '2026-09-11T00:02:00.000Z',
			locale: 'en' as const
		}));
		const result = await resolveRecipientPage(
			{
				accessHint: null,
				cookie: 'sealed',
				clearSession,
				recoverDeclined
			},
			() => application(null),
			async (): Promise<string> => 'raw-token',
			() => new Date('2026-09-11T00:03:00.000Z')
		);

		expect(recoverDeclined).toHaveBeenCalledWith('raw-token', new Date('2026-09-11T00:03:00.000Z'));
		expect(result).toEqual({
			state: 'declined',
			envelopeId: 'env-1',
			recipientId: 'recipient-1',
			recipientStatus: 'declined',
			envelopeStatus: 'declined',
			declinedAt: '2026-09-11T00:02:00.000Z',
			locale: 'en'
		});
		expect(clearSession).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toMatch(/documents|fields|organization|archive/);
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

	it('preserves the session when cookie key configuration is unavailable', async () => {
		const clearSession = vi.fn();
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		await expect(
			resolveRecipientPage(
				{ accessHint: null, cookie: 'sealed', clearSession },
				() => application(),
				async (): Promise<string> => {
					throw new Error('configuration detail that must not be logged');
				}
			)
		).resolves.toEqual({ state: 'unavailable' });
		expect(clearSession).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(
			JSON.stringify({ event: 'recipient_page_resolution_failed' })
		);
		expect(error).not.toHaveBeenCalledWith(expect.stringContaining('configuration detail'));
		error.mockRestore();
	});

	it('emits a distinct secret-free event for workspace integrity failures', async () => {
		const clearSession = vi.fn();
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		await expect(
			resolveRecipientPage(
				{ accessHint: null, cookie: 'sealed', clearSession },
				() => ({
					resolve: async (): Promise<RecipientWorkspace> => {
						throw new RecipientWorkspaceIntegrityError();
					}
				}),
				async (): Promise<string> => 'raw-token'
			)
		).resolves.toEqual({ state: 'unavailable' });
		expect(clearSession).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(
			JSON.stringify({ event: 'recipient_page_integrity_failed' })
		);
		error.mockRestore();
	});
});

const declinedLocator: DeclinedReceiptSessionLocator = {
	version: 1,
	organizationId: '01910000-0000-7000-8000-000000000001',
	envelopeId: '01910000-0000-7000-8000-000000000002',
	recipientId: '01910000-0000-7000-8000-000000000003',
	idempotencyKey: 'decline-1',
	capabilityHash: 'a'.repeat(64),
	declinedAt: '2026-09-11T00:02:00.000Z',
	expiresAt: '2026-10-11T00:02:00.000Z'
};

function declinedReceiptApplication(): RecipientDeclinedReceiptApplicationPort {
	return {
		recoverByToken: vi.fn(),
		resolveLocator: vi.fn(async () => ({
			receipt: {
				envelopeId: declinedLocator.envelopeId,
				recipientId: declinedLocator.recipientId,
				recipientStatus: 'declined' as const,
				envelopeStatus: 'declined' as const,
				declinedAt: declinedLocator.declinedAt,
				locale: 'en' as const
			},
			locator: declinedLocator
		}))
	};
}

describe('terminal decline receipt page resolution', () => {
	it('evidence-checks the encrypted locator without returning a workspace', async () => {
		const application: RecipientDeclinedReceiptApplicationPort = declinedReceiptApplication();
		const result = await resolveDeclinedReceiptPage(
			{ cookie: 'sealed', clearSession: vi.fn() },
			() => application,
			async (): Promise<DeclinedReceiptSessionLocator> => declinedLocator,
			() => new Date('2026-09-11T00:03:00.000Z')
		);

		expect(application.resolveLocator).toHaveBeenCalledWith(
			{
				organizationId: declinedLocator.organizationId,
				envelopeId: declinedLocator.envelopeId,
				recipientId: declinedLocator.recipientId,
				idempotencyKey: declinedLocator.idempotencyKey,
				capabilityHash: declinedLocator.capabilityHash,
				declinedAt: declinedLocator.declinedAt,
				expiresAt: declinedLocator.expiresAt
			},
			new Date('2026-09-11T00:03:00.000Z')
		);
		expect(result).toMatchObject({ state: 'declined', locale: 'en' });
		expect(JSON.stringify(result)).not.toMatch(/documents|fields|organization|archive|capability/);
	});

	it.each(['unreadable', 'expired', 'unproven'] as const)(
		'clears an %s receipt cookie and fails closed',
		async (scenario) => {
			const clearSession = vi.fn();
			const application: RecipientDeclinedReceiptApplicationPort = declinedReceiptApplication();
			if (scenario === 'unproven') {
				vi.mocked(application.resolveLocator).mockResolvedValue(null);
			}
			const result = await resolveDeclinedReceiptPage(
				{ cookie: 'sealed', clearSession },
				() => application,
				async (): Promise<DeclinedReceiptSessionLocator | null> =>
					scenario === 'unreadable' ? null : declinedLocator,
				() =>
					new Date(scenario === 'expired' ? '2026-10-11T00:02:00.000Z' : '2026-09-11T00:03:00.000Z')
			);

			expect(result).toEqual({ state: 'invalid' });
			expect(clearSession).toHaveBeenCalledOnce();
		}
	);

	it('preserves the receipt cookie during a transient resolver outage', async () => {
		const clearSession = vi.fn();
		await expect(
			resolveDeclinedReceiptPage(
				{ cookie: 'sealed', clearSession },
				() => null,
				async (): Promise<DeclinedReceiptSessionLocator> => declinedLocator,
				() => new Date('2026-09-11T00:03:00.000Z')
			)
		).resolves.toEqual({ state: 'unavailable' });
		expect(clearSession).not.toHaveBeenCalled();
	});
});
