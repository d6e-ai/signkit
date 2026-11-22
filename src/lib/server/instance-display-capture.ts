import { resolveInstanceDisplayApplication } from '$lib/application/instance-display/instance-display-runtime';
import type { VerifiedPrincipal } from './d6e-auth';

export const INSTANCE_DISPLAY_CAPTURE_FAILED_CODE: string = 'instance_display_capture_failed';

export interface CaptureMemberDisplayRequest {
	platform?: Readonly<App.Platform>;
	/**
	 * The profile observation of the verified d6e-auth access token (its
	 * `iat`). Without one there is nothing to capture.
	 */
	accessTokenObservedAt?: string;
	memberUserId: string;
	principal: VerifiedPrincipal;
}

/**
 * Where an immediate capture (bootstrap, invitation acceptance) takes its
 * profile observation from: the verified access-token bearer. Any other
 * request (an API key, a failed or absent token) supplies none.
 */
export function displayCaptureSource(
	locals: App.Locals
): Pick<CaptureMemberDisplayRequest, 'accessTokenObservedAt'> {
	const accessToken: App.Locals['accessTokenAuthentication'] = locals.accessTokenAuthentication;
	if (accessToken.state === 'verified' && accessToken.observedAt !== null) {
		return { accessTokenObservedAt: accessToken.observedAt };
	}
	return {};
}

/**
 * Best-effort member snapshot capture from the member's own verified token
 * claims. Never throws, never fails authentication or membership, and logs only
 * a fixed redacted code. There is no per-observation marker to suppress
 * repeats, so callers limit how often this runs; the store already ignores an
 * observation not newer than the stored one.
 */
export async function bestEffortCaptureMemberDisplay(
	input: CaptureMemberDisplayRequest
): Promise<void> {
	try {
		await capture(input);
	} catch {
		logCaptureFailed();
	}
}

async function capture(input: CaptureMemberDisplayRequest): Promise<void> {
	const observedAt: string | undefined = input.accessTokenObservedAt;
	if (observedAt === undefined) return;
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
