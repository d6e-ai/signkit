#!/usr/bin/env node
/**
 * Production-grade PostgreSQL migration runner for migrations/postgres.
 *
 * Usage:
 *   node scripts/postgres-migrate.mjs [--check] [--database-url=postgres://...]
 *                                     [--migrations-dir=migrations/postgres]
 *
 * Environment:
 *   DATABASE_URL   Connection string used when --database-url is not given.
 *                   Must belong to a role with DDL rights (CREATE/ALTER/DROP);
 *                   see docs/deployment.md ("Applying PostgreSQL migrations")
 *                   for why this role must differ from the long-lived
 *                   application role.
 *
 * Modes:
 *   (default) apply  Applies every pending migration, in filename order, each
 *                     inside its own transaction, recording a durable ledger
 *                     row (filename + SHA-256 checksum) only on success.
 *   --check          Never writes anything. Reports pending migrations and
 *                     checksum drift, exiting non-zero if either is found.
 *                     Safe to run with an ordinary read-only role.
 *
 * Safety properties:
 *   - A session-level advisory lock (pg_advisory_lock) serializes concurrent
 *     migrator invocations against the same database; a second invocation
 *     blocks rather than racing DDL against the first.
 *   - Every applied migration's SHA-256 checksum is recorded in a durable
 *     `schema_migrations` ledger table. If a previously-applied file's
 *     contents ever change on disk, the checksum recorded at apply time no
 *     longer matches the file, and the runner fails closed rather than
 *     silently re-running or ignoring the drift.
 *   - Diagnostics never print the connection string or any credential; only
 *     filenames, checksums (not secret), counts, and durations are logged.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_MIGRATIONS_DIR = 'migrations/postgres';
const MIGRATION_FILENAME_PATTERN = /^\d{4}_.+\.sql$/;

// Derived from the ASCII bytes of "SIGNKIT" (0x53 0x49 0x47 0x4E 0x4B 0x49 0x54),
// a fixed 56-bit constant well within Postgres's signed 64-bit advisory lock key
// range. Any stable, collision-unlikely constant works; this one is simply
// self-documenting. Do not reuse this key for an unrelated advisory lock.
export const MIGRATION_ADVISORY_LOCK_KEY = 0x5349474e4b4954n;

export const SCHEMA_MIGRATIONS_TABLE_DDL = `
	CREATE TABLE IF NOT EXISTS schema_migrations (
		filename text PRIMARY KEY,
		checksum text NOT NULL,
		applied_at timestamptz NOT NULL DEFAULT now()
	)`;

export class MigrationDriftError extends Error {
	constructor(message) {
		super(message);
		this.name = 'MigrationDriftError';
	}
}

export class MigrationApplyError extends Error {
	constructor(message, { cause } = {}) {
		super(message, { cause });
		this.name = 'MigrationApplyError';
	}
}

/**
 * Reads migration filenames from disk in canonical ascending order.
 * Filenames must match `NNNN_description.sql`; anything else is ignored,
 * consistent with the convention already used by the integration test suite.
 */
export function listMigrationFiles(migrationsDir) {
	return readdirSync(migrationsDir)
		.filter((name) => MIGRATION_FILENAME_PATTERN.test(name))
		.sort();
}

export function sha256Hex(contents) {
	return createHash('sha256').update(contents).digest('hex');
}

/**
 * Computes the plan without touching the database beyond a read of the
 * ledger table: which files are pending, which already-applied files have
 * drifted (checksum mismatch), and which ledger rows have no matching file
 * on disk (orphans - usually a sign of an accidentally deleted or renamed
 * migration file, surfaced as a warning rather than a hard failure since a
 * deliberate migration-squash could legitimately produce one).
 */
export async function planMigrations(sql, migrationsDir) {
	const files = listMigrationFiles(migrationsDir);
	const checksumByFilename = new Map(
		files.map((name) => [name, sha256Hex(readFileSync(join(migrationsDir, name)))])
	);
	const ledgerRows = await sql`SELECT filename, checksum FROM schema_migrations`;
	const ledgerByFilename = new Map(ledgerRows.map((row) => [row.filename, row.checksum]));

	const pending = [];
	const drifted = [];
	for (const name of files) {
		const ledgerChecksum = ledgerByFilename.get(name);
		if (ledgerChecksum === undefined) {
			pending.push(name);
			continue;
		}
		const currentChecksum = checksumByFilename.get(name);
		if (ledgerChecksum !== currentChecksum) {
			drifted.push({ filename: name, ledgerChecksum, currentChecksum });
		}
	}
	const orphans = [...ledgerByFilename.keys()].filter((name) => !checksumByFilename.has(name));

	return { files, checksumByFilename, pending, drifted, orphans };
}

function assertNoDrift(drifted) {
	if (drifted.length === 0) return;
	const details = drifted
		.map(
			(d) =>
				`  ${d.filename}: ledger checksum ${d.ledgerChecksum} != current file checksum ${d.currentChecksum}`
		)
		.join('\n');
	throw new MigrationDriftError(
		`Checksum drift detected on ${drifted.length} already-applied migration file(s). ` +
			`A migration file's contents changed after it was applied, which this runner refuses ` +
			`to silently re-run or ignore:\n${details}\n` +
			`Resolve by reverting the file to its originally-applied contents, or by adding a new ` +
			`forward migration instead of editing history.`
	);
}

/**
 * Applies every pending migration in order, each inside its own transaction
 * paired with its ledger insert, under a held session-level advisory lock so
 * a concurrent invocation against the same database blocks instead of racing
 * DDL. Refuses to apply anything if checksum drift is present anywhere in
 * the already-applied set, even for files ordered before the drifted one.
 */
export async function applyMigrations(sql, { migrationsDir, log = () => {} } = {}) {
	await sql`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`;
	try {
		await sql.unsafe(SCHEMA_MIGRATIONS_TABLE_DDL);
		const { pending, drifted, orphans } = await planMigrations(sql, migrationsDir);
		assertNoDrift(drifted);
		for (const name of orphans) {
			log(
				`warning: schema_migrations references ${name}, which no longer exists in ${migrationsDir}`
			);
		}
		if (pending.length === 0) {
			log('up to date: no pending migrations');
			return { applied: [], pending: [], orphans };
		}
		const applied = [];
		for (const name of pending) {
			const filePath = join(migrationsDir, name);
			const contents = readFileSync(filePath);
			const checksum = sha256Hex(contents);
			log(`applying ${name}`);
			try {
				await sql.begin(async (tx) => {
					await tx.unsafe(contents.toString('utf8'));
					await tx`
						INSERT INTO schema_migrations (filename, checksum)
						VALUES (${name}, ${checksum})`;
				});
			} catch (error) {
				throw new MigrationApplyError(
					`Failed applying ${name}; the transaction was rolled back and no ledger row was written. ` +
						`Migrations already applied before this one remain committed.`,
					{ cause: error }
				);
			}
			applied.push(name);
		}
		log(`applied ${applied.length} migration(s); up to date`);
		return { applied, pending: [], orphans };
	} finally {
		await sql`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`;
	}
}

/**
 * Read-only equivalent of applyMigrations for CI/release-checklist gating:
 * reports pending/drift without ever writing to the database. Works with a
 * role that only has SELECT on schema_migrations.
 */
export async function checkMigrations(sql, { migrationsDir, log = () => {} } = {}) {
	const { pending, drifted, orphans } = await planMigrations(sql, migrationsDir);
	assertNoDrift(drifted);
	for (const name of orphans) {
		log(
			`warning: schema_migrations references ${name}, which no longer exists in ${migrationsDir}`
		);
	}
	if (pending.length > 0) {
		log(`${pending.length} pending migration(s):`);
		for (const name of pending) log(`  ${name}`);
	} else {
		log('up to date: no pending migrations');
	}
	return { pending, orphans };
}

export function parseArgs(argv) {
	const args = { check: false, databaseUrl: undefined, migrationsDir: DEFAULT_MIGRATIONS_DIR };
	for (const arg of argv) {
		if (arg === '--check') {
			args.check = true;
		} else if (arg.startsWith('--database-url=')) {
			args.databaseUrl = arg.slice('--database-url='.length);
		} else if (arg.startsWith('--migrations-dir=')) {
			args.migrationsDir = arg.slice('--migrations-dir='.length);
		} else {
			throw new Error(`Unrecognized argument: ${arg}`);
		}
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
		console.error(
			'DATABASE_URL is required (set the environment variable or pass --database-url=...).'
		);
		process.exitCode = 1;
		return;
	}
	const migrationsDir = args.migrationsDir.startsWith('/')
		? args.migrationsDir
		: join(ROOT, args.migrationsDir);
	const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
	const label = args.check ? '[signkit-migrate:check]' : '[signkit-migrate]';
	const log = (message) => console.log(`${label} ${message}`);
	try {
		if (args.check) {
			const { pending } = await checkMigrations(sql, { migrationsDir, log });
			if (pending.length > 0) {
				process.exitCode = 1;
			}
		} else {
			await applyMigrations(sql, { migrationsDir, log });
		}
	} catch (error) {
		const name = error instanceof Error ? error.name : 'Error';
		const message = error instanceof Error ? error.message : String(error);
		console.error(`${label} ${name}: ${message}`);
		process.exitCode = 1;
	} finally {
		await sql.end({ timeout: 5 });
	}
}

const isMain =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	await main();
}

// Exported for tests that want to assert on the CLI's own filename base.
export const CLI_BASENAME = basename(fileURLToPath(import.meta.url));
