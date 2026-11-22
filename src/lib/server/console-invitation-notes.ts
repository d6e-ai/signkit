import { resolveConsoleUrl } from './console-url';
import { serverClientCredentials, type ServerClientCredentials } from './d6e-auth';

/**
 * Invitation notes for the d6e console that lists this server.
 *
 * Every invitation is delivered to D6E Auth as a note (the normalized email,
 * the expiry, the inviter's subject, and the mail language), so the console
 * lists this server for the invitee and D6E Auth emails them a link to join
 * there; revoking withdraws the note. Acceptance does not: the console's own
 * acceptance call consumes it. This server sends no invitation mail itself.
 *
 * The create command sends the note right after committing and awaits it, so
 * a revoke issued from the create response cannot be overtaken by it; a note it
 * could not deliver stays in the invitation outbox, which retries it. Only the
 * withdrawal may continue after its response (see {@link runAfterCommand}).
 * D6E Auth refuses a note for an id it has already seen withdrawn, so a late
 * note can never revive a revoked one. Failures are logged by event name and
 * status only, never with the email or credentials.
 */

const NOTE_TIMEOUT_MS: number = 5_000;
const NOTE_PATH: string = '/api/v1/console/server-invitations/';
/**
 * How long a new invitation's outbox row waits for the create command's own
 * note before the drain may retry it. Far above {@link NOTE_TIMEOUT_MS}, so the
 * create note always settles the row first unless the request dies.
 */
export const CONSOLE_NOTE_DELIVERY_HOLD_MS: number = 60_000;

const NOTE_LOCALES: Readonly<Record<'en' | 'ja', string>> = { en: 'en-US', ja: 'ja-JP' };

export interface ConsoleInvitationNote {
	invitationId: string;
	recipientEmail: string;
	expiresAt: string;
	inviterSubject: string;
	/** The invitation's language; D6E Auth writes its email in it. */
	locale: 'en' | 'ja';
}

export interface ConsoleInvitationNoteContext {
	platform?: Readonly<App.Platform>;
}

/**
 * `withdrawn`: D6E Auth already holds a withdrawal for this invitation id and
 * refused the note (409 `invitation_revoked`). That is the intended end state
 * after a revoke that overtook the note, not a failure.
 */
export type ConsoleInvitationNoteOutcome = 'sent' | 'withdrawn' | 'disabled' | 'failed';

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
	return resolveConsoleUrl(context.platform) !== null;
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
		if (method === 'PUT' && response.status === 409) return 'withdrawn';
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
				inviterSubject: note.inviterSubject,
				locale: NOTE_LOCALES[note.locale]
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
