import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1SignatureAssetLedger } from '$lib/adapters/db/d1-signature-asset-ledger';
import { applyD1Migrations, sqliteD1Database } from '$lib/adapters/db/sqlite-d1-test-support';
import { signatureAssetKey } from '$lib/application/documents/signature-asset';
import {
	ORPHAN_SWEEP_BATCH_SIZE,
	ORPHAN_SWEEP_MAX_LIST_PAGES,
	ORPHAN_SWEEP_MAX_OBJECTS
} from '$lib/http/orphan-sweep';
import type { SignatureAssetScope } from '$lib/ports/signature-asset-ledger';
import {
	D1_FREE_QUERY_LIMIT,
	D1_ORPHAN_SWEEP_STATEMENT_BUDGET,
	D1OrphanReferenceStore,
	D1OrphanSweepCheckpointStore,
	OrphanCollector,
	type OrphanCollectorOptions,
	type OrphanCollectorReport
} from './orphan-collector';
import {
	AgedObjectStore,
	RETENTION_AGED_AT,
	RETENTION_ENVELOPE_ID,
	RETENTION_NOW,
	RETENTION_SIGNER_ID
} from './signature-asset-retention-test-support';

/** The exact options the HTTP orphan-sweep route (and so the cron) passes. */
const ROUTE_OPTIONS: OrphanCollectorOptions = {
	batchSize: ORPHAN_SWEEP_BATCH_SIZE,
	maxObjectsToScan: ORPHAN_SWEEP_MAX_OBJECTS,
	maxListPages: ORPHAN_SWEEP_MAX_LIST_PAGES
};
const LIVE_ARCHIVE_KEY: string = 'archives/live.git.gz';

class D1QueryLimitExceeded extends Error {}

/**
 * Counts every SQL statement the D1 adapters actually execute (each
 * `all`/`first`/`run`, including each statement inside a batch, prepares
 * exactly once) and fails the statement past `limit`, simulating D1's
 * per-invocation query limit. Transaction control for batches is not a query.
 */
function countingDatabase(sqlite: DatabaseSync): {
	database: D1Database;
	counter: { executed: number; limit: number };
} {
	const counter = { executed: 0, limit: Number.POSITIVE_INFINITY };
	const proxy = new Proxy(sqlite, {
		get(target: DatabaseSync, property: string | symbol): unknown {
			if (property === 'prepare') {
				return (sql: string) => {
					counter.executed += 1;
					if (counter.executed > counter.limit) throw new D1QueryLimitExceeded(sql);
					return target.prepare(sql);
				};
			}
			const value: unknown = Reflect.get(target, property);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	return { database: sqliteD1Database(proxy), counter };
}

/** Distinct hex digest per (salt, index); salts are long enough never to collide with plain indexes. */
function sha(index: number, salt: string = ''): string {
	return `${salt}${index.toString(16)}`.padStart(64, '0');
}
const ABANDONED_SALT: string = 'abcdef0';
const FRESH_SALT: string = 'fedcba0';

interface Fixture {
	sqlite: DatabaseSync;
	objects: AgedObjectStore;
	ledger: D1SignatureAssetLedger;
	collector: OrphanCollector;
	/** Runs one sweep under the simulated 50-query limit and reports statements executed. */
	sweep(
		options?: OrphanCollectorOptions
	): Promise<{ report: OrphanCollectorReport; statements: number }>;
	checkpoint(): string;
	ledgerSnapshot(): string;
	retiredCount(): number;
}

function fixture(): Fixture {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	sqlite.exec(`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('user-1', 'owner', 'active', '${RETENTION_AGED_AT}', '${RETENTION_AGED_AT}')`);
	sqlite
		.prepare(
			`INSERT INTO envelope (
				id, created_by_user_id, title, status, repository_generation, repository_head,
				repository_archive_key, repository_archive_sha256, sent_commit_sha,
				field_generation, created_at, updated_at
			) VALUES (?, 'user-1', 'Agreement', 'in_progress', 1, ?, ?, ?, ?, 1, ?, ?)`
		)
		.run(
			RETENTION_ENVELOPE_ID,
			'0'.repeat(40),
			LIVE_ARCHIVE_KEY,
			'a'.repeat(64),
			'0'.repeat(40),
			RETENTION_AGED_AT,
			RETENTION_AGED_AT
		);
	sqlite
		.prepare(
			`INSERT INTO recipient (
				id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at
			) VALUES (?, ?, 'alice@example.test', 'Alice', 'signer', 'en', 1, 'viewed', ?, ?)`
		)
		.run(RETENTION_SIGNER_ID, RETENTION_ENVELOPE_ID, RETENTION_AGED_AT, RETENTION_AGED_AT);
	const { database, counter } = countingDatabase(sqlite);
	const objects = new AgedObjectStore();
	objects.seed(LIVE_ARCHIVE_KEY, new Uint8Array([1]));
	const ledger = new D1SignatureAssetLedger(database);
	const collector = new OrphanCollector(
		objects,
		new D1OrphanReferenceStore(database),
		(): Date => RETENTION_NOW,
		new D1OrphanSweepCheckpointStore(database),
		ledger,
		D1_ORPHAN_SWEEP_STATEMENT_BUDGET
	);
	return {
		sqlite,
		objects,
		ledger,
		collector,
		sweep: async (options: OrphanCollectorOptions = ROUTE_OPTIONS) => {
			counter.executed = 0;
			counter.limit = D1_FREE_QUERY_LIMIT;
			try {
				const report: OrphanCollectorReport = await collector.sweep(options);
				return { report, statements: counter.executed };
			} finally {
				counter.limit = Number.POSITIVE_INFINITY;
			}
		},
		checkpoint: (): string =>
			(
				sqlite
					.prepare('SELECT last_object_key AS key FROM orphan_sweep_checkpoint WHERE singleton = 1')
					.get() as { key: string }
			).key,
		ledgerSnapshot: (): string =>
			JSON.stringify(
				sqlite
					.prepare('SELECT * FROM signature_asset ORDER BY envelope_id, recipient_id, sha256')
					.all()
			),
		retiredCount: (): number =>
			Number(
				(
					sqlite
						.prepare(`SELECT count(*) AS count FROM signature_asset WHERE state = 'retired'`)
						.get() as { count: number }
				).count
			)
	};
}

/** Aged objects under one recipient: two signature PNGs for every generic (non-PNG) key, interleaved. */
function seedMixed(
	objects: AgedObjectStore,
	count: number,
	signaturesOnly: boolean = false
): string[] {
	const keys: string[] = [];
	for (let index: number = 0; index < count; index += 1) {
		const png: string = signatureAssetKey(RETENTION_ENVELOPE_ID, RETENTION_SIGNER_ID, sha(index));
		const key: string = signaturesOnly || index % 3 !== 2 ? png : png.replace(/\.png$/, '.txt');
		objects.seed(key, new Uint8Array([1]));
		keys.push(key);
	}
	return keys;
}

function scope(index: number, salt: string): SignatureAssetScope {
	return {
		envelopeId: RETENTION_ENVELOPE_ID,
		recipientId: RETENTION_SIGNER_ID,
		sha256: sha(index, salt)
	};
}

async function seedAbandoned(ledger: D1SignatureAssetLedger, count: number): Promise<void> {
	for (let index: number = 0; index < count; index += 1) {
		await ledger.registerPending(scope(index, ABANDONED_SALT), RETENTION_AGED_AT);
	}
}

// D1 adapters on node:sqlite (not workerd), with every executed statement counted.
describe('D1 orphan sweep statement budget (node:sqlite)', () => {
	it('spends exactly its 40-statement budget on a full signature page and checkpoints after it', async () => {
		const f: Fixture = fixture();
		const keys: string[] = seedMixed(f.objects, 1200, true);
		await seedAbandoned(f.ledger, 25);

		const { report, statements } = await f.sweep();

		// 1 checkpoint read + 6 chunks x (4 reference + 2 retirement)
		// + 2 abandoned-registration statements + 1 checkpoint write.
		expect(statements).toBe(40);
		expect(statements).toBeLessThanOrEqual(D1_ORPHAN_SWEEP_STATEMENT_BUDGET.maxStatements);
		const sorted: string[] = [LIVE_ARCHIVE_KEY, ...keys].sort();
		expect(report.scanned).toBe(600);
		expect(report.retiredPendingRegistrations).toBe(25);
		expect(report.nextStartAfter).toBe(sorted[599]);
		expect(f.checkpoint()).toBe(sorted[599]);
		expect([...f.objects.keys()].sort()).toEqual([LIVE_ARCHIVE_KEY, ...sorted.slice(600)].sort());
	});

	it('collects >=1000 mixed aged keys over repeated route sweeps, each within budget', async () => {
		const f: Fixture = fixture();
		const keys: string[] = seedMixed(f.objects, 1500);
		const fresh: SignatureAssetScope[] = Array.from({ length: 10 }, (_, index) =>
			scope(index, FRESH_SALT)
		);
		for (const freshScope of fresh) {
			await f.ledger.registerPending(freshScope, RETENTION_NOW.toISOString());
			f.objects.seed(
				signatureAssetKey(freshScope.envelopeId, freshScope.recipientId, freshScope.sha256),
				new Uint8Array([1])
			);
		}
		await seedAbandoned(f.ledger, 25);
		const statements: number[] = [];
		const checkpoints: string[] = [];

		for (let sweep: number = 0; sweep < 5; sweep += 1) {
			const result = await f.sweep();
			statements.push(result.statements);
			checkpoints.push(f.checkpoint());
			if (f.checkpoint() === '') break;
		}

		expect(Math.max(...statements)).toBeLessThanOrEqual(
			D1_ORPHAN_SWEEP_STATEMENT_BUDGET.maxStatements
		);
		expect(checkpoints.at(-1)).toBe('');
		// Strict forward progress until the listing wrapped.
		const advancing: string[] = checkpoints.slice(0, -1);
		expect(advancing).toEqual([...advancing].sort());
		expect(new Set(advancing).size).toBe(advancing.length);
		const retained: string[] = [
			LIVE_ARCHIVE_KEY,
			...fresh.map((freshScope) =>
				signatureAssetKey(freshScope.envelopeId, freshScope.recipientId, freshScope.sha256)
			)
		].sort();
		expect([...f.objects.keys()].sort()).toEqual(retained);
		const signatures: number = keys.filter((key: string): boolean => key.endsWith('.png')).length;
		expect(f.retiredCount()).toBe(signatures + 25);
	});

	it('stays within budget on small pages and still makes progress', async () => {
		const f: Fixture = fixture();
		const keys: string[] = seedMixed(f.objects, 200);
		await seedAbandoned(f.ledger, 25);

		const { report, statements } = await f.sweep({ batchSize: 1 });

		expect(statements).toBeLessThanOrEqual(D1_ORPHAN_SWEEP_STATEMENT_BUDGET.maxStatements);
		const sorted: string[] = [LIVE_ARCHIVE_KEY, ...keys].sort();
		// Each one-key page is charged a whole chunk: 36 page statements / 6.
		expect(report.scanned).toBe(6);
		expect(f.checkpoint()).toBe(sorted[5]);

		const next = await f.sweep({ batchSize: 1 });
		expect(next.statements).toBeLessThanOrEqual(D1_ORPHAN_SWEEP_STATEMENT_BUDGET.maxStatements);
		expect(f.checkpoint()).toBe(sorted[11]);
	});

	it('bounds already-retired retries to the same per-chunk cost', async () => {
		const f: Fixture = fixture();
		const keys: string[] = seedMixed(f.objects, 1000, true);
		for (let offset: number = 0; offset < keys.length; offset += 100) {
			await f.ledger.retireOrphans(
				Array.from({ length: 100 }, (_, index) => scope(offset + index, '')),
				RETENTION_NOW.toISOString(),
				RETENTION_AGED_AT
			);
		}

		const { report, statements } = await f.sweep();

		// 1 read + 6 x 6 chunk statements + 1 pending listing (no abandoned
		// registrations, so no bulk update) + 1 write.
		expect(statements).toBe(39);
		expect(report.deleted).toBe(599);
	});

	it('dry-run previews within budget without writing the ledger or deleting objects', async () => {
		const f: Fixture = fixture();
		seedMixed(f.objects, 1200);
		await seedAbandoned(f.ledger, 25);
		const ledgerBefore: string = f.ledgerSnapshot();
		const objectsBefore: number = f.objects.size;

		const { report, statements } = await f.sweep({ ...ROUTE_OPTIONS, dryRun: true });

		expect(statements).toBeLessThanOrEqual(D1_ORPHAN_SWEEP_STATEMENT_BUDGET.maxStatements);
		expect(report.scanned).toBe(600);
		expect(report.deleted).toBe(599);
		expect(report.retiredPendingRegistrations).toBe(25);
		expect(f.ledgerSnapshot()).toBe(ledgerBefore);
		expect(f.objects.size).toBe(objectsBefore);
	});

	it.each(['before_delete', 'after_delete'] as const)(
		'keeps the checkpoint on a %s provider failure and resumes the same page within budget',
		async (failure: 'before_delete' | 'after_delete') => {
			const f: Fixture = fixture();
			seedMixed(f.objects, 1200);
			await seedAbandoned(f.ledger, 25);
			f.objects.deleteFailures = failure;

			await expect(f.sweep()).rejects.toMatchObject({ code: 'object_delete_failed' });
			expect(f.checkpoint()).toBe('');
			// The first chunk's retirements are durable before the failed delete.
			expect(f.retiredCount()).toBeGreaterThan(0);
			const beforeRetry: string[] = [...f.objects.keys()].sort();
			// `before_delete` deleted nothing; `after_delete` already deleted the first chunk.
			expect(beforeRetry.length).toBe(failure === 'before_delete' ? 1201 : 1201 - 99);

			const retry = await f.sweep();
			expect(retry.statements).toBeLessThanOrEqual(D1_ORPHAN_SWEEP_STATEMENT_BUDGET.maxStatements);
			expect(retry.report.scanned).toBe(600);
			// The retry resumes from the unchanged checkpoint: exactly the next 600 keys.
			expect(retry.report.nextStartAfter).toBe(beforeRetry[599]);
			expect(f.checkpoint()).toBe(retry.report.nextStartAfter);
			// Nothing the retry listed survives unless it is live.
			expect(f.objects.keys().filter((key) => key <= retry.report.nextStartAfter)).toEqual([
				LIVE_ARCHIVE_KEY
			]);
		}
	);

	it('refuses a budget that cannot process a single chunk', () => {
		const sqlite = new DatabaseSync(':memory:');
		applyD1Migrations(sqlite);
		const database: D1Database = sqliteD1Database(sqlite);
		expect(
			() =>
				new OrphanCollector(
					new AgedObjectStore(),
					new D1OrphanReferenceStore(database),
					(): Date => RETENTION_NOW,
					new D1OrphanSweepCheckpointStore(database),
					new D1SignatureAssetLedger(database),
					{ ...D1_ORPHAN_SWEEP_STATEMENT_BUDGET, maxStatements: 9 }
				)
		).toThrow(RangeError);
	});
});
