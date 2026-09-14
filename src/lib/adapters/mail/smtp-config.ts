const MIN_PORT: number = 1;
const MAX_PORT: number = 65535;

export interface SmtpAuth {
	readonly user: string;
	readonly pass: string;
}

/**
 * `secure: true` opens the connection already inside TLS (implicit TLS, the
 * classic port-465 mode). `secure: false` pairs with a hardcoded
 * `requireTLS: true` in the adapter so the client still refuses to hand off
 * a message unless the server accepts a STARTTLS upgrade first — there is no
 * configuration path that leaves a connection able to send in plaintext.
 */
export interface SmtpConfig {
	readonly host: string;
	readonly port: number;
	readonly secure: boolean;
	readonly auth?: SmtpAuth;
}

export interface SmtpConfigEnv {
	[key: string]: string | undefined;
	SIGNKIT_SMTP_HOST?: string;
	SIGNKIT_SMTP_PORT?: string;
	SIGNKIT_SMTP_SECURE?: string;
	SIGNKIT_SMTP_USERNAME?: string;
	SIGNKIT_SMTP_PASSWORD?: string;
}

/**
 * Returns `null` on any missing or malformed field rather than guessing a
 * default host, port, or auth pairing — an ambiguous SMTP configuration must
 * fail closed instead of silently sending through an unintended relay.
 */
export function parseSmtpConfig(env: SmtpConfigEnv): SmtpConfig | null {
	const host: string | undefined = nonempty(env.SIGNKIT_SMTP_HOST);
	if (host === undefined) return null;
	const port: number | null = parsePort(env.SIGNKIT_SMTP_PORT);
	if (port === null) return null;
	const secure: boolean | null = parseSecure(env.SIGNKIT_SMTP_SECURE);
	if (secure === null) return null;
	const auth: SmtpAuth | null | undefined = parseAuth(
		env.SIGNKIT_SMTP_USERNAME,
		env.SIGNKIT_SMTP_PASSWORD
	);
	if (auth === null) return null;
	return auth === undefined ? { host, port, secure } : { host, port, secure, auth };
}

function parsePort(value: string | undefined): number | null {
	const normalized: string | undefined = nonempty(value);
	if (normalized === undefined || !/^[0-9]+$/.test(normalized)) return null;
	const port: number = Number.parseInt(normalized, 10);
	return port >= MIN_PORT && port <= MAX_PORT ? port : null;
}

/**
 * `SIGNKIT_SMTP_SECURE` has no implicit default: an unset or blank value
 * fails closed rather than silently picking a TLS mode the operator never
 * chose.
 */
function parseSecure(value: string | undefined): boolean | null {
	const normalized: string | undefined = nonempty(value)?.toLowerCase();
	if (normalized === 'true') return true;
	if (normalized === 'false') return false;
	return null;
}

/**
 * The host and username are trimmed like every other configuration value,
 * but the password is preserved exactly as supplied — trimming it could
 * silently turn a valid credential with meaningful leading/trailing bytes
 * into one that fails at the server instead of failing closed here. A blank
 * (empty-string) password is still treated as absent, matching how every
 * other optional variable in this deployment is read.
 */
function parseAuth(
	user: string | undefined,
	pass: string | undefined
): SmtpAuth | null | undefined {
	const normalizedUser: string | undefined = nonempty(user);
	const rawPass: string | undefined = pass !== undefined && pass.length > 0 ? pass : undefined;
	if (normalizedUser === undefined && rawPass === undefined) return undefined;
	if (normalizedUser === undefined || rawPass === undefined) return null;
	return { user: normalizedUser, pass: rawPass };
}

function nonempty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized: string = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}
