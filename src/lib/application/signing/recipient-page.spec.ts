import { describe, expect, it, vi } from 'vitest';
import type { RecipientWorkspace, RecipientWorkspaceApplicationPort } from './recipient-workspace';
import { RecipientWorkspaceIntegrityError } from './recipient-workspace';
import { resolveRecipientPage } from './recipient-page';

const workspace: RecipientWorkspace = {
	access: {
		envelopeId: 'env-1',
		recipientId: 'recipient-1',
		role: 'approver',
		locale: 'en',
		recipientStatus: 'viewed',
		envelopeTitle: 'Agreement',
		envelopeStatus: 'in_progress',
		expiresAt: '2026-09-12T00:00:00.000Z'
	},
	documents: [{ path: 'documents/agreement.md', content: '# Agreement\n' }]
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
		expect(JSON.stringify(result)).not.toMatch(/organization|archive|recipientName/);
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
