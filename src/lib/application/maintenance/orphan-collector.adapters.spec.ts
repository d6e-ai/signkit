import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { sqliteD1Database, applyD1Migrations } from '$lib/adapters/db/sqlite-d1-test-support';
import { D1SignatureAssetLedger } from '$lib/adapters/db/d1-signature-asset-ledger';
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

	it('retains a drawn-initials sig:sha256 asset past the grace period while an unrelated recipient asset is swept', async () => {
		const sqlite: DatabaseSync = migratedDatabase();
		const envelopeId: string = '01900000-0000-7000-8000-000000000010';
		const initialsRecipientId: string = '01900000-0000-7000-8000-000000000011';
		const orphanRecipientId: string = '01900000-0000-7000-8000-000000000012';
		const initialsSha256: string = 'ab'.repeat(32);
		const orphanSha256: string = 'cd'.repeat(32);
		const initialsAssetKey: string = `signature-assets/v1/envelopes/${envelopeId}/recipients/${initialsRecipientId}/sha256/${initialsSha256}.png`;
		const orphanAssetKey: string = `signature-assets/v1/envelopes/${envelopeId}/recipients/${orphanRecipientId}/sha256/${orphanSha256}.png`;
		insertFieldValueAssetReference(sqlite, {
			envelopeId,
			recipientId: initialsRecipientId,
			fieldId: '01900000-0000-7000-8000-000000000013',
			fieldType: 'initials',
			sha256: initialsSha256
		});
		insertRecipient(sqlite, envelopeId, orphanRecipientId);
		const database: D1Database = sqliteD1Database(sqlite);
		const bucket = r2Bucket([initialsAssetKey, orphanAssetKey]);

		try {
			const report = await new OrphanCollector(
				new R2ObjectStore(bucket.binding),
				new D1OrphanReferenceStore(database),
				() => NOW,
				null,
				new D1SignatureAssetLedger(database)
			).sweep();

			expect(report.deletedKeys).toEqual([orphanAssetKey]);
			expect(bucket.remainingKeys()).toEqual([initialsAssetKey]);
			// The legacy orphan was tombstoned before deletion; the referenced one bound.
			expect(
				sqlite
					.prepare('SELECT recipient_id, state FROM signature_asset ORDER BY recipient_id')
					.all()
					.map((row) => ({ ...row }))
			).toEqual([
				{ recipient_id: initialsRecipientId, state: 'bound' },
				{ recipient_id: orphanRecipientId, state: 'retired' }
			]);
		} finally {
			sqlite.close();
		}
	});

	it('never deletes a signature asset when no retention ledger is wired', async () => {
		const sqlite: DatabaseSync = migratedDatabase();
		const orphanAssetKey: string = `signature-assets/v1/envelopes/01900000-0000-7000-8000-000000000010/recipients/01900000-0000-7000-8000-000000000012/sha256/${'cd'.repeat(32)}.png`;
		const bucket = r2Bucket([orphanAssetKey, 'drafts/orphan.git.gz']);
		try {
			const report = await new OrphanCollector(
				new R2ObjectStore(bucket.binding),
				new D1OrphanReferenceStore(sqliteD1Database(sqlite)),
				() => NOW
			).sweep();

			expect(report.deletedKeys).toEqual(['drafts/orphan.git.gz']);
			expect(bucket.remainingKeys()).toEqual([orphanAssetKey]);
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

function insertInstanceMemberOnce(sqlite: DatabaseSync): void {
	const exists = sqlite.prepare(`SELECT 1 FROM instance_member WHERE user_id = 'user-1'`).get();
	if (exists !== undefined) return;
	sqlite
		.prepare(
			`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			 VALUES (?, 'owner', 'active', ?, ?)`
		)
		.run('user-1', NOW.toISOString(), NOW.toISOString());
}

function insertEnvelopeOnce(sqlite: DatabaseSync, envelopeId: string): void {
	const exists = sqlite.prepare(`SELECT 1 FROM envelope WHERE id = ?`).get(envelopeId);
	if (exists !== undefined) return;
	insertInstanceMemberOnce(sqlite);
	sqlite
		.prepare(
			`INSERT INTO envelope (
				id, created_by_user_id, title, status, repository_generation, created_at, updated_at
			 ) VALUES (?, 'user-1', 'Agreement', 'completed', 1, ?, ?)`
		)
		.run(envelopeId, NOW.toISOString(), NOW.toISOString());
}

function insertRecipient(sqlite: DatabaseSync, envelopeId: string, recipientId: string): void {
	insertEnvelopeOnce(sqlite, envelopeId);
	sqlite
		.prepare(
			`INSERT INTO recipient (
				id, envelope_id, role, routing_order, name, email, locale, status, created_at, updated_at
			 ) VALUES (?, ?, 'signer', 1, 'Signer', ?, 'en', 'completed', ?, ?)`
		)
		.run(
			recipientId,
			envelopeId,
			`${recipientId}@example.test`,
			NOW.toISOString(),
			NOW.toISOString()
		);
}

function insertFieldValueAssetReference(
	sqlite: DatabaseSync,
	options: {
		envelopeId: string;
		recipientId: string;
		fieldId: string;
		fieldType: 'signature' | 'initials';
		sha256: string;
	}
): void {
	insertRecipient(sqlite, options.envelopeId, options.recipientId);
	sqlite
		.prepare(
			`INSERT INTO envelope_field (
				id, envelope_id, recipient_id, document_path, field_type, label, required, position, created_at, updated_at
			 ) VALUES (?, ?, ?, 'documents/agreement.md', ?, ?, 1, 0, ?, ?)`
		)
		.run(
			options.fieldId,
			options.envelopeId,
			options.recipientId,
			options.fieldType,
			options.fieldType === 'initials' ? 'Initials' : 'Signature',
			NOW.toISOString(),
			NOW.toISOString()
		);
	sqlite
		.prepare(
			`INSERT INTO field_value (
				field_id, envelope_id, recipient_id, field_type, value_json, value_sha256, created_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			options.fieldId,
			options.envelopeId,
			options.recipientId,
			options.fieldType,
			JSON.stringify(`sig:sha256:${options.sha256}`),
			'c'.repeat(64),
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
