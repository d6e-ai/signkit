import { usage } from './errors.js';

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
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) || trimmed.includes('\0')) {
		throw usage(`${flag} must be an email address`);
	}
	return trimmed;
}

export function originFromDomain(domain: string): string {
	return `https://${domain}`;
}

export function hostnameFromOrigin(origin: string): string {
	return new URL(origin).hostname;
}
