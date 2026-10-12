import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { normalizeRecipientEmail } from '$lib/domain/recipient-identity';
import type { EnvelopeStatus, RecipientRole, RecipientStatus } from '$lib/domain/envelope';
import { decodeDashboardCursor, encodeDashboardCursor } from '$lib/application/dashboard/cursor';
import type { DashboardActor, DashboardStoreQuery } from '$lib/ports/dashboard-store';
import { D1DashboardStore } from './d1-dashboard-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const CALLER: DashboardActor = { email: 'caller@example.com' };
const BASE_TIME: number = Date.parse('2026-09-11T00:00:00.000Z');

function uuid(sequence: number): string {
	const hex: string = sequence.toString(16).padStart(12, '0');
	return `01910000-0000-7000-8000-${hex}`;
}

function isoAt(offsetSeconds: number): string {
	return new Date(BASE_TIME + offsetSeconds * 1000).toISOString();
}

interface RecipientFixture {
	id: string;
	email: string;
	name: string;
	role: RecipientRole;
	routingOrder: number;
	status: RecipientStatus;
}

interface EnvelopeFixture {
	id: string;
	status: EnvelopeStatus;
	title: string;
	updatedAtOffsetSeconds: number;
	recipients: readonly RecipientFixture[];
}

function createFixtureSqlite(envelopes: readonly EnvelopeFixture[]): DatabaseSync {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	sqlite
		.prepare(
			`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			 VALUES ('user-1', 'owner', 'active', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z')`
		)
		.run();
	for (const envelope of envelopes) {
		const updatedAt: string = isoAt(envelope.updatedAtOffsetSeconds);
		sqlite
			.prepare(
				`INSERT INTO envelope (
					id, created_by_user_id, title, status, repository_generation, repository_head,
					repository_archive_key, repository_archive_sha256, created_at, updated_at
				) VALUES (?, 'user-1', ?, ?, 1, 'sha-1', 'archives/a.git.gz', ?, ?, ?)`
			)
			.run(envelope.id, envelope.title, envelope.status, 'a'.repeat(64), updatedAt, updatedAt);
		for (const recipient of envelope.recipients) {
			sqlite
				.prepare(
					`INSERT INTO recipient (
						id, envelope_id, email, name, role, locale, routing_order, status,
						created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, 'en', ?, ?, ?, ?)`
				)
				.run(
					recipient.id,
					envelope.id,
					recipient.email,
					recipient.name,
					recipient.role,
					recipient.routingOrder,
					recipient.status,
					updatedAt,
					updatedAt
				);
		}
	}
	return sqlite;
}

function createFixtureDatabase(envelopes: readonly EnvelopeFixture[]): D1Database {
	return sqliteD1Database(createFixtureSqlite(envelopes));
}

function query(overrides: Partial<DashboardStoreQuery> = {}): DashboardStoreQuery {
	return { view: 'all', query: null, cursor: null, limit: 25, ...overrides };
}

describe('D1DashboardStore', () => {
	it('preserves exact non-ASCII title and recipient-name searches without JavaScript/SQLite folding mismatches', async () => {
		const database = createFixtureDatabase([
			{
				id: uuid(999),
				status: 'draft',
				title: 'Überprüfung 契約書',
				updatedAtOffsetSeconds: 1,
				recipients: [
					{
						id: uuid(9991),
						email: 'elodie@example.com',
						name: 'Élodie',
						role: 'signer',
						routingOrder: 1,
						status: 'pending'
					}
				]
			}
		]);
		const store = new D1DashboardStore(database);
		for (const text of ['Überprüfung', 'Élodie', '契約書']) {
			const page = await store.readDashboard(CALLER, query({ query: text }));
			expect(page.items.map((item) => item.envelope.id)).toEqual([uuid(999)]);
		}
	});

	it('classifies action_required only for the caller holding the active turn, and waiting otherwise', async () => {
		const database = createFixtureDatabase([
			{
				id: uuid(1),
				status: 'sent',
				title: 'Caller turn',
				updatedAtOffsetSeconds: 10,
				recipients: [
					{
						id: uuid(101),
						email: CALLER.email,
						name: 'Caller',
						role: 'signer',
						routingOrder: 1,
						status: 'pending'
					}
				]
			},
			{
				id: uuid(2),
				status: 'in_progress',
				title: "Other's turn",
				updatedAtOffsetSeconds: 20,
				recipients: [
					{
						id: uuid(201),
						email: 'other@example.com',
						name: 'Other',
						role: 'signer',
						routingOrder: 1,
						status: 'pending'
					}
				]
			}
		]);
		const store = new D1DashboardStore(database);

		const actionRequired = await store.readDashboard(CALLER, query({ view: 'action_required' }));
		expect(actionRequired.items.map((item) => item.envelope.id)).toEqual([uuid(1)]);
		expect(actionRequired.items[0]?.actionRequired).toBe(true);

		const waiting = await store.readDashboard(CALLER, query({ view: 'waiting' }));
		expect(waiting.items.map((item) => item.envelope.id)).toEqual([uuid(2)]);
		expect(waiting.items[0]?.actionRequired).toBe(false);

		expect(actionRequired.counts).toEqual({
			all: 2,
			actionRequired: 1,
			waiting: 1,
			drafts: 0,
			completed: 0
		});
	});

	it('only treats a caller as holding the turn at the earliest outstanding routing order, not a later one', async () => {
		const database = createFixtureDatabase([
			{
				id: uuid(3),
				status: 'sent',
				title: 'Sequential',
				updatedAtOffsetSeconds: 10,
				recipients: [
					{
						id: uuid(301),
						email: 'first@example.com',
						name: 'First',
						role: 'signer',
						routingOrder: 1,
						status: 'pending'
					},
					{
						id: uuid(302),
						email: CALLER.email,
						name: 'Caller',
						role: 'signer',
						routingOrder: 2,
						status: 'pending'
					}
				]
			}
		]);
		const store = new D1DashboardStore(database);
		const page = await store.readDashboard(CALLER, query());
		expect(page.items[0]?.actionRequired).toBe(false);
		expect(page.items[0]?.nextRecipient).toEqual({ name: 'First', email: 'first@example.com' });
	});

	it('resolves a declined earlier recipient so the next outstanding group becomes active, matching domain routing policy', async () => {
		const database = createFixtureDatabase([
			{
				id: uuid(30),
				status: 'sent',
				title: 'Declined predecessor',
				updatedAtOffsetSeconds: 10,
				recipients: [
					{
						id: uuid(3001),
						email: 'declined@example.com',
						name: 'Declined',
						role: 'signer',
						routingOrder: 1,
						status: 'declined'
					},
					{
						id: uuid(3002),
						email: CALLER.email,
						name: 'Caller',
						role: 'approver',
						routingOrder: 2,
						status: 'pending'
					}
				]
			}
		]);
		const store = new D1DashboardStore(database);
		const page = await store.readDashboard(CALLER, query({ view: 'action_required' }));
		expect(page.items.map((item) => item.envelope.id)).toEqual([uuid(30)]);
		expect(page.items[0]?.nextRecipient).toEqual({ name: 'Caller', email: CALLER.email });
	});

	it('includes every parallel recipient at the active routing order for action_required', async () => {
		const database = createFixtureDatabase([
			{
				id: uuid(4),
				status: 'sent',
				title: 'Parallel',
				updatedAtOffsetSeconds: 10,
				recipients: [
					{
						id: uuid(401),
						email: 'other@example.com',
						name: 'Other',
						role: 'approver',
						routingOrder: 1,
						status: 'pending'
					},
					{
						id: uuid(402),
						email: CALLER.email,
						name: 'Caller',
						role: 'signer',
						routingOrder: 1,
						status: 'pending'
					}
				]
			}
		]);
		const store = new D1DashboardStore(database);
		const page = await store.readDashboard(CALLER, query({ view: 'action_required' }));
		expect(page.items).toHaveLength(1);
		expect(page.items[0]?.actionRequired).toBe(true);
	});

	it('excludes cc recipients from next-recipient selection and action-required classification', async () => {
		const database = createFixtureDatabase([
			{
				id: uuid(5),
				status: 'sent',
				title: 'CC only turn',
				updatedAtOffsetSeconds: 10,
				recipients: [
					{
						id: uuid(501),
						email: CALLER.email,
						name: 'Caller CC',
						role: 'cc',
						routingOrder: 1,
						status: 'pending'
					},
					{
						id: uuid(502),
						email: 'signer@example.com',
						name: 'Signer',
						role: 'signer',
						routingOrder: 1,
						status: 'pending'
					}
				]
			}
		]);
		const store = new D1DashboardStore(database);
		const page = await store.readDashboard(CALLER, query());
		expect(page.items[0]?.actionRequired).toBe(false);
		expect(page.items[0]?.nextRecipient).toEqual({ name: 'Signer', email: 'signer@example.com' });
	});

	it('handles an envelope with no recipients and a cc-only envelope without error', async () => {
		const database = createFixtureDatabase([
			{
				id: uuid(6),
				status: 'draft',
				title: 'No recipients',
				updatedAtOffsetSeconds: 10,
				recipients: []
			},
			{
				id: uuid(7),
				status: 'sent',
				title: 'CC only',
				updatedAtOffsetSeconds: 20,
				recipients: [
					{
						id: uuid(701),
						email: 'cc@example.com',
						name: 'CC',
						role: 'cc',
						routingOrder: 1,
						status: 'pending'
					}
				]
			}
		]);
		const store = new D1DashboardStore(database);
		const page = await store.readDashboard(CALLER, query());
		expect(page.items).toHaveLength(2);
		const noRecipients = page.items.find((item) => item.envelope.id === uuid(6));
		expect(noRecipients?.recipient).toBeNull();
		expect(noRecipients?.nextRecipient).toBeNull();
		const ccOnly = page.items.find((item) => item.envelope.id === uuid(7));
		expect(ccOnly?.actionRequired).toBe(false);
		expect(ccOnly?.nextRecipient).toBeNull();
	});

	it('buckets draft and ready into drafts, and completed only into completed, excluding them from action_required/waiting', async () => {
		const database = createFixtureDatabase([
			{ id: uuid(8), status: 'draft', title: 'D', updatedAtOffsetSeconds: 1, recipients: [] },
			{ id: uuid(9), status: 'ready', title: 'R', updatedAtOffsetSeconds: 2, recipients: [] },
			{
				id: uuid(10),
				status: 'completed',
				title: 'C',
				updatedAtOffsetSeconds: 3,
				recipients: [
					{
						id: uuid(1001),
						email: CALLER.email,
						name: 'Caller',
						role: 'signer',
						routingOrder: 1,
						status: 'completed'
					}
				]
			}
		]);
		const store = new D1DashboardStore(database);
		const drafts = await store.readDashboard(CALLER, query({ view: 'drafts' }));
		expect(drafts.items.map((i) => i.envelope.id).sort()).toEqual([uuid(8), uuid(9)].sort());
		const completed = await store.readDashboard(CALLER, query({ view: 'completed' }));
		expect(completed.items.map((i) => i.envelope.id)).toEqual([uuid(10)]);
		const actionRequired = await store.readDashboard(CALLER, query({ view: 'action_required' }));
		expect(actionRequired.items).toHaveLength(0);
	});

	it('preserves voided, declined, and expired envelopes only in the all view', async () => {
		const database = createFixtureDatabase([
			{ id: uuid(11), status: 'voided', title: 'V', updatedAtOffsetSeconds: 1, recipients: [] },
			{ id: uuid(12), status: 'declined', title: 'Dcl', updatedAtOffsetSeconds: 2, recipients: [] },
			{ id: uuid(13), status: 'expired', title: 'Exp', updatedAtOffsetSeconds: 3, recipients: [] }
		]);
		const store = new D1DashboardStore(database);
		const all = await store.readDashboard(CALLER, query());
		expect(all.items).toHaveLength(3);
		for (const view of ['action_required', 'waiting', 'drafts', 'completed'] as const) {
			const page = await store.readDashboard(CALLER, query({ view }));
			expect(page.items).toHaveLength(0);
		}
	});

	it('matches a literal, case-insensitive search against the title and recipient name/email', async () => {
		const database = createFixtureDatabase([
			{
				id: uuid(14),
				status: 'draft',
				title: 'Master Services Agreement',
				updatedAtOffsetSeconds: 1,
				recipients: []
			},
			{
				id: uuid(15),
				status: 'draft',
				title: 'Unrelated',
				updatedAtOffsetSeconds: 2,
				recipients: [
					{
						id: uuid(1501),
						email: 'jane.doe@example.com',
						name: 'Jane Doe',
						role: 'signer',
						routingOrder: 1,
						status: 'pending'
					}
				]
			},
			{
				id: uuid(16),
				status: 'draft',
				title: 'No match here',
				updatedAtOffsetSeconds: 3,
				recipients: []
			}
		]);
		const store = new D1DashboardStore(database);
		const byTitle = await store.readDashboard(CALLER, query({ query: 'services AGREEMENT' }));
		expect(byTitle.items.map((i) => i.envelope.id)).toEqual([uuid(14)]);
		const byName = await store.readDashboard(CALLER, query({ query: 'jane' }));
		expect(byName.items.map((i) => i.envelope.id)).toEqual([uuid(15)]);
		const byEmail = await store.readDashboard(CALLER, query({ query: 'jane.doe@example.com' }));
		expect(byEmail.items.map((i) => i.envelope.id)).toEqual([uuid(15)]);
	});

	it('treats percent, underscore, and backslash in the search text as literal characters', async () => {
		const database = createFixtureDatabase([
			{
				id: uuid(17),
				status: 'draft',
				title: '50%_off\\deal',
				updatedAtOffsetSeconds: 1,
				recipients: []
			},
			{
				id: uuid(18),
				status: 'draft',
				title: 'xx50xxoffxxdealxx',
				updatedAtOffsetSeconds: 2,
				recipients: []
			}
		]);
		const store = new D1DashboardStore(database);
		const matched = await store.readDashboard(CALLER, query({ query: '50%_off\\deal' }));
		expect(matched.items.map((i) => i.envelope.id)).toEqual([uuid(17)]);
	});

	it('counts reflect the whole instance regardless of the active search text', async () => {
		const database = createFixtureDatabase([
			{ id: uuid(19), status: 'draft', title: 'Alpha', updatedAtOffsetSeconds: 1, recipients: [] },
			{ id: uuid(20), status: 'draft', title: 'Beta', updatedAtOffsetSeconds: 2, recipients: [] }
		]);
		const store = new D1DashboardStore(database);
		const filtered = await store.readDashboard(CALLER, query({ query: 'alpha' }));
		expect(filtered.items).toHaveLength(1);
		expect(filtered.counts.all).toBe(2);
		expect(filtered.counts.drafts).toBe(2);
	});

	it('scopes completedRecipientCount and actionableRecipientCount to signer/approver only, counting true signed and approved cases and excluding cc', async () => {
		const database = createFixtureDatabase([
			{
				id: uuid(40),
				status: 'completed',
				title: 'Mixed progress',
				updatedAtOffsetSeconds: 1,
				recipients: [
					{
						id: uuid(4001),
						email: 'signer@example.com',
						name: 'Signer',
						role: 'signer',
						routingOrder: 1,
						status: 'completed'
					},
					{
						id: uuid(4002),
						email: 'approver@example.com',
						name: 'Approver',
						role: 'approver',
						routingOrder: 2,
						status: 'completed'
					},
					{
						id: uuid(4003),
						email: 'cc@example.com',
						name: 'CC',
						role: 'cc',
						routingOrder: 1,
						status: 'pending'
					},
					{
						id: uuid(4004),
						email: 'viewer@example.com',
						name: 'Viewer',
						role: 'viewer',
						routingOrder: 1,
						status: 'pending'
					}
				]
			}
		]);
		const store = new D1DashboardStore(database);
		const page = await store.readDashboard(CALLER, query());
		const item = page.items[0];
		expect(item?.recipientCount).toBe(4);
		expect(item?.actionableRecipientCount).toBe(2);
		expect(item?.completedRecipientCount).toBe(2);
	});

	it('never counts a cc or viewer recipient toward completedRecipientCount even if only those roles are present', async () => {
		const database = createFixtureDatabase([
			{
				id: uuid(41),
				status: 'sent',
				title: 'No actionable recipients',
				updatedAtOffsetSeconds: 1,
				recipients: [
					{
						id: uuid(4101),
						email: 'cc@example.com',
						name: 'CC',
						role: 'cc',
						routingOrder: 1,
						status: 'pending'
					}
				]
			}
		]);
		const store = new D1DashboardStore(database);
		const page = await store.readDashboard(CALLER, query());
		expect(page.items[0]?.completedRecipientCount).toBe(0);
		expect(page.items[0]?.actionableRecipientCount).toBe(0);
	});

	it('paginates with a stable updatedAt-desc,id-desc opaque cursor, even when updatedAt ties', async () => {
		const envelopes: EnvelopeFixture[] = Array.from({ length: 5 }, (_, index) => ({
			id: uuid(100 + index),
			status: 'draft' as const,
			title: `Tied ${index}`,
			updatedAtOffsetSeconds: 0,
			recipients: []
		}));
		const database = createFixtureDatabase(envelopes);
		const store = new D1DashboardStore(database);
		const expectedOrder: string[] = [...envelopes.map((e) => e.id)].sort().reverse();

		const firstPage = await store.readDashboard(CALLER, query({ limit: 2 }));
		expect(firstPage.items.map((i) => i.envelope.id)).toEqual(expectedOrder.slice(0, 2));
		expect(firstPage.nextCursor).not.toBeNull();

		const decoded = decodeDashboardCursor(firstPage.nextCursor as string, {
			view: 'all',
			query: null
		});
		expect(decoded.ok).toBe(true);
		if (decoded.ok) expect(decoded.value.id).toBe(expectedOrder[1]);

		const secondPage = await store.readDashboard(
			CALLER,
			query({ limit: 2, cursor: decoded.ok ? decoded.value : null })
		);
		expect(secondPage.items.map((i) => i.envelope.id)).toEqual(expectedOrder.slice(2, 4));

		const secondDecoded = decodeDashboardCursor(secondPage.nextCursor as string, {
			view: 'all',
			query: null
		});
		const thirdPage = await store.readDashboard(
			CALLER,
			query({ limit: 2, cursor: secondDecoded.ok ? secondDecoded.value : null })
		);
		expect(thirdPage.items.map((i) => i.envelope.id)).toEqual(expectedOrder.slice(4, 5));
		expect(thirdPage.nextCursor).toBeNull();
	});

	it('is unaffected by a cursor anchored to an envelope that no longer exists, unlike a live row-id lookup', async () => {
		const database = createFixtureDatabase([
			{
				id: uuid(51),
				status: 'draft',
				title: 'Before anchor',
				updatedAtOffsetSeconds: 3,
				recipients: []
			}
		]);
		const store = new D1DashboardStore(database);
		// `uuid(50)` is never inserted: this models a cursor minted while its
		// anchor envelope existed, then the anchor was deleted before the next
		// page was requested. Because the cursor carries the keyset position
		// itself rather than an id to look up, the deleted anchor changes
		// nothing about the page boundary.
		const cursor = encodeDashboardCursor('all', null, { updatedAt: isoAt(5), id: uuid(50) });
		const decoded = decodeDashboardCursor(cursor, { view: 'all', query: null });
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) throw new Error('unreachable');
		const page = await store.readDashboard(CALLER, query({ cursor: decoded.value }));
		expect(page.items.map((i) => i.envelope.id)).toEqual([uuid(51)]);
	});

	it('rejects a cursor minted under a different view or search text as a context mismatch', () => {
		const cursor = encodeDashboardCursor('drafts', 'foo', {
			updatedAt: isoAt(1),
			id: uuid(60)
		});
		expect(decodeDashboardCursor(cursor, { view: 'all', query: 'foo' })).toEqual({
			ok: false,
			reason: 'context_mismatch'
		});
		expect(decodeDashboardCursor(cursor, { view: 'drafts', query: 'bar' })).toEqual({
			ok: false,
			reason: 'context_mismatch'
		});
		expect(decodeDashboardCursor(cursor, { view: 'drafts', query: 'foo' })).toEqual({
			ok: true,
			value: { updatedAt: isoAt(1), id: uuid(60) }
		});
	});

	it('rejects a malformed, truncated, or non-UUID cursor', () => {
		expect(decodeDashboardCursor('not-base64url!!', { view: 'all', query: null }).ok).toBe(false);
		expect(decodeDashboardCursor('', { view: 'all', query: null }).ok).toBe(false);
		const badId = encodeDashboardCursor('all', null, { updatedAt: isoAt(1), id: 'not-a-uuid' });
		expect(decodeDashboardCursor(badId, { view: 'all', query: null }).ok).toBe(false);
	});

	it('scales to over 100 envelopes with counts and pagination independent of row volume', async () => {
		const envelopes: EnvelopeFixture[] = Array.from({ length: 140 }, (_, index) => ({
			id: uuid(1000 + index),
			status: index % 3 === 0 ? ('completed' as const) : ('draft' as const),
			title: `Bulk ${index}`,
			updatedAtOffsetSeconds: index,
			recipients: []
		}));
		const database = createFixtureDatabase(envelopes);
		const store = new D1DashboardStore(database);
		const page = await store.readDashboard(CALLER, query({ limit: 25 }));
		expect(page.items).toHaveLength(25);
		expect(page.counts.all).toBe(140);
		const completedCount = envelopes.filter((e) => e.status === 'completed').length;
		expect(page.counts.completed).toBe(completedCount);
		expect(page.counts.drafts).toBe(140 - completedCount);
	});

	it('issues exactly one batch of two statements regardless of row volume', async () => {
		const envelopes: EnvelopeFixture[] = Array.from({ length: 120 }, (_, index) => ({
			id: uuid(2000 + index),
			status: 'draft' as const,
			title: `Row ${index}`,
			updatedAtOffsetSeconds: index,
			recipients: []
		}));
		const database = createFixtureDatabase(envelopes);
		const batchSpy = database.batch.bind(database);
		let callCount: number = 0;
		let lastStatementCount: number = 0;
		database.batch = (async (statements: D1PreparedStatement[]) => {
			callCount += 1;
			lastStatementCount = statements.length;
			return batchSpy(statements);
		}) as typeof database.batch;
		const store = new D1DashboardStore(database);
		await store.readDashboard(CALLER, query({ limit: 25 }));
		expect(callCount).toBe(1);
		expect(lastStatementCount).toBe(2);
	});

	it('handles case differences between the caller session email and the stored recipient email', async () => {
		const database = createFixtureDatabase([
			{
				id: uuid(21),
				status: 'sent',
				title: 'Case',
				updatedAtOffsetSeconds: 1,
				recipients: [
					{
						id: uuid(2101),
						email: normalizeRecipientEmail('Caller@Example.com'),
						name: 'Caller',
						role: 'signer',
						routingOrder: 1,
						status: 'pending'
					}
				]
			}
		]);
		const store = new D1DashboardStore(database);
		// The store compares exactly whatever email it is given; normalization
		// is `DashboardApplication`'s responsibility, exercised in
		// `dashboard-service.spec.ts`. A caller already normalized matches;
		// one that is not, does not.
		const normalized = await store.readDashboard(
			{ email: normalizeRecipientEmail('CALLER@EXAMPLE.COM') },
			query()
		);
		expect(normalized.items[0]?.actionRequired).toBe(true);

		const unnormalized = await store.readDashboard({ email: 'CALLER@EXAMPLE.COM' }, query());
		expect(unnormalized.items[0]?.actionRequired).toBe(false);
	});

	it('throws instead of returning a fabricated zero when the batch does not complete successfully', async () => {
		const database = createFixtureDatabase([]);
		const originalBatch = database.batch.bind(database);
		database.batch = (async () => [
			{ success: false, results: [], meta: {} },
			{ success: false, results: [], meta: {} }
		]) as unknown as typeof database.batch;
		const store = new D1DashboardStore(database);
		await expect(store.readDashboard(CALLER, query())).rejects.toThrow();
		database.batch = originalBatch;
	});

	it('throws instead of returning a fabricated zero when the counts row is missing or malformed', async () => {
		const database = createFixtureDatabase([]);
		const originalBatch = database.batch.bind(database);
		database.batch = (async (statements: D1PreparedStatement[]) => {
			const real = await originalBatch(statements);
			return [{ success: true, results: [], meta: {} }, real[1]];
		}) as typeof database.batch;
		const store = new D1DashboardStore(database);
		await expect(store.readDashboard(CALLER, query())).rejects.toThrow();
		database.batch = originalBatch;
	});

	it('proves a genuinely empty instance returns real zero counts, not a swallowed failure', async () => {
		const database = createFixtureDatabase([]);
		const store = new D1DashboardStore(database);
		const page = await store.readDashboard(CALLER, query());
		expect(page.items).toHaveLength(0);
		expect(page.counts).toEqual({ all: 0, actionRequired: 0, waiting: 0, drafts: 0, completed: 0 });
	});

	it('restricts every recipient CTE to an indexed per-envelope-id search over page_envelopes, never a bare scan of the whole recipient table (EXPLAIN QUERY PLAN evidence)', async () => {
		const sqlite = createFixtureSqlite([
			{
				id: uuid(900),
				status: 'draft',
				title: 'Page row',
				updatedAtOffsetSeconds: 10,
				recipients: []
			}
		]);
		const database = sqliteD1Database(sqlite);
		let rowsSql: string | null = null;
		const originalPrepare = database.prepare.bind(database);
		database.prepare = ((sql: string) => {
			if (sql.includes('page_envelopes')) rowsSql = sql;
			return originalPrepare(sql);
		}) as typeof database.prepare;
		const store = new D1DashboardStore(database);
		await store.readDashboard(CALLER, query());
		database.prepare = originalPrepare;

		expect(rowsSql).not.toBeNull();
		const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${rowsSql}`).all() as { detail: string }[];
		const details: string[] = plan.map((row) => row.detail);

		// No step may be a bare, unindexed scan of the whole `recipient`
		// table: every reference to `recipient` must be an indexed search
		// correlated to a specific `envelope_id`, which is only possible once
		// `page_envelopes` has already bounded the candidate set.
		expect(details.some((detail) => /^SCAN recipient\b/.test(detail))).toBe(false);
		const recipientSearches: string[] = details.filter((detail) =>
			detail.includes('SEARCH recipient')
		);
		expect(recipientSearches.length).toBeGreaterThan(0);
		for (const detail of recipientSearches) {
			expect(detail).toMatch(/USING (COVERING )?INDEX .*\(envelope_id=\?\)/);
		}
	});

	it('keeps first-recipient/next-actionable/progress aggregation correct and bounded to the page even with a large volume of off-page historical recipients', async () => {
		const pageEnvelope: EnvelopeFixture = {
			id: uuid(910),
			status: 'sent',
			title: 'In page',
			updatedAtOffsetSeconds: 1000,
			recipients: [
				{
					id: uuid(9101),
					email: CALLER.email,
					name: 'Caller',
					role: 'signer',
					routingOrder: 1,
					status: 'pending'
				}
			]
		};
		// 40 old, terminal envelopes sorting well below the page, each with 50
		// recipients (2,000 off-page recipient rows): large enough that an
		// unbounded whole-table window would be easy to distinguish from a
		// page-bounded one, both in correctness and in timing.
		const historical: EnvelopeFixture[] = Array.from({ length: 40 }, (_, envelopeIndex) => ({
			id: uuid(1000 + envelopeIndex),
			status: 'completed' as const,
			title: `Historical ${envelopeIndex}`,
			updatedAtOffsetSeconds: envelopeIndex,
			recipients: Array.from({ length: 50 }, (_, recipientIndex) => ({
				id: uuid(20000 + envelopeIndex * 50 + recipientIndex),
				email: `historical-${envelopeIndex}-${recipientIndex}@example.com`,
				name: `Historical Recipient ${envelopeIndex}-${recipientIndex}`,
				role: 'signer' as const,
				routingOrder: 1,
				status: 'completed' as const
			}))
		}));
		const database = createFixtureDatabase([pageEnvelope, ...historical]);
		const store = new D1DashboardStore(database);

		const startedAt: number = performance.now();
		const page = await store.readDashboard(CALLER, query({ limit: 1 }));
		const elapsedMs: number = performance.now() - startedAt;

		expect(page.items.map((item) => item.envelope.id)).toEqual([uuid(910)]);
		expect(page.items[0]?.recipientCount).toBe(1);
		expect(page.items[0]?.actionRequired).toBe(true);
		expect(page.items[0]?.nextRecipient).toEqual({ name: 'Caller', email: CALLER.email });
		// Generous but meaningful: page-bounded recipient work is independent
		// of the 2,000 off-page recipient rows, so this stays fast regardless.
		expect(elapsedMs).toBeLessThan(500);
	});
});
