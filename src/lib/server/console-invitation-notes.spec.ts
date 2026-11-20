import { afterEach, describe, expect, it, vi } from 'vitest';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import { consoleInvitationNotes, runAfterCommand } from './console-invitation-notes';

const INVITATION_ID: string = '01900000-0000-7000-8000-000000000001';
const NOTE = {
	invitationId: INVITATION_ID,
	recipientEmail: 'invitee@example.com',
	expiresAt: '2026-09-19T12:00:00.000Z',
	inviterSubject: '0190aaaa-0000-7000-8000-000000000001'
};

function configure(overrides: Record<string, string | undefined> = {}): void {
	Object.assign(privateEnv, {
		D6E_AUTH_BASE_URL: 'https://auth.example.com',
		D6E_AUTH_CLIENT_ID: 'd6e_client',
		D6E_AUTH_CLIENT_SECRET: 'd6es_secret',
		SIGNKIT_CONSOLE_URL: 'https://auth.example.com/signkit/console',
		...overrides
	});
}

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('consoleInvitationNotes', () => {
	it('does nothing unless a console URL and the server client are configured', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		expect(await consoleInvitationNotes.note(NOTE, {})).toBe('disabled');
		configure({ SIGNKIT_CONSOLE_URL: undefined });
		expect(await consoleInvitationNotes.note(NOTE, {})).toBe('disabled');
		configure({ SIGNKIT_CONSOLE_URL: 'http://console.example.com/' });
		expect(await consoleInvitationNotes.note(NOTE, {})).toBe('disabled');
		configure({ D6E_AUTH_CLIENT_SECRET: undefined });
		expect(await consoleInvitationNotes.forget(INVITATION_ID, {})).toBe('disabled');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('reads the console URL from the Worker environment first', async () => {
		configure({ SIGNKIT_CONSOLE_URL: undefined });
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const platform = {
			env: { SIGNKIT_CONSOLE_URL: 'https://auth.example.com/signkit/console' }
		} as unknown as App.Platform;
		expect(await consoleInvitationNotes.note(NOTE, { platform })).toBe('sent');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('PUTs the note as this server client, without following redirects', async () => {
		configure();
		const fetchMock = vi.fn(async () => new Response('{"noted":true}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		expect(await consoleInvitationNotes.note(NOTE, {})).toBe('sent');
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`https://auth.example.com/api/v1/console/server-invitations/${INVITATION_ID}`);
		expect(init.method).toBe('PUT');
		expect(init.redirect).toBe('error');
		const headers = new Headers(init.headers);
		expect(headers.get('authorization')).toBe(`Basic ${btoa('d6e_client:d6es_secret')}`);
		expect(headers.get('content-type')).toBe('application/json');
		expect(JSON.parse(init.body as string)).toEqual({
			recipientEmail: NOTE.recipientEmail,
			expiresAt: NOTE.expiresAt,
			inviterSubject: NOTE.inviterSubject
		});
	});

	it('DELETEs the note on withdraw', async () => {
		configure();
		const fetchMock = vi.fn(async () => new Response('{"removed":true}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		expect(await consoleInvitationNotes.forget(INVITATION_ID, {})).toBe('sent');
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`https://auth.example.com/api/v1/console/server-invitations/${INVITATION_ID}`);
		expect(init.method).toBe('DELETE');
		expect(init.body).toBeUndefined();
	});

	it('treats a note refused for an already withdrawn invitation as withdrawn, not failed', async () => {
		configure();
		const warn = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{"error":"invitation_revoked"}', { status: 409 }))
		);
		expect(await consoleInvitationNotes.note(NOTE, {})).toBe('withdrawn');
		expect(warn).not.toHaveBeenCalled();
	});

	it('reports a rejected or unreachable D6E Auth as failed, logging neither email nor secret', async () => {
		configure();
		const warn = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{"error":"invalid_client"}', { status: 401 }))
		);
		expect(await consoleInvitationNotes.note(NOTE, {})).toBe('failed');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('fetch failed for invitee@example.com d6es_secret');
			})
		);
		expect(await consoleInvitationNotes.note(NOTE, {})).toBe('failed');
		const logged: string = JSON.stringify(warn.mock.calls);
		expect(logged).toContain('console_invitation_note_failed');
		expect(logged).toContain('401');
		expect(logged).not.toContain('invitee@example.com');
		expect(logged).not.toContain('d6es_secret');
	});
});

describe('runAfterCommand', () => {
	it('hands the task to waitUntil on Workers and swallows its failure', async () => {
		const waitUntil = vi.fn();
		await runAfterCommand({ context: { waitUntil } } as unknown as App.Platform, async () => {
			throw new Error('boom');
		});
		expect(waitUntil).toHaveBeenCalledTimes(1);
		await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
	});

	it('awaits the task elsewhere and swallows its failure', async () => {
		let ran: boolean = false;
		await runAfterCommand(undefined, async () => {
			ran = true;
			throw new Error('boom');
		});
		expect(ran).toBe(true);
	});
});
