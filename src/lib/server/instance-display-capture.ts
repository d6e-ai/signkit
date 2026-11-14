import { resolveInstanceDisplayApplication } from '$lib/application/instance-display/instance-display-runtime';
import type { VerifiedPrincipal } from './d6e-auth';
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS, seal, unseal, type Session } from './session';

export const INSTANCE_DISPLAY_CAPTURE_FAILED_CODE: string = 'instance_display_capture_failed';

interface CaptureCookies {
	get(name: string): string | undefined;
	set(
		name: string,
		value: string,
		opts: Omit<typeof SESSION_COOKIE_OPTIONS, 'secure'> & { secure: boolean }
	): void;
}

export interface CaptureMemberDisplayRequest {
	cookies?: CaptureCookies;
	url?: URL;
	platform?: Readonly<App.Platform>;
	session?: Session;
	memberUserId: string;
	principal: VerifiedPrincipal;
}

/**
 * Best-effort member snapshot capture. Never throws. Never fails authentication
 * or membership. Logs only a fixed redacted code.
 */
export async function bestEffortCaptureMemberDisplay(
	input: CaptureMemberDisplayRequest
): Promise<Session | null> {
	try {
		return await capture(input);
	} catch {
		logCaptureFailed();
		return input.session ?? null;
	}
}

async function capture(input: CaptureMemberDisplayRequest): Promise<Session | null> {
	if (input.cookies === undefined) return input.session ?? null;
	if (input.principal.subject !== input.memberUserId) return input.session ?? null;
	if (input.principal.emailVerified !== true) return input.session ?? null;

	let session: Session | null = input.session ?? null;
	if (session === null) {
		const cookie: string | undefined = input.cookies.get(SESSION_COOKIE);
		if (cookie === undefined) return null;
		const unsealed = await unseal(cookie);
		if (unsealed === null) return null;
		session = unsealed.session;
	}

	const observedAt: string | undefined = session.profileObservedAt;
	if (observedAt === undefined) return session;
	if (session.profileStoredAt === observedAt) return session;

	const application = await resolveInstanceDisplayApplication({ platform: input.platform });
	if (application === null) return session;

	const storedAt: string = new Date().toISOString();
	const result = await application.captureMemberSnapshot({
		userId: input.memberUserId,
		name: input.principal.name,
		email: input.principal.email,
		observedAt,
		storedAt
	});
	if (result.outcome === 'failed') {
		logCaptureFailed();
		return session;
	}
	if (result.outcome === 'skipped') return session;

	const updated: Session = { ...session, profileStoredAt: observedAt };
	const sealed: string = await seal(updated);
	input.cookies.set(SESSION_COOKIE, sealed, {
		...SESSION_COOKIE_OPTIONS,
		secure: input.url?.protocol !== 'http:'
	});
	return updated;
}

function logCaptureFailed(): void {
	console.error(
		JSON.stringify({
			event: INSTANCE_DISPLAY_CAPTURE_FAILED_CODE,
			code: INSTANCE_DISPLAY_CAPTURE_FAILED_CODE
		})
	);
}
