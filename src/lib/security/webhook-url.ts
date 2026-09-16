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

export type WebhookDnsResolver = (hostname: string) => Promise<readonly string[]>;

/**
 * One resolve per hostname per drain batch. Fail-closed SSRF still runs on the
 * resolved set. Residual limitation: this is not a double-resolve rebinding
 * detector, so DNS can still change between this lookup and `fetch`.
 */
export function createDrainBatchDnsCache(): WebhookDnsResolver {
	const memo: Map<string, Promise<readonly string[]>> = new Map();
	return (hostname: string): Promise<readonly string[]> => {
		const cached: Promise<readonly string[]> | undefined = memo.get(hostname);
		if (cached !== undefined) return cached;
		const pending: Promise<readonly string[]> = resolvePublicWebhookAddresses(hostname);
		memo.set(hostname, pending);
		return pending;
	};
}

export async function assertWebhookTargetSafe(
	raw: string,
	resolveAddresses: WebhookDnsResolver = resolvePublicWebhookAddresses
): Promise<URL> {
	const url: URL = assertWebhookHttpsUrl(raw);
	await resolveAddresses(url.hostname);
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
	if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	return false;
}

function isBlockedIpv6(address: string): boolean {
	const words: readonly number[] | null = parseIpv6Words(address);
	if (words === null) return true;

	const allZero: boolean = words.every((word: number): boolean => word === 0);
	const loopback: boolean =
		words.slice(0, 7).every((word: number): boolean => word === 0) && words[7] === 1;
	if (allZero || loopback) return true;

	if ((words[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
	if ((words[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
	if ((words[0] & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
	if (words[0] === 0x2001 && words[1] === 0x0db8) return true; // documentation
	if (words[0] === 0x0100 && words.slice(1, 4).every((word: number): boolean => word === 0)) {
		return true; // discard-only 100::/64
	}

	const embeddedIpv4: string | null = ipv4FromWords(words[6], words[7]);
	const mappedOrCompatible: boolean =
		words.slice(0, 5).every((word: number): boolean => word === 0) &&
		(words[5] === 0 || words[5] === 0xffff);
	if (mappedOrCompatible && embeddedIpv4 !== null) return isBlockedIpv4(embeddedIpv4);

	if (words[0] === 0x2002) {
		const sixToFourIpv4: string | null = ipv4FromWords(words[1], words[2]);
		return sixToFourIpv4 === null || isBlockedIpv4(sixToFourIpv4);
	}

	const wellKnownNat64: boolean =
		words[0] === 0x0064 &&
		words[1] === 0xff9b &&
		words.slice(2, 6).every((word: number): boolean => word === 0);
	if (wellKnownNat64 && embeddedIpv4 !== null) return isBlockedIpv4(embeddedIpv4);

	// RFC 8215 reserves 64:ff9b:1::/48 for local-use translation. Its
	// mapping is deployment-defined, so webhook delivery cannot prove the
	// translated destination is public and must fail closed.
	if (words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0x0001) return true;

	return false;
}

function parseIpv6Words(address: string): readonly number[] | null {
	const normalized: string = address.toLowerCase();
	if (normalized.includes('%') || normalized === '' || normalized.split('::').length > 2)
		return null;

	const [leftRaw, rightRaw]: [string, string?] = normalized.split('::') as [string, string?];
	const left: number[] | null = parseIpv6Side(leftRaw);
	const right: number[] | null = rightRaw === undefined ? [] : parseIpv6Side(rightRaw);
	if (left === null || right === null) return null;

	if (rightRaw === undefined) return left.length === 8 ? left : null;
	const omittedWordCount: number = 8 - left.length - right.length;
	if (omittedWordCount < 1) return null;
	return [...left, ...Array<number>(omittedWordCount).fill(0), ...right];
}

function parseIpv6Side(side: string): number[] | null {
	if (side === '') return [];
	const parts: string[] = side.split(':');
	const words: number[] = [];
	for (let index: number = 0; index < parts.length; index += 1) {
		const part: string = parts[index];
		if (part.includes('.')) {
			if (index !== parts.length - 1) return null;
			const ipv4Parts: number[] = part.split('.').map((value: string): number => Number(value));
			if (
				ipv4Parts.length !== 4 ||
				ipv4Parts.some(
					(value: number): boolean => !Number.isInteger(value) || value < 0 || value > 255
				)
			) {
				return null;
			}
			words.push((ipv4Parts[0] << 8) | ipv4Parts[1], (ipv4Parts[2] << 8) | ipv4Parts[3]);
			continue;
		}
		if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
		words.push(Number.parseInt(part, 16));
	}
	return words;
}

function ipv4FromWords(high: number, low: number): string {
	return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}
