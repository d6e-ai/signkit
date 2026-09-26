import { describe, expect, it, vi } from 'vitest';
import type { RecipientWorkspace, RecipientWorkspaceApplicationPort } from './recipient-workspace';
import type { RecipientDeclinedReceiptApplicationPort } from './recipient-declined-receipt';
import type { RecipientCompletedReceiptApplicationPort } from './recipient-completed-receipt';
import { RecipientWorkspaceIntegrityError } from './recipient-workspace';
import {
	resolveCompletedReceiptPage,
	resolveDeclinedReceiptPage,
	resolveRecipientPage
} from './recipient-page';
import type { DeclinedReceiptSessionLocator } from '$lib/server/declined-receipt-session';
import type { CompletedReceiptSessionLocator } from '$lib/server/completed-receipt-session';

const envelopeId: string = '01910000-0000-7000-8000-000000000010';
const otherEnvelopeId: string = '01910000-0000-7000-8000-000000000011';

const workspace: RecipientWorkspace = {
	access: {
		envelopeId,
		recipientId: 'recipient-1',
		recipientName: 'Alex Rivera',
		role: 'approver',
		locale: 'en',
		recipientStatus: 'viewed',
		envelopeTitle: 'Agreement',
		envelopeStatus: 'in_progress',
		expiresAt: '2026-09-12T00:00:00.000Z'
	},
	documents: [
		{
			documentId: 'legacy',
			position: 0,
			title: 'agreement',
			kind: 'legacy',
			pageCount: 2,
			pageWidth: 595.28,
			pageHeight: 841.89
		}
	],
	source: 'legacy' as const,
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
				{ accessHint: 'invalid', envelopeId, cookie: 'old' },
				() => application(),
				unseal
			)
		).resolves.toEqual({ state: 'invalid' });
		expect(unseal).not.toHaveBeenCalled();
	});

	it('fails closed on an unreadable cookie without deleting it', async () => {
		await expect(
			resolveRecipientPage(
				{ accessHint: null, envelopeId, cookie: 'bad' },
				() => application(),
				async (): Promise<null> => null
			)
		).resolves.toEqual({ state: 'invalid' });
	});

	it('revalidates the decrypted capability and returns the public workspace', async () => {
		const app: RecipientWorkspaceApplicationPort = application();
		const result = await resolveRecipientPage(
			{ accessHint: null, envelopeId, cookie: 'sealed' },
			() => app,
			async (): Promise<string> => 'raw-token',
			() => new Date('2026-09-11T00:00:00.000Z')
		);

		expect(app.resolve).toHaveBeenCalledWith('raw-token', '2026-09-11T00:00:00.000Z');
		expect(result).toEqual({ state: 'active', ...workspace });
		expect(JSON.stringify(result)).not.toMatch(/organization|archive/);
	});

	it('fails closed when durable state no longer authorizes the recipient without deleting the cookie', async () => {
		await expect(
			resolveRecipientPage(
				{ accessHint: null, envelopeId, cookie: 'sealed' },
				() => application(null),
				async (): Promise<string> => 'raw-token'
			)
		).resolves.toEqual({ state: 'invalid' });
	});

	it('recovers a durable decline receipt without returning the document workspace', async () => {
		const recoverDeclined = vi.fn(async () => ({
			envelopeId,
			recipientId: 'recipient-1',
			recipientStatus: 'declined' as const,
			envelopeStatus: 'declined' as const,
			declinedAt: '2026-09-11T00:02:00.000Z',
			locale: 'en' as const
		}));
		const result = await resolveRecipientPage(
			{
				accessHint: null,
				envelopeId,
				cookie: 'sealed',
				recoverDeclined
			},
			() => application(null),
			async (): Promise<string> => 'raw-token',
			() => new Date('2026-09-11T00:03:00.000Z')
		);

		expect(recoverDeclined).toHaveBeenCalledWith('raw-token', new Date('2026-09-11T00:03:00.000Z'));
		expect(result).toEqual({
			state: 'declined',
			envelopeId: envelopeId,
			recipientId: 'recipient-1',
			recipientStatus: 'declined',
			envelopeStatus: 'declined',
			declinedAt: '2026-09-11T00:02:00.000Z',
			locale: 'en'
		});
		expect(JSON.stringify(result)).not.toMatch(/documents|fields|organization|archive/);
	});

	it('recovers a durable completed-action receipt when the live capability is revoked', async () => {
		const recoverCompleted = vi.fn(async () => ({
			envelopeId,
			recipientId: 'recipient-1',
			recipientStatus: 'completed' as const,
			action: 'signed' as const,
			completedAt: '2026-09-11T00:02:00.000Z',
			envelopeStatus: 'in_progress' as const,
			envelopeCompletedByThisAction: false,
			locale: 'en' as const
		}));
		const result = await resolveRecipientPage(
			{
				accessHint: null,
				envelopeId,
				cookie: 'sealed',
				recoverCompleted
			},
			() => application(null),
			async (): Promise<string> => 'raw-token',
			() => new Date('2026-09-11T00:03:00.000Z')
		);

		expect(recoverCompleted).toHaveBeenCalledWith(
			'raw-token',
			new Date('2026-09-11T00:03:00.000Z')
		);
		expect(result).toEqual({
			state: 'completed',
			envelopeId,
			recipientId: 'recipient-1',
			recipientStatus: 'completed',
			action: 'signed',
			completedAt: '2026-09-11T00:02:00.000Z',
			envelopeStatus: 'in_progress',
			envelopeCompletedByThisAction: false,
			locale: 'en'
		});
		expect(JSON.stringify(result)).not.toMatch(/documents|fields|organization|archive/);
	});

	it('prefers a decline over a completion and never asks for both', async () => {
		const recoverCompleted = vi.fn();
		const result = await resolveRecipientPage(
			{
				accessHint: null,
				envelopeId,
				cookie: 'sealed',
				recoverDeclined: async () => ({
					envelopeId,
					recipientId: 'recipient-1',
					recipientStatus: 'declined' as const,
					envelopeStatus: 'declined' as const,
					declinedAt: '2026-09-11T00:02:00.000Z',
					locale: 'en' as const
				}),
				recoverCompleted
			},
			() => application(null),
			async (): Promise<string> => 'raw-token',
			() => new Date('2026-09-11T00:03:00.000Z')
		);

		expect(result).toMatchObject({ state: 'declined' });
		expect(recoverCompleted).not.toHaveBeenCalled();
	});

	it('fails closed when a recovered completion names a different envelope', async () => {
		await expect(
			resolveRecipientPage(
				{
					accessHint: null,
					envelopeId,
					cookie: 'sealed',
					recoverCompleted: async () => ({
						envelopeId: otherEnvelopeId,
						recipientId: 'recipient-1',
						recipientStatus: 'completed' as const,
						action: 'approved' as const,
						completedAt: '2026-09-11T00:02:00.000Z',
						envelopeStatus: 'completed' as const,
						envelopeCompletedByThisAction: true,
						locale: 'en' as const
					})
				},
				() => application(null),
				async (): Promise<string> => 'raw-token',
				() => new Date('2026-09-11T00:03:00.000Z')
			)
		).resolves.toEqual({ state: 'invalid' });
	});

	it('preserves the session during a transient persistence outage', async () => {
		await expect(
			resolveRecipientPage(
				{ accessHint: null, envelopeId, cookie: 'sealed' },
				() => null,
				async (): Promise<string> => 'raw-token'
			)
		).resolves.toEqual({ state: 'unavailable' });
	});

	it('preserves the session when cookie key configuration is unavailable', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		await expect(
			resolveRecipientPage(
				{ accessHint: null, envelopeId, cookie: 'sealed' },
				() => application(),
				async (): Promise<string> => {
					throw new Error('configuration detail that must not be logged');
				}
			)
		).resolves.toEqual({ state: 'unavailable' });
		expect(error).toHaveBeenCalledWith(
			JSON.stringify({ event: 'recipient_page_resolution_failed' })
		);
		expect(error).not.toHaveBeenCalledWith(expect.stringContaining('configuration detail'));
		error.mockRestore();
	});

	it('emits a distinct secret-free event for workspace integrity failures', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		await expect(
			resolveRecipientPage(
				{ accessHint: null, envelopeId, cookie: 'sealed' },
				() => ({
					resolve: async (): Promise<RecipientWorkspace> => {
						throw new RecipientWorkspaceIntegrityError();
					}
				}),
				async (): Promise<string> => 'raw-token'
			)
		).resolves.toEqual({ state: 'unavailable' });
		expect(error).toHaveBeenCalledWith(
			JSON.stringify({ event: 'recipient_page_integrity_failed' })
		);
		error.mockRestore();
	});

	it('fails closed when the workspace envelope ID does not match the path without deleting the cookie', async () => {
		await expect(
			resolveRecipientPage(
				{ accessHint: null, envelopeId: otherEnvelopeId, cookie: 'sealed' },
				() => application(),
				async (): Promise<string> => 'raw-token'
			)
		).resolves.toEqual({ state: 'invalid' });
	});
});

const declinedLocator: DeclinedReceiptSessionLocator = {
	version: 1,
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
			{ envelopeId: declinedLocator.envelopeId, cookie: 'sealed' },
			() => application,
			async (): Promise<DeclinedReceiptSessionLocator> => declinedLocator,
			() => new Date('2026-09-11T00:03:00.000Z')
		);

		expect(application.resolveLocator).toHaveBeenCalledWith(
			{
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
		'fails closed on an %s receipt cookie without deleting it',
		async (scenario) => {
			const application: RecipientDeclinedReceiptApplicationPort = declinedReceiptApplication();
			if (scenario === 'unproven') {
				vi.mocked(application.resolveLocator).mockResolvedValue(null);
			}
			const result = await resolveDeclinedReceiptPage(
				{ envelopeId: declinedLocator.envelopeId, cookie: 'sealed' },
				() => application,
				async (): Promise<DeclinedReceiptSessionLocator | null> =>
					scenario === 'unreadable' ? null : declinedLocator,
				() =>
					new Date(scenario === 'expired' ? '2026-10-11T00:02:00.000Z' : '2026-09-11T00:03:00.000Z')
			);

			expect(result).toEqual({ state: 'invalid' });
		}
	);

	it('preserves the receipt cookie during a transient resolver outage', async () => {
		await expect(
			resolveDeclinedReceiptPage(
				{ envelopeId: declinedLocator.envelopeId, cookie: 'sealed' },
				() => null,
				async (): Promise<DeclinedReceiptSessionLocator> => declinedLocator,
				() => new Date('2026-09-11T00:03:00.000Z')
			)
		).resolves.toEqual({ state: 'unavailable' });
	});

	it('fails closed when the receipt locator envelope does not match the path without deleting the cookie', async () => {
		await expect(
			resolveDeclinedReceiptPage(
				{ envelopeId: '01910000-0000-7000-8000-000000000099', cookie: 'sealed' },
				() => declinedReceiptApplication(),
				async (): Promise<DeclinedReceiptSessionLocator> => declinedLocator,
				() => new Date('2026-09-11T00:03:00.000Z')
			)
		).resolves.toEqual({ state: 'invalid' });
	});
});

const completedLocator: CompletedReceiptSessionLocator = {
	version: 1,
	envelopeId: '01910000-0000-7000-8000-000000000002',
	recipientId: '01910000-0000-7000-8000-000000000003',
	idempotencyKey: 'sign-1',
	capabilityHash: 'a'.repeat(64),
	action: 'signed',
	completedAt: '2026-09-11T00:02:00.000Z',
	expiresAt: '2026-10-11T00:02:00.000Z'
};

function completedReceiptApplication(): RecipientCompletedReceiptApplicationPort {
	return {
		recoverByToken: vi.fn(),
		resolveLocator: vi.fn(async () => ({
			receipt: {
				envelopeId: completedLocator.envelopeId,
				recipientId: completedLocator.recipientId,
				recipientStatus: 'completed' as const,
				action: completedLocator.action,
				completedAt: completedLocator.completedAt,
				envelopeStatus: 'completed' as const,
				envelopeCompletedByThisAction: true,
				locale: 'en' as const
			},
			locator: completedLocator
		}))
	};
}

describe('terminal completed-action receipt page resolution', () => {
	it('re-proves the encrypted locator on every load without returning a workspace', async () => {
		const application: RecipientCompletedReceiptApplicationPort = completedReceiptApplication();
		const result = await resolveCompletedReceiptPage(
			{ envelopeId: completedLocator.envelopeId, cookie: 'sealed' },
			() => application,
			async (): Promise<CompletedReceiptSessionLocator> => completedLocator,
			() => new Date('2026-09-11T00:03:00.000Z')
		);

		expect(application.resolveLocator).toHaveBeenCalledWith(
			{
				envelopeId: completedLocator.envelopeId,
				recipientId: completedLocator.recipientId,
				idempotencyKey: completedLocator.idempotencyKey,
				capabilityHash: completedLocator.capabilityHash,
				action: completedLocator.action,
				completedAt: completedLocator.completedAt,
				expiresAt: completedLocator.expiresAt
			},
			new Date('2026-09-11T00:03:00.000Z')
		);
		expect(result).toMatchObject({
			state: 'completed',
			action: 'signed',
			envelopeStatus: 'completed',
			envelopeCompletedByThisAction: true,
			locale: 'en'
		});
		expect(JSON.stringify(result)).not.toMatch(/documents|fields|organization|archive|capability/);
	});

	it.each(['missing', 'unreadable', 'expired', 'unproven'] as const)(
		'fails closed on an %s receipt cookie without deleting it',
		async (scenario) => {
			const application: RecipientCompletedReceiptApplicationPort = completedReceiptApplication();
			if (scenario === 'unproven') {
				vi.mocked(application.resolveLocator).mockResolvedValue(null);
			}
			const result = await resolveCompletedReceiptPage(
				{
					envelopeId: completedLocator.envelopeId,
					cookie: scenario === 'missing' ? null : 'sealed'
				},
				() => application,
				async (): Promise<CompletedReceiptSessionLocator | null> =>
					scenario === 'unreadable' ? null : completedLocator,
				() =>
					new Date(scenario === 'expired' ? '2026-10-11T00:02:00.000Z' : '2026-09-11T00:03:00.000Z')
			);

			expect(result).toEqual({ state: 'invalid' });
		}
	);

	it('preserves the receipt cookie during a transient resolver outage', async () => {
		await expect(
			resolveCompletedReceiptPage(
				{ envelopeId: completedLocator.envelopeId, cookie: 'sealed' },
				() => null,
				async (): Promise<CompletedReceiptSessionLocator> => completedLocator,
				() => new Date('2026-09-11T00:03:00.000Z')
			)
		).resolves.toEqual({ state: 'unavailable' });
	});

	it('reports a secret-free event and stays unavailable when unsealing throws', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		await expect(
			resolveCompletedReceiptPage(
				{ envelopeId: completedLocator.envelopeId, cookie: 'sealed' },
				() => completedReceiptApplication(),
				async (): Promise<CompletedReceiptSessionLocator> => {
					throw new Error('SESSION_ENCRYPTION_KEY is not set');
				},
				() => new Date('2026-09-11T00:03:00.000Z')
			)
		).resolves.toEqual({ state: 'unavailable' });
		expect(error).toHaveBeenCalledWith(
			JSON.stringify({ event: 'recipient_completed_receipt_page_resolution_failed' })
		);
		expect(error).not.toHaveBeenCalledWith(expect.stringContaining('SESSION_ENCRYPTION_KEY'));
		error.mockRestore();
	});

	it('fails closed when the receipt locator envelope does not match the path', async () => {
		await expect(
			resolveCompletedReceiptPage(
				{ envelopeId: '01910000-0000-7000-8000-000000000099', cookie: 'sealed' },
				() => completedReceiptApplication(),
				async (): Promise<CompletedReceiptSessionLocator> => completedLocator,
				() => new Date('2026-09-11T00:03:00.000Z')
			)
		).resolves.toEqual({ state: 'invalid' });
	});
});
