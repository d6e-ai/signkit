import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyD1Migrations, d1MigrationPaths } from './sqlite-d1-test-support';

// Cloudflare D1 runs SQLite with `SQLITE_LIMIT_LIKE_PATTERN_LENGTH` set far
// below SQLite's own 50000-byte default, and `likeFunc` rejects any longer
// pattern at evaluation time with `LIKE or GLOB pattern too complex`. Nothing
// local reproduces it: node:sqlite keeps the default limit, so a migration with
// an over-long pattern applies and every CHECK it guards passes here while the
// same INSERT fails against real D1.
//
// Observed against D1: the 102-byte per-character timestamp pattern
// `'[0-9][0-9][0-9][0-9]-...[0-9][0-9][0-9]Z'` fails, which broke instance
// bootstrap, since the first write of a fresh deployment is the
// `instance_member` row whose `created_at` CHECK carried it. The short negated
// classes this schema also uses (`'*[^!-~]*'`, `'*[^0-9a-f]*'`) evaluate fine.
//
// Authoring rules this suite pins:
//
//   * Every LIKE/GLOB pattern in migrations/d1 stays inside a small byte
//     budget, which means short negated character classes and prefix globs
//     rather than one bracket group per character.
//   * Canonical UTC ISO-8601 millisecond timestamps are validated by round
//     tripping through `strftime` instead of a per-character pattern. The
//     comparison is `IS`, not `=`: `strftime` returns NULL for an unparsable
//     value, and a CHECK whose expression evaluates to NULL passes.

/**
 * Conservative authoring budget, not D1's exact cap: it clears every pattern
 * the schema needs while staying an order of magnitude under the shortest
 * pattern D1 has been seen to reject.
 */
const PATTERN_BUDGET_BYTES: number = 50;

const ISO_TIMESTAMP: string = '2026-09-12T12:00:00.000Z';
const OWNER_ID: string = 'user-owner-1';
const KEY_ID: string = '01900000-0000-7000-8000-000000000201';
const ENDPOINT_ID: string = '01900000-0000-7000-8000-000000000301';
const ORGANIZATION_ID: string = 'org_d6e_01K9ZQ';
const EXPIRES_AT: string = '2026-12-11T12:00:00.000Z';

interface PatternUse {
	readonly path: string;
	readonly pattern: string;
}

/**
 * The supported shape, which `finds every LIKE/GLOB operand` below enforces so
 * that a pattern can never slip past the budget unscanned: the operand is a
 * single-quoted literal immediately after the operator, optionally wrapped in
 * parentheses. Comments carry LIKE and GLOB prose, so both comment forms are
 * stripped first.
 */
const PATTERN_OPERAND: RegExp = /\b(?:LIKE|GLOB)\s*\(?\s*'((?:[^']|'')*)'/gi;
const PATTERN_OPERATOR: RegExp = /\b(?:LIKE|GLOB)\b/gi;

function withoutComments(sql: string): string {
	return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function patternsIn(sql: string): readonly string[] {
	return [...withoutComments(sql).matchAll(PATTERN_OPERAND)].map(
		(match: RegExpMatchArray): string => match[1]
	);
}

function operatorCount(sql: string): number {
	return [...withoutComments(sql).matchAll(PATTERN_OPERATOR)].length;
}

function patternUses(path: string): readonly PatternUse[] {
	return patternsIn(readFileSync(path, 'utf8')).map((pattern: string): PatternUse => ({
		path,
		pattern
	}));
}

function allPatternUses(): readonly PatternUse[] {
	return d1MigrationPaths().flatMap(patternUses);
}

function database(): DatabaseSync {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	return sqlite;
}

function insertMember(
	sqlite: DatabaseSync,
	createdAt: string,
	updatedAt: string = createdAt
): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${OWNER_ID}', 'owner', 'active', '${createdAt}', '${updatedAt}')
	`);
}

/** Every string a `Date.toISOString()` can produce inside SQLite's year range. */
const CANONICAL_TIMESTAMPS: readonly string[] = [
	'2026-09-12T12:00:00.000Z',
	'2026-01-01T00:00:00.000Z',
	'2026-12-31T23:59:59.999Z',
	'2024-02-29T23:59:59.999Z',
	'1970-01-01T00:00:00.000Z'
];

const REJECTED_TIMESTAMPS: readonly Record<'value' | 'why', string>[] = [
	{ value: '2026-09-12 12:00:00.000Z', why: 'space instead of T' },
	{ value: '2026-09-12T12:00:00.000z', why: 'lowercase zone marker' },
	{ value: '2026-09-12T12:00:00Z', why: 'no milliseconds' },
	{ value: '2026-09-12T12:00:00.00Z', why: 'two-digit milliseconds' },
	{ value: '2026-09-12T12:00:00.0000Z', why: 'four-digit milliseconds' },
	{ value: '2026-09-12T12:00:00.000+00:00', why: 'numeric offset instead of Z' },
	{ value: '2026-09-12T12:00:00.000', why: 'no zone marker' },
	{ value: '20260912T120000.000Z', why: 'basic format' },
	{ value: '2026-13-01T00:00:00.000Z', why: 'month out of range' },
	{ value: '2026-09-12T12:60:00.000Z', why: 'minute out of range' },
	{ value: '2026-02-30T00:00:00.000Z', why: 'day past end of month' },
	{ value: '2025-02-29T00:00:00.000Z', why: 'leap day of a common year' },
	{ value: 'not-a-timestamp-at-all!!', why: 'unparsable, 24 bytes wide' },
	{ value: '', why: 'empty' }
];

describe('D1 GLOB pattern complexity', () => {
	it('keeps every migration LIKE/GLOB pattern inside the byte budget', () => {
		const oversized: string[] = allPatternUses()
			.filter(
				(use: PatternUse): boolean => Buffer.byteLength(use.pattern, 'utf8') > PATTERN_BUDGET_BYTES
			)
			.map(
				(use: PatternUse): string => `${use.path}: ${Buffer.byteLength(use.pattern, 'utf8')} bytes`
			);

		expect(oversized).toEqual([]);
	});

	// Regression: this exact pattern is what D1 rejected as too complex.
	it('no longer validates timestamps with a per-character pattern', () => {
		const perCharacter: readonly PatternUse[] = allPatternUses().filter(
			(use: PatternUse): boolean => use.pattern.includes('[0-9][0-9]')
		);

		expect(perCharacter).toEqual([]);
	});

	it('scans the patterns it claims to scan', () => {
		const patterns: readonly string[] = allPatternUses().map(
			(use: PatternUse): string => use.pattern
		);

		expect(patterns).toContain('*[^0-9a-f]*');
		expect(patterns.length).toBeGreaterThan(20);
	});

	// A budget audit is only as good as its extraction: an operator whose operand
	// it cannot read is a pattern it never measures. Rather than parse SQL, this
	// pins the shape the audit supports and fails on anything else — a bound
	// parameter, a concatenation, or a column-to-column comparison.
	it('finds every LIKE/GLOB operand in every migration', () => {
		const unscanned: string[] = [];
		for (const path of d1MigrationPaths()) {
			const sql: string = readFileSync(path, 'utf8');
			const operators: number = operatorCount(sql);
			const operands: number = patternsIn(sql).length;
			if (operators !== operands) {
				unscanned.push(`${path}: ${operators} operators, ${operands} literal operands`);
			}
		}

		expect(unscanned).toEqual([]);
	});

	it('reads operands through comments and parentheses', () => {
		const sql: string = `
			/* A block comment naming GLOB '[0-9][0-9][0-9][0-9]-not-a-real-pattern'. */
			-- A line comment naming GLOB '[0-9][0-9]-also-not-real'.
			CREATE TABLE t (
				a TEXT CHECK (a NOT GLOB '*[^0-9a-f]*'),
				b TEXT CHECK ((b GLOB 'https://*')),
				c TEXT CHECK (c LIKE ('signkit\\_%'))
			);
		`;

		expect(patternsIn(sql)).toEqual(['*[^0-9a-f]*', 'https://*', 'signkit\\_%']);
		expect(operatorCount(sql)).toBe(3);
	});
});

describe('D1 canonical ISO-8601 timestamp checks', () => {
	it('accepts every canonical UTC millisecond timestamp', () => {
		for (const value of CANONICAL_TIMESTAMPS) {
			const sqlite: DatabaseSync = database();
			try {
				expect(() => insertMember(sqlite, value)).not.toThrow();
			} finally {
				sqlite.close();
			}
		}
	});

	it('rejects every non-canonical or invalid timestamp', () => {
		for (const { value, why } of REJECTED_TIMESTAMPS) {
			const sqlite: DatabaseSync = database();
			try {
				expect(() => insertMember(sqlite, value), why).toThrow(/CHECK constraint failed/);
			} finally {
				sqlite.close();
			}
		}
	});

	// SQLite parses hour 24 and renders it back verbatim rather than rolling into
	// the next day, so the round trip admits it. The per-character pattern this
	// replaced admitted it too, and `Date.toISOString()` never emits it, so the
	// tolerance is pinned here rather than closed with another CHECK term.
	it('tolerates hour 24, exactly as the pattern it replaced did', () => {
		const sqlite: DatabaseSync = database();
		try {
			expect(() => insertMember(sqlite, '2026-09-12T24:00:00.000Z')).not.toThrow();
		} finally {
			sqlite.close();
		}
	});

	// `strftime` returns NULL for an unparsable value, and `NULL = x` is NULL,
	// which a CHECK treats as satisfied. `IS` is what makes these rows fail. The
	// value has to be exactly 24 characters wide, or `length(...) = 24` rejects it
	// first and the round trip is never reached.
	it('rejects an unparsable 24-character timestamp instead of passing it on a NULL', () => {
		const sqlite: DatabaseSync = database();
		const unparsable: string = 'not-a-timestamp-at-all!!';
		try {
			expect(unparsable).toHaveLength(24);
			expect(
				sqlite
					.prepare(
						`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', '${unparsable}') AS round_trip,
							('${unparsable}' = strftime('%Y-%m-%dT%H:%M:%fZ', '${unparsable}')) AS with_equals,
							('${unparsable}' IS strftime('%Y-%m-%dT%H:%M:%fZ', '${unparsable}')) AS with_is`
					)
					.get()
			).toEqual({ round_trip: null, with_equals: null, with_is: 0 });
			expect(() => insertMember(sqlite, unparsable)).toThrow(/CHECK constraint failed/);
		} finally {
			sqlite.close();
		}
	});

	it('guards instance_bootstrap, the first write of a fresh deployment', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, ISO_TIMESTAMP);

			expect(() => {
				sqlite.exec(`
					INSERT INTO instance_bootstrap (singleton_key, owner_user_id, created_at)
					VALUES (1, '${OWNER_ID}', '2026-09-12 12:00:00.000Z')
				`);
			}).toThrow(/CHECK constraint failed/);

			sqlite.exec(`
				INSERT INTO instance_bootstrap (singleton_key, owner_user_id, created_at)
				VALUES (1, '${OWNER_ID}', '${ISO_TIMESTAMP}')
			`);

			expect(
				sqlite.prepare('SELECT created_at FROM instance_bootstrap WHERE singleton_key = 1').get()
			).toEqual({ created_at: ISO_TIMESTAMP });
		} finally {
			sqlite.close();
		}
	});

	it('still allows NULL in a nullable timestamp column and rejects a malformed one', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, ISO_TIMESTAMP);
			sqlite.exec(`
				INSERT INTO api_key (
					id, name, token_hash, key_prefix, scopes_json,
					owner_user_id, created_at, expires_at, rate_window_count
				) VALUES (
					'${KEY_ID}', 'CI agent', '${'b'.repeat(64)}', 'signkit_abcdefgh',
					'["envelopes:read"]', '${OWNER_ID}', '${ISO_TIMESTAMP}', '${EXPIRES_AT}', 0
				)
			`);

			expect(sqlite.prepare(`SELECT revoked_at FROM api_key WHERE id = '${KEY_ID}'`).get()).toEqual(
				{
					revoked_at: null
				}
			);

			expect(() => {
				sqlite.exec(
					`UPDATE api_key SET revoked_at = '2026-09-13 12:00:00.000Z' WHERE id = '${KEY_ID}'`
				);
			}).toThrow(/CHECK constraint failed/);

			sqlite.exec(`UPDATE api_key SET revoked_at = '${EXPIRES_AT}' WHERE id = '${KEY_ID}'`);
			expect(sqlite.prepare(`SELECT revoked_at FROM api_key WHERE id = '${KEY_ID}'`).get()).toEqual(
				{
					revoked_at: EXPIRES_AT
				}
			);
		} finally {
			sqlite.close();
		}
	});
});

// The other two patterns that exceeded the budget bounded hexadecimal material
// one bracket group per character. Both now bound length separately from the
// alphabet, which is the same acceptance set.
describe('D1 hexadecimal shape checks', () => {
	function insertEndpoint(sqlite: DatabaseSync, sealingKeyId: string | null): void {
		sqlite.exec(`
			INSERT INTO webhook_endpoint (
				id, organization_id, url, status, events_json, secret_hash,
				signing_secret, sealing_key_id, secret_prefix, created_at, created_by_user_id
			) VALUES (
				'${ENDPOINT_ID}', '${ORGANIZATION_ID}', 'https://example.com/hooks', 'active',
				'["envelope.completed"]', '${'a'.repeat(64)}', '${'s'.repeat(32)}',
				${sealingKeyId === null ? 'NULL' : `'${sealingKeyId}'`},
				'skwh1_', '${ISO_TIMESTAMP}', '${OWNER_ID}'
			)
		`);
	}

	function organization(): DatabaseSync {
		const sqlite: DatabaseSync = database();
		sqlite.exec(`
			INSERT INTO organization (id, d6e_organization_id, name, created_at)
			VALUES ('${ORGANIZATION_ID}', '${ORGANIZATION_ID}', 'Workspace', '${ISO_TIMESTAMP}')
		`);
		return sqlite;
	}

	it.each([
		['a lowercase 16-digit key id', '0123456789abcdef', true],
		['an unsealed row', null, true],
		['uppercase hexadecimal', '0123456789ABCDEF', false],
		['a non-hexadecimal digit', '0123456789abcdeg', false],
		['a short key id', '0123456789abcde', false],
		['a long key id', '0123456789abcdef0', false]
	])('%s on webhook_endpoint.sealing_key_id', (_name, value, accepted) => {
		const sqlite: DatabaseSync = organization();
		try {
			if (accepted) {
				expect(() => insertEndpoint(sqlite, value)).not.toThrow();
			} else {
				expect(() => insertEndpoint(sqlite, value)).toThrow(/CHECK constraint failed/);
			}
		} finally {
			sqlite.close();
		}
	});
});
