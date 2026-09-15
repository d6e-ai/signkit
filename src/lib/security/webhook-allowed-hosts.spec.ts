import { describe, expect, it } from 'vitest';
import {
	assertWebhookHostAllowed,
	isWebhookHostAllowed,
	parseWebhookAllowedHosts,
	resolveWebhookAllowedHostsPolicy,
	WEBHOOK_ALLOWED_HOSTS_ENV_VAR,
	WebhookHostNotAllowedError,
	WebhookHostPolicyError,
	type WebhookHostPolicy
} from './webhook-allowed-hosts';
import { WebhookTargetRejectedError } from './webhook-url';

function policy(raw: string): WebhookHostPolicy {
	const parsed: WebhookHostPolicy | null = parseWebhookAllowedHosts(raw);
	if (parsed === null) throw new Error('expected a policy');
	return parsed;
}

describe('parseWebhookAllowedHosts', () => {
	it.each([undefined, null, '', '   '])(
		'returns null (default deny) for absent or blank values: %s',
		(raw) => {
			expect(parseWebhookAllowedHosts(raw as string | undefined | null)).toBeNull();
		}
	);

	it('parses exact hosts and explicit wildcard suffixes', () => {
		const parsed: WebhookHostPolicy | null = parseWebhookAllowedHosts(
			'hooks.example.com, *.hooks.example.net'
		);
		expect(parsed).not.toBeNull();
		expect([...parsed!.exact]).toEqual(['hooks.example.com']);
		expect([...parsed!.suffixes]).toEqual(['hooks.example.net']);
	});

	it('canonicalizes case, whitespace, and trailing dots', () => {
		const parsed: WebhookHostPolicy | null = parseWebhookAllowedHosts(
			'  HOOKS.Example.COM. ,  *.Hooks.Example.NET. '
		);
		expect([...parsed!.exact]).toEqual(['hooks.example.com']);
		expect([...parsed!.suffixes]).toEqual(['hooks.example.net']);
	});

	it('deduplicates repeated entries', () => {
		const parsed: WebhookHostPolicy | null = parseWebhookAllowedHosts(
			'hooks.example.com, hooks.example.com, *.hooks.example.net, *.hooks.example.net'
		);
		expect([...parsed!.exact]).toEqual(['hooks.example.com']);
		expect([...parsed!.suffixes]).toEqual(['hooks.example.net']);
	});

	it.each([
		'https://hooks.example.com',
		'hooks.example.com/path',
		'hooks.example.com?query=1',
		'hooks.example.com#frag',
		'user:pass@hooks.example.com',
		'user@hooks.example.com',
		'hooks.example.com:8443',
		'https://hooks.example.com:443/signkit',
		'127.0.0.1',
		'10.0.0.1',
		'::1',
		'2001:db8::1',
		'[::1]',
		'localhost',
		'LOCALHOST',
		'hooks.localhost',
		'hooks.local',
		'hooks.internal',
		'metadata.google.internal',
		'singlelabel',
		'*.com',
		'*.co',
		'*.local',
		'*.internal',
		'*.localhost',
		'*',
		'**.example.com',
		'*hooks.example.com',
		'hooks.*.example.com',
		'hooks.example.com*',
		'-hooks.example.com',
		'hooks-.example.com',
		'hook s.example.com',
		'hooks.example.com,',
		',hooks.example.com',
		' , , '
	])('rejects invalid entry %s', (raw) => {
		expect(() => parseWebhookAllowedHosts(raw)).toThrow(WebhookHostPolicyError);
	});

	it('never echoes the configured value in the policy error', () => {
		const secretLike: string = 'hooks.example.com:8443';
		try {
			parseWebhookAllowedHosts(secretLike);
		} catch (error: unknown) {
			expect(String((error as Error).message)).not.toContain('8443');
			return;
		}
		throw new Error('expected parseWebhookAllowedHosts to throw');
	});
});

describe('resolveWebhookAllowedHostsPolicy', () => {
	it('returns null when no env source is present', () => {
		expect(resolveWebhookAllowedHostsPolicy(undefined)).toBeNull();
	});

	it('returns null when the variable is absent or blank', () => {
		expect(resolveWebhookAllowedHostsPolicy({})).toBeNull();
		expect(resolveWebhookAllowedHostsPolicy({ [WEBHOOK_ALLOWED_HOSTS_ENV_VAR]: '  ' })).toBeNull();
	});

	it('parses the configured value from the env source', () => {
		const parsed: WebhookHostPolicy | null = resolveWebhookAllowedHostsPolicy({
			[WEBHOOK_ALLOWED_HOSTS_ENV_VAR]: 'hooks.example.com'
		});
		expect(parsed).not.toBeNull();
		expect(isWebhookHostAllowed('hooks.example.com', parsed)).toBe(true);
	});

	it('throws on an invalid configured value so the runtime can fail closed', () => {
		expect(() =>
			resolveWebhookAllowedHostsPolicy({
				[WEBHOOK_ALLOWED_HOSTS_ENV_VAR]: 'hooks.example.com:8443'
			})
		).toThrow(WebhookHostPolicyError);
	});
});

describe('isWebhookHostAllowed', () => {
	it('denies everything when no policy is configured', () => {
		expect(isWebhookHostAllowed('hooks.example.com', null)).toBe(false);
	});

	it('matches exact hosts case-insensitively and nothing else', () => {
		const allowed: WebhookHostPolicy = policy('hooks.example.com');
		expect(isWebhookHostAllowed('hooks.example.com', allowed)).toBe(true);
		expect(isWebhookHostAllowed('HOOKS.EXAMPLE.COM', allowed)).toBe(true);
		expect(isWebhookHostAllowed('hooks.example.com.', allowed)).toBe(true);
		expect(isWebhookHostAllowed('other-hooks.example.com', allowed)).toBe(false);
		expect(isWebhookHostAllowed('hooks.example.com.evil.example.com', allowed)).toBe(false);
		expect(isWebhookHostAllowed('example.com', allowed)).toBe(false);
	});

	it('matches wildcard suffixes at any depth but never the bare suffix', () => {
		const allowed: WebhookHostPolicy = policy('*.hooks.example.com');
		expect(isWebhookHostAllowed('a.hooks.example.com', allowed)).toBe(true);
		expect(isWebhookHostAllowed('a.b.hooks.example.com', allowed)).toBe(true);
		expect(isWebhookHostAllowed('hooks.example.com', allowed)).toBe(false);
		expect(isWebhookHostAllowed('nothooks.example.com', allowed)).toBe(false);
		expect(isWebhookHostAllowed('hooks.example.com.evil.example.com', allowed)).toBe(false);
	});
});

describe('assertWebhookHostAllowed', () => {
	it('throws a target rejection when unconfigured', () => {
		expect(() => assertWebhookHostAllowed('hooks.example.com', null)).toThrow(
			WebhookHostNotAllowedError
		);
		expect(() => assertWebhookHostAllowed('hooks.example.com', null)).toThrow(
			WebhookTargetRejectedError
		);
		expect(() => assertWebhookHostAllowed('hooks.example.com', null)).toThrow(
			/destinations are not configured/
		);
	});

	it('throws a target rejection for hosts outside the policy', () => {
		expect(() => assertWebhookHostAllowed('evil.example.com', policy('hooks.example.com'))).toThrow(
			WebhookHostNotAllowedError
		);
	});

	it('passes for allowlisted hosts', () => {
		expect(() =>
			assertWebhookHostAllowed('hooks.example.com', policy('hooks.example.com'))
		).not.toThrow();
		expect(() =>
			assertWebhookHostAllowed('a.hooks.example.com', policy('*.hooks.example.com'))
		).not.toThrow();
	});

	it('never echoes the rejected host or the configured policy', () => {
		const configured: WebhookHostPolicy = policy('hooks.example.com');
		for (const hostname of ['hooks.example.com', 'evil.example.com']) {
			try {
				assertWebhookHostAllowed(hostname, hostname === 'hooks.example.com' ? null : configured);
			} catch (error: unknown) {
				expect(String((error as Error).message)).not.toContain(hostname);
				continue;
			}
			throw new Error('expected assertWebhookHostAllowed to throw');
		}
	});
});
