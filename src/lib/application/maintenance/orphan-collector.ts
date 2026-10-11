import type { ObjectStore } from '$lib/ports/object-store';
import { MAX_LIST_OBJECTS_LIMIT } from '$lib/ports/object-store';
import type {
	RetireSignatureAssetResult,
	SignatureAssetLedger,
	SignatureAssetScope
} from '$lib/ports/signature-asset-ledger';
import {
	parseSignatureAssetKey,
	referencedSignatureAssetKeys,
	signatureAssetKey,
	type ParsedSignatureAssetKey
} from '$lib/application/documents/signature-asset';
import type { D1Database } from '@cloudflare/workers-types';
import type postgres from 'postgres';

export const DEFAULT_ORPHAN_GRACE_PERIOD_MS: number = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_ORPHAN_BATCH_SIZE: number = 100;
export const MAX_ORPHAN_SCAN_LIMIT: number = MAX_LIST_OBJECTS_LIMIT;
export const D1_MAX_BOUND_PARAMETERS: number = 100;
export const D1_FREE_QUERY_LIMIT: number = 50;
/** Abandoned `pending` signature-asset registrations examined per sweep. */
export const MAX_ABANDONED_SIGNATURE_REGISTRATIONS: number = 25;
const D1_REFERENCE_CHUNK_SIZE: number = DEFAULT_ORPHAN_BATCH_SIZE;
/**
 * Completion artifact objects are written before their DB pointer lands
 * (`completion-artifacts/v1/envelopes/<envelopeId>/sha256/...`, where a valid
 * envelope ID is its own URI segment). While that envelope's primary job is
 * unpublished, or its manifest is published without a PDF pointer (PDF
 * repair pending, discovered or not), every object under its prefix is live:
 * a partial write must survive until publication or repair references it.
 */
const COMPLETION_ARTIFACT_KEY_PREFIX: string = 'completion-artifacts/v1/envelopes/';
const D1_COMPLETION_CANDIDATES: string = `(
		SELECT value AS key,
			substr(value, ${COMPLETION_ARTIFACT_KEY_PREFIX.length + 1},
				instr(substr(value, ${COMPLETION_ARTIFACT_KEY_PREFIX.length + 1}), '/') - 1) AS envelope_id
		FROM json_each(?1)
		WHERE value LIKE '${COMPLETION_ARTIFACT_KEY_PREFIX}%'
			AND instr(substr(value, ${COMPLETION_ARTIFACT_KEY_PREFIX.length + 1}), '/') > 1
	) candidate`;
const D1_REFERENCE_QUERIES: readonly string[] = [
	`SELECT repository_archive_key AS key FROM envelope
	 WHERE repository_archive_key IN (SELECT value FROM json_each(?1))
	 UNION
	 SELECT archive_key AS key FROM draft_revision_command
	 WHERE archive_key IN (SELECT value FROM json_each(?1))
	 UNION
	 SELECT json_object_key AS key FROM completion_artifact
	 WHERE json_object_key IN (SELECT value FROM json_each(?1))
	 UNION
	 SELECT markdown_object_key AS key FROM completion_artifact
	 WHERE markdown_object_key IN (SELECT value FROM json_each(?1))
	 UNION
	 SELECT candidate.key AS key FROM ${D1_COMPLETION_CANDIDATES}
	 WHERE EXISTS (
		SELECT 1 FROM completion_artifact_job job
		WHERE job.envelope_id = candidate.envelope_id AND job.status <> 'published'
	 )`,
	`SELECT pdf_object_key AS key FROM completion_artifact_pdf
	 WHERE pdf_object_key IN (SELECT value FROM json_each(?1))
	 UNION
	 SELECT pdf_manifest_object_key AS key FROM completion_artifact_pdf
	 WHERE pdf_manifest_object_key IN (SELECT value FROM json_each(?1))
	 UNION
	 SELECT object_key AS key FROM envelope_sent_pdf
	 WHERE object_key IN (SELECT value FROM json_each(?1))
	 UNION
	 SELECT object_key AS key FROM envelope_uploaded_document
	 WHERE object_key IN (SELECT value FROM json_each(?1))
	 UNION
	 SELECT candidate.key AS key FROM ${D1_COMPLETION_CANDIDATES}
	 WHERE EXISTS (
		SELECT 1 FROM completion_artifact artifact
		WHERE artifact.envelope_id = candidate.envelope_id
			AND NOT EXISTS (
				SELECT 1 FROM completion_artifact_pdf pdf
				WHERE pdf.envelope_id = artifact.envelope_id
			)
	 )`,
	`SELECT object_key AS key FROM envelope_sent_document
	 WHERE object_key IN (SELECT value FROM json_each(?1))
	 UNION
	 SELECT source_object_key AS key FROM docx_conversion_job
	 WHERE source_object_key IN (SELECT value FROM json_each(?1))
		AND (status IN ('pending','processing') OR (status = 'failed' AND retryable = 1))
	 UNION
	 SELECT result_object_key AS key FROM docx_conversion_job
	 WHERE result_object_key IN (SELECT value FROM json_each(?1)) AND status = 'succeeded'
	 UNION
	 SELECT sealed_object_key AS key FROM pdf_seal_job
	 WHERE sealed_object_key IN (SELECT value FROM json_each(?1))
	 UNION
	 SELECT validation_report_object_key AS key FROM pdf_seal_job
	 WHERE validation_report_object_key IN (SELECT value FROM json_each(?1))`
];

export type OrphanSweepFailureCode =
	| 'checkpoint_read_failed'
	| 'object_list_failed'
	| 'reference_lookup_failed'
	| 'signature_retirement_failed'
	| 'object_delete_failed'
	| 'checkpoint_write_failed';

export type OrphanSweepOperation =
	| 'checkpoint_read'
	| 'object_list'
	| 'reference_lookup'
	| 'signature_retirement'
	| 'object_delete'
	| 'checkpoint_write';

export class OrphanSweepFailure extends Error {
	readonly code: OrphanSweepFailureCode;
	readonly operation: OrphanSweepOperation;

	constructor(code: OrphanSweepFailureCode, operation: OrphanSweepOperation, cause: unknown) {
		super(code, { cause });
		this.name = 'OrphanSweepFailure';
		this.code = code;
		this.operation = operation;
	}
}

export interface OrphanReferenceStore {
	filterReferencedKeys(keys: readonly string[]): Promise<Set<string>>;
}

export interface OrphanCollectorOptions {
	gracePeriodMs?: number;
	batchSize?: number;
	maxObjectsToScan?: number;
	/** Maximum object-store list calls in this invocation. */
	maxListPages?: number;
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
	/**
	 * Abandoned `pending` signature-asset registrations (no object was ever
	 * stored) retired this sweep, or that would be retired under `dryRun`.
	 */
	retiredPendingRegistrations: number;
	nextStartAfter: string;
	/**
	 * True when a durable checkpoint was wired but another writer already
	 * advanced it, so this sweep's `nextStartAfter` was not persisted. The
	 * scan and any deletions above already completed and are not retried or
	 * repeated by this call; the next sweep simply resumes from whatever the
	 * winning writer stored.
	 */
	checkpointConflict: boolean;
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
	readonly #signatureLedger: SignatureAssetLedger | null;

	/**
	 * `signatureLedger` is required to collect drawn signature/initials assets
	 * at all: without it an unreferenced `signature-assets/` object is always
	 * retained, because deleting it could race a concurrent fresh signing.
	 */
	constructor(
		objects: ObjectStore,
		references: OrphanReferenceStore,
		now: () => Date = (): Date => new Date(),
		checkpoint: OrphanSweepCheckpointStore | null = null,
		signatureLedger: SignatureAssetLedger | null = null
	) {
		this.#objects = objects;
		this.#references = references;
		this.#now = now;
		this.#checkpoint = checkpoint;
		this.#signatureLedger = signatureLedger;
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
		const maxListPages = Math.max(1, Math.floor(options.maxListPages ?? Number.MAX_SAFE_INTEGER));
		const dryRun = options.dryRun ?? false;
		const nowTime = this.#now().getTime();
		const nowIso: string = new Date(nowTime).toISOString();
		const touchedBefore: string = new Date(nowTime - gracePeriodMs).toISOString();
		const resume = await runOrphanSweepOperation(
			'checkpoint_read_failed',
			'checkpoint_read',
			async (): Promise<{ stored: string; startAfter: string | undefined }> =>
				this.#resumeAfter(options.startAfter)
		);
		const startAfter = resume.startAfter;

		let scanned = 0;
		let referencedCount = 0;
		let inGracePeriodCount = 0;
		const deletedKeys: string[] = [];

		let cursor: string | undefined = undefined;
		let hasMore = true;
		let lastKey = startAfter ?? '';
		let listedPages = 0;

		while (hasMore && scanned < maxScan && listedPages < maxListPages) {
			const limit = Math.min(batchSize, maxScan - scanned);
			const listed = await runOrphanSweepOperation('object_list_failed', 'object_list', async () =>
				this.#objects.list({
					prefix: options.prefix,
					cursor,
					startAfter: cursor === undefined ? startAfter : undefined,
					limit
				})
			);
			listedPages += 1;

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
				const referencedKeys = await runOrphanSweepOperation(
					'reference_lookup_failed',
					'reference_lookup',
					async (): Promise<Set<string>> => this.#references.filterReferencedKeys(candidates)
				);
				referencedCount += referencedKeys.size;

				const orphans = candidates.filter((k) => !referencedKeys.has(k));
				const deletable: string[] = [];
				for (const key of orphans) {
					const asset: ParsedSignatureAssetKey | null = parseSignatureAssetKey(key);
					if (asset === null) {
						deletable.push(key);
						continue;
					}
					// Commit the one-way retirement before any delete, so a fresh
					// signing either already touched/bound the row (retained here) or
					// can never bind this exact key afterwards.
					const retirable: boolean = await runOrphanSweepOperation(
						'signature_retirement_failed',
						'signature_retirement',
						async (): Promise<boolean> =>
							this.#retireSignatureAsset(asset, nowIso, touchedBefore, dryRun)
					);
					if (retirable) deletable.push(key);
					else referencedCount += 1;
				}
				if (deletable.length > 0) {
					if (!dryRun) {
						await runOrphanSweepOperation(
							'object_delete_failed',
							'object_delete',
							async (): Promise<void> => this.#objects.deleteMany(deletable)
						);
					}
					deletedKeys.push(...deletable);
				}
			}

			hasMore = listed.truncated && listed.cursor !== undefined;
			cursor = listed.cursor;
		}

		const retiredPendingRegistrations: number = await runOrphanSweepOperation(
			'signature_retirement_failed',
			'signature_retirement',
			async (): Promise<number> => this.#retireAbandonedRegistrations(nowIso, touchedBefore, dryRun)
		);

		const nextStartAfter = hasMore && lastKey.length > 0 ? lastKey : '';
		let checkpointConflict = false;
		const checkpoint: OrphanSweepCheckpointStore | null = this.#checkpoint;
		if (checkpoint !== null) {
			const advanced = await runOrphanSweepOperation(
				'checkpoint_write_failed',
				'checkpoint_write',
				async (): Promise<boolean> =>
					checkpoint.compareAndSwapLastObjectKey(resume.stored, nextStartAfter)
			);
			checkpointConflict = !advanced;
		}

		return {
			scanned,
			referenced: referencedCount,
			inGracePeriod: inGracePeriodCount,
			deleted: deletedKeys.length,
			deletedKeys,
			retiredPendingRegistrations,
			nextStartAfter,
			checkpointConflict
		};
	}

	/** True when this unreferenced signature asset's object may be deleted. Never writes under `dryRun`. */
	async #retireSignatureAsset(
		asset: ParsedSignatureAssetKey,
		nowIso: string,
		touchedBefore: string,
		dryRun: boolean
	): Promise<boolean> {
		const ledger: SignatureAssetLedger | null = this.#signatureLedger;
		if (ledger === null) return false;
		const scope: SignatureAssetScope = {
			envelopeId: asset.envelopeId,
			recipientId: asset.recipientId,
			sha256: asset.sha256
		};
		if (dryRun) return await ledger.previewRetirement(scope, touchedBefore);
		const state: RetireSignatureAssetResult = await ledger.retireOrphan(
			scope,
			nowIso,
			touchedBefore
		);
		return state === 'retired' || state === 'unowned';
	}

	/**
	 * Bounded, DB-driven cleanup of `pending` registrations whose upload never
	 * stored an object (a crash between registration and put). A registration
	 * whose object exists is left to the object listing above.
	 */
	async #retireAbandonedRegistrations(
		nowIso: string,
		touchedBefore: string,
		dryRun: boolean
	): Promise<number> {
		const ledger: SignatureAssetLedger | null = this.#signatureLedger;
		if (ledger === null) return 0;
		const pending: readonly SignatureAssetScope[] = await ledger.listPendingBefore(
			touchedBefore,
			MAX_ABANDONED_SIGNATURE_REGISTRATIONS
		);
		let retired: number = 0;
		for (const scope of pending) {
			const key: string = signatureAssetKey(scope.envelopeId, scope.recipientId, scope.sha256);
			if ((await this.#objects.head(key)) !== null) continue;
			if (dryRun || (await ledger.retireAbandonedPending(scope, touchedBefore, nowIso))) {
				retired += 1;
			}
		}
		return retired;
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

		// D1 allows 100 bound parameters per statement, five terms per compound
		// SELECT, and 50 queries per invocation on the free plan. Three batched
		// set-based queries keep every UNION below that limit. Each query expands
		// one bound JSON array through json_each instead of repeating the
		// candidate list for every reference source.
		for (let i = 0; i < keys.length; i += D1_REFERENCE_CHUNK_SIZE) {
			const chunk = keys.slice(i, i + D1_REFERENCE_CHUNK_SIZE);
			const serializedKeys: string = JSON.stringify(chunk);
			const results: D1Result<{ key: string }>[] = await this.#database.batch<{ key: string }>(
				D1_REFERENCE_QUERIES.map((query: string): D1PreparedStatement =>
					this.#database.prepare(query).bind(serializedKeys)
				)
			);
			for (const result of results) {
				for (const row of result.results ?? []) {
					if (row.key) referenced.add(row.key);
				}
			}

			for (const key of await filterSignatureAssetReferences(
				chunk,
				loadD1SignatureFieldValues(this.#database)
			)) {
				referenced.add(key);
			}
		}

		return referenced;
	}
}

async function runOrphanSweepOperation<T>(
	code: OrphanSweepFailureCode,
	operation: OrphanSweepOperation,
	run: () => Promise<T>
): Promise<T> {
	try {
		return await run();
	} catch (error: unknown) {
		if (error instanceof OrphanSweepFailure) throw error;
		throw new OrphanSweepFailure(code, operation, error);
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
				UNION
				SELECT object_key AS key FROM envelope_sent_pdf WHERE object_key = ANY(${chunk})
				UNION
				SELECT object_key AS key FROM envelope_uploaded_document WHERE object_key = ANY(${chunk})
				UNION
				SELECT object_key AS key FROM envelope_sent_document WHERE object_key = ANY(${chunk})
				UNION
				SELECT source_object_key AS key FROM docx_conversion_job
				WHERE source_object_key = ANY(${chunk})
					AND (status IN ('pending','processing') OR (status = 'failed' AND retryable))
				UNION
				SELECT result_object_key AS key FROM docx_conversion_job
				WHERE result_object_key = ANY(${chunk}) AND status = 'succeeded'
				UNION
				SELECT sealed_object_key AS key FROM pdf_seal_job
				WHERE sealed_object_key = ANY(${chunk})
				UNION
				SELECT validation_report_object_key AS key FROM pdf_seal_job
				WHERE validation_report_object_key = ANY(${chunk})
				UNION
				SELECT candidate.key FROM unnest(${chunk}::text[]) AS candidate(key)
				WHERE candidate.key LIKE ${COMPLETION_ARTIFACT_KEY_PREFIX + '%'}
					AND (
						EXISTS (
							SELECT 1 FROM completion_artifact_job job
							WHERE job.envelope_id = split_part(candidate.key, '/', 4)
								AND job.status <> 'published'
						)
						OR EXISTS (
							SELECT 1 FROM completion_artifact artifact
							WHERE artifact.envelope_id = split_part(candidate.key, '/', 4)
								AND NOT EXISTS (
									SELECT 1 FROM completion_artifact_pdf pdf
									WHERE pdf.envelope_id = artifact.envelope_id
								)
						)
					)
			`;

			for (const row of rows) {
				if (row.key) referenced.add(row.key);
			}

			for (const key of await filterSignatureAssetReferences(
				chunk,
				loadPostgresSignatureFieldValues(this.#sql)
			)) {
				referenced.add(key);
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

interface SignatureFieldValueRow {
	envelopeId: string;
	recipientId: string;
	valueJson: string;
}

type SignatureFieldValueLoader = (
	scopes: readonly ParsedSignatureAssetKey[]
) => Promise<readonly SignatureFieldValueRow[]>;

async function filterSignatureAssetReferences(
	keys: readonly string[],
	load: SignatureFieldValueLoader
): Promise<Set<string>> {
	const parsed: ParsedSignatureAssetKey[] = [];
	for (const key of keys) {
		const asset: ParsedSignatureAssetKey | null = parseSignatureAssetKey(key);
		if (asset !== null) parsed.push(asset);
	}
	if (parsed.length === 0) return new Set();
	const fieldValues: readonly SignatureFieldValueRow[] = await load(parsed);
	return referencedSignatureAssetKeys(keys, fieldValues);
}

function loadD1SignatureFieldValues(database: D1Database): SignatureFieldValueLoader {
	return async (
		scopes: readonly ParsedSignatureAssetKey[]
	): Promise<readonly SignatureFieldValueRow[]> => {
		const serializedScopes: string = JSON.stringify(
			scopes.map((scope: ParsedSignatureAssetKey): readonly [string, string] => [
				scope.envelopeId,
				scope.recipientId
			])
		);
		const rows = await database
			.prepare(
				`SELECT envelope_id, recipient_id, value_json
				 FROM field_value AS field
				 INNER JOIN json_each(?1) AS scope
					ON field.envelope_id = json_extract(scope.value, '$[0]')
					AND field.recipient_id = json_extract(scope.value, '$[1]')
				 WHERE field_type IN ('signature', 'initials')`
			)
			.bind(serializedScopes)
			.all<{
				envelope_id: string;
				recipient_id: string;
				value_json: string;
			}>();
		return (rows.results ?? []).map((row): SignatureFieldValueRow => ({
			envelopeId: row.envelope_id,
			recipientId: row.recipient_id,
			valueJson: row.value_json
		}));
	};
}

function loadPostgresSignatureFieldValues(
	sql: ReturnType<typeof postgres>
): SignatureFieldValueLoader {
	return async (
		scopes: readonly ParsedSignatureAssetKey[]
	): Promise<readonly SignatureFieldValueRow[]> => {
		// Row-aligned unnest so each candidate's (envelope, recipient) is
		// matched as one tuple, not cross-matched from two independent sets.
		const envelopeIds: string[] = scopes.map((scope) => scope.envelopeId);
		const recipientIds: string[] = scopes.map((scope) => scope.recipientId);
		const rows = await sql<
			{
				envelopeId: string;
				recipientId: string;
				valueJson: string;
			}[]
		>`
			SELECT fv.envelope_id AS "envelopeId",
				fv.recipient_id AS "recipientId", fv.value_json AS "valueJson"
			FROM field_value fv
			INNER JOIN (
				SELECT
					unnest(${envelopeIds}::text[]) AS envelope_id,
					unnest(${recipientIds}::text[]) AS recipient_id
			) scope
				ON fv.envelope_id = scope.envelope_id
				AND fv.recipient_id = scope.recipient_id
			WHERE fv.field_type IN ('signature', 'initials')
		`;
		return rows;
	};
}
