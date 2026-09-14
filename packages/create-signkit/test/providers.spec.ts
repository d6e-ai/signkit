import { describe, expect, it } from 'vitest';
import { runCreateSignkit } from '../src/cli/run.js';
import {
	ACCOUNT_ID,
	FakeWrangler,
	MemoryFileSystem,
	command,
	fakeExtractor,
	fakeReleases
} from './helpers.js';

async function run(argv: string[]) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await runCreateSignkit({
		argv,
		stdout: { write: (chunk) => stdout.push(chunk) },
		stderr: { write: (chunk) => stderr.push(chunk) },
		env: { XDG_STATE_HOME: '/xdg/state' }
	});
	return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

describe('provider abstraction', () => {
	it('fails --node and --vercel with a usage error rather than implying Cloudflare', async () => {
		const node = await run(['--node', 'plan', '--account-id', ACCOUNT_ID, '--json']);
		expect(node.code).toBe(2);
		expect(node.stdout).toMatch(/not implemented/);
		expect(node.stdout).not.toMatch(/implicit/i);

		const vercel = await run(['--vercel', 'deploy', '--account-id', ACCOUNT_ID, '--yes', '--json']);
		expect(vercel.code).toBe(2);
		expect(vercel.stdout).toMatch(/--vercel is recognized but not implemented/);
	});

	it('does not default to Cloudflare when the provider flag is omitted', async () => {
		const result = await run(['plan', '--account-id', ACCOUNT_ID, '--json']);
		expect(result.code).toBe(2);
		expect(result.stdout).toMatch(/explicit provider flag/);
	});

	it('runs the Cloudflare provider when --cloudflare precedes the command', async () => {
		const fs = new MemoryFileSystem();
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		const stdout: string[] = [];
		const code = await runCreateSignkit({
			argv: ['--cloudflare', 'plan', '--account-id', ACCOUNT_ID, '--json'],
			stdout: { write: (chunk) => stdout.push(chunk) },
			stderr: { write: () => undefined },
			env: { XDG_STATE_HOME: '/xdg/state' },
			runtime: {
				fs,
				wrangler,
				releases: fakeReleases(),
				extractor: fakeExtractor(fs)
			}
		});
		expect(code).toBe(0);
		expect(stdout.join('')).toMatch(/"provider": "cloudflare"/);
		expect(command().provider).toBe('cloudflare');
	});
});
