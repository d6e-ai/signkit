import { WebhookTargetRejectedError } from './webhook-url';

/**
 * Name of the deployer-owned environment variable that lists the webhook
 * destination hosts this deployment may deliver to. The value is a
 * comma-separated list of exact host entries (`hooks.example.com`) and
 * explicit wildcard suffix entries (`*.hooks.example.com`). When the variable
 * is absent, empty, or invalid, webhook creation and delivery default deny.
 */
export const WEBHOOK_ALLOWED_HOSTS_ENV_VAR: 'SIGNKIT_WEBHOOK_ALLOWED_HOSTS' =
	'SIGNKIT_WEBHOOK_ALLOWED_HOSTS';

const HOSTNAME_PATTERN: RegExp = /^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const LABEL_PATTERN: RegExp = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
	'localhost',
	'localhost.localdomain',
	'metadata.google.internal',
	'metadata.internal'
]);

export interface WebhookHostPolicy {
	readonly exact: ReadonlySet<string>;
	readonly suffixes: readonly string[];
}

export class WebhookHostPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WebhookHostPolicyError';
	}
}

/**
 * Thrown when a webhook target host is outside the deployer allowlist, or
 * when no allowlist is configured. Extends the SSRF rejection family so the
 * existing delivery path already treats it as a terminal non-retryable
 * failure, while remaining distinguishable for creation-time reporting.
 */
export class WebhookHostNotAllowedError extends WebhookTargetRejectedError {
	constructor(message: string) {
		super(message);
		this.name = 'WebhookHostNotAllowedError';
	}
}

/**
 * Parses a raw `SIGNKIT_WEBHOOK_ALLOWED_HOSTS` value into a canonical host
 * policy. Returns `null` when the value is absent or blank, which callers
 * treat as default-deny. Throws `WebhookHostPolicyError` when any entry is
 * invalid, which callers also treat as default-deny (fail closed) without
 * echoing the configured value.
 */
export function parseWebhookAllowedHosts(raw: string | undefined | null): WebhookHostPolicy | null {
	if (raw === undefined || raw === null || raw.trim().length === 0) return null;
	const exact: Set<string> = new Set();
	const suffixes: string[] = [];
	for (const entry of raw.split(',')) {
		const trimmed: string = entry.trim();
		if (trimmed.length === 0) {
			throw new WebhookHostPolicyError('Webhook allowlist entries must not be empty');
		}
		if (trimmed.startsWith('*.')) {
			const suffix: string = canonicalizeExactHost(trimmed.slice(2), 'wildcard');
			if (!suffix.includes('.')) {
				throw new WebhookHostPolicyError(
					'Webhook allowlist wildcard entries must name a multi-label suffix'
				);
			}
			if (!suffixes.includes(suffix)) suffixes.push(suffix);
			continue;
		}
		exact.add(canonicalizeExactHost(trimmed, 'exact'));
	}
	return { exact, suffixes };
}

/**
 * Resolves the deployer policy from an env-like source (platform env or
 * process env). Returns `null` for absent/blank values. Throws
 * `WebhookHostPolicyError` for invalid values; the runtime layer catches that,
 * logs a value-free diagnostic, and denies.
 */
export function resolveWebhookAllowedHostsPolicy(
	source: Readonly<Record<string, string | undefined>> | undefined
): WebhookHostPolicy | null {
	if (source === undefined) return null;
	return parseWebhookAllowedHosts(source[WEBHOOK_ALLOWED_HOSTS_ENV_VAR]);
}

export function isWebhookHostAllowed(hostname: string, policy: WebhookHostPolicy | null): boolean {
	if (policy === null) return false;
	const canonical: string = canonicalizeHostname(hostname);
	if (policy.exact.has(canonical)) return true;
	return policy.suffixes.some(
		(suffix: string): boolean =>
			canonical.length > suffix.length && canonical.endsWith(`.${suffix}`)
	);
}

/**
 * Fails closed when no policy is configured and when the host is outside the
 * configured policy. Messages are generic on purpose: they never echo the
 * configured allowlist or the rejected host.
 */
export function assertWebhookHostAllowed(hostname: string, policy: WebhookHostPolicy | null): void {
	if (policy === null) {
		throw new WebhookHostNotAllowedError(
			'Webhook destinations are not configured for this deployment'
		);
	}
	if (!isWebhookHostAllowed(hostname, policy)) {
		throw new WebhookHostNotAllowedError(
			'Webhook host is not in the deployment destination allowlist'
		);
	}
}

function canonicalizeHostname(hostname: string): string {
	const trimmed: string = hostname.trim().toLowerCase();
	return trimmed.endsWith('.') && trimmed.length > 1 ? trimmed.slice(0, -1) : trimmed;
}

function canonicalizeExactHost(entry: string, kind: 'exact' | 'wildcard'): string {
	const host: string = canonicalizeHostname(entry);
	if (
		host.length === 0 ||
		host.length > 253 ||
		host.includes(' ') ||
		host.includes('\t') ||
		host.includes('://') ||
		host.includes('/') ||
		host.includes('?') ||
		host.includes('#') ||
		host.includes('@') ||
		host.includes(':') ||
		host.includes('[') ||
		host.includes(']') ||
		host.includes('*')
	) {
		throw new WebhookHostPolicyError(
			`Webhook allowlist ${kind} entries must be bare hostnames without credentials, ports, or paths`
		);
	}
	if (isIpLiteral(host) || BLOCKED_HOSTNAMES.has(host)) {
		throw new WebhookHostPolicyError(
			`Webhook allowlist ${kind} entries must not be IP literals or loopback hosts`
		);
	}
	if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
		throw new WebhookHostPolicyError(`Webhook allowlist ${kind} entries must be public DNS names`);
	}
	if (!HOSTNAME_PATTERN.test(host)) {
		throw new WebhookHostPolicyError(`Webhook allowlist ${kind} entries must be public DNS names`);
	}
	for (const label of host.split('.')) {
		if (!LABEL_PATTERN.test(label)) {
			throw new WebhookHostPolicyError(
				`Webhook allowlist ${kind} entries must be public DNS names`
			);
		}
	}
	return host;
}

function isIpLiteral(hostname: string): boolean {
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true;
	if (hostname.includes(':')) return true;
	return false;
}
