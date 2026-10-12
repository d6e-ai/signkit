import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUuidV7 } from '$lib/ids/uuid-v7';
import { normalizeRecipientEmail } from '$lib/domain/recipient-identity';
import { decodeDashboardCursor } from '$lib/application/dashboard/cursor';
import type { DashboardActor, DashboardStoreQuery } from '$lib/ports/dashboard-store';
import { PostgresDashboardStore } from './postgres-dashboard-store';

const databaseUrl: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const liveDescribe = databaseUrl === undefined ? describe.skip : describe;
const AT: string = '2026-09-11T00:00:00.000Z';
const CALLER: DashboardActor = { email: 'caller@example.com' };

function query(overrides: Partial<DashboardStoreQuery> = {}): DashboardStoreQuery {
	return { view: 'all', query: null, cursor: null, limit: 25, ...overrides };
}

liveDescribe('PostgresDashboardStore integration', () => {
	const schema: string = `signkit_dashboard_${newUuidV7().replaceAll('-', '')}`;
	let sql: ReturnType<typeof postgres> | null = null;
	let secondConnection: ReturnType<typeof postgres> | null = null;
	let ownerId: string;

	beforeAll(async () => {
		sql = postgres(databaseUrl as string, { max: 1, onnotice: (): void => undefined });
		await sql.unsafe(`CREATE SCHEMA "${schema}"`);
		await sql.unsafe(`SET search_path TO "${schema}"`);
		for (const file of readdirSync('migrations/postgres')
			.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
			.sort()) {
			await sql.unsafe(readFileSync(`migrations/postgres/${file}`, 'utf8'));
		}
		ownerId = `dashboard-owner-${newUuidV7()}`;
		await sql`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES (${ownerId}, 'owner', 'active', ${AT}::timestamptz, ${AT}::timestamptz)`;

		// A second, independent connection pinned to the same schema, used to
		// mutate data concurrently with an in-flight `readDashboard` call --
		// the only way to actually observe whether counts and rows came from
		// one coherent snapshot or two independently-committed ones.
		secondConnection = postgres(databaseUrl as string, { max: 1, onnotice: (): void => undefined });
		await secondConnection.unsafe(`SET search_path TO "${schema}"`);
	});

	afterAll(async () => {
		if (secondConnection !== null) await secondConnection.end({ timeout: 5 });
		if (sql === null) return;
		try {
			await sql.unsafe('SET search_path TO public');
			await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
		} finally {
			await sql.end({ timeout: 5 });
		}
	});

	async function insertEnvelope(title: string, status: string, updatedAt: string): Promise<string> {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const envelopeId: string = newUuidV7();
		await sql`INSERT INTO envelope (id, created_by_user_id, title, status, repository_generation,
			repository_head, sent_commit_sha, created_at, updated_at)
			VALUES (${envelopeId}, ${ownerId}, ${title}, ${status}, 1, 'commit-1', NULL,
				${updatedAt}::text::timestamptz, ${updatedAt}::text::timestamptz)`;
		return envelopeId;
	}

	async function insertRecipient(
		envelopeId: string,
		email: string,
		name: string,
		role: string,
		routingOrder: number,
		status: string,
		updatedAt: string
	): Promise<void> {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		await sql`INSERT INTO recipient (id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at)
			VALUES (${newUuidV7()}, ${envelopeId}, ${email}, ${name}, ${role}, 'en', ${routingOrder}, ${status},
				${updatedAt}::timestamptz, ${updatedAt}::timestamptz)`;
	}

	it('classifies action_required and waiting as exclusive buckets based on the active routing turn', async () => {
		const callerTurn: string = await insertEnvelope('Caller turn', 'sent', AT);
		await insertRecipient(callerTurn, CALLER.email, 'Caller', 'signer', 1, 'pending', AT);
		const otherTurn: string = await insertEnvelope('Other turn', 'in_progress', AT);
		await insertRecipient(otherTurn, 'other@example.com', 'Other', 'signer', 1, 'pending', AT);

		const store = new PostgresDashboardStore(sql as ReturnType<typeof postgres>);
		const actionRequired = await store.readDashboard(CALLER, query({ view: 'action_required' }));
		expect(actionRequired.items.map((item) => item.envelope.id)).toEqual([callerTurn]);
		const waiting = await store.readDashboard(CALLER, query({ view: 'waiting' }));
		expect(waiting.items.map((item) => item.envelope.id)).toEqual([otherTurn]);
	});

	it('scopes completed/actionable recipient counts to signer/approver only, with true signed and approved rows, excluding cc', async () => {
		const envelopeId: string = await insertEnvelope('Mixed progress', 'completed', AT);
		await insertRecipient(envelopeId, 'signer@example.com', 'Signer', 'signer', 1, 'completed', AT);
		await insertRecipient(
			envelopeId,
			'approver@example.com',
			'Approver',
			'approver',
			2,
			'completed',
			AT
		);
		await insertRecipient(envelopeId, 'cc@example.com', 'CC', 'cc', 1, 'pending', AT);

		const store = new PostgresDashboardStore(sql as ReturnType<typeof postgres>);
		const page = await store.readDashboard(CALLER, query({ view: 'completed' }));
		const item = page.items.find((candidate) => candidate.envelope.id === envelopeId);
		expect(item?.recipientCount).toBe(3);
		expect(item?.actionableRecipientCount).toBe(2);
		expect(item?.completedRecipientCount).toBe(2);
	});

	it('performs a literal, escaped search across title and recipient name/email', async () => {
		const target: string = await insertEnvelope('50%_off\\deal', 'draft', AT);
		await insertEnvelope('xx50xxoffxxdealxx', 'draft', AT);

		const store = new PostgresDashboardStore(sql as ReturnType<typeof postgres>);
		const page = await store.readDashboard(CALLER, query({ query: '50%_off\\deal' }));
		expect(page.items.map((item) => item.envelope.id)).toEqual([target]);
	});

	it('preserves exact accented and Japanese title and recipient-name searches', async () => {
		const target: string = await insertEnvelope('Überprüfung 契約書', 'draft', AT);
		await insertRecipient(target, 'elodie@example.com', 'Élodie', 'signer', 1, 'pending', AT);
		const store = new PostgresDashboardStore(sql as ReturnType<typeof postgres>);
		for (const text of ['Überprüfung', 'Élodie', '契約書']) {
			const page = await store.readDashboard(CALLER, query({ query: text }));
			expect(page.items.map((item) => item.envelope.id)).toEqual([target]);
		}
	});

	it('matches title and recipient name/email case-insensitively', async () => {
		const envelopeId: string = await insertEnvelope('Case Sensitive Title', 'draft', AT);
		await insertRecipient(
			envelopeId,
			'Mixed.Case@Example.com',
			'Mixed Case Name',
			'signer',
			1,
			'pending',
			AT
		);

		const store = new PostgresDashboardStore(sql as ReturnType<typeof postgres>);
		const byTitle = await store.readDashboard(CALLER, query({ query: 'CASE sensitive' }));
		expect(byTitle.items.map((item) => item.envelope.id)).toContain(envelopeId);
		const byName = await store.readDashboard(CALLER, query({ query: 'mixed case name' }));
		expect(byName.items.map((item) => item.envelope.id)).toContain(envelopeId);
	});

	it('is case-sensitive at the store layer for the caller email, matching only an already-normalized caller', async () => {
		const envelopeId: string = await insertEnvelope('Case parity', 'sent', AT);
		const storedEmail: string = normalizeRecipientEmail('Normalized@Example.com');
		await insertRecipient(envelopeId, storedEmail, 'Recipient', 'signer', 1, 'pending', AT);

		const store = new PostgresDashboardStore(sql as ReturnType<typeof postgres>);
		const normalizedCaller = await store.readDashboard(
			{ email: normalizeRecipientEmail('NORMALIZED@EXAMPLE.COM') },
			query({ view: 'action_required' })
		);
		expect(normalizedCaller.items.map((item) => item.envelope.id)).toContain(envelopeId);

		const unnormalizedCaller = await store.readDashboard(
			{ email: 'NORMALIZED@EXAMPLE.COM' },
			query({ view: 'action_required' })
		);
		expect(unnormalizedCaller.items.map((item) => item.envelope.id)).not.toContain(envelopeId);
	});

	it('paginates with a stable opaque cursor and counts independent of row volume', async () => {
		const ids: string[] = [];
		for (let index = 0; index < 120; index += 1) {
			ids.push(await insertEnvelope(`Bulk ${index}`, 'draft', AT));
		}
		const expectedOrder: string[] = [...ids].sort().reverse();

		const store = new PostgresDashboardStore(sql as ReturnType<typeof postgres>);
		const firstPage = await store.readDashboard(CALLER, query({ limit: 25 }));
		expect(firstPage.items.map((item) => item.envelope.id)).toEqual(expectedOrder.slice(0, 25));
		expect(firstPage.counts.all).toBeGreaterThanOrEqual(120);
		expect(firstPage.counts.drafts).toBeGreaterThanOrEqual(120);

		const decoded = decodeDashboardCursor(firstPage.nextCursor as string, {
			view: 'all',
			query: null
		});
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) throw new Error('unreachable');
		const secondPage = await store.readDashboard(
			CALLER,
			query({ limit: 25, cursor: decoded.value })
		);
		expect(secondPage.items.map((item) => item.envelope.id)).toEqual(expectedOrder.slice(25, 50));
	});

	it('opens a REPEATABLE READ, READ ONLY transaction, not the READ COMMITTED default of a plain BEGIN', async () => {
		if (secondConnection === null) throw new Error('PostgreSQL unavailable');
		const capturedStatements: string[] = [];
		const debugSql = postgres(databaseUrl as string, {
			max: 1,
			onnotice: (): void => undefined,
			debug: (_connection: number, statement: string): void => {
				capturedStatements.push(statement);
			}
		});
		try {
			await debugSql.unsafe(`SET search_path TO "${schema}"`);
			const store = new PostgresDashboardStore(debugSql);
			await store.readDashboard(CALLER, query());
		} finally {
			await debugSql.end({ timeout: 5 });
		}
		const isolationStatements: string[] = capturedStatements.filter((statement) =>
			/SET\s+TRANSACTION\s+ISOLATION\s+LEVEL/i.test(statement)
		);
		expect(isolationStatements).toHaveLength(1);
		expect(isolationStatements[0]).toMatch(/REPEATABLE READ/i);
		expect(isolationStatements[0]).toMatch(/READ ONLY/i);
	});

	it('reads counts and rows from one coherent snapshot even when another connection writes between them', async () => {
		if (sql === null || secondConnection === null) throw new Error('PostgreSQL unavailable');
		const prefix: string = `Snapshot race ${newUuidV7()}`;
		const stableId: string = await insertEnvelope(`${prefix} stable`, 'draft', AT);
		const newId: string = newUuidV7();
		const connection: ReturnType<typeof postgres> = sql;
		const writer: ReturnType<typeof postgres> = secondConnection;
		const [before] = await connection<
			{ count: number }[]
		>`SELECT COUNT(*)::int AS count FROM envelope`;
		let insertedBetweenReads: boolean = false;

		// Execute the real counts query, then commit through an independent
		// connection before returning its result to the store. Only this test
		// interception controls timing; both queries still run on PostgreSQL.
		// Under READ COMMITTED, the subsequent page query would see `newId`.
		const interceptedSql = {
			begin: <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
				connection.begin(async (tx) => {
					const interceptedTx = new Proxy(tx, {
						apply(target, thisArg, args) {
							const result: unknown = Reflect.apply(target, thisArg, args);
							const template: unknown = args[0];
							if (Array.isArray(template) && template.join('').includes('AS "allCount"')) {
								return Promise.resolve(result).then(async (rows) => {
									await writer`INSERT INTO envelope
										(id, created_by_user_id, title, status, repository_generation,
										 repository_head, created_at, updated_at)
										VALUES (${newId}, ${ownerId}, ${`${prefix} concurrent`}, 'draft',
										 1, 'commit-1', ${AT}::timestamptz, ${AT}::timestamptz)`;
									insertedBetweenReads = true;
									return rows;
								});
							}
							return result;
						}
					});
					return await callback(interceptedTx);
				})
		} as unknown as ReturnType<typeof postgres>;
		const page = await new PostgresDashboardStore(interceptedSql).readDashboard(
			CALLER,
			query({ query: prefix })
		);
		expect(insertedBetweenReads).toBe(true);
		expect(page.counts.all).toBe(before.count);
		expect(page.items.map((item) => item.envelope.id)).toEqual([stableId]);
		const [after] = await writer<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM envelope`;
		expect(after.count).toBe(before.count + 1);
	});

	it('preserves sub-millisecond ordering so a keyset cursor never skips a row between timestamps sharing a millisecond', async () => {
		// Three envelopes whose `updated_at` values share the same
		// millisecond (`.123`) but differ only in microseconds, plus a
		// fourth sharing the exact same microsecond-precision instant as one
		// of them to exercise the `(updated_at, id)` tie-break. If the cursor
		// were derived from `Date#toISOString()` (millisecond precision),
		// all four would collapse to the same cursor tie-break value and a
		// `limit: 1` walk could skip or repeat a row.
		const highest: string = await insertEnvelope(
			'Highest microsecond',
			'draft',
			'2099-01-01T00:00:00.123456Z'
		);
		const middle: string = await insertEnvelope(
			'Middle microsecond',
			'draft',
			'2099-01-01T00:00:00.123123Z'
		);
		const lowest: string = await insertEnvelope(
			'Lowest microsecond',
			'draft',
			'2099-01-01T00:00:00.123000Z'
		);

		const store = new PostgresDashboardStore(sql as ReturnType<typeof postgres>);
		const firstPage = await store.readDashboard(CALLER, query({ limit: 1 }));
		expect(firstPage.items.map((item) => item.envelope.id)).toEqual([highest]);
		expect(firstPage.nextCursor).not.toBeNull();

		const decodedFirst = decodeDashboardCursor(firstPage.nextCursor as string, {
			view: 'all',
			query: null
		});
		expect(decodedFirst.ok).toBe(true);
		if (!decodedFirst.ok) throw new Error('unreachable');
		expect(decodedFirst.value.updatedAt).toBe('2099-01-01T00:00:00.123456Z');

		const secondPage = await store.readDashboard(
			CALLER,
			query({ limit: 1, cursor: decodedFirst.value })
		);
		expect(secondPage.items.map((item) => item.envelope.id)).toEqual([middle]);

		const decodedSecond = decodeDashboardCursor(secondPage.nextCursor as string, {
			view: 'all',
			query: null
		});
		expect(decodedSecond.ok).toBe(true);
		if (!decodedSecond.ok) throw new Error('unreachable');
		expect(decodedSecond.value.updatedAt).toBe('2099-01-01T00:00:00.123123Z');

		const thirdPage = await store.readDashboard(
			CALLER,
			query({ limit: 1, cursor: decodedSecond.value })
		);
		expect(thirdPage.items.map((item) => item.envelope.id)).toEqual([lowest]);
	});

	it('breaks an exact microsecond-precision tie by id, descending, without skipping or repeating a row', async () => {
		const tiedTimestamp: string = '2099-01-02T00:00:00.123456Z';
		const ids: string[] = [];
		for (let i = 0; i < 4; i += 1) {
			ids.push(await insertEnvelope(`Tied ${i}`, 'draft', tiedTimestamp));
		}
		const expectedOrder: string[] = [...ids].sort().reverse();

		const store = new PostgresDashboardStore(sql as ReturnType<typeof postgres>);
		const firstPage = await store.readDashboard(CALLER, query({ limit: 2 }));
		expect(firstPage.items.map((item) => item.envelope.id)).toEqual(expectedOrder.slice(0, 2));

		const decoded = decodeDashboardCursor(firstPage.nextCursor as string, {
			view: 'all',
			query: null
		});
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) throw new Error('unreachable');
		expect(decoded.value.updatedAt).toBe(tiedTimestamp);

		const secondPage = await store.readDashboard(
			CALLER,
			query({ limit: 2, cursor: decoded.value })
		);
		// No skip and no repeat: the second page is exactly the other two
		// tied rows, never overlapping the first page and never omitting one.
		expect(secondPage.items.map((item) => item.envelope.id)).toEqual(expectedOrder.slice(2, 4));
	});

	it('preserves microsecond cursor boundaries with a non-UTC connection TimeZone', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const prefix: string = `Timezone precision ${newUuidV7()}`;
		const firstId: string = await insertEnvelope(
			`${prefix} first`,
			'draft',
			'2099-02-01T00:00:00.123456Z'
		);
		const secondId: string = await insertEnvelope(
			`${prefix} second`,
			'draft',
			'2099-02-01T00:00:00.123123Z'
		);
		const thirdId: string = await insertEnvelope(
			`${prefix} third`,
			'draft',
			'2099-02-01T00:00:00.123000Z'
		);
		const store = new PostgresDashboardStore(sql);
		try {
			await sql.unsafe("SET TIME ZONE 'Asia/Tokyo'");
			let cursor: DashboardStoreQuery['cursor'] = null;
			const ids: string[] = [];
			for (let index: number = 0; index < 3; index += 1) {
				const page = await store.readDashboard(CALLER, query({ query: prefix, limit: 1, cursor }));
				ids.push(...page.items.map((item) => item.envelope.id));
				if (page.nextCursor === null) break;
				const decoded = decodeDashboardCursor(page.nextCursor, { view: 'all', query: prefix });
				if (!decoded.ok) throw new Error('Invalid cursor from PostgreSQL');
				cursor = decoded.value;
			}
			expect(ids).toEqual([firstId, secondId, thirdId]);
		} finally {
			await sql.unsafe("SET TIME ZONE 'UTC'");
		}
	});

	it('bounds first-recipient/next-actionable/progress aggregation to a per-envelope indexed LATERAL join, never a sequential scan of the whole recipient table, even with many off-page historical recipients (EXPLAIN evidence)', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const envelopeId: string = await insertEnvelope('Plan probe', 'sent', AT);
		await insertRecipient(envelopeId, CALLER.email, 'Caller', 'signer', 1, 'pending', AT);
		// 300 off-page historical envelopes, each with its own recipient:
		// large enough that a sequential scan of the whole `recipient` table
		// would be the clearly inferior plan once PostgreSQL has real
		// statistics (`ANALYZE`) to cost against.
		for (let i = 0; i < 300; i += 1) {
			const historicalId: string = await insertEnvelope(
				`Historical ${i}`,
				'completed',
				'2020-01-01T00:00:00.000Z'
			);
			await insertRecipient(
				historicalId,
				`historical-${i}@example.com`,
				'Historical',
				'signer',
				1,
				'completed',
				AT
			);
		}
		await sql.unsafe('ANALYZE recipient');
		await sql.unsafe('ANALYZE envelope');

		const captured: { statement: string; parameters: postgres.ParameterOrJSON<never>[] }[] = [];
		const debugSql = postgres(databaseUrl as string, {
			max: 1,
			onnotice: (): void => undefined,
			debug: (_connection: number, statement: string, parameters: unknown[]): void => {
				if (statement.includes('WITH page_envelopes')) {
					captured.push({ statement, parameters: parameters as postgres.ParameterOrJSON<never>[] });
				}
			}
		});
		try {
			await debugSql.unsafe(`SET search_path TO "${schema}"`);
			const page = await new PostgresDashboardStore(debugSql).readDashboard(CALLER, query());
			const item = page.items.find((candidate) => candidate.envelope.id === envelopeId);
			expect(item?.recipientCount).toBe(1);
			expect(item?.actionRequired).toBe(true);
		} finally {
			await debugSql.end({ timeout: 5 });
		}
		expect(captured).toHaveLength(1);
		// Explain the exact statement and bindings issued by the adapter, not
		// a hand-written approximation whose joins could be optimized away.
		const planRows = await sql.unsafe(`EXPLAIN ${captured[0].statement}`, captured[0].parameters);
		const planText: string = (planRows as unknown as Record<string, string>[])
			.map((row) => Object.values(row)[0])
			.join('\n');

		expect(planText).not.toMatch(/Seq Scan on recipient\b/);
		expect(planText).toMatch(/Nested Loop/);
		expect(planText).toMatch(
			/Index(?: Only)? Scan using (recipient_envelope_route|recipient_envelope_role_status) on recipient/
		);
	});
});
