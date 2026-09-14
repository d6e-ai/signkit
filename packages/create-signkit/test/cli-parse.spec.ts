import { describe, expect, it } from 'vitest';
import { parseArgv, argvRequestsJson } from '../src/cli/parse.js';
import { CliError } from '../src/cli/errors.js';
import { ACCOUNT_ID } from './helpers.js';

function parse(argv: string[]) {
	return parseArgv(argv);
}

describe('parseArgv provider flags', () => {
	it('requires --cloudflare before the command', () => {
		expect(() => parse(['plan', '--account-id', ACCOUNT_ID])).toThrow(CliError);
		try {
			parse(['plan', '--account-id', ACCOUNT_ID]);
		} catch (error) {
			expect(error).toBeInstanceOf(CliError);
			expect((error as CliError).exitCode).toBe(2);
			expect((error as CliError).message).toMatch(/explicit provider flag/i);
			expect((error as CliError).message).toMatch(/not an implicit default/i);
		}
	});

	it('rejects a provider flag after the command', () => {
		expect(() => parse(['plan', '--cloudflare', '--account-id', ACCOUNT_ID])).toThrow(
			/must appear before the command/
		);
	});

	it('rejects mutually exclusive provider flags', () => {
		expect(() => parse(['--cloudflare', '--node', 'plan', '--account-id', ACCOUNT_ID])).toThrow(
			/mutually exclusive/
		);
		expect(() => parse(['--cloudflare', '--vercel', 'plan', '--account-id', ACCOUNT_ID])).toThrow(
			/mutually exclusive/
		);
	});

	it('parses --cloudflare plan with required account id', () => {
		expect(parse(['--cloudflare', 'plan', '--account-id', ACCOUNT_ID])).toMatchObject({
			kind: 'command',
			provider: 'cloudflare',
			command: 'plan',
			accountId: ACCOUNT_ID
		});
	});

	it('accepts --cloudflare before other flags and the command', () => {
		expect(parse(['--cloudflare', '--account-id', ACCOUNT_ID, '--yes', 'deploy'])).toMatchObject({
			command: 'deploy',
			yes: true,
			provider: 'cloudflare'
		});
	});

	it('parses --node and --vercel as explicit providers', () => {
		expect(parse(['--node', 'plan', '--account-id', ACCOUNT_ID])).toMatchObject({
			provider: 'node',
			command: 'plan'
		});
		expect(parse(['--vercel', 'upgrade', '--account-id', ACCOUNT_ID])).toMatchObject({
			provider: 'vercel',
			command: 'upgrade'
		});
	});

	it('returns help without requiring a provider', () => {
		expect(parse(['--help'])).toEqual({ kind: 'help' });
		expect(parse(['-h'])).toEqual({ kind: 'help' });
	});
});

describe('parseArgv options', () => {
	it('requires --account-id', () => {
		expect(() => parse(['--cloudflare', 'plan'])).toThrow(/--account-id is required/);
	});

	it('rejects a malformed account id', () => {
		expect(() => parse(['--cloudflare', 'plan', '--account-id', 'not-an-id'])).toThrow(
			/32-character hexadecimal/
		);
	});

	it('rejects git refs and build-metadata tags as --version', () => {
		expect(() =>
			parse(['--cloudflare', 'plan', '--account-id', ACCOUNT_ID, '--version', 'main'])
		).toThrow(/refusing git ref/);
		expect(() =>
			parse(['--cloudflare', 'plan', '--account-id', ACCOUNT_ID, '--version', ACCOUNT_ID])
		).toThrow(/refusing git ref/);
		expect(() =>
			parse(['--cloudflare', 'plan', '--account-id', ACCOUNT_ID, '--version', 'v1.2.3+build.1'])
		).toThrow(/build metadata|refusing git ref/);
	});

	it('accepts latest and exact tags', () => {
		expect(
			parse(['--cloudflare', 'plan', '--account-id', ACCOUNT_ID, '--version', 'latest'])
		).toMatchObject({ version: 'latest' });
		expect(
			parse(['--cloudflare', 'deploy', '--account-id', ACCOUNT_ID, '--version', 'v1.2.3'])
		).toMatchObject({ version: 'v1.2.3' });
	});

	it('accepts resource overrides and records which flags were explicit', () => {
		const parsed = parse([
			'--cloudflare',
			'upgrade',
			'--account-id',
			ACCOUNT_ID,
			'--worker-name',
			'signkit-prod',
			'--d1',
			'signkit-prod-db',
			'--r2',
			'signkit-prod-objects',
			'--domain',
			'sign.example.com',
			'--channel',
			'beta',
			'--state',
			'/tmp/state.json',
			'--yes',
			'--json'
		]);
		expect(parsed).toMatchObject({
			command: 'upgrade',
			workerName: 'signkit-prod',
			d1: 'signkit-prod-db',
			r2: 'signkit-prod-objects',
			domain: 'sign.example.com',
			channel: 'beta',
			statePath: '/tmp/state.json',
			yes: true,
			json: true,
			overrides: { workerName: true, d1: true, r2: true, domain: true }
		});
	});

	it('accepts first-deploy var flags and requires public-origin to agree with domain', () => {
		const parsed = parse([
			'--cloudflare',
			'deploy',
			'--account-id',
			ACCOUNT_ID,
			'--domain',
			'sign.example.com',
			'--public-origin',
			'https://sign.example.com',
			'--email-from',
			'sign@example.com',
			'--email-from-name',
			'SignKit Ops',
			'--d6e-auth-base-url',
			'https://auth.example.com'
		]);
		expect(parsed).toMatchObject({
			domain: 'sign.example.com',
			publicOrigin: 'https://sign.example.com',
			emailFrom: 'sign@example.com',
			emailFromName: 'SignKit Ops',
			d6eAuthBaseUrl: 'https://auth.example.com',
			overrides: {
				domain: true,
				publicOrigin: true,
				emailFrom: true,
				emailFromName: true,
				d6eAuthBaseUrl: true
			}
		});
		expect(() =>
			parse([
				'--cloudflare',
				'deploy',
				'--account-id',
				ACCOUNT_ID,
				'--domain',
				'sign.example.com',
				'--public-origin',
				'https://other.example.com'
			])
		).toThrow(/must agree/);
	});

	it('accepts --json=true as JSON output', () => {
		expect(
			parse(['--cloudflare', 'plan', '--account-id', ACCOUNT_ID, '--json=true'])
		).toMatchObject({ json: true });
		expect(argvRequestsJson(['--cloudflare', 'plan', '--json=true'])).toBe(true);
		expect(argvRequestsJson(['--cloudflare', 'plan', '--json=false'])).toBe(false);
	});

	it('refuses secret-bearing flags on argv', () => {
		expect(() =>
			parse(['--cloudflare', 'deploy', '--account-id', ACCOUNT_ID, '--token', 'cf-secret'])
		).toThrow(/never accepted on argv/);
		expect(() =>
			parse(['--cloudflare', 'deploy', '--account-id', ACCOUNT_ID, '--api-token=cf-secret'])
		).toThrow(/never accepted on argv/);
	});
});

describe('--json=true error routing', () => {
	it('writes parse errors as JSON on stdout', async () => {
		const { runCreateSignkit } = await import('../src/cli/run.js');
		const stdout: string[] = [];
		const stderr: string[] = [];
		const code = await runCreateSignkit({
			argv: ['plan', '--account-id', ACCOUNT_ID, '--json=true'],
			stdout: { write: (chunk) => stdout.push(chunk) },
			stderr: { write: (chunk) => stderr.push(chunk) }
		});
		expect(code).toBe(2);
		expect(stderr.join('')).toBe('');
		expect(JSON.parse(stdout.join('')).ok).toBe(false);
		expect(JSON.parse(stdout.join('')).message).toMatch(/explicit provider flag/i);
	});
});
