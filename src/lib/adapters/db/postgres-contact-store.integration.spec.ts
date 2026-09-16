import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ContactApplication } from '$lib/application/contacts/contact-service';
import { PostgresContactStore } from './postgres-contact-store';

const DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const postgresDescribe = DATABASE_URL === undefined ? describe.skip : describe;
const OWNER = 'contact-owner-1';
const OTHER = 'contact-owner-2';
const ID1 = '01900000-0000-7000-8000-000000000711';
const ID2 = '01900000-0000-7000-8000-000000000712';
const ID3 = '01900000-0000-7000-8000-000000000713';
const ID4 = '01900000-0000-7000-8000-000000000714';

postgresDescribe('PostgresContactStore', () => {
	const schema = `signkit_contacts_${randomUUID().replaceAll('-', '')}`;
	let sql: ReturnType<typeof postgres> | null = null;

	beforeAll(async () => {
		sql = postgres(DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		await sql.unsafe(`CREATE SCHEMA "${schema}"`);
		await sql.unsafe(`SET search_path TO "${schema}"`);
		const paths = readdirSync('migrations/postgres')
			.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
			.sort();
		for (const path of paths) {
			await sql.unsafe(readFileSync(`migrations/postgres/${path}`, 'utf8'));
		}
	});

	beforeEach(async () => {
		if (sql === null) return;
		await sql`TRUNCATE contact_command, contact, instance_member CASCADE`;
		await sql`INSERT INTO instance_member (user_id, role, status, created_at, updated_at) VALUES
			(${OWNER}, 'member', 'active', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z'),
			(${OTHER}, 'member', 'active', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z')`;
	});

	afterAll(async () => {
		if (sql === null) return;
		await sql.unsafe('SET search_path TO public');
		await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
		await sql.end({ timeout: 5 });
	});

	it('matches D1 normalization, isolation, replay, stale update, hard delete, and receipt privacy', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const ids: string[] = [ID1, ID2];
		let minute = 0;
		const application = new ContactApplication(
			new PostgresContactStore(sql),
			(): Date => new Date(Date.UTC(2026, 8, 17, 0, minute++)),
			(): string => ids.shift() ?? ID2
		);
		await expect(
			application.create(
				{ id: OWNER },
				{ idempotencyKey: 'create-1', name: ' Alice ', email: ' ALICE@EXAMPLE.COM ', locale: 'ja' }
			)
		).resolves.toMatchObject({
			outcome: 'created',
			contact: { id: ID1, email: 'alice@example.com' }
		});
		await expect(
			application.create(
				{ id: OWNER },
				{ idempotencyKey: 'create-1', name: ' Alice ', email: ' ALICE@EXAMPLE.COM ', locale: 'ja' }
			)
		).resolves.toMatchObject({ outcome: 'replayed', contact: { id: ID1 } });
		await expect(
			application.create(
				{ id: OWNER },
				{ idempotencyKey: 'create-2', name: 'Duplicate', email: 'alice@example.com', locale: 'en' }
			)
		).resolves.toEqual({ outcome: 'email_conflict' });
		const searched = await application.list(
			{ id: OWNER },
			{ cursor: null, limit: 25, query: 'EXAMPLE' }
		);
		expect(searched.outcome === 'listed' ? searched.page.items : []).toHaveLength(1);
		await expect(
			application.update({ id: OTHER }, ID1, {
				idempotencyKey: 'other-update',
				expectedVersion: 1,
				name: 'No',
				email: 'no@example.com',
				locale: 'en'
			})
		).resolves.toEqual({ outcome: 'not_found' });
		await expect(
			application.update({ id: OWNER }, ID1, {
				idempotencyKey: 'update-1',
				expectedVersion: 1,
				name: 'Alice B',
				email: 'alice.b@example.com',
				locale: 'ja'
			})
		).resolves.toMatchObject({ outcome: 'updated', contact: { version: 2 } });
		await expect(
			application.update({ id: OWNER }, ID1, {
				idempotencyKey: 'update-1',
				expectedVersion: 1,
				name: 'Alice B',
				email: 'alice.b@example.com',
				locale: 'ja'
			})
		).resolves.toMatchObject({ outcome: 'replayed', contact: { version: 2 } });
		await expect(
			application.update({ id: OWNER }, ID1, {
				idempotencyKey: 'update-stale',
				expectedVersion: 1,
				name: 'Stale',
				email: 'stale@example.com',
				locale: 'en'
			})
		).resolves.toEqual({ outcome: 'version_conflict' });
		await expect(
			application.delete({ id: OWNER }, ID1, { idempotencyKey: 'delete-1', expectedVersion: 2 })
		).resolves.toMatchObject({ outcome: 'deleted', contactId: ID1 });
		await expect(
			application.delete({ id: OWNER }, ID1, { idempotencyKey: 'delete-1', expectedVersion: 2 })
		).resolves.toMatchObject({ outcome: 'replayed', contactId: ID1 });
		expect(await sql`SELECT id FROM contact`).toEqual([]);
		const receiptColumns = await sql<{ columnName: string }[]>`
			SELECT column_name AS "columnName" FROM information_schema.columns
			WHERE table_schema = ${schema} AND table_name = 'contact_command'`;
		expect(receiptColumns.map((column) => column.columnName)).not.toEqual(
			expect.arrayContaining(['name', 'email', 'locale'])
		);
	});

	it('uses the same byte-stable Unicode ordering across cursor pages as D1', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const ids: string[] = [ID1, ID2, ID3, ID4];
		const application = new ContactApplication(
			new PostgresContactStore(sql),
			(): Date => new Date('2026-09-17T00:00:00.000Z'),
			(): string => ids.shift() ?? ID4
		);
		for (const [key, name, email] of [
			['z', 'Zulu', 'z@example.com'],
			['aring', 'Ångström', 'aring@example.com'],
			['eacute', 'Éclair', 'eacute@example.com'],
			['hiragana', 'あお', 'hiragana@example.com']
		] as const) {
			await application.create({ id: OWNER }, { idempotencyKey: key, name, email, locale: 'en' });
		}

		const names: string[] = [];
		let cursor: string | null = null;
		do {
			const result = await application.list({ id: OWNER }, { cursor, limit: 2, query: null });
			if (result.outcome !== 'listed') throw new Error('expected list');
			names.push(...result.page.items.map((contact) => contact.name));
			cursor = result.page.nextCursor;
		} while (cursor !== null);
		expect(names).toEqual(['Zulu', 'Ångström', 'Éclair', 'あお']);
	});

	it('classifies concurrent normalized-email duplicates without partial receipts', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const leftSql = postgres(DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		const rightSql = postgres(DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		try {
			await leftSql.unsafe(`SET search_path TO "${schema}"`);
			await rightSql.unsafe(`SET search_path TO "${schema}"`);
			const at = (): Date => new Date('2026-09-17T00:00:00.000Z');
			const left = new ContactApplication(new PostgresContactStore(leftSql), at, (): string => ID1);
			const right = new ContactApplication(
				new PostgresContactStore(rightSql),
				at,
				(): string => ID2
			);
			const results = await Promise.all([
				left.create(
					{ id: OWNER },
					{ idempotencyKey: 'left', name: 'Left', email: 'same@example.com', locale: 'en' }
				),
				right.create(
					{ id: OWNER },
					{ idempotencyKey: 'right', name: 'Right', email: ' SAME@EXAMPLE.COM ', locale: 'ja' }
				)
			]);
			expect(results.map((result) => result.outcome).sort()).toEqual(['created', 'email_conflict']);
			expect((await sql`SELECT id FROM contact`).length).toBe(1);
			expect((await sql`SELECT contact_id FROM contact_command`).length).toBe(1);
		} finally {
			await leftSql.end({ timeout: 5 });
			await rightSql.end({ timeout: 5 });
		}
	});

	it('classifies a concurrent exact idempotency collision as one create and one replay', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const leftSql = postgres(DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		const rightSql = postgres(DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		try {
			await leftSql.unsafe(`SET search_path TO "${schema}"`);
			await rightSql.unsafe(`SET search_path TO "${schema}"`);
			const at = (): Date => new Date('2026-09-17T00:00:00.000Z');
			const left = new ContactApplication(new PostgresContactStore(leftSql), at, (): string => ID1);
			const right = new ContactApplication(
				new PostgresContactStore(rightSql),
				at,
				(): string => ID2
			);
			const input = {
				idempotencyKey: 'same-command',
				name: 'Same',
				email: 'same@example.com',
				locale: 'en' as const
			};
			const results = await Promise.all([
				left.create({ id: OWNER }, input),
				right.create({ id: OWNER }, input)
			]);
			expect(results.map((result) => result.outcome).sort()).toEqual(['created', 'replayed']);
			expect((await sql`SELECT id FROM contact`).length).toBe(1);
			expect((await sql`SELECT contact_id FROM contact_command`).length).toBe(1);
		} finally {
			await leftSql.end({ timeout: 5 });
			await rightSql.end({ timeout: 5 });
		}
	});

	it('classifies concurrent updates to the same normalized email without partial receipts', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const at = (): Date => new Date('2026-09-17T00:00:00.000Z');
		const setupIds: string[] = [ID1, ID2];
		const setup = new ContactApplication(
			new PostgresContactStore(sql),
			at,
			(): string => setupIds.shift() ?? ID2
		);
		await setup.create(
			{ id: OWNER },
			{ idempotencyKey: 'create-left', name: 'Left', email: 'left@example.com', locale: 'en' }
		);
		await setup.create(
			{ id: OWNER },
			{ idempotencyKey: 'create-right', name: 'Right', email: 'right@example.com', locale: 'en' }
		);

		const leftSql = postgres(DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		const rightSql = postgres(DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		try {
			await leftSql.unsafe(`SET search_path TO "${schema}"`);
			await rightSql.unsafe(`SET search_path TO "${schema}"`);
			const left = new ContactApplication(new PostgresContactStore(leftSql), at, (): string => ID1);
			const right = new ContactApplication(
				new PostgresContactStore(rightSql),
				at,
				(): string => ID2
			);
			const results = await Promise.all([
				left.update({ id: OWNER }, ID1, {
					idempotencyKey: 'update-left',
					expectedVersion: 1,
					name: 'Left',
					email: 'shared@example.com',
					locale: 'en'
				}),
				right.update({ id: OWNER }, ID2, {
					idempotencyKey: 'update-right',
					expectedVersion: 1,
					name: 'Right',
					email: ' SHARED@EXAMPLE.COM ',
					locale: 'en'
				})
			]);
			expect(results.map((result) => result.outcome).sort()).toEqual(['email_conflict', 'updated']);
			const contacts = await sql<{ email: string; version: number }[]>`
				SELECT email, version FROM contact ORDER BY id`;
			expect(contacts.filter((contact) => contact.email === 'shared@example.com')).toHaveLength(1);
			expect(contacts.map((contact) => contact.version).sort()).toEqual([1, 2]);
			expect((await sql`SELECT contact_id FROM contact_command`).length).toBe(3);
		} finally {
			await leftSql.end({ timeout: 5 });
			await rightSql.end({ timeout: 5 });
		}
	});

	it('does not receipt or replay the loser of fixed-clock same-version updates', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const at = (): Date => new Date('2026-09-17T00:00:00.000Z');
		const setup = new ContactApplication(new PostgresContactStore(sql), at, (): string => ID1);
		await setup.create(
			{ id: OWNER },
			{ idempotencyKey: 'create', name: 'Original', email: 'original@example.com', locale: 'en' }
		);

		const leftSql = postgres(DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		const rightSql = postgres(DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		try {
			await leftSql.unsafe(`SET search_path TO "${schema}"`);
			await rightSql.unsafe(`SET search_path TO "${schema}"`);
			const left = new ContactApplication(new PostgresContactStore(leftSql), at, (): string => ID1);
			const right = new ContactApplication(
				new PostgresContactStore(rightSql),
				at,
				(): string => ID2
			);
			const results = await Promise.all([
				left.update({ id: OWNER }, ID1, {
					idempotencyKey: 'update-left',
					expectedVersion: 1,
					name: 'Left',
					email: 'left@example.com',
					locale: 'en'
				}),
				right.update({ id: OWNER }, ID1, {
					idempotencyKey: 'update-right',
					expectedVersion: 1,
					name: 'Right',
					email: 'right@example.com',
					locale: 'ja'
				})
			]);
			expect(results.map((result) => result.outcome).sort()).toEqual([
				'updated',
				'version_conflict'
			]);
			expect((await sql`SELECT id FROM contact`).length).toBe(1);
			expect((await sql`SELECT contact_id FROM contact_command`).length).toBe(2);
			expect(
				(
					await sql`SELECT idempotency_key FROM contact_command
						WHERE idempotency_key IN ('update-left', 'update-right')`
				).length
			).toBe(1);
		} finally {
			await leftSql.end({ timeout: 5 });
			await rightSql.end({ timeout: 5 });
		}
	});
});
