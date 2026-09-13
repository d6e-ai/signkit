import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_ORPHAN_GRACE_PERIOD_MS,
	MAX_ORPHAN_SCAN_LIMIT,
	OrphanCollector,
	D1OrphanReferenceStore,
	D1OrphanSweepCheckpointStore,
	PostgresOrphanReferenceStore,
	PostgresOrphanSweepCheckpointStore,
	type OrphanReferenceStore,
	type OrphanSweepCheckpointStore
} from './orphan-collector';
import type { ObjectStore, ListObjectsResult } from '$lib/ports/object-store';
import type { D1Database } from '@cloudflare/workers-types';
import { applyD1Migrations, sqliteD1Database } from '$lib/adapters/db/sqlite-d1-test-support';

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

	it('does not delete objects missing a parseable upload time even when unreferenced', async () => {
		const deleteManyMock = vi.fn(async () => {});
		const objects: ObjectStore = {
			get: vi.fn(),
			head: vi.fn(),
			putImmutable: vi.fn(),
			delete: vi.fn(),
			list: vi.fn(async (): Promise<ListObjectsResult> => ({
				objects: [
					{ key: 'unknown-age.bin', size: 10 },
					{ key: 'bad-date.bin', size: 10, uploadedAt: 'not-a-date' },
					{ key: '../escape.bin', size: 10, uploadedAt: twentyFiveHoursAgo }
				],
				truncated: false
			})),
			deleteMany: deleteManyMock
		};
		const references: OrphanReferenceStore = {
			filterReferencedKeys: vi.fn(async (): Promise<Set<string>> => new Set())
		};

		const report = await new OrphanCollector(objects, references, () => now).sweep();

		expect(report.deleted).toBe(0);
		expect(report.inGracePeriod).toBe(2);
		expect(references.filterReferencedKeys).not.toHaveBeenCalled();
		expect(deleteManyMock).not.toHaveBeenCalled();
	});

	it('ignores a requested grace period below the 24-hour floor', async () => {
		const deleteManyMock = vi.fn(async () => {});
		const objects: ObjectStore = {
			get: vi.fn(),
			head: vi.fn(),
			putImmutable: vi.fn(),
			delete: vi.fn(),
			list: vi.fn(async (): Promise<ListObjectsResult> => ({
				objects: [{ key: 'recent.bin', size: 10, uploadedAt: oneHourAgo }],
				truncated: false
			})),
			deleteMany: deleteManyMock
		};
		const references: OrphanReferenceStore = {
			filterReferencedKeys: vi.fn(async (): Promise<Set<string>> => new Set())
		};

		const report = await new OrphanCollector(objects, references, () => now).sweep({
			gracePeriodMs: 0,
			maxObjectsToScan: 50_000
		});

		expect(DEFAULT_ORPHAN_GRACE_PERIOD_MS).toBe(24 * 60 * 60 * 1000);
		expect(report.deleted).toBe(0);
		expect(report.inGracePeriod).toBe(1);
		expect(deleteManyMock).not.toHaveBeenCalled();
		expect(objects.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
	});

	it('caps each invocation at the object-store list bound', async () => {
		expect(MAX_ORPHAN_SCAN_LIMIT).toBe(1000);
		const listMock = vi.fn(async (): Promise<ListObjectsResult> => ({
			objects: [{ key: 'item', size: 1, uploadedAt: twentyFiveHoursAgo }],
			truncated: false
		}));
		const objects: ObjectStore = {
			get: vi.fn(),
			head: vi.fn(),
			putImmutable: vi.fn(),
			delete: vi.fn(),
			list: listMock,
			deleteMany: vi.fn()
		};

		await new OrphanCollector(
			objects,
			{ filterReferencedKeys: vi.fn(async () => new Set<string>()) },
			() => now
		).sweep({ maxObjectsToScan: 10_000, batchSize: 5_000 });

		expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }));
	});

	it('resumes from a durable checkpoint so later runs are not starved by the first page', async () => {
		const keys = ['live-a', 'live-b', 'orphan-c'];
		const listMock = vi.fn(
			async (options?: { startAfter?: string; cursor?: string; limit?: number }) => {
				const remaining = keys.filter(
					(key) => options?.startAfter === undefined || key > options.startAfter
				);
				const limit = options?.limit ?? remaining.length;
				const page = remaining.slice(0, limit);
				return {
					objects: page.map((key) => ({ key, size: 1, uploadedAt: twentyFiveHoursAgo })),
					truncated: remaining.length > page.length,
					cursor: remaining.length > page.length ? `after-${page[page.length - 1]}` : undefined
				};
			}
		);
		const objects: ObjectStore = {
			get: vi.fn(),
			head: vi.fn(),
			putImmutable: vi.fn(),
			delete: vi.fn(),
			list: listMock,
			deleteMany: vi.fn()
		};
		const checkpoint = memoryCheckpoint();
		const collector = new OrphanCollector(
			objects,
			{
				filterReferencedKeys: vi.fn(
					async (candidates: readonly string[]): Promise<Set<string>> =>
						new Set(candidates.filter((key) => key.startsWith('live-')))
				)
			},
			() => now,
			checkpoint
		);

		const first = await collector.sweep({ batchSize: 1, maxObjectsToScan: 1 });
		expect(first.scanned).toBe(1);
		expect(first.deleted).toBe(0);
		expect(first.nextStartAfter).toBe('live-a');
		expect(checkpoint.key).toBe('live-a');

		const second = await collector.sweep({ batchSize: 1, maxObjectsToScan: 1 });
		expect(second.scanned).toBe(1);
		expect(listMock.mock.calls[1][0]).toEqual(expect.objectContaining({ startAfter: 'live-a' }));
		expect(checkpoint.key).toBe('live-b');

		const third = await collector.sweep({ batchSize: 1, maxObjectsToScan: 1 });
		expect(third.deletedKeys).toEqual(['orphan-c']);
		expect(third.nextStartAfter).toBe('');
		expect(checkpoint.key).toBe('');
	});

	it('does not let a stale concurrent sweep regress a later checkpoint', async () => {
		const deleteManyMock = vi.fn(async () => {});
		const objects: ObjectStore = {
			get: vi.fn(),
			head: vi.fn(),
			putImmutable: vi.fn(),
			delete: vi.fn(),
			list: vi.fn(async (): Promise<ListObjectsResult> => ({
				objects: [{ key: 'early-key', size: 1, uploadedAt: twentyFiveHoursAgo }],
				truncated: false
			})),
			deleteMany: deleteManyMock
		};
		const checkpoint: OrphanSweepCheckpointStore & { key: string; rejected: number } = {
			key: 'later-key',
			rejected: 0,
			async readLastObjectKey(): Promise<string> {
				return '';
			},
			async compareAndSwapLastObjectKey(expected: string, next: string): Promise<boolean> {
				if (this.key !== expected) {
					this.rejected += 1;
					return false;
				}
				this.key = next;
				return true;
			}
		};
		const collector = new OrphanCollector(
			objects,
			{ filterReferencedKeys: vi.fn(async () => new Set<string>()) },
			() => now,
			checkpoint
		);

		const report = await collector.sweep({ batchSize: 1, maxObjectsToScan: 1 });

		// The lost CAS is surfaced on the report rather than swallowed, so a
		// caller can observe the collision instead of assuming the checkpoint
		// reflects this run.
		expect(report.checkpointConflict).toBe(true);
		expect(checkpoint.key).toBe('later-key');
		expect(checkpoint.rejected).toBe(1);

		// The scan and deletion already ran exactly once for this invocation;
		// losing the CAS must not trigger a retry that deletes the same
		// orphan again (no duplicate deletion) or loops on the conflict (no
		// livelock).
		expect(deleteManyMock).toHaveBeenCalledOnce();
		expect(deleteManyMock).toHaveBeenCalledWith(['early-key']);
	});

	it('reports no checkpoint conflict when the compare-and-swap wins', async () => {
		const objects: ObjectStore = {
			get: vi.fn(),
			head: vi.fn(),
			putImmutable: vi.fn(),
			delete: vi.fn(),
			list: vi.fn(async (): Promise<ListObjectsResult> => ({
				objects: [{ key: 'only-key', size: 1, uploadedAt: twentyFiveHoursAgo }],
				truncated: false
			})),
			deleteMany: vi.fn()
		};
		const checkpoint = memoryCheckpoint();
		const collector = new OrphanCollector(
			objects,
			{ filterReferencedKeys: vi.fn(async () => new Set<string>()) },
			() => now,
			checkpoint
		);

		const report = await collector.sweep();

		expect(report.checkpointConflict).toBe(false);
		expect(checkpoint.rejected).toBe(0);
	});

	it('does not delete when the reference check fails', async () => {
		const deleteManyMock = vi.fn(async () => {});
		const objects: ObjectStore = {
			get: vi.fn(),
			head: vi.fn(),
			putImmutable: vi.fn(),
			delete: vi.fn(),
			list: vi.fn(async (): Promise<ListObjectsResult> => ({
				objects: [{ key: 'maybe-orphan.bin', size: 10, uploadedAt: twentyFiveHoursAgo }],
				truncated: false
			})),
			deleteMany: deleteManyMock
		};

		await expect(
			new OrphanCollector(
				objects,
				{
					filterReferencedKeys: vi.fn(async () => {
						throw new Error('sql unavailable');
					})
				},
				() => now
			).sweep()
		).rejects.toThrow('sql unavailable');
		expect(deleteManyMock).not.toHaveBeenCalled();
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

	it('classifies signature-assets/v1 keys referenced by field_value sig:sha256 as live', async () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		applyD1Migrations(sqlite);
		const sha256: string = 'ab'.repeat(32);
		const organizationId: string = 'org-1';
		const envelopeId: string = '01900000-0000-7000-8000-000000000001';
		const recipientId: string = '01900000-0000-7000-8000-000000000002';
		const fieldId: string = '01900000-0000-7000-8000-000000000003';
		const assetKey = `signature-assets/v1/organizations/${organizationId}/envelopes/${envelopeId}/recipients/${recipientId}/sha256/${sha256}.png`;
		const foreignAssetKey = `signature-assets/v1/organizations/org-other/envelopes/${envelopeId}/recipients/${recipientId}/sha256/${sha256}.png`;
		sqlite.exec(`
			INSERT INTO organization (id, d6e_organization_id, name, created_at)
			VALUES ('${organizationId}', '${organizationId}', 'Workspace', '2026-09-11T00:00:00.000Z');
			INSERT INTO envelope (
				id, organization_id, title, status, repository_generation, created_at, updated_at
			) VALUES (
				'${envelopeId}', '${organizationId}', 'Agreement', 'completed', 1,
				'2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
			);
			INSERT INTO recipient (
				id, organization_id, envelope_id, role, routing_order, name, email, locale,
				status, created_at, updated_at
			) VALUES (
				'${recipientId}', '${organizationId}', '${envelopeId}', 'signer', 1, 'Signer',
				'signer@example.test', 'en', 'completed', '2026-09-11T00:00:00.000Z',
				'2026-09-11T00:00:00.000Z'
			);
			INSERT INTO envelope_field (
				id, organization_id, envelope_id, recipient_id, document_path, field_type, label,
				required, position, created_at, updated_at
			) VALUES (
				'${fieldId}', '${organizationId}', '${envelopeId}', '${recipientId}',
				'documents/agreement.md', 'signature', 'Signature', 1, 0,
				'2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
			);
			INSERT INTO field_value (
				organization_id, field_id, envelope_id, recipient_id, field_type,
				value_json, value_sha256, created_at
			) VALUES (
				'${organizationId}', '${fieldId}', '${envelopeId}', '${recipientId}', 'signature',
				'${JSON.stringify(`sig:sha256:${sha256}`)}', '${'c'.repeat(64)}',
				'2026-09-11T00:00:00.000Z'
			);
		`);
		try {
			const store = new D1OrphanReferenceStore(sqliteD1Database(sqlite));
			const referenced = await store.filterReferencedKeys([
				assetKey,
				foreignAssetKey,
				'drafts/orphan.git.gz'
			]);
			expect(referenced.has(assetKey)).toBe(true);
			expect(referenced.has(foreignAssetKey)).toBe(false);
			expect(referenced.has('drafts/orphan.git.gz')).toBe(false);
		} finally {
			sqlite.close();
		}
	});
});

describe('D1OrphanSweepCheckpointStore', () => {
	it('reads an empty checkpoint as the start of the listing', async () => {
		const first = vi.fn(async () => ({ key: '' }));
		const bindMock = vi.fn(() => ({ first }));
		const prepareMock = vi.fn(() => ({ bind: bindMock }));
		const store = new D1OrphanSweepCheckpointStore({
			prepare: prepareMock
		} as unknown as D1Database);
		await expect(store.readLastObjectKey()).resolves.toBe('');
	});

	it('rejects an unsafe stored key', async () => {
		const first = vi.fn(async () => ({ key: '../escape.bin' }));
		const store = new D1OrphanSweepCheckpointStore({
			prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) }))
		} as unknown as D1Database);
		await expect(store.readLastObjectKey()).rejects.toThrow('safe object key');
	});

	it('advances with compare-and-swap and rejects a stale writer', async () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		applyD1Migrations(sqlite);
		const store = new D1OrphanSweepCheckpointStore(sqliteD1Database(sqlite));
		try {
			await expect(store.readLastObjectKey()).resolves.toBe('');
			await expect(store.compareAndSwapLastObjectKey('', 'drafts/a.git.gz')).resolves.toBe(true);
			await expect(store.compareAndSwapLastObjectKey('', 'drafts/b.git.gz')).resolves.toBe(false);
			await expect(store.readLastObjectKey()).resolves.toBe('drafts/a.git.gz');
			const [first, second] = await Promise.all([
				store.compareAndSwapLastObjectKey('drafts/a.git.gz', 'drafts/c.git.gz'),
				store.compareAndSwapLastObjectKey('drafts/a.git.gz', 'drafts/d.git.gz')
			]);
			expect([first, second].filter((won: boolean): boolean => won)).toHaveLength(1);
			expect(['drafts/c.git.gz', 'drafts/d.git.gz']).toContain(await store.readLastObjectKey());
		} finally {
			sqlite.close();
		}
	});
});

describe('PostgresOrphanReferenceStore', () => {
	it('returns empty set for empty keys without querying', async () => {
		const sql = vi.fn();
		const store = new PostgresOrphanReferenceStore(
			sql as unknown as ConstructorParameters<typeof PostgresOrphanReferenceStore>[0]
		);
		const result = await store.filterReferencedKeys([]);
		expect(result.size).toBe(0);
		expect(sql).not.toHaveBeenCalled();
	});
});

describe('PostgresOrphanSweepCheckpointStore', () => {
	it('compare-and-swaps only when the expected key still matches', async () => {
		const sql = Object.assign(
			vi.fn(async () => [{ key: 'drafts/next.git.gz' }]),
			{}
		);
		const store = new PostgresOrphanSweepCheckpointStore(
			sql as unknown as ConstructorParameters<typeof PostgresOrphanSweepCheckpointStore>[0]
		);
		await expect(store.compareAndSwapLastObjectKey('', 'drafts/next.git.gz')).resolves.toBe(true);
		expect(sql).toHaveBeenCalledOnce();

		sql.mockResolvedValueOnce([]);
		await expect(store.compareAndSwapLastObjectKey('', 'drafts/stale.git.gz')).resolves.toBe(false);
	});
});

function memoryCheckpoint(): OrphanSweepCheckpointStore & { key: string; rejected: number } {
	return {
		key: '',
		rejected: 0,
		async readLastObjectKey(): Promise<string> {
			return this.key;
		},
		async compareAndSwapLastObjectKey(expected: string, next: string): Promise<boolean> {
			if (this.key !== expected) {
				this.rejected += 1;
				return false;
			}
			this.key = next;
			return true;
		}
	};
}
