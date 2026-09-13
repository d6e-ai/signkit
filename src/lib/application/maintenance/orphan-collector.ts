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
}

export interface OrphanCollectorReport {
	scanned: number;
	referenced: number;
	inGracePeriod: number;
	deleted: number;
	deletedKeys: readonly string[];
}

export class OrphanCollector {
	readonly #objects: ObjectStore;
	readonly #references: OrphanReferenceStore;
	readonly #now: () => Date;

	constructor(
		objects: ObjectStore,
		references: OrphanReferenceStore,
		now: () => Date = (): Date => new Date()
	) {
		this.#objects = objects;
		this.#references = references;
		this.#now = now;
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

		let scanned = 0;
		let referencedCount = 0;
		let inGracePeriodCount = 0;
		const deletedKeys: string[] = [];

		let cursor: string | undefined = undefined;
		let hasMore = true;

		while (hasMore && scanned < maxScan) {
			const limit = Math.min(batchSize, maxScan - scanned);
			const listed = await this.#objects.list({
				prefix: options.prefix,
				cursor,
				limit
			});

			if (listed.objects.length === 0) break;

			const candidates: string[] = [];
			for (const obj of listed.objects) {
				scanned += 1;
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

		return {
			scanned,
			referenced: referencedCount,
			inGracePeriod: inGracePeriodCount,
			deleted: deletedKeys.length,
			deletedKeys
		};
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

function isSafeObjectKey(key: string): boolean {
	return key.length > 0 && !key.startsWith('/') && !key.includes('..') && !key.includes('\\');
}

function uploadAgeMs(uploadedAt: string | undefined, nowTime: number): number | null {
	if (uploadedAt === undefined || uploadedAt.trim().length === 0) return null;
	const uploadTime: number = Date.parse(uploadedAt);
	if (!Number.isFinite(uploadTime)) return null;
	return nowTime - uploadTime;
}
