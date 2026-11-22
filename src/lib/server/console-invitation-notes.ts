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
 * response (see {@link runAfterCommand}). D6E Auth refuses a note for an id it
 * has already seen withdrawn, so a late note can never revive a revoked one.
 *
 * D6E Auth emails the invitee a console link the first time it stores a note
 * for an invitation and address, and says so with `invitationEmail: "queued"`
 * in the note's answer. The create command holds its own invitation mail
 * briefly so the answer can decide: `queued` hands delivery to D6E Auth, and
 * anything else (`skipped`, no field from an older D6E Auth, a failed note)
 * releases this server's mail at once. A crash before the decision only lets
 * the hold lapse, so the invitee still gets this server's mail.
 */

const NOTE_TIMEOUT_MS: number = 5_000;
const NOTE_PATH: string = '/api/v1/console/server-invitations/';
/** Largest note answer read for `invitationEmail`; anything longer is ignored. */
const MAX_NOTE_ANSWER_BYTES: number = 4_096;

/**
 * How long a new invitation's own mail waits for the note's answer. Far above
 * {@link NOTE_TIMEOUT_MS}, so the answer always arrives first unless the
 * request dies, and short enough that the mail still goes out promptly then.
 */
export const CONSOLE_NOTE_DELIVERY_HOLD_MS: number = 60_000;

const NOTE_LOCALES: Readonly<Record<'en' | 'ja', string>> = { en: 'en-US', ja: 'ja-JP' };

export interface ConsoleInvitationNote {
	invitationId: string;
	recipientEmail: string;
	expiresAt: string;
	inviterSubject: string;
	/** The invitation mail's language; D6E Auth writes its own email in it. */
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

/**
 * D6E Auth's word on emailing the invitee for this note: `queued` when it
 * sends the invitation email, `skipped` when it does not (a repeated note, or
 * a rate limit), `null` when the answer named neither (an older D6E Auth, or
 * no answer at all).
 */
export type ConsoleInvitationEmail = 'queued' | 'skipped' | null;

export interface ConsoleInvitationNoteResult {
	outcome: ConsoleInvitationNoteOutcome;
	invitationEmail: ConsoleInvitationEmail;
}

export interface ConsoleInvitationNotesPort {
	/** Whether notes are sent at all: a valid console URL and client credentials. */
	enabled(context: ConsoleInvitationNoteContext): boolean;
	note(
		note: ConsoleInvitationNote,
		context: ConsoleInvitationNoteContext
	): Promise<ConsoleInvitationNoteResult>;
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

function notesEnabled(context: ConsoleInvitationNoteContext): boolean {
	return consoleConfigured(context) && serverClientCredentials() !== null;
}

/**
 * Reads `invitationEmail` from a successful note answer. Any other shape, an
 * oversized or unreadable body, or invalid JSON reads as `null`, which keeps
 * this server's own mail: the safe side, since it never leaves the invitee
 * without an email.
 */
async function readInvitationEmail(response: Response): Promise<ConsoleInvitationEmail> {
	if (response.body === null) return null;
	const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total: number = 0;
	try {
		while (true) {
			const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
			if (chunk.done) break;
			total += chunk.value.byteLength;
			if (total > MAX_NOTE_ANSWER_BYTES) {
				await reader.cancel().catch((): void => undefined);
				return null;
			}
			chunks.push(chunk.value);
		}
	} catch {
		return null;
	}
	const bytes: Uint8Array = new Uint8Array(total);
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		if (typeof parsed !== 'object' || parsed === null) return null;
		const value: unknown = (parsed as { invitationEmail?: unknown }).invitationEmail;
		return value === 'queued' || value === 'skipped' ? value : null;
	} catch {
		return null;
	}
}

async function send(
	method: 'PUT' | 'DELETE',
	invitationId: string,
	body: string | undefined,
	context: ConsoleInvitationNoteContext,
	event: string
): Promise<ConsoleInvitationNoteResult> {
	const none = (outcome: ConsoleInvitationNoteOutcome): ConsoleInvitationNoteResult => ({
		outcome,
		invitationEmail: null
	});
	if (!consoleConfigured(context)) return none('disabled');
	const credentials: ServerClientCredentials | null = serverClientCredentials();
	if (credentials === null) return none('disabled');
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
		if (response.ok) {
			return {
				outcome: 'sent',
				invitationEmail: method === 'PUT' ? await readInvitationEmail(response) : null
			};
		}
		await response.body?.cancel().catch((): void => undefined);
		if (method === 'PUT' && response.status === 409) return none('withdrawn');
		console.warn(JSON.stringify({ event, status: response.status }));
		return none('failed');
	} catch (error: unknown) {
		console.warn(
			JSON.stringify({ event, reason: error instanceof Error ? error.name : 'unknown_error' })
		);
		return none('failed');
	}
}

export const consoleInvitationNotes: ConsoleInvitationNotesPort = {
	enabled(context) {
		return notesEnabled(context);
	},
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
		const result: ConsoleInvitationNoteResult = await send(
			'DELETE',
			invitationId,
			undefined,
			context,
			'console_invitation_note_withdraw_failed'
		);
		return result.outcome;
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
