import type { ObjectStore } from '$lib/ports/object-store';
import { MAX_LIST_OBJECTS_LIMIT } from '$lib/ports/object-store';
import type { D1Database } from '@cloudflare/workers-types';
import type postgres from 'postgres';

export const DEFAULT_ORPHAN_GRACE_PERIOD_MS: number = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_ORPHAN_BATCH_SIZE: number = 100;
export const MAX_ORPHAN_SCAN_LIMIT: number = MAX_LIST_OBJECTS_LIMIT;

export interface OrphanReferenceStore {
	filterReferencedKeys(keys: readonly string[]): Promise<Set<string>>;
}

export interface OrphanCollectorOptions {
	gracePeriodMs?: number;
	batchSize?: number;
	maxObjectsToScan?: number;
	dryRun?: boolean;
	prefix?: string;
	/** Exclusive resume key for this invocation when no durable checkpoint is wired. */
	startAfter?: string;
}

export interface OrphanCollectorReport {
	scanned: number;
	referenced: number;
	inGracePeriod: number;
	deleted: number;
	deletedKeys: readonly string[];
	nextStartAfter: string;
}

export interface OrphanSweepCheckpointStore {
	readLastObjectKey(): Promise<string>;
	/**
	 * Atomically replace `expected` with `next` on the singleton row.
	 * Returns false when another writer already advanced the checkpoint.
	 */
	compareAndSwapLastObjectKey(expected: string, next: string): Promise<boolean>;
}

export class OrphanCollector {
	readonly #objects: ObjectStore;
	readonly #references: OrphanReferenceStore;
	readonly #now: () => Date;
	readonly #checkpoint: OrphanSweepCheckpointStore | null;

	constructor(
		objects: ObjectStore,
		references: OrphanReferenceStore,
		now: () => Date = (): Date => new Date(),
		checkpoint: OrphanSweepCheckpointStore | null = null
	) {
		this.#objects = objects;
		this.#references = references;
		this.#now = now;
		this.#checkpoint = checkpoint;
	}

	async sweep(options: OrphanCollectorOptions = {}): Promise<OrphanCollectorReport> {
		const gracePeriodMs = Math.max(
			options.gracePeriodMs ?? DEFAULT_ORPHAN_GRACE_PERIOD_MS,
			DEFAULT_ORPHAN_GRACE_PERIOD_MS
		);
		const batchSize = Math.max(
			1,
			Math.min(options.batchSize ?? DEFAULT_ORPHAN_BATCH_SIZE, MAX_ORPHAN_SCAN_LIMIT)
		);
		const maxScan = Math.max(
			1,
			Math.min(options.maxObjectsToScan ?? MAX_ORPHAN_SCAN_LIMIT, MAX_ORPHAN_SCAN_LIMIT)
		);
		const dryRun = options.dryRun ?? false;
		const nowTime = this.#now().getTime();
		const resume = await this.#resumeAfter(options.startAfter);
		const startAfter = resume.startAfter;

		let scanned = 0;
		let referencedCount = 0;
		let inGracePeriodCount = 0;
		const deletedKeys: string[] = [];

		let cursor: string | undefined = undefined;
		let hasMore = true;
		let lastKey = startAfter ?? '';

		while (hasMore && scanned < maxScan) {
			const limit = Math.min(batchSize, maxScan - scanned);
			const listed = await this.#objects.list({
				prefix: options.prefix,
				cursor,
				startAfter: cursor === undefined ? startAfter : undefined,
				limit
			});

			if (listed.objects.length === 0) {
				hasMore = false;
				break;
			}

			const candidates: string[] = [];
			for (const obj of listed.objects) {
				scanned += 1;
				lastKey = obj.key;
				if (!isSafeObjectKey(obj.key)) continue;
				const ageMs = uploadAgeMs(obj.uploadedAt, nowTime);
				if (ageMs === null || ageMs < gracePeriodMs) {
					inGracePeriodCount += 1;
					continue;
				}
				candidates.push(obj.key);
			}

			if (candidates.length > 0) {
				const referencedKeys = await this.#references.filterReferencedKeys(candidates);
				referencedCount += referencedKeys.size;

				const orphans = candidates.filter((k) => !referencedKeys.has(k));
				if (orphans.length > 0) {
					if (!dryRun) {
						await this.#objects.deleteMany(orphans);
					}
					deletedKeys.push(...orphans);
				}
			}

			hasMore = listed.truncated && listed.cursor !== undefined;
			cursor = listed.cursor;
		}

		const nextStartAfter = hasMore && lastKey.length > 0 ? lastKey : '';
		if (this.#checkpoint !== null) {
			await this.#checkpoint.compareAndSwapLastObjectKey(resume.stored, nextStartAfter);
		}

		return {
			scanned,
			referenced: referencedCount,
			inGracePeriod: inGracePeriodCount,
			deleted: deletedKeys.length,
			deletedKeys,
			nextStartAfter
		};
	}

	async #resumeAfter(
		requested: string | undefined
	): Promise<{ stored: string; startAfter: string | undefined }> {
		const stored: string =
			this.#checkpoint !== null ? await this.#checkpoint.readLastObjectKey() : (requested ?? '');
		if (stored.length === 0) return { stored: '', startAfter: undefined };
		if (!isSafeObjectKey(stored)) {
			throw new Error('orphan sweep checkpoint is not a safe object key');
		}
		return { stored, startAfter: stored };
	}
}

export class D1OrphanReferenceStore implements OrphanReferenceStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async filterReferencedKeys(keys: readonly string[]): Promise<Set<string>> {
		if (keys.length === 0) return new Set();
		const referenced = new Set<string>();

		// Chunk to avoid SQLite variable limit
		const CHUNK_SIZE = 50;
		for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
			const chunk = keys.slice(i, i + CHUNK_SIZE);
			const placeholders = chunk.map(() => '?').join(',');

			const query = `
				SELECT repository_archive_key AS key FROM envelope WHERE repository_archive_key IN (${placeholders})
				UNION
				SELECT archive_key AS key FROM draft_revision_command WHERE archive_key IN (${placeholders})
				UNION
				SELECT json_object_key AS key FROM completion_artifact WHERE json_object_key IN (${placeholders})
				UNION
				SELECT markdown_object_key AS key FROM completion_artifact WHERE markdown_object_key IN (${placeholders})
				UNION
				SELECT pdf_object_key AS key FROM completion_artifact_pdf WHERE pdf_object_key IN (${placeholders})
				UNION
				SELECT pdf_manifest_object_key AS key FROM completion_artifact_pdf WHERE pdf_manifest_object_key IN (${placeholders})
			`;

			const bindings = [...chunk, ...chunk, ...chunk, ...chunk, ...chunk, ...chunk];

			const rows = await this.#database
				.prepare(query)
				.bind(...bindings)
				.all<{ key: string }>();
			for (const row of rows.results ?? []) {
				if (row.key) referenced.add(row.key);
			}
		}

		return referenced;
	}
}

export class PostgresOrphanReferenceStore implements OrphanReferenceStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async filterReferencedKeys(keys: readonly string[]): Promise<Set<string>> {
		if (keys.length === 0) return new Set();
		const referenced = new Set<string>();

		const CHUNK_SIZE = 200;
		for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
			const chunk = keys.slice(i, i + CHUNK_SIZE);

			const rows = await this.#sql<{ key: string }[]>`
				SELECT repository_archive_key AS key FROM envelope WHERE repository_archive_key = ANY(${chunk})
				UNION
				SELECT archive_key AS key FROM draft_revision_command WHERE archive_key = ANY(${chunk})
				UNION
				SELECT json_object_key AS key FROM completion_artifact WHERE json_object_key = ANY(${chunk})
				UNION
				SELECT markdown_object_key AS key FROM completion_artifact WHERE markdown_object_key = ANY(${chunk})
				UNION
				SELECT pdf_object_key AS key FROM completion_artifact_pdf WHERE pdf_object_key = ANY(${chunk})
				UNION
				SELECT pdf_manifest_object_key AS key FROM completion_artifact_pdf WHERE pdf_manifest_object_key = ANY(${chunk})
			`;

			for (const row of rows) {
				if (row.key) referenced.add(row.key);
			}
		}

		return referenced;
	}
}

const CHECKPOINT_SINGLETON: number = 1;

export class D1OrphanSweepCheckpointStore implements OrphanSweepCheckpointStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async readLastObjectKey(): Promise<string> {
		const row = await this.#database
			.prepare('SELECT last_object_key AS key FROM orphan_sweep_checkpoint WHERE singleton = ?')
			.bind(CHECKPOINT_SINGLETON)
			.first<{ key: string }>();
		return normalizeCheckpointKey(row?.key);
	}

	async compareAndSwapLastObjectKey(expected: string, next: string): Promise<boolean> {
		const expectedKey = normalizeCheckpointKey(expected);
		const nextKey = normalizeCheckpointKey(next);
		const updatedAt = new Date().toISOString();
		const result = await this.#database
			.prepare(
				`UPDATE orphan_sweep_checkpoint
				 SET last_object_key = ?, updated_at = ?
				 WHERE singleton = ? AND last_object_key = ?`
			)
			.bind(nextKey, updatedAt, CHECKPOINT_SINGLETON, expectedKey)
			.run();
		return (result.meta.changes ?? 0) === 1;
	}
}

export class PostgresOrphanSweepCheckpointStore implements OrphanSweepCheckpointStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async readLastObjectKey(): Promise<string> {
		const rows = await this.#sql<{ key: string }[]>`
			SELECT last_object_key AS key FROM orphan_sweep_checkpoint WHERE singleton = ${CHECKPOINT_SINGLETON}
		`;
		return normalizeCheckpointKey(rows[0]?.key);
	}

	async compareAndSwapLastObjectKey(expected: string, next: string): Promise<boolean> {
		const expectedKey = normalizeCheckpointKey(expected);
		const nextKey = normalizeCheckpointKey(next);
		const rows = await this.#sql<{ key: string }[]>`
			UPDATE orphan_sweep_checkpoint
			SET last_object_key = ${nextKey}, updated_at = NOW()
			WHERE singleton = ${CHECKPOINT_SINGLETON} AND last_object_key = ${expectedKey}
			RETURNING last_object_key AS key
		`;
		return rows.length === 1;
	}
}

function normalizeCheckpointKey(key: string | undefined): string {
	if (key === undefined || key.length === 0) return '';
	if (!isSafeObjectKey(key)) {
		throw new Error('orphan sweep checkpoint is not a safe object key');
	}
	return key;
}

function isSafeObjectKey(key: string): boolean {
	return key.length > 0 && !key.startsWith('/') && !key.includes('..') && !key.includes('\\');
}

function uploadAgeMs(uploadedAt: string | undefined, nowTime: number): number | null {
	if (uploadedAt === undefined || uploadedAt.trim().length === 0) return null;
	const uploadTime: number = Date.parse(uploadedAt);
	if (!Number.isFinite(uploadTime)) return null;
	return nowTime - uploadTime;
}
