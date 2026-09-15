import { describe, expect, it } from 'vitest';
import {
	createStateStore,
	d1BackupFileName,
	parseState,
	resolveStatePath
} from '../src/state/store.js';
import { ACCOUNT_ID, MemoryFileSystem } from './helpers.js';

describe('XDG state', () => {
	it('defaults to XDG_STATE_HOME/create-signkit/state.json', () => {
		const fs = new MemoryFileSystem();
		expect(resolveStatePath(fs, { XDG_STATE_HOME: '/xdg/state' })).toBe(
			'/xdg/state/create-signkit/state.json'
		);
		expect(resolveStatePath(fs, {})).toBe('/home/operator/.local/state/create-signkit/state.json');
	});

	it('stores only non-secret deployment metadata', async () => {
		const fs = new MemoryFileSystem();
		const store = createStateStore(fs, '/xdg/state/create-signkit/state.json');
		await store.save({
			schemaVersion: 1,
			provider: 'cloudflare',
			accountId: ACCOUNT_ID,
			workerName: 'signkit',
			d1: { name: 'signkit', id: '11111111-1111-1111-1111-111111111111' },
			r2: { name: 'signkit-objects' },
			channel: 'stable',
			version: 'v1.2.3',
			commit: '0123456789abcdef0123456789abcdef01234567',
			updatedAt: '2026-09-15T00:00:00.000Z',
			lastCommand: 'deploy'
		});
		const raw = await fs.readFile('/xdg/state/create-signkit/state.json');
		expect(raw).not.toMatch(/secret|token|password|api[_-]?key/i);
		expect(parseState(raw).accountId).toBe(ACCOUNT_ID);
	});

	it('round-trips the non-secret bootstrap owner email', async () => {
		const fs = new MemoryFileSystem();
		const store = createStateStore(fs, '/xdg/state/create-signkit/state.json');
		await store.save({
			schemaVersion: 1,
			provider: 'cloudflare',
			accountId: ACCOUNT_ID,
			workerName: 'signkit',
			d1: { name: 'signkit', id: '11111111-1111-1111-1111-111111111111' },
			r2: { name: 'signkit-objects' },
			channel: 'stable',
			updatedAt: '2026-09-15T00:00:00.000Z',
			bootstrapOwnerEmail: 'owner@example.com'
		});
		const loaded = await store.load();
		expect(loaded?.bootstrapOwnerEmail).toBe('owner@example.com');
	});

	it('includes milliseconds in D1 backup names', () => {
		expect(d1BackupFileName('signkit', new Date('2026-09-15T00:00:00.123Z'))).toBe(
			'd1-signkit-20260915T000000123Z.sql'
		);
	});

	it('refuses to load or save secret fields', async () => {
		const fs = new MemoryFileSystem();
		const store = createStateStore(fs, '/tmp/state.json');
		await expect(
			store.save({
				schemaVersion: 1,
				provider: 'cloudflare',
				accountId: ACCOUNT_ID,
				workerName: 'signkit',
				d1: { name: 'signkit', id: '11111111-1111-1111-1111-111111111111' },
				r2: { name: 'signkit-objects' },
				channel: 'stable',
				updatedAt: '2026-09-15T00:00:00.000Z',
				apiToken: 'cf-secret'
			} as never)
		).rejects.toThrow(/must not contain secret field/);

		fs.files.set(
			'/tmp/state.json',
			JSON.stringify({ schemaVersion: 1, CLOUDFLARE_API_TOKEN: 'cf-secret' })
		);
		await expect(store.load()).rejects.toThrow(/secret field/);
	});
});
