import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	applyMigrations,
	checkMigrations,
	listMigrationFiles,
	MigrationApplyError,
	MigrationDriftError,
	parseArgs,
	planMigrations,
	sha256Hex
} from './postgres-migrate.mjs';

const TEST_DATABASE_URL = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const CI_ENABLED =
	process.env.CI !== undefined &&
	process.env.CI.trim() !== '' &&
	!['0', 'false', 'no'].includes(process.env.CI.toLowerCase());
if (CI_ENABLED && TEST_DATABASE_URL === undefined) {
	throw new Error('POSTGRES_TEST_URL is required when PostgreSQL integration tests run in CI');
}
const postgresDescribe = TEST_DATABASE_URL === undefined ? describe.skip : describe;

describe('postgres-migrate: parseArgs', () => {
	it('defaults to apply mode with no explicit database URL or migrations dir override', () => {
		expect(parseArgs([])).toEqual({
			check: false,
			databaseUrl: undefined,
			migrationsDir: 'migrations/postgres'
		});
	});

	it('parses --check, --database-url, and --migrations-dir', () => {
		expect(
			parseArgs([
				'--check',
				'--database-url=postgres://u:p@host/db',
				'--migrations-dir=fixtures/migrations'
			])
		).toEqual({
			check: true,
			databaseUrl: 'postgres://u:p@host/db',
			migrationsDir: 'fixtures/migrations'
		});
	});

	it('rejects unrecognized arguments', () => {
		expect(() => parseArgs(['--bogus'])).toThrow(/Unrecognized argument/);
	});
});

describe('postgres-migrate: sha256Hex and listMigrationFiles', () => {
	let dir;

	afterEach(() => {
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it('hashes file contents deterministically', () => {
		expect(sha256Hex('hello')).toBe(sha256Hex(Buffer.from('hello')));
		expect(sha256Hex('hello')).not.toBe(sha256Hex('hello!'));
	});

	it('lists only NNNN_description.sql files in ascending order, ignoring everything else', () => {
		dir = mkdtempSync(join(tmpdir(), 'signkit-migrate-list-'));
		writeFileSync(join(dir, '0002_second.sql'), 'SELECT 1;');
		writeFileSync(join(dir, '0001_first.sql'), 'SELECT 1;');
		writeFileSync(join(dir, 'README.md'), 'not a migration');
		writeFileSync(join(dir, 'not-numbered.sql'), 'SELECT 1;');
		expect(listMigrationFiles(dir)).toEqual(['0001_first.sql', '0002_second.sql']);
	});
});

postgresDescribe('postgres-migrate: applyMigrations against real PostgreSQL', () => {
	let sql = null;
	const schemaName = `signkit_migrate_${process.pid}_${randomUUID().replaceAll('-', '')}`;
	const fixtureDirs = [];

	function database() {
		if (sql === null) throw new Error('PostgreSQL test client is not connected');
		return sql;
	}

	function fixtureDir(files) {
		const dir = mkdtempSync(join(tmpdir(), 'signkit-migrate-fixtures-'));
		for (const [name, contents] of Object.entries(files)) {
			writeFileSync(join(dir, name), contents);
		}
		fixtureDirs.push(dir);
		return dir;
	}

	beforeAll(async () => {
		sql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
		await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
		await sql.unsafe(`SET search_path TO "${schemaName}"`);
	});

	afterAll(async () => {
		if (sql === null) return;
		for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
		await sql.unsafe('SET search_path TO public');
		await sql.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
		await sql.end({ timeout: 5 });
		sql = null;
	});

	it('applies every real migrations/postgres file to a fresh schema and is idempotent on rerun', async () => {
		const realFiles = listMigrationFiles('migrations/postgres');
		const first = await applyMigrations(database(), { migrationsDir: 'migrations/postgres' });
		expect(first.applied).toEqual(realFiles);

		const ledgerCount = await database()`SELECT COUNT(*)::int AS n FROM schema_migrations`;
		expect(ledgerCount[0].n).toBe(realFiles.length);

		const second = await applyMigrations(database(), { migrationsDir: 'migrations/postgres' });
		expect(second.applied).toEqual([]);
	});

	it('applies pending fixture migrations transactionally, detects drift, and reports orphans', async () => {
		const dir = fixtureDir({
			'0001_create_widgets.sql': 'CREATE TABLE widgets (id integer PRIMARY KEY);',
			'0002_create_gadgets.sql': 'CREATE TABLE gadgets (id integer PRIMARY KEY);'
		});
		const localSchema = `signkit_migrate_fx_${randomUUID().replaceAll('-', '')}`;
		await database().unsafe(`CREATE SCHEMA "${localSchema}"`);
		try {
			await database().unsafe(`SET search_path TO "${localSchema}"`);
			const applied = await applyMigrations(database(), { migrationsDir: dir });
			expect(applied.applied).toEqual(['0001_create_widgets.sql', '0002_create_gadgets.sql']);

			const upToDate = await checkMigrations(database(), { migrationsDir: dir });
			expect(upToDate.pending).toEqual([]);

			// Mutating an already-applied file's contents must be detected as drift.
			writeFileSync(
				join(dir, '0001_create_widgets.sql'),
				'CREATE TABLE widgets_renamed (id integer);'
			);
			await expect(checkMigrations(database(), { migrationsDir: dir })).rejects.toThrow(
				MigrationDriftError
			);
			await expect(applyMigrations(database(), { migrationsDir: dir })).rejects.toThrow(
				MigrationDriftError
			);

			// Restore, then delete a file whose ledger row still exists: reported as an
			// orphan warning, not a hard failure, and does not block applying new work.
			writeFileSync(
				join(dir, '0001_create_widgets.sql'),
				'CREATE TABLE widgets (id integer PRIMARY KEY);'
			);
			rmSync(join(dir, '0002_create_gadgets.sql'));
			writeFileSync(
				join(dir, '0003_create_sprockets.sql'),
				'CREATE TABLE sprockets (id integer PRIMARY KEY);'
			);
			const warnings = [];
			const result = await applyMigrations(database(), {
				migrationsDir: dir,
				log: (message) => warnings.push(message)
			});
			expect(result.applied).toEqual(['0003_create_sprockets.sql']);
			expect(result.orphans).toEqual(['0002_create_gadgets.sql']);
			expect(warnings.some((line) => line.includes('0002_create_gadgets.sql'))).toBe(true);
		} finally {
			await database().unsafe(`SET search_path TO "${schemaName}"`);
			await database().unsafe(`DROP SCHEMA "${localSchema}" CASCADE`);
		}
	});

	it('rolls back a failing migration transactionally and preserves prior progress', async () => {
		const dir = fixtureDir({
			'0001_create_ok.sql': 'CREATE TABLE ok_table (id integer PRIMARY KEY);',
			'0002_broken.sql': 'CREATE TABLE broken_table (id integer PRIMARY KEY); THIS IS NOT SQL;'
		});
		const localSchema = `signkit_migrate_fail_${randomUUID().replaceAll('-', '')}`;
		await database().unsafe(`CREATE SCHEMA "${localSchema}"`);
		try {
			await database().unsafe(`SET search_path TO "${localSchema}"`);
			await expect(applyMigrations(database(), { migrationsDir: dir })).rejects.toThrow(
				MigrationApplyError
			);

			const ledgerRows = await database()`SELECT filename FROM schema_migrations`;
			expect(ledgerRows.map((row) => row.filename)).toEqual(['0001_create_ok.sql']);

			const brokenTable = await database()`
				SELECT to_regclass(${localSchema + '.broken_table'}) AS "table"`;
			expect(brokenTable[0].table).toBeNull();
		} finally {
			await database().unsafe(`SET search_path TO "${schemaName}"`);
			await database().unsafe(`DROP SCHEMA "${localSchema}" CASCADE`);
		}
	});

	it('serializes two concurrent migrator invocations via the advisory lock instead of double-applying', async () => {
		const dir = fixtureDir({
			'0001_create_race_table.sql': 'CREATE TABLE race_table (id integer PRIMARY KEY);'
		});
		const localSchema = `signkit_migrate_race_${randomUUID().replaceAll('-', '')}`;
		await database().unsafe(`CREATE SCHEMA "${localSchema}"`);
		const clientA = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
		const clientB = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
		try {
			await clientA.unsafe(`SET search_path TO "${localSchema}"`);
			await clientB.unsafe(`SET search_path TO "${localSchema}"`);

			const [resultA, resultB] = await Promise.all([
				applyMigrations(clientA, { migrationsDir: dir }),
				applyMigrations(clientB, { migrationsDir: dir })
			]);
			const totalApplied = resultA.applied.length + resultB.applied.length;
			expect(totalApplied).toBe(1);

			await database().unsafe(`SET search_path TO "${localSchema}"`);
			const ledgerRows = await database()`SELECT filename FROM schema_migrations`;
			expect(ledgerRows).toHaveLength(1);
		} finally {
			await clientA.end({ timeout: 5 });
			await clientB.end({ timeout: 5 });
			await database().unsafe(`SET search_path TO "${schemaName}"`);
			await database().unsafe(`DROP SCHEMA "${localSchema}" CASCADE`);
		}
	});

	it('planMigrations never mutates the database (safe for a read-only role)', async () => {
		const dir = fixtureDir({
			'0001_readonly_check.sql': 'CREATE TABLE readonly_check (id integer PRIMARY KEY);'
		});
		const localSchema = `signkit_migrate_ro_${randomUUID().replaceAll('-', '')}`;
		await database().unsafe(`CREATE SCHEMA "${localSchema}"`);
		try {
			await database().unsafe(`SET search_path TO "${localSchema}"`);
			await database().unsafe(
				`CREATE TABLE schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`
			);
			const plan = await planMigrations(database(), dir);
			expect(plan.pending).toEqual(['0001_readonly_check.sql']);
			const table = await database()`
				SELECT to_regclass(${localSchema + '.readonly_check'}) AS "table"`;
			expect(table[0].table).toBeNull();
		} finally {
			await database().unsafe(`SET search_path TO "${schemaName}"`);
			await database().unsafe(`DROP SCHEMA "${localSchema}" CASCADE`);
		}
	});
});
