import { usage } from './errors.js';

const MAX_EMAIL_ADDRESS_LENGTH = 254;

export function parseHttpsOrigin(value: string, flag: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw usage(`${flag} must be an https URL`);
	}
	if (url.protocol !== 'https:') {
		throw usage(`${flag} must be an https URL`);
	}
	if (url.username || url.password) {
		throw usage(`${flag} must not include userinfo`);
	}
	if (url.search || url.hash) {
		throw usage(`${flag} must be an origin (no query or fragment)`);
	}
	if (url.pathname !== '/' && url.pathname !== '') {
		throw usage(`${flag} must be an origin (no path)`);
	}
	return url.origin;
}

export function parseEmailAddress(value: string, flag: string): string {
	const trimmed = value.trim();
	if (!isValidEmailAddress(trimmed)) {
		throw usage(`${flag} must be an email address`);
	}
	return trimmed;
}

/**
 * Deliberately small email syntax check matching the CLI's historical contract:
 * one nonempty local part, one `@`, and a dotted nonempty domain. This is not an
 * RFC mailbox parser. It is bounded and scans each code unit once so untrusted
 * deployment state cannot trigger regular-expression backtracking.
 */
export function isValidEmailAddress(value: string): boolean {
	const candidate: string = value.trim();
	if (candidate.length === 0 || candidate.length > MAX_EMAIL_ADDRESS_LENGTH) {
		return false;
	}

	let atIndex = -1;
	let hasInteriorDomainDot = false;
	for (let index = 0; index < candidate.length; index += 1) {
		const codeUnit: number = candidate.charCodeAt(index);
		if (codeUnit === 0 || isEcmaScriptWhitespace(codeUnit)) {
			return false;
		}
		if (codeUnit === 0x40) {
			if (atIndex !== -1) {
				return false;
			}
			atIndex = index;
		} else if (
			codeUnit === 0x2e &&
			atIndex !== -1 &&
			index > atIndex + 1 &&
			index < candidate.length - 1
		) {
			hasInteriorDomainDot = true;
		}
	}

	return atIndex > 0 && atIndex < candidate.length - 1 && hasInteriorDomainDot;
}

/** ECMAScript WhiteSpace and LineTerminator code units formerly matched by `\\s`. */
function isEcmaScriptWhitespace(codeUnit: number): boolean {
	return (
		(codeUnit >= 0x0009 && codeUnit <= 0x000d) ||
		codeUnit === 0x0020 ||
		codeUnit === 0x00a0 ||
		codeUnit === 0x1680 ||
		(codeUnit >= 0x2000 && codeUnit <= 0x200a) ||
		codeUnit === 0x2028 ||
		codeUnit === 0x2029 ||
		codeUnit === 0x202f ||
		codeUnit === 0x205f ||
		codeUnit === 0x3000 ||
		codeUnit === 0xfeff
	);
}

export const MAX_CONSOLE_ORIGINS = 16;
const MAX_CONSOLE_ORIGIN_LENGTH = 512;
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Canonical origin for `SIGNKIT_CONSOLE_ORIGINS`: an `https:` origin, or
 * `http:` only for a loopback host. No userinfo, path, query, or fragment, and
 * never a comma (the Worker var is a comma-separated list). The WHATWG origin
 * serialization is returned, so a trailing `/` is dropped. Returns `undefined`
 * instead of throwing so callers choose their own error class and wording.
 */
export function canonicalConsoleOrigin(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CONSOLE_ORIGIN_LENGTH) {
		return undefined;
	}
	// WHATWG URL accepts `*` in a host; the Worker refuses such an entry and
	// would turn console CORS off entirely, so it is rejected here first.
	if (value.includes('*')) {
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (url.username || url.password || url.search || url.hash) {
		return undefined;
	}
	if (url.pathname !== '/' && url.pathname !== '') {
		return undefined;
	}
	const secure = url.protocol === 'https:';
	const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname);
	if (!secure && !loopbackHttp) {
		return undefined;
	}
	if (url.origin.includes(',') || url.origin === 'null') {
		return undefined;
	}
	return url.origin;
}

/**
 * Canonicalizes a list of console origins, preserving first-seen order and
 * dropping exact duplicates. An empty list is valid and means "console CORS
 * off". Throws a usage error naming `label`, never echoing the rejected value.
 */
export function canonicalConsoleOrigins(values: readonly unknown[], label: string): string[] {
	if (values.length > MAX_CONSOLE_ORIGINS) {
		throw usage(`${label} must list at most ${MAX_CONSOLE_ORIGINS} origins`);
	}
	const origins: string[] = [];
	for (const value of values) {
		const origin = canonicalConsoleOrigin(value);
		if (origin === undefined) {
			throw usage(
				`${label} entries must be https origins (http only for localhost, 127.0.0.1, or [::1]) with no path, query, or fragment`
			);
		}
		if (!origins.includes(origin)) {
			origins.push(origin);
		}
	}
	return origins;
}

/** Parses the comma-separated `--console-origins` value. An empty value clears the list. */
export function parseConsoleOriginsFlag(value: string, flag: string): string[] {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return [];
	}
	const entries = trimmed.split(',').map((entry) => entry.trim());
	if (entries.some((entry) => entry.length === 0)) {
		throw usage(`${flag} must not contain empty entries`);
	}
	return canonicalConsoleOrigins(entries, flag);
}

export function originFromDomain(domain: string): string {
	return `https://${domain}`;
}

export function hostnameFromOrigin(origin: string): string {
	return new URL(origin).hostname;
}

const MAX_CONSOLE_URL_LENGTH = 2048;

/**
 * Canonical `SIGNKIT_CONSOLE_URL`: where invitation emails send people to
 * join without the link. An `https:` URL, or `http:` only for a loopback host,
 * with no userinfo, query, or fragment. Returns `undefined` when invalid.
 */
export function canonicalConsoleUrl(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CONSOLE_URL_LENGTH) {
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (url.username || url.password || url.search || url.hash) {
		return undefined;
	}
	const secure = url.protocol === 'https:';
	const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname);
	if (!secure && !loopbackHttp) {
		return undefined;
	}
	return url.href;
}

/** Parses `--console-url`. An empty value clears it, which deploy and upgrade then refuse. */
export function parseConsoleUrlFlag(value: string, flag: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return '';
	}
	const url = canonicalConsoleUrl(trimmed);
	if (url === undefined) {
		throw usage(
			`${flag} must be an https URL (http only for localhost, 127.0.0.1, or [::1]) with no query or fragment`
		);
	}
	return url;
}
