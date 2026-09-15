/**
 * Deploy-time bootstrap protection.
 *
 * Uninitialized instances fail closed: `POST /api/v1/instance/bootstrap`
 * claims the sole `owner` slot only when either
 *
 * (a) `SIGNKIT_BOOTSTRAP_OWNER_EMAIL` is configured and exactly matches the
 *     caller's verified d6e-auth email (compared case-insensitively after
 *     trimming), or
 * (b) the explicit local-development-only opt-in
 *     `SIGNKIT_ALLOW_UNSAFE_FIRST_USER_BOOTSTRAP=true` is set *and* the
 *     instance is actually running in local development.
 *
 * "Local development" is deliberately narrow and follows the existing
 * runtime/profile conventions (see `docs/architecture/deployment-and-risks.md`
 * § Primary risks): the request is not served by Cloudflare Workers (no
 * `platform.env`, which also covers `wrangler dev`), not served by Vercel
 * (no `VERCEL` indicator in process env), and the configured
 * `SIGNKIT_PUBLIC_ORIGIN` names a loopback host (`localhost`, `127.0.0.1`,
 * `::1`) — the same loopback exception the d6e-auth base-URL validation and
 * the recipient-link Secure-cookie handling already use. A `true` unsafe flag
 * outside that environment is ignored: the gate still returns
 * `owner_required`, so a flag accidentally left on in Node production,
 * Cloudflare Workers, or Vercel can never reopen the first-user-wins race.
 *
 * The expected email is plain deployment configuration, not a secret, but it
 * is still never echoed back: both refusal results carry generic problem
 * details, and callers must not log the configured value. The gate stops
 * mattering the moment the instance is claimed since bootstrap never runs
 * again — already-bootstrapped instances are unaffected.
 */

export const BOOTSTRAP_OWNER_EMAIL_ENV_VAR = 'SIGNKIT_BOOTSTRAP_OWNER_EMAIL' as const;

export const UNSAFE_BOOTSTRAP_ENV_VAR = 'SIGNKIT_ALLOW_UNSAFE_FIRST_USER_BOOTSTRAP' as const;

export const PUBLIC_ORIGIN_ENV_VAR = 'SIGNKIT_PUBLIC_ORIGIN' as const;

export type BootstrapOwnerGateResult = 'allowed' | 'owner_mismatch' | 'owner_required';

export interface BootstrapOwnerGateInput {
	readonly configuredEmail: string | undefined;
	readonly actorEmail: string;
	/** Whether the unsafe opt-in flag is set to exactly `true`. */
	readonly unsafeOptIn?: boolean;
	/**
	 * Whether this process is running in local development per
	 * {@link isLocalDevelopmentBootstrapEnvironment}. The unsafe opt-in is
	 * honored only when this is `true`; otherwise it is ignored.
	 */
	readonly localDevelopment?: boolean;
}

export function resolveBootstrapOwnerGate({
	configuredEmail,
	actorEmail,
	unsafeOptIn = false,
	localDevelopment = false
}: BootstrapOwnerGateInput): BootstrapOwnerGateResult {
	const expected: string | undefined = normalizeEmail(configuredEmail);
	if (expected !== undefined) {
		return normalizeEmail(actorEmail) === expected ? 'allowed' : 'owner_mismatch';
	}
	if (unsafeOptIn && localDevelopment) return 'allowed';
	return 'owner_required';
}

/** The unsafe flag opts in only on exactly `true` after trimming. */
export function isUnsafeBootstrapOptIn(value: string | undefined): boolean {
	return value !== undefined && value.trim() === 'true';
}

export interface BootstrapEnvironmentInput {
	/** True when running on Cloudflare Workers (platform env present, including `wrangler dev`). */
	readonly hasPlatformEnv: boolean;
	/** Raw `VERCEL` process-env indicator, if any. */
	readonly vercelIndicator?: string;
	/** Raw configured `SIGNKIT_PUBLIC_ORIGIN`, if any. */
	readonly publicOrigin?: string;
}

/**
 * Narrow local-development check for the unsafe bootstrap opt-in. All three
 * must hold: not Cloudflare Workers, not Vercel, and a loopback public
 * origin. Anything else — Node production, Cloudflare, Vercel, or a missing
 * or non-loopback origin — returns `false` so the unsafe flag is ignored.
 */
export function isLocalDevelopmentBootstrapEnvironment({
	hasPlatformEnv,
	vercelIndicator,
	publicOrigin
}: BootstrapEnvironmentInput): boolean {
	if (hasPlatformEnv) return false;
	if (isVercelEnvironment(vercelIndicator)) return false;
	return isLoopbackOrigin(publicOrigin);
}

function isVercelEnvironment(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized: string = value.trim().toLowerCase();
	return normalized === '1' || normalized === 'true';
}

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackOrigin(value: string | undefined): boolean {
	if (value === undefined) return false;
	const trimmed: string = value.trim();
	if (trimmed.length === 0) return false;
	let hostname: string;
	try {
		hostname = new URL(trimmed).hostname.toLowerCase();
	} catch {
		return false;
	}
	// URL normalizes `[::1]` to `::1`.
	return LOOPBACK_HOSTNAMES.has(hostname);
}

function normalizeEmail(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed: string = value.trim();
	return trimmed.length === 0 ? undefined : trimmed.toLowerCase();
}
