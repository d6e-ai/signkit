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
	/**
	 * The profile observation of a verified d6e-auth access-token bearer (its
	 * `iat`). When set, the observation comes from the token, the cookie jar is
	 * neither read nor written, and nothing is returned: a bearer request has no
	 * session to update.
	 */
	accessTokenObservedAt?: string;
	memberUserId: string;
	principal: VerifiedPrincipal;
}

/**
 * Where an immediate capture (bootstrap, invitation acceptance) takes its
 * profile observation from: the verified access-token bearer when the request
 * is in that mode, otherwise the operator cookie session. A bearer request never
 * hands over the cookie jar, so a cookie that happens to accompany it can
 * neither supply the observation nor receive the stored marker.
 */
export function displayCaptureSource(
	locals: App.Locals,
	cookies: CaptureCookies
): Pick<CaptureMemberDisplayRequest, 'cookies' | 'accessTokenObservedAt'> {
	const accessToken: App.Locals['accessTokenAuthentication'] = locals.accessTokenAuthentication;
	if (accessToken.state === 'absent') return { cookies };
	if (accessToken.state === 'verified' && accessToken.observedAt !== null) {
		return { accessTokenObservedAt: accessToken.observedAt };
	}
	return {};
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
	if (input.accessTokenObservedAt !== undefined) {
		await captureAccessTokenObservation(input, input.accessTokenObservedAt);
		return null;
	}
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

/**
 * Captures from a verified access-token bearer. The same guards as the cookie
 * path apply -- only the member's own verified claims -- but there is no
 * per-observation marker to suppress repeats, so callers limit how often this
 * runs; the store already ignores an observation not newer than the stored one.
 */
async function captureAccessTokenObservation(
	input: CaptureMemberDisplayRequest,
	observedAt: string
): Promise<void> {
	if (input.principal.subject !== input.memberUserId) return;
	if (input.principal.emailVerified !== true) return;
	const application = await resolveInstanceDisplayApplication({ platform: input.platform });
	if (application === null) return;
	const result = await application.captureMemberSnapshot({
		userId: input.memberUserId,
		name: input.principal.name,
		email: input.principal.email,
		observedAt,
		storedAt: new Date().toISOString()
	});
	if (result.outcome === 'failed') logCaptureFailed();
}

function logCaptureFailed(): void {
	console.error(
		JSON.stringify({
			event: INSTANCE_DISPLAY_CAPTURE_FAILED_CODE,
			code: INSTANCE_DISPLAY_CAPTURE_FAILED_CODE
		})
	);
}
