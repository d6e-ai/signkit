import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { sqliteD1Database, applyD1Migrations } from '$lib/adapters/db/sqlite-d1-test-support';
import { R2ObjectStore } from '$lib/adapters/object/r2';
import {
	D1_MAX_BOUND_PARAMETERS,
	D1OrphanReferenceStore,
	OrphanCollector
} from './orphan-collector';

const NOW: Date = new Date('2026-09-22T12:00:00.000Z');
const OLD_UPLOAD: Date = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);

describe('D1 SQL and R2 binding adapter contract', () => {
	it('handles an empty bucket without querying or deleting', async () => {
		const sqlite: DatabaseSync = migratedDatabase();
		const bucket = r2Bucket([]);
		try {
			const report = await new OrphanCollector(
				new R2ObjectStore(bucket.binding),
				new D1OrphanReferenceStore(sqliteD1Database(sqlite)),
				() => NOW
			).sweep();

			expect(report).toMatchObject({ scanned: 0, referenced: 0, deleted: 0 });
			expect(bucket.deleteMock).not.toHaveBeenCalled();
		} finally {
			sqlite.close();
		}
	});

	it('retains live D1 references and deletes eligible R2 orphans above the former limit', async () => {
		const sqlite: DatabaseSync = migratedDatabase();
		const liveKey: string = 'drafts/live.git.gz';
		const orphanKeys: string[] = Array.from(
			{ length: 11 },
			(_, index: number): string => `drafts/orphan-${String(index).padStart(2, '0')}.git.gz`
		);
		insertEnvelopeArchiveReference(sqlite, liveKey);
		const bindingCounts: number[] = [];
		const database: D1Database = enforceD1BindingLimit(sqliteD1Database(sqlite), bindingCounts);
		const bucket = r2Bucket([liveKey, ...orphanKeys]);

		try {
			const report = await new OrphanCollector(
				new R2ObjectStore(bucket.binding),
				new D1OrphanReferenceStore(database),
				() => NOW
			).sweep();

			expect(report.scanned).toBe(12);
			expect(report.referenced).toBe(1);
			expect(report.deleted).toBe(11);
			expect(report.deletedKeys).toEqual(orphanKeys);
			expect(bucket.remainingKeys()).toEqual([liveKey]);
			expect(Math.max(...bindingCounts)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
		} finally {
			sqlite.close();
		}
	});

	it('continues after a short truncated R2 page without skipping objects', async () => {
		const sqlite: DatabaseSync = migratedDatabase();
		const bucket = r2Bucket(
			['drafts/orphan-a.git.gz', 'drafts/orphan-b.git.gz', 'drafts/orphan-c.git.gz'],
			2
		);
		const collector = new OrphanCollector(
			new R2ObjectStore(bucket.binding),
			new D1OrphanReferenceStore(sqliteD1Database(sqlite)),
			() => NOW
		);
		try {
			const first = await collector.sweep({ maxListPages: 1 });
			expect(first).toMatchObject({
				scanned: 2,
				deleted: 2,
				nextStartAfter: 'drafts/orphan-b.git.gz'
			});

			const second = await collector.sweep({
				maxListPages: 1,
				startAfter: first.nextStartAfter
			});
			expect(second).toMatchObject({ scanned: 1, deleted: 1, nextStartAfter: '' });
			expect(bucket.remainingKeys()).toEqual([]);
		} finally {
			sqlite.close();
		}
	});

	it('classifies an R2 list failure without deleting anything', async () => {
		const sqlite: DatabaseSync = migratedDatabase();
		const bucket = r2Bucket([]);
		bucket.listMock.mockRejectedValueOnce(new Error('private R2 provider detail'));
		try {
			await expect(
				new OrphanCollector(
					new R2ObjectStore(bucket.binding),
					new D1OrphanReferenceStore(sqliteD1Database(sqlite)),
					() => NOW
				).sweep()
			).rejects.toMatchObject({ code: 'object_list_failed', operation: 'object_list' });
			expect(bucket.deleteMock).not.toHaveBeenCalled();
		} finally {
			sqlite.close();
		}
	});

	it('classifies an R2 delete failure after a successful D1 reference lookup', async () => {
		const sqlite: DatabaseSync = migratedDatabase();
		const bucket = r2Bucket(['drafts/orphan.git.gz']);
		bucket.deleteMock.mockRejectedValueOnce(new Error('private R2 delete detail'));
		try {
			await expect(
				new OrphanCollector(
					new R2ObjectStore(bucket.binding),
					new D1OrphanReferenceStore(sqliteD1Database(sqlite)),
					() => NOW
				).sweep()
			).rejects.toMatchObject({ code: 'object_delete_failed', operation: 'object_delete' });
		} finally {
			sqlite.close();
		}
	});
});

function migratedDatabase(): DatabaseSync {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	return sqlite;
}

function insertEnvelopeArchiveReference(sqlite: DatabaseSync, objectKey: string): void {
	sqlite
		.prepare(
			`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			 VALUES (?, 'owner', 'active', ?, ?)`
		)
		.run('user-1', NOW.toISOString(), NOW.toISOString());
	sqlite
		.prepare(
			`INSERT INTO envelope (
				id, created_by_user_id, title, status, repository_generation,
				repository_archive_key, created_at, updated_at
			 ) VALUES (?, ?, ?, 'draft', 1, ?, ?, ?)`
		)
		.run(
			'01900000-0000-7000-8000-000000000001',
			'user-1',
			'Agreement',
			objectKey,
			NOW.toISOString(),
			NOW.toISOString()
		);
}

function enforceD1BindingLimit(database: D1Database, counts: number[]): D1Database {
	return {
		prepare(sql: string): D1PreparedStatement {
			const statement: D1PreparedStatement = database.prepare(sql);
			return {
				bind(...values: unknown[]): D1PreparedStatement {
					counts.push(values.length);
					if (values.length > D1_MAX_BOUND_PARAMETERS) {
						throw new Error('D1 binding limit exceeded');
					}
					return statement.bind(...values);
				}
			} as D1PreparedStatement;
		},
		async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
			return database.batch<T>(statements);
		}
	} as D1Database;
}

interface TestR2Bucket {
	readonly binding: R2Bucket;
	readonly listMock: ReturnType<typeof vi.fn>;
	readonly deleteMock: ReturnType<typeof vi.fn>;
	remainingKeys(): string[];
}

function r2Bucket(initialKeys: readonly string[], pageSize?: number): TestR2Bucket {
	const objects: Map<string, Date> = new Map(
		initialKeys.map((key: string): [string, Date] => [key, OLD_UPLOAD])
	);
	const listMock = vi.fn(async (options?: R2ListOptions): Promise<R2Objects> => {
		const allKeys: string[] = [...objects.keys()]
			.filter(
				(key: string): boolean => options?.startAfter === undefined || key > options.startAfter
			)
			.sort();
		const offset: number = options?.cursor === undefined ? 0 : Number(options.cursor);
		const limit: number = Math.min(options?.limit ?? 1000, pageSize ?? Number.MAX_SAFE_INTEGER);
		const keys: string[] = allKeys.slice(offset, offset + limit);
		const nextOffset: number = offset + keys.length;
		const truncated: boolean = nextOffset < allKeys.length;
		return {
			objects: keys.map((key: string) => ({
				key,
				size: 10,
				etag: `etag-${key}`,
				httpEtag: `"etag-${key}"`,
				uploaded: objects.get(key)!,
				version: 'test-version',
				checksums: {}
			})),
			truncated,
			...(truncated ? { cursor: String(nextOffset) } : {}),
			delimitedPrefixes: []
		} as unknown as R2Objects;
	});
	const deleteMock = vi.fn(async (keys: string | string[]): Promise<void> => {
		for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key);
	});
	return {
		binding: { list: listMock, delete: deleteMock } as unknown as R2Bucket,
		listMock,
		deleteMock,
		remainingKeys(): string[] {
			return [...objects.keys()].sort();
		}
	};
}
