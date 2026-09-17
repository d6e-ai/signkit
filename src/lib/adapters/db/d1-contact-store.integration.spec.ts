import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ContactApplication } from '$lib/application/contacts/contact-service';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';
import { D1ContactStore } from './d1-contact-store';

const OWNER = 'contact-owner-1';
const OTHER = 'contact-owner-2';
const ID1 = '01900000-0000-7000-8000-000000000701';
const ID2 = '01900000-0000-7000-8000-000000000702';
const ID3 = '01900000-0000-7000-8000-000000000703';
const ID4 = '01900000-0000-7000-8000-000000000704';

function fixture(fixedNow?: () => Date) {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at) VALUES
		('${OWNER}', 'member', 'active', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z'),
		('${OTHER}', 'member', 'active', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z');
	`);
	const ids: string[] = [ID1, ID2, ID3, ID4];
	let tick = 0;
	const application = new ContactApplication(
		new D1ContactStore(sqliteD1Database(sqlite)),
		fixedNow ?? ((): Date => new Date(Date.UTC(2026, 8, 17, 0, tick++))),
		(): string => ids.shift() ?? ID4
	);
	return { sqlite, application };
}

describe('D1ContactStore', () => {
	it('persists a lowercase search key that expands beyond the display-name limit', async () => {
		const { sqlite, application } = fixture();
		try {
			const expandingName: string = '\u0130'.repeat(200);
			await expect(
				application.create(
					{ id: OWNER },
					{
						idempotencyKey: 'unicode-expansion',
						name: expandingName,
						email: 'unicode@example.com',
						locale: 'en'
					}
				)
			).resolves.toMatchObject({ outcome: 'created', contact: { name: expandingName } });
			expect(sqlite.prepare('SELECT length(name_search) AS length FROM contact').get()).toEqual({
				length: 400
			});
			const searched = await application.list(
				{ id: OWNER },
				{ cursor: null, limit: 25, query: expandingName }
			);
			expect(searched.outcome === 'listed' ? searched.page.items : []).toHaveLength(1);
		} finally {
			sqlite.close();
		}
	});

	it('normalizes, isolates owners, paginates, and searches without putting PII in a cursor', async () => {
		const { sqlite, application } = fixture();
		try {
			const first = await application.create(
				{ id: OWNER },
				{ idempotencyKey: 'create-1', name: ' Alice ', email: ' Alice@Example.COM ', locale: 'ja' }
			);
			expect(first).toMatchObject({
				outcome: 'created',
				contact: { id: ID1, name: 'Alice', email: 'alice@example.com', locale: 'ja', version: 1 }
			});
			await expect(
				application.create(
					{ id: OWNER },
					{
						idempotencyKey: 'create-1',
						name: ' Alice ',
						email: ' Alice@Example.COM ',
						locale: 'ja'
					}
				)
			).resolves.toMatchObject({ outcome: 'replayed', contact: { id: ID1 } });
			await application.create(
				{ id: OWNER },
				{ idempotencyKey: 'create-2', name: 'Bob', email: 'bob@example.com', locale: 'en' }
			);

			const page = await application.list({ id: OWNER }, { cursor: null, limit: 1, query: null });
			expect(page.outcome).toBe('listed');
			if (page.outcome !== 'listed') throw new Error('expected list');
			expect(page.page.items.map((contact) => contact.name)).toEqual(['Alice']);
			expect(page.page.nextCursor).toBe(ID1);
			expect(page.page.nextCursor).not.toContain('alice');

			const searched = await application.list(
				{ id: OWNER },
				{ cursor: null, limit: 25, query: 'EXAMPLE.COM' }
			);
			expect(searched.outcome === 'listed' ? searched.page.items : []).toHaveLength(2);

			const other = await application.list({ id: OTHER }, { cursor: ID1, limit: 25, query: null });
			expect(other).toEqual({ outcome: 'listed', page: { items: [], nextCursor: null } });
		} finally {
			sqlite.close();
		}
	});

	it('uses byte-stable Unicode ordering across cursor pages', async () => {
		const { sqlite, application } = fixture();
		try {
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
		} finally {
			sqlite.close();
		}
	});

	it('enforces normalized-email uniqueness per owner and opaque cross-owner mutations', async () => {
		const { sqlite, application } = fixture();
		try {
			await application.create(
				{ id: OWNER },
				{ idempotencyKey: 'create-1', name: 'Alice', email: 'alice@example.com', locale: 'en' }
			);
			await expect(
				application.create(
					{ id: OWNER },
					{
						idempotencyKey: 'create-2',
						name: 'Duplicate',
						email: ' ALICE@EXAMPLE.COM ',
						locale: 'ja'
					}
				)
			).resolves.toEqual({ outcome: 'email_conflict' });

			await expect(
				application.update({ id: OTHER }, ID1, {
					idempotencyKey: 'update-other',
					expectedVersion: 1,
					name: 'Stolen',
					email: 'stolen@example.com',
					locale: 'en'
				})
			).resolves.toEqual({ outcome: 'not_found' });
			await expect(
				application.delete({ id: OTHER }, ID1, {
					idempotencyKey: 'delete-other',
					expectedVersion: 1
				})
			).resolves.toEqual({ outcome: 'not_found' });
		} finally {
			sqlite.close();
		}
	});

	it('updates with optimistic concurrency, hard deletes, and replays without PII receipts', async () => {
		const { sqlite, application } = fixture();
		try {
			await application.create(
				{ id: OWNER },
				{ idempotencyKey: 'create-1', name: 'Alice', email: 'alice@example.com', locale: 'en' }
			);
			const updated = await application.update({ id: OWNER }, ID1, {
				idempotencyKey: 'update-1',
				expectedVersion: 1,
				name: 'Alice B',
				email: 'alice.b@example.com',
				locale: 'ja'
			});
			expect(updated).toMatchObject({ outcome: 'updated', contact: { version: 2 } });
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
					name: 'Old',
					email: 'old@example.com',
					locale: 'en'
				})
			).resolves.toEqual({ outcome: 'version_conflict' });

			const removed = await application.delete({ id: OWNER }, ID1, {
				idempotencyKey: 'delete-1',
				expectedVersion: 2
			});
			expect(removed).toMatchObject({ outcome: 'deleted', contactId: ID1 });
			const replayed = await application.delete({ id: OWNER }, ID1, {
				idempotencyKey: 'delete-1',
				expectedVersion: 2
			});
			expect(replayed).toMatchObject({ outcome: 'replayed', contactId: ID1 });
			expect(sqlite.prepare('SELECT COUNT(*) AS count FROM contact').get()).toEqual({ count: 0 });

			const receiptColumns = sqlite
				.prepare("PRAGMA table_info('contact_command')")
				.all()
				.map((row) => String((row as { name: unknown }).name));
			expect(receiptColumns).not.toEqual(expect.arrayContaining(['name', 'email', 'locale']));
		} finally {
			sqlite.close();
		}
	});

	it('classifies concurrent normalized-email creates and exact idempotency replay atomically', async () => {
		const { sqlite, application } = fixture(() => new Date('2026-09-17T00:00:00.000Z'));
		try {
			const duplicates = await Promise.all([
				application.create(
					{ id: OWNER },
					{ idempotencyKey: 'left', name: 'Left', email: 'same@example.com', locale: 'en' }
				),
				application.create(
					{ id: OWNER },
					{ idempotencyKey: 'right', name: 'Right', email: ' SAME@EXAMPLE.COM ', locale: 'ja' }
				)
			]);
			expect(duplicates.map((result) => result.outcome).sort()).toEqual([
				'created',
				'email_conflict'
			]);

			const input = {
				idempotencyKey: 'same-command',
				name: 'Exact',
				email: 'exact@example.com',
				locale: 'en' as const
			};
			const replay = await Promise.all([
				application.create({ id: OWNER }, input),
				application.create({ id: OWNER }, input)
			]);
			expect(replay.map((result) => result.outcome).sort()).toEqual(['created', 'replayed']);
			expect(sqlite.prepare('SELECT COUNT(*) AS count FROM contact').get()).toEqual({ count: 2 });
			expect(sqlite.prepare('SELECT COUNT(*) AS count FROM contact_command').get()).toEqual({
				count: 2
			});
		} finally {
			sqlite.close();
		}
	});

	it('classifies concurrent normalized-email updates without partial receipts', async () => {
		const { sqlite, application } = fixture(() => new Date('2026-09-17T00:00:00.000Z'));
		try {
			await application.create(
				{ id: OWNER },
				{ idempotencyKey: 'create-left', name: 'Left', email: 'left@example.com', locale: 'en' }
			);
			await application.create(
				{ id: OWNER },
				{ idempotencyKey: 'create-right', name: 'Right', email: 'right@example.com', locale: 'en' }
			);
			const results = await Promise.all([
				application.update({ id: OWNER }, ID1, {
					idempotencyKey: 'update-left',
					expectedVersion: 1,
					name: 'Left',
					email: 'shared@example.com',
					locale: 'en'
				}),
				application.update({ id: OWNER }, ID2, {
					idempotencyKey: 'update-right',
					expectedVersion: 1,
					name: 'Right',
					email: ' SHARED@EXAMPLE.COM ',
					locale: 'en'
				})
			]);
			expect(results.map((result) => result.outcome).sort()).toEqual(['email_conflict', 'updated']);
			expect(sqlite.prepare('SELECT COUNT(*) AS count FROM contact_command').get()).toEqual({
				count: 3
			});
		} finally {
			sqlite.close();
		}
	});

	it('does not receipt or replay the loser of fixed-clock same-version updates', async () => {
		const { sqlite, application } = fixture(() => new Date('2026-09-17T00:00:00.000Z'));
		try {
			await application.create(
				{ id: OWNER },
				{ idempotencyKey: 'create', name: 'Original', email: 'original@example.com', locale: 'en' }
			);
			const results = await Promise.all([
				application.update({ id: OWNER }, ID1, {
					idempotencyKey: 'update-left',
					expectedVersion: 1,
					name: 'Left',
					email: 'left@example.com',
					locale: 'en'
				}),
				application.update({ id: OWNER }, ID1, {
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
			expect(sqlite.prepare('SELECT COUNT(*) AS count FROM contact_command').get()).toEqual({
				count: 2
			});
			expect(
				sqlite
					.prepare(
						"SELECT COUNT(*) AS count FROM contact_command WHERE idempotency_key IN ('update-left','update-right')"
					)
					.get()
			).toEqual({ count: 1 });
		} finally {
			sqlite.close();
		}
	});
});
