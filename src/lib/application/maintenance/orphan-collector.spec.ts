import { describe, expect, it, vi } from 'vitest';
import {
	OrphanCollector,
	D1OrphanReferenceStore,
	type OrphanReferenceStore
} from './orphan-collector';
import type { ObjectStore, ListObjectsResult } from '$lib/ports/object-store';
import type { D1Database } from '@cloudflare/workers-types';

describe('OrphanCollector', () => {
	const now = new Date('2026-09-13T12:00:00.000Z');
	const twentyFiveHoursAgo = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
	const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();

	it('identifies and deletes unreferenced objects older than grace period', async () => {
		const listMock = vi.fn(async (): Promise<ListObjectsResult> => ({
			objects: [
				{ key: 'drafts/recent.git.gz', size: 10, uploadedAt: oneHourAgo }, // within grace period
				{ key: 'drafts/referenced.git.gz', size: 20, uploadedAt: twentyFiveHoursAgo }, // referenced
				{ key: 'drafts/orphan.git.gz', size: 30, uploadedAt: twentyFiveHoursAgo } // orphan
			],
			truncated: false
		}));

		const deleteManyMock = vi.fn(async () => {});
		const objects: ObjectStore = {
			get: vi.fn(),
			head: vi.fn(),
			putImmutable: vi.fn(),
			delete: vi.fn(),
			list: listMock,
			deleteMany: deleteManyMock
		};

		const references: OrphanReferenceStore = {
			filterReferencedKeys: vi.fn(
				async (): Promise<Set<string>> => new Set(['drafts/referenced.git.gz'])
			)
		};

		const collector = new OrphanCollector(objects, references, () => now);
		const report = await collector.sweep();

		expect(report.scanned).toBe(3);
		expect(report.inGracePeriod).toBe(1);
		expect(report.referenced).toBe(1);
		expect(report.deleted).toBe(1);
		expect(report.deletedKeys).toEqual(['drafts/orphan.git.gz']);

		expect(references.filterReferencedKeys).toHaveBeenCalledWith([
			'drafts/referenced.git.gz',
			'drafts/orphan.git.gz'
		]);
		expect(deleteManyMock).toHaveBeenCalledWith(['drafts/orphan.git.gz']);
	});

	it('respects dryRun option and does not delete objects', async () => {
		const objects: ObjectStore = {
			get: vi.fn(),
			head: vi.fn(),
			putImmutable: vi.fn(),
			delete: vi.fn(),
			list: vi.fn(async (): Promise<ListObjectsResult> => ({
				objects: [{ key: 'orphan.pdf', size: 40, uploadedAt: twentyFiveHoursAgo }],
				truncated: false
			})),
			deleteMany: vi.fn()
		};

		const references: OrphanReferenceStore = {
			filterReferencedKeys: vi.fn(async (): Promise<Set<string>> => new Set())
		};

		const collector = new OrphanCollector(objects, references, () => now);
		const report = await collector.sweep({ dryRun: true });

		expect(report.deleted).toBe(1);
		expect(report.deletedKeys).toEqual(['orphan.pdf']);
		expect(objects.deleteMany).not.toHaveBeenCalled();
	});

	it('handles paginated listings with cursor and respects maxObjectsToScan', async () => {
		let call = 0;
		const listMock = vi.fn(async (): Promise<ListObjectsResult> => {
			call += 1;
			if (call === 1) {
				return {
					objects: [{ key: 'item-1', size: 50, uploadedAt: twentyFiveHoursAgo }],
					truncated: true,
					cursor: 'cursor-1'
				};
			}
			return {
				objects: [{ key: 'item-2', size: 60, uploadedAt: twentyFiveHoursAgo }],
				truncated: false
			};
		});

		const objects: ObjectStore = {
			get: vi.fn(),
			head: vi.fn(),
			putImmutable: vi.fn(),
			delete: vi.fn(),
			list: listMock,
			deleteMany: vi.fn()
		};

		const references: OrphanReferenceStore = {
			filterReferencedKeys: vi.fn(async (): Promise<Set<string>> => new Set())
		};

		const collector = new OrphanCollector(objects, references, () => now);
		const report = await collector.sweep({ batchSize: 1, maxObjectsToScan: 1 });

		expect(report.scanned).toBe(1);
		expect(listMock).toHaveBeenCalledTimes(1);
	});
});

describe('D1OrphanReferenceStore', () => {
	it('returns empty set for empty keys', async () => {
		const db = {} as D1Database;
		const store = new D1OrphanReferenceStore(db);
		const result = await store.filterReferencedKeys([]);
		expect(result.size).toBe(0);
	});

	it('queries database and returns set of found keys', async () => {
		const allMock = vi.fn(async () => ({
			results: [{ key: 'key-1' }, { key: 'key-3' }]
		}));
		const bindMock = vi.fn(() => ({ all: allMock }));
		const prepareMock = vi.fn(() => ({ bind: bindMock }));
		const db = { prepare: prepareMock } as unknown as D1Database;

		const store = new D1OrphanReferenceStore(db);
		const result = await store.filterReferencedKeys(['key-1', 'key-2', 'key-3']);

		expect(prepareMock).toHaveBeenCalledOnce();
		expect(result.has('key-1')).toBe(true);
		expect(result.has('key-2')).toBe(false);
		expect(result.has('key-3')).toBe(true);
	});
});
