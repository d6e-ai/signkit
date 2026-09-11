import { type DatabaseSync, type SQLInputValue, type StatementResultingChanges } from 'node:sqlite';

class SqliteD1Statement {
	constructor(
		private readonly database: DatabaseSync,
		readonly sql: string,
		private readonly bindings: readonly SQLInputValue[] = []
	) {}

	bind(...bindings: unknown[]): D1PreparedStatement {
		return new SqliteD1Statement(
			this.database,
			this.sql,
			bindings as readonly SQLInputValue[]
		) as unknown as D1PreparedStatement;
	}

	async all<T>(): Promise<D1Result<T>> {
		const results = this.database.prepare(this.sql).all(...this.bindings) as T[];
		return result(results, 0);
	}

	async first<T>(): Promise<T | null> {
		return (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null;
	}

	async run(): Promise<D1Result> {
		const update: StatementResultingChanges = this.database.prepare(this.sql).run(...this.bindings);
		return result([], Number(update.changes));
	}
}

class SqliteD1Database {
	constructor(readonly sqlite: DatabaseSync) {}

	prepare(sql: string): D1PreparedStatement {
		return new SqliteD1Statement(this.sqlite, sql) as unknown as D1PreparedStatement;
	}

	async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
		this.sqlite.exec('BEGIN IMMEDIATE');
		try {
			const results: D1Result<T>[] = [];
			for (const statement of statements) {
				const sqliteStatement: SqliteD1Statement = statement as unknown as SqliteD1Statement;
				results.push(
					sqliteStatement.sql.trimStart().startsWith('SELECT')
						? await sqliteStatement.all<T>()
						: ((await sqliteStatement.run()) as D1Result<T>)
				);
			}
			this.sqlite.exec('COMMIT');
			return results;
		} catch (error: unknown) {
			this.sqlite.exec('ROLLBACK');
			throw error;
		}
	}
}

export function sqliteD1Database(sqlite: DatabaseSync): D1Database {
	return new SqliteD1Database(sqlite) as unknown as D1Database;
}

function result<T>(results: T[], changes: number): D1Result<T> {
	return {
		success: true,
		results,
		meta: { changes }
	} as unknown as D1Result<T>;
}
