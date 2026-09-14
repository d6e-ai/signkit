import { describe, expect, it } from 'vitest';
import {
	createWranglerClient,
	isMissingWorkerError,
	parseDeployResult,
	parseMigrationList,
	sortWorkerVersions,
	assertSuccessfulUpload
} from '../src/providers/cloudflare/wrangler.js';
import { ACCOUNT_ID, RecordingProcessRunner } from './helpers.js';

const D1_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKER_VERSION = '22222222-2222-2222-2222-222222222222';

const REAL_PENDING_MIGRATIONS = `Migrations to be applied:
┌───────────────────────────────────────┬────────┐
│ Name                                  │ Status │
├───────────────────────────────────────┼────────┤
│ 0001_core.sql                         │        │
├───────────────────────────────────────┼────────┤
│ 0002_next.sql                         │        │
└───────────────────────────────────────┴────────┘
`;

describe('parseMigrationList', () => {
	it('parses real Wrangler nonempty output by filenames after the section header', () => {
		expect(parseMigrationList(REAL_PENDING_MIGRATIONS)).toEqual({
			pending: ['0001_core.sql', '0002_next.sql'],
			applied: []
		});
	});

	it('parses real Wrangler empty output without inventing applied history', () => {
		expect(parseMigrationList('No migrations to apply!')).toEqual({ pending: [], applied: [] });
	});

	it('does not treat filename rows without pending as applied history', () => {
		expect(parseMigrationList(REAL_PENDING_MIGRATIONS).applied).toEqual([]);
	});
});

describe('parseDeployResult', () => {
	it('accepts only a labelled Worker Version ID', () => {
		const result = parseDeployResult(
			`Uploaded signkit\nVersion ID: ${WORKER_VERSION}\nhttps://signkit.example.workers.dev\n`,
			''
		);
		expect(result.aborted).toBe(false);
		expect(result.workerVersionId).toBe(WORKER_VERSION);
		expect(result.workerUrl).toBe('https://signkit.example.workers.dev');
	});

	it('refuses abort exit-0 output that contains a D1 UUID and no labelled Worker version', () => {
		const stdout = `D1 database_id = "${D1_UUID}"
Remote configuration would be overwritten.
Aborted. Did not upload a new version.
`;
		const result = parseDeployResult(stdout, '');
		expect(result.aborted).toBe(true);
		expect(result.workerVersionId).toBeUndefined();
		expect(() => assertSuccessfulUpload(result)).toThrow(/aborted|did not upload/i);
	});

	it('never falls back to an arbitrary UUID as the Worker version', () => {
		const result = parseDeployResult(
			`Created D1 ${D1_UUID}\nhttps://signkit.example.workers.dev`,
			''
		);
		expect(result.workerVersionId).toBeUndefined();
		expect(() => assertSuccessfulUpload(result)).toThrow(/labelled Worker Version ID/);
	});
});

describe('missing Worker classification', () => {
	it('recognizes script_not_found and API codes 10007/10006/10090', () => {
		expect(isMissingWorkerError('code: 10007 script_not_found')).toBe(true);
		expect(isMissingWorkerError('[10006] Worker script not present')).toBe(true);
		expect(isMissingWorkerError('[code: 10090] missing script')).toBe(true);
		expect(isMissingWorkerError('error 10090')).toBe(false);
		expect(isMissingWorkerError('A generic resource was not found')).toBe(false);
		expect(isMissingWorkerError('database 10007 rows scanned')).toBe(false);
	});

	it('treats listSecrets and listVersions fresh-account errors as an empty Worker', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = (request) => {
			if (request.argv.includes('secret')) {
				return {
					code: 1,
					stdout: '',
					stderr: 'code: 10007 script_not_found'
				};
			}
			if (request.argv.includes('versions')) {
				return {
					code: 1,
					stdout: '',
					stderr: '[code: 10006] script_not_found'
				};
			}
			return { code: 0, stdout: '[]', stderr: '' };
		};
		const wrangler = createWranglerClient({
			runner,
			accountId: ACCOUNT_ID,
			env: { PATH: '/usr/bin' },
			wranglerBin: '/opt/wrangler/bin/wrangler.js',
			nodeExecutable: '/usr/bin/node'
		});
		await expect(wrangler.listSecrets('signkit')).resolves.toEqual([]);
		await expect(wrangler.listVersions('signkit')).resolves.toEqual([]);
	});

	it('treats createWranglerClient deploy abort output as a hard failure', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 0,
			stdout: `database_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
Remote configuration would be overwritten.
Aborted. Did not upload a new version.
`,
			stderr: ''
		});
		const wrangler = createWranglerClient({
			runner,
			accountId: ACCOUNT_ID,
			env: { PATH: '/usr/bin' },
			wranglerBin: '/opt/wrangler/bin/wrangler.js',
			nodeExecutable: '/usr/bin/node'
		});
		await expect(
			wrangler.deploy({
				cwd: '/tmp/bundle',
				configPath: '/tmp/bundle/wrangler.jsonc',
				workerName: 'signkit',
				keepVars: true,
				noBundle: true
			})
		).rejects.toThrow(/aborted|did not upload/i);
	});
	it('does not classify a broad not-found as a missing Worker for secret listing', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 1,
			stdout: '',
			stderr: 'bucket not found'
		});
		const wrangler = createWranglerClient({
			runner,
			accountId: ACCOUNT_ID,
			env: { PATH: '/usr/bin' },
			wranglerBin: '/opt/wrangler/bin/wrangler.js',
			nodeExecutable: '/usr/bin/node'
		});
		await expect(wrangler.listSecrets('signkit')).rejects.toThrow(/not found/);
	});
});

describe('discovery cwd isolation', () => {
	it('runs non-bundle commands from a fresh empty temp cwd and cleans it up', async () => {
		const { access } = await import('node:fs/promises');
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 0,
			stdout: JSON.stringify([{ uuid: D1_UUID, name: 'signkit' }]),
			stderr: ''
		});
		const wrangler = createWranglerClient({
			runner,
			accountId: ACCOUNT_ID,
			env: { PATH: '/usr/bin' },
			wranglerBin: '/opt/wrangler/bin/wrangler.js',
			nodeExecutable: '/usr/bin/node'
		});
		await wrangler.listD1();
		const cwd = runner.requests[0]?.cwd;
		expect(cwd).toMatch(/create-signkit-wrangler-/);
		expect(cwd).not.toBe('/opt/wrangler/bin');
		expect(cwd).not.toBe(process.cwd());
		await expect(access(cwd!)).rejects.toThrow();
	});
});

describe('sortWorkerVersions', () => {
	it('sorts by createdOn descending, missing timestamps last, stable among equals', () => {
		expect(
			sortWorkerVersions([
				{ id: 'old', createdOn: '2026-01-01T00:00:00.000Z' },
				{ id: 'missing-a' },
				{ id: 'new', createdOn: '2026-09-01T00:00:00.000Z' },
				{ id: 'same-first', createdOn: '2026-06-01T00:00:00.000Z' },
				{ id: 'same-second', createdOn: '2026-06-01T00:00:00.000Z' },
				{ id: 'missing-b' }
			]).map((version) => version.id)
		).toEqual(['new', 'same-first', 'same-second', 'old', 'missing-a', 'missing-b']);
	});
});
