import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyD1Migrations } from './sqlite-d1-test-support';

// SQLite cannot ALTER COLUMN SET DEFAULT (see 0023_audit_hash_v2.sql), so every
// D1 trigger that inserts into audit_event after that migration must stamp
// hash_version = 2 explicitly; there is no column default to fall back on.
// A trigger that omits it silently stamps hash_version = 1 (the column's
// original DEFAULT), understating the audit hash algorithm for that event.
// This inspects the final, live schema reached by applying every migration in
// order, so a superseded historical definition (e.g. a trigger a later
// migration DROPs and recreates) cannot fail it — only what a fresh D1
// database would actually run today.

interface AuditEventInsert {
	trigger: string;
	columns: readonly string[];
	values: readonly string[];
}

function splitTopLevel(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	let quote: string | null = null;
	for (const char of text) {
		if (quote !== null) {
			current += char;
			if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		if (char === '(') depth += 1;
		if (char === ')') depth -= 1;
		if (char === ',' && depth === 0) {
			parts.push(current.trim());
			current = '';
			continue;
		}
		current += char;
	}
	if (current.trim().length > 0) parts.push(current.trim());
	return parts;
}

function findAuditEventInserts(triggerName: string, body: string): AuditEventInsert[] {
	const inserts: AuditEventInsert[] = [];
	const pattern = /INSERT INTO audit_event\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)\s*;/g;
	for (const match of body.matchAll(pattern)) {
		inserts.push({
			trigger: triggerName,
			columns: splitTopLevel(match[1]),
			values: splitTopLevel(match[2])
		});
	}
	return inserts;
}

describe('D1 final-schema audit_event hash_version invariant', () => {
	it('stamps hash_version = 2 on every live trigger insert into audit_event', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		applyD1Migrations(sqlite);
		try {
			const triggers = sqlite
				.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
				.all() as { name: string; sql: string }[];

			const inserts: AuditEventInsert[] = triggers.flatMap((trigger) =>
				findAuditEventInserts(trigger.name, trigger.sql)
			);

			// Sanity check the parser itself found real work, so a regex or schema
			// change that silently stops matching cannot pass this test vacuously.
			expect(inserts.length).toBeGreaterThan(10);

			const violations: string[] = [];
			for (const insert of inserts) {
				const columnIndex = insert.columns.indexOf('hash_version');
				if (columnIndex === -1) {
					violations.push(`${insert.trigger}: no hash_version column`);
					continue;
				}
				const value = insert.values[columnIndex];
				if (value !== '2') {
					violations.push(`${insert.trigger}: hash_version = ${value}`);
				}
			}

			expect(violations).toEqual([]);
		} finally {
			sqlite.close();
		}
	});
});
