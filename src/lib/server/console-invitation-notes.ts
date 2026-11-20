import { env } from '$env/dynamic/private';
import { parseInstanceInvitationConsoleUrl } from '$lib/application/instance-invitations/instance-invitation-delivery-service';
import { serverClientCredentials, type ServerClientCredentials } from './d6e-auth';

/**
 * Invitation notes for a console that lists this server.
 *
 * When `SIGNKIT_CONSOLE_URL` is configured, this server is listed in a d6e
 * console. Creating an invitation then tells D6E Auth who was invited (the
 * normalized email, the expiry, and the inviter's subject), so the console can
 * show this server to the invitee before they join; revoking withdraws the
 * note. Acceptance does not: the console's own acceptance call consumes it.
 *
 * Notes are best effort and run after the invitation command has committed.
 * A failure is logged by event name and status only, never with the email or
 * credentials, and never changes the command's response. The create note is
 * awaited before the create response so a revoke issued from that response
 * cannot be overtaken by it; only the withdrawal may continue after its
 * response (see {@link runAfterCommand}).
 */

const NOTE_TIMEOUT_MS: number = 5_000;
const NOTE_PATH: string = '/api/v1/console/server-invitations/';

export interface ConsoleInvitationNote {
	invitationId: string;
	recipientEmail: string;
	expiresAt: string;
	inviterSubject: string;
}

export interface ConsoleInvitationNoteContext {
	platform?: Readonly<App.Platform>;
}

export type ConsoleInvitationNoteOutcome = 'sent' | 'disabled' | 'failed';

export interface ConsoleInvitationNotesPort {
	note(
		note: ConsoleInvitationNote,
		context: ConsoleInvitationNoteContext
	): Promise<ConsoleInvitationNoteOutcome>;
	forget(
		invitationId: string,
		context: ConsoleInvitationNoteContext
	): Promise<ConsoleInvitationNoteOutcome>;
}

function consoleConfigured(context: ConsoleInvitationNoteContext): boolean {
	const raw: string | undefined =
		context.platform?.env?.SIGNKIT_CONSOLE_URL ?? env.SIGNKIT_CONSOLE_URL;
	const trimmed: string = raw?.trim() ?? '';
	return trimmed.length > 0 && parseInstanceInvitationConsoleUrl(trimmed) !== null;
}

function basicAuthorization(credentials: ServerClientCredentials): string {
	const bytes: Uint8Array = new TextEncoder().encode(
		`${credentials.clientId}:${credentials.clientSecret}`
	);
	let binary: string = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `Basic ${btoa(binary)}`;
}

async function send(
	method: 'PUT' | 'DELETE',
	invitationId: string,
	body: string | undefined,
	context: ConsoleInvitationNoteContext,
	event: string
): Promise<ConsoleInvitationNoteOutcome> {
	if (!consoleConfigured(context)) return 'disabled';
	const credentials: ServerClientCredentials | null = serverClientCredentials();
	if (credentials === null) return 'disabled';
	try {
		const response: Response = await fetch(
			`${credentials.baseUrl}${NOTE_PATH}${encodeURIComponent(invitationId)}`,
			{
				method,
				headers: {
					authorization: basicAuthorization(credentials),
					accept: 'application/json',
					...(body === undefined ? {} : { 'content-type': 'application/json' })
				},
				...(body === undefined ? {} : { body }),
				// The client secret must never follow a redirect elsewhere.
				redirect: 'error',
				signal: AbortSignal.timeout(NOTE_TIMEOUT_MS)
			}
		);
		await response.body?.cancel().catch((): void => undefined);
		if (response.ok) return 'sent';
		console.warn(JSON.stringify({ event, status: response.status }));
		return 'failed';
	} catch (error: unknown) {
		console.warn(
			JSON.stringify({ event, reason: error instanceof Error ? error.name : 'unknown_error' })
		);
		return 'failed';
	}
}

export const consoleInvitationNotes: ConsoleInvitationNotesPort = {
	async note(note, context) {
		return await send(
			'PUT',
			note.invitationId,
			JSON.stringify({
				recipientEmail: note.recipientEmail,
				expiresAt: note.expiresAt,
				inviterSubject: note.inviterSubject
			}),
			context,
			'console_invitation_note_failed'
		);
	},
	async forget(invitationId, context) {
		return await send(
			'DELETE',
			invitationId,
			undefined,
			context,
			'console_invitation_note_withdraw_failed'
		);
	}
};

/**
 * Runs a best-effort follow-up without failing or delaying the response more
 * than necessary: on Workers it continues after the response through
 * `waitUntil`; elsewhere it is awaited (bounded by the request timeout).
 */
export async function runAfterCommand(
	platform: Readonly<App.Platform> | undefined,
	task: () => Promise<unknown>
): Promise<void> {
	const settled: Promise<void> = task().then(
		(): void => undefined,
		(): void => undefined
	);
	const waitUntil = platform?.context?.waitUntil;
	if (waitUntil !== undefined) {
		waitUntil.call(platform?.context, settled);
		return;
	}
	await settled;
}
