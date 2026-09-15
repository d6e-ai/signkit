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

export function originFromDomain(domain: string): string {
	return `https://${domain}`;
}

export function hostnameFromOrigin(origin: string): string {
	return new URL(origin).hostname;
}
