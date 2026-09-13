const HOSTNAME_PATTERN: RegExp = /^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
	'localhost',
	'localhost.localdomain',
	'metadata.google.internal',
	'metadata.internal'
]);
const DOH_ENDPOINT: string = 'https://cloudflare-dns.com/dns-query';
const DNS_A: number = 1;
const DNS_AAAA: number = 28;

export class WebhookTargetRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WebhookTargetRejectedError';
	}
}

export function assertWebhookHttpsUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new WebhookTargetRejectedError('Webhook URL is not a valid absolute HTTPS URL');
	}
	if (url.protocol !== 'https:') {
		throw new WebhookTargetRejectedError('Webhook URL must use https');
	}
	if (url.username !== '' || url.password !== '') {
		throw new WebhookTargetRejectedError('Webhook URL must not include credentials');
	}
	if (url.hash !== '') {
		throw new WebhookTargetRejectedError('Webhook URL must not include a fragment');
	}
	if (url.port !== '' && url.port !== '443') {
		throw new WebhookTargetRejectedError('Webhook URL must use the default HTTPS port');
	}
	const hostname: string = url.hostname.toLowerCase();
	if (hostname.startsWith('[') || isIpLiteral(hostname) || BLOCKED_HOSTNAMES.has(hostname)) {
		throw new WebhookTargetRejectedError(
			'Webhook URL must not target an IP literal or loopback host'
		);
	}
	if (
		hostname.endsWith('.localhost') ||
		hostname.endsWith('.local') ||
		hostname.endsWith('.internal')
	) {
		throw new WebhookTargetRejectedError('Webhook URL hostname is not a public DNS name');
	}
	if (!HOSTNAME_PATTERN.test(hostname)) {
		throw new WebhookTargetRejectedError('Webhook URL hostname is not a public DNS name');
	}
	return url;
}

export function isBlockedIpAddress(address: string): boolean {
	if (address.includes(':')) return isBlockedIpv6(address);
	return isBlockedIpv4(address);
}

export async function resolvePublicWebhookAddresses(hostname: string): Promise<readonly string[]> {
	try {
		const addresses: readonly string[] = await resolveViaNodeDns(hostname);
		return assertPublicAddresses(addresses);
	} catch (error: unknown) {
		if (error instanceof WebhookTargetRejectedError) throw error;
	}
	return assertPublicAddresses(await resolveViaDoh(hostname));
}

export async function assertWebhookTargetSafe(raw: string): Promise<URL> {
	const url: URL = assertWebhookHttpsUrl(raw);
	const first: readonly string[] = await resolvePublicWebhookAddresses(url.hostname);
	const second: readonly string[] = await resolvePublicWebhookAddresses(url.hostname);
	if (!sameAddressSet(first, second)) {
		throw new WebhookTargetRejectedError('Webhook hostname DNS re-resolution disagreed');
	}
	return url;
}

async function resolveViaNodeDns(hostname: string): Promise<readonly string[]> {
	const dns = await import('node:dns/promises');
	const records: readonly { address: string }[] = await dns.lookup(hostname, {
		all: true,
		verbatim: true
	});
	return records.map((record: { address: string }): string => record.address);
}

async function resolveViaDoh(hostname: string): Promise<readonly string[]> {
	const [ipv4, ipv6] = await Promise.all([lookupDoh(hostname, 'A'), lookupDoh(hostname, 'AAAA')]);
	return [...ipv4, ...ipv6];
}

async function lookupDoh(hostname: string, type: 'A' | 'AAAA'): Promise<readonly string[]> {
	const url: URL = new URL(DOH_ENDPOINT);
	url.searchParams.set('name', hostname);
	url.searchParams.set('type', type);
	let response: Response;
	try {
		response = await fetch(url, {
			method: 'GET',
			redirect: 'error',
			headers: { accept: 'application/dns-json' },
			signal: AbortSignal.timeout(5_000)
		});
	} catch {
		throw new WebhookTargetRejectedError('Webhook hostname did not resolve');
	}
	if (!response.ok) {
		throw new WebhookTargetRejectedError('Webhook hostname did not resolve');
	}
	const body: unknown = await response.json();
	if (!isDohResponse(body) || body.Status !== 0 || !Array.isArray(body.Answer)) {
		return [];
	}
	const recordType: number = type === 'A' ? DNS_A : DNS_AAAA;
	return body.Answer.filter(
		(answer): answer is { type: number; data: string } =>
			typeof answer === 'object' &&
			answer !== null &&
			'type' in answer &&
			'data' in answer &&
			answer.type === recordType &&
			typeof answer.data === 'string'
	).map((answer: { data: string }): string => answer.data);
}

function isDohResponse(value: unknown): value is { Status: number; Answer?: unknown[] } {
	return (
		typeof value === 'object' &&
		value !== null &&
		'Status' in value &&
		typeof value.Status === 'number'
	);
}

function assertPublicAddresses(addresses: readonly string[]): readonly string[] {
	if (addresses.length === 0) {
		throw new WebhookTargetRejectedError('Webhook hostname did not resolve');
	}
	for (const address of addresses) {
		if (isBlockedIpAddress(address)) {
			throw new WebhookTargetRejectedError('Webhook hostname resolved to a blocked address');
		}
	}
	return addresses;
}

function isIpLiteral(hostname: string): boolean {
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true;
	if (hostname.includes(':')) return true;
	return false;
}

function isBlockedIpv4(address: string): boolean {
	const parts: number[] = address.split('.').map((part: string): number => Number(part));
	if (
		parts.length !== 4 ||
		parts.some((part: number): boolean => !Number.isInteger(part) || part < 0 || part > 255)
	) {
		return true;
	}
	const [a, b] = parts;
	if (a === 0 || a === 10 || a === 127 || a === 224 || a >= 240) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	return false;
}

function isBlockedIpv6(address: string): boolean {
	const normalized: string = address.toLowerCase();
	if (normalized === '::1' || normalized === '::') return true;
	if (
		normalized.startsWith('fe80:') ||
		normalized.startsWith('ff') ||
		normalized.startsWith('fc') ||
		normalized.startsWith('fd')
	) {
		return true;
	}
	if (
		normalized.startsWith('2001:db8:') ||
		normalized === '100::' ||
		normalized.startsWith('100::')
	) {
		return true;
	}
	const mappedIpv4: RegExpMatchArray | null = normalized.match(
		/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/
	);
	if (mappedIpv4 !== null) return isBlockedIpv4(mappedIpv4[1]);
	if (normalized.startsWith('::ffff:')) return true;
	return false;
}

function sameAddressSet(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const expected: Set<string> = new Set(left);
	for (const address of right) {
		if (!expected.has(address)) return false;
	}
	return true;
}
