import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { unstable_splitSqlQuery } from 'wrangler';
import { d1MigrationPaths } from './sqlite-d1-test-support';

// The rest of the D1 suite applies whole migration files through node:sqlite
// `exec`, which uses SQLite's own tokenizer and therefore never splits a file
// into statements. Wrangler does split, and a fresh `wrangler d1 migrations
// apply` is the only way the production schema is ever created, so statement
// boundaries are themselves an invariant. This suite pins them.
//
// Two splitters matter:
//
//   * Wrangler's own `splitSqlQuery`, exported as `unstable_splitSqlQuery`.
//     `wrangler d1 migrations apply --local` runs the resulting statements as
//     one `D1Database.batch`, one prepared statement per chunk.
//   * D1's server-side splitter, which `--remote` reaches because
//     `migrations apply` posts the migration to the `/query` endpoint as a
//     single `sql` string rather than uploading it to `/import`. That splitter
//     tracks `BEGIN ... END` trigger bodies but has no notion of an
//     unparenthesized `CASE ... END` expression, so a bare `END;` inside a
//     trigger body closes the trigger early and the truncated statement fails
//     with `incomplete input: SQLITE_ERROR [code: 7500]`.
//
// Authoring rule this suite enforces: inside a D1 trigger body, every `CASE`
// expression is parenthesized, so that its `END` is followed by `)` and only
// the trigger's own `END;` can close the compound statement.

/** Mirrors wrangler's `getCreateMigrationsTableQuery`. */
const MIGRATIONS_LEDGER_DDL: string = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	name       TEXT UNIQUE,
	applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

/** Mirrors wrangler's `buildMigrationQuery`: the file plus the ledger INSERT. */
function migrationCommand(path: string): string {
	const name: string = path.slice('migrations/d1/'.length);
	return `${readFileSync(path, 'utf8')}
INSERT INTO "d1_migrations" (name)
values ('${name.replace(/'/g, "''")}');`;
}

/**
 * Conservative model of the splitter D1 applies to the `/query` endpoint, which
 * is the parser `wrangler d1 migrations apply --remote` depends on. It is the
 * pre-`CASE` shape of wrangler's own algorithm and matches keywords
 * case-sensitively: it opens a compound statement on ` BEGIN ` and closes it on
 * the first ` END;` or ` END `, and knows nothing about `CASE ... END`.
 */
function splitLikeD1RemoteQuery(sql: string): readonly string[] {
	const statements: string[] = [];
	const iterator: Iterator<string> = sql[Symbol.iterator]();
	let compoundDepth: number = 0;
	let statement: string = '';
	let next: IteratorResult<string> = iterator.next();

	function consumeUntil(marker: string): void {
		let tail: string = '';
		let scanned: IteratorResult<string> = iterator.next();
		while (!scanned.done) {
			tail = (tail + scanned.value).slice(-marker.length);
			if (tail === marker) return;
			scanned = iterator.next();
		}
	}

	function consumeQuoted(quote: string): string {
		let quoted: string = '';
		let scanned: IteratorResult<string> = iterator.next();
		while (!scanned.done) {
			quoted += scanned.value;
			if (scanned.value === quote) return quoted;
			scanned = iterator.next();
		}
		return quoted;
	}

	while (!next.done) {
		const char: string = next.value;
		if (compoundDepth > 0 && /\sEND[;\s]$/.test(statement + char)) compoundDepth -= 1;
		switch (char) {
			case "'":
			case '"':
			case '`':
				statement += char + consumeQuoted(char);
				break;
			case '-':
				next = iterator.next();
				if (!next.done && next.value === '-') {
					consumeUntil('\n');
					statement += '\n';
					break;
				}
				statement += char;
				continue;
			case '/':
				next = iterator.next();
				if (!next.done && next.value === '*') {
					consumeUntil('*/');
					break;
				}
				statement += char;
				continue;
			case ';':
				if (compoundDepth === 0) {
					statements.push(statement);
					statement = '';
				} else {
					statement += char;
				}
				break;
			default:
				statement += char;
				break;
		}
		if (/\sBEGIN\s$/.test(statement)) compoundDepth += 1;
		next = iterator.next();
	}
	statements.push(statement);
	return statements.map((candidate: string): string => candidate.trim()).filter(Boolean);
}

/**
 * Applies every migration the way wrangler does: one prepared statement per
 * chunk. A chunk holding more than one statement silently loses everything
 * after the first, which `schemaFingerprint` then catches.
 */
function applySplitMigrations(split: (sql: string) => readonly string[]): DatabaseSync {
	const database: DatabaseSync = new DatabaseSync(':memory:');
	database.exec(MIGRATIONS_LEDGER_DDL);
	for (const path of d1MigrationPaths()) {
		for (const statement of split(migrationCommand(path))) {
			database.prepare(statement).run();
		}
	}
	return database;
}

/** Comments and whitespace survive in `sqlite_master`, so normalize them away. */
function schemaFingerprint(database: DatabaseSync): string {
	return database
		.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
		.all()
		.map((row: Record<string, unknown>): string => {
			const sql: string = typeof row.sql === 'string' ? row.sql : '';
			const normalized: string = sql
				.replace(/--[^\n]*/g, ' ')
				.replace(/\s+/g, ' ')
				.trim();
			return `${String(row.type)}|${String(row.name)}|${String(row.tbl_name)}|${normalized}`;
		})
		.join('\n');
}

function appliedMigrationNames(database: DatabaseSync): readonly string[] {
	return database
		.prepare('SELECT name FROM d1_migrations ORDER BY id')
		.all()
		.map((row: Record<string, unknown>): string => String(row.name));
}

const MIGRATION_NAMES: readonly string[] = d1MigrationPaths().map((path: string): string =>
	path.slice('migrations/d1/'.length)
);

describe('D1 migration statement parsing', () => {
	it('splits every migration identically under wrangler and D1 remote semantics', () => {
		const disagreements: string[] = [];
		for (const path of d1MigrationPaths()) {
			const command: string = migrationCommand(path);
			const wrangler: readonly string[] = unstable_splitSqlQuery(command);
			const remote: readonly string[] = splitLikeD1RemoteQuery(command);
			const diverges: boolean =
				wrangler.length !== remote.length ||
				wrangler.some((statement: string, index: number): boolean => statement !== remote[index]);
			if (diverges) {
				disagreements.push(`${path}: wrangler=${wrangler.length} remote=${remote.length}`);
			}
		}
		expect(disagreements).toEqual([]);
	});

	it('applies a fresh database through wrangler own splitter', () => {
		const database: DatabaseSync = applySplitMigrations(unstable_splitSqlQuery);
		expect(appliedMigrationNames(database)).toEqual(MIGRATION_NAMES);
	});

	// Regression: before the trigger `CASE` expressions were parenthesized this
	// failed at 0003_draft_revisions.sql with `incomplete input`, exactly as a
	// fresh `wrangler d1 migrations apply --remote` did against a new D1
	// database, while every local path kept passing.
	it('applies a fresh database through D1 remote query splitting', () => {
		const database: DatabaseSync = applySplitMigrations(splitLikeD1RemoteQuery);
		expect(appliedMigrationNames(database)).toEqual(MIGRATION_NAMES);
	});

	it('reaches the same schema as unsplit whole-file application', () => {
		const unsplit: DatabaseSync = new DatabaseSync(':memory:');
		unsplit.exec(MIGRATIONS_LEDGER_DDL);
		for (const path of d1MigrationPaths()) unsplit.exec(migrationCommand(path));
		const expected: string = schemaFingerprint(unsplit);

		expect(schemaFingerprint(applySplitMigrations(unstable_splitSqlQuery))).toBe(expected);
		expect(schemaFingerprint(applySplitMigrations(splitLikeD1RemoteQuery))).toBe(expected);
	});

	it('keeps every trigger body CASE expression parenthesized', () => {
		const unparenthesized: string[] = [];
		for (const path of d1MigrationPaths()) {
			const sql: string = readFileSync(path, 'utf8');
			// A trigger body is a compound statement, so any ` END;` or ` END ` that
			// belongs to a CASE instead of the trigger ends the statement early.
			for (const body of sql.matchAll(/\sBEGIN\s[\s\S]*?\sEND;/g)) {
				if (/\sCASE\s[\s\S]*?\sEND[;\s]/.test(body[0].slice(0, -4))) {
					unparenthesized.push(path);
					break;
				}
			}
		}
		expect(unparenthesized).toEqual([]);
	});
});
