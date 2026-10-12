import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
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
	role: 'signer' | 'approver' | 'viewer' | 'cc';
	routingOrder: number;
	status: 'pending' | 'viewed' | 'completed' | 'declined';
}

interface EnvelopeFixture {
	id: string;
	status:
		'draft' | 'ready' | 'sent' | 'in_progress' | 'completed' | 'declined' | 'expired' | 'voided';
	title: string;
	updatedAtOffsetSeconds: number;
	recipients: readonly RecipientFixture[];
}

function createFixtureDatabase(envelopes: readonly EnvelopeFixture[]): D1Database {
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
	return sqliteD1Database(sqlite);
}

function query(overrides: Partial<DashboardStoreQuery> = {}): DashboardStoreQuery {
	return { view: 'all', query: null, cursor: null, limit: 25, ...overrides };
}

describe('D1DashboardStore', () => {
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

	it('paginates with a stable updatedAt-desc,id-desc cursor, even when updatedAt ties', async () => {
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
		expect(firstPage.nextCursor).toBe(expectedOrder[1]);

		const secondPage = await store.readDashboard(
			CALLER,
			query({ limit: 2, cursor: firstPage.nextCursor })
		);
		expect(secondPage.items.map((i) => i.envelope.id)).toEqual(expectedOrder.slice(2, 4));

		const thirdPage = await store.readDashboard(
			CALLER,
			query({ limit: 2, cursor: secondPage.nextCursor })
		);
		expect(thirdPage.items.map((i) => i.envelope.id)).toEqual(expectedOrder.slice(4, 5));
		expect(thirdPage.nextCursor).toBeNull();
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
						email: 'caller@example.com',
						name: 'Caller',
						role: 'signer',
						routingOrder: 1,
						status: 'pending'
					}
				]
			}
		]);
		const store = new D1DashboardStore(database);
		const page = await store.readDashboard({ email: 'CALLER@EXAMPLE.COM' }, query());
		expect(page.items[0]?.actionRequired).toBe(false);
	});
});
