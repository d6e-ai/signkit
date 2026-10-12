import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUuidV7 } from '$lib/ids/uuid-v7';
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
	});

	afterAll(async () => {
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
				${updatedAt}::timestamptz, ${updatedAt}::timestamptz)`;
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

	it('performs a literal, escaped search across title and recipient name/email', async () => {
		const target: string = await insertEnvelope('50%_off\\deal', 'draft', AT);
		await insertEnvelope('xx50xxoffxxdealxx', 'draft', AT);

		const store = new PostgresDashboardStore(sql as ReturnType<typeof postgres>);
		const page = await store.readDashboard(CALLER, query({ query: '50%_off\\deal' }));
		expect(page.items.map((item) => item.envelope.id)).toEqual([target]);
	});

	it('paginates with a stable updatedAt-desc,id-desc cursor under tied timestamps, with counts independent of row volume', async () => {
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

		const secondPage = await store.readDashboard(
			CALLER,
			query({ limit: 25, cursor: firstPage.nextCursor })
		);
		expect(secondPage.items.map((item) => item.envelope.id)).toEqual(expectedOrder.slice(25, 50));
	});
});
