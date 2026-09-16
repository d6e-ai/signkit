import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	WebhookTargetRejectedError,
	assertWebhookHttpsUrl,
	assertWebhookTargetSafe,
	createDrainBatchDnsCache,
	isBlockedIpAddress,
	resolvePublicWebhookAddresses
} from './webhook-url';

vi.mock('node:dns/promises', () => ({
	lookup: vi.fn(async () => {
		throw new Error('dns unavailable');
	})
}));

describe('assertWebhookHttpsUrl', () => {
	it('accepts a public HTTPS URL on the default port', () => {
		expect(assertWebhookHttpsUrl('https://hooks.example.com/signkit').href).toBe(
			'https://hooks.example.com/signkit'
		);
	});

	it.each([
		['http://hooks.example.com/signkit', 'https'],
		['https://user:pass@hooks.example.com/signkit', 'credentials'],
		['https://hooks.example.com/signkit#frag', 'fragment'],
		['https://hooks.example.com:8443/signkit', 'port'],
		['https://127.0.0.1/signkit', 'IP literal'],
		['https://localhost/signkit', 'loopback host'],
		['https://hooks.localhost/signkit', 'public DNS name'],
		['https://hooks.internal/signkit', 'public DNS name'],
		['not-a-url', 'absolute HTTPS URL']
	])('rejects %s', (raw, messagePart) => {
		expect(() => assertWebhookHttpsUrl(raw)).toThrow(WebhookTargetRejectedError);
		expect(() => assertWebhookHttpsUrl(raw)).toThrow(messagePart);
	});
});

describe('isBlockedIpAddress', () => {
	it.each([
		'127.0.0.1',
		'10.0.0.1',
		'192.168.1.1',
		'169.254.1.1',
		'172.16.0.2',
		'100.64.0.1',
		'224.0.0.1',
		'225.1.2.3',
		'239.255.255.255',
		'::1',
		'0:0:0:0:0:0:0:1',
		'::ffff:127.0.0.1',
		'0:0:0:0:0:ffff:7f00:1',
		'::ffff:7f00:1',
		'2002:7f00:1::',
		'64:ff9b::7f00:1',
		'64:ff9b:1::1',
		'fc00::1',
		'fe80::1'
	])('blocks %s', (address) => {
		expect(isBlockedIpAddress(address)).toBe(true);
	});

	it('allows public native and transition-mechanism addresses', () => {
		expect(isBlockedIpAddress('1.1.1.1')).toBe(false);
		expect(isBlockedIpAddress('223.255.255.255')).toBe(false);
		expect(isBlockedIpAddress('2606:4700:4700::1111')).toBe(false);
		expect(isBlockedIpAddress('2002:0101:0101::')).toBe(false);
		expect(isBlockedIpAddress('64:ff9b::101:101')).toBe(false);
	});

	it.each(['not:ipv6', '1::2::3', 'fe80::1%eth0'])('fails closed for malformed %s', (address) => {
		expect(isBlockedIpAddress(address)).toBe(true);
	});
});

describe('resolvePublicWebhookAddresses DoH fallback', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('accepts public A records from DNS-over-HTTPS when node DNS is unavailable', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				const type = url.searchParams.get('type');
				return new Response(
					JSON.stringify({
						Status: 0,
						Answer: type === 'A' ? [{ type: 1, data: '1.1.1.1' }] : []
					}),
					{ status: 200, headers: { 'content-type': 'application/dns-json' } }
				);
			})
		);

		await expect(resolvePublicWebhookAddresses('hooks.example.com')).resolves.toEqual(['1.1.1.1']);
	});

	it('rejects a DoH answer that resolves to a blocked address', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				const type = url.searchParams.get('type');
				return new Response(
					JSON.stringify({
						Status: 0,
						Answer: type === 'A' ? [{ type: 1, data: '127.0.0.1' }] : []
					}),
					{ status: 200, headers: { 'content-type': 'application/dns-json' } }
				);
			})
		);

		await expect(resolvePublicWebhookAddresses('hooks.example.com')).rejects.toBeInstanceOf(
			WebhookTargetRejectedError
		);
	});

	it('memoizes DoH resolution once per hostname for a drain batch', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			const type = url.searchParams.get('type');
			return new Response(
				JSON.stringify({
					Status: 0,
					Answer: type === 'A' ? [{ type: 1, data: '1.1.1.1' }] : []
				}),
				{ status: 200, headers: { 'content-type': 'application/dns-json' } }
			);
		});
		vi.stubGlobal('fetch', fetchMock);
		const resolve = createDrainBatchDnsCache();
		await assertWebhookTargetSafe('https://hooks.example.com/a', resolve);
		await assertWebhookTargetSafe('https://hooks.example.com/b', resolve);
		// One DoH resolution per hostname, each resolution queries both A and AAAA
		// so a blocked IPv6 answer cannot hide behind a benign A record.
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('blocks a hostname whose AAAA record is private even though its A record is public', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			const type = url.searchParams.get('type');
			return new Response(
				JSON.stringify({
					Status: 0,
					Answer: type === 'A' ? [{ type: 1, data: '1.1.1.1' }] : [{ type: 28, data: 'fd00::1' }]
				}),
				{ status: 200, headers: { 'content-type': 'application/dns-json' } }
			);
		});
		vi.stubGlobal('fetch', fetchMock);
		await expect(resolvePublicWebhookAddresses('hooks.example.com')).rejects.toThrow(
			WebhookTargetRejectedError
		);
	});
});
