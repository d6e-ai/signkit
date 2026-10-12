import { describe, expect, it, vi } from 'vitest';
import type {
	DashboardActor,
	DashboardStore,
	DashboardStoreQuery
} from '$lib/ports/dashboard-store';
import type { DashboardPage } from './model';
import { DashboardApplication } from './dashboard-service';

const EMPTY_PAGE: DashboardPage = {
	items: [],
	nextCursor: null,
	counts: { all: 0, actionRequired: 0, waiting: 0, drafts: 0, completed: 0 }
};

function fakeStore(): { store: DashboardStore; readDashboard: ReturnType<typeof vi.fn> } {
	const readDashboard = vi.fn().mockResolvedValue(EMPTY_PAGE);
	return { store: { readDashboard }, readDashboard };
}

describe('DashboardApplication', () => {
	it('normalizes the caller email to lowercase before querying the store', async () => {
		const { store, readDashboard } = fakeStore();
		const application = new DashboardApplication(store);
		await application.read(
			{ email: 'User@Example.com' },
			{ view: 'all', query: '', cursor: null, limit: 25 }
		);
		const [actor]: [DashboardActor, DashboardStoreQuery] = readDashboard.mock.calls[0] as [
			DashboardActor,
			DashboardStoreQuery
		];
		expect(actor.email).toBe('user@example.com');
	});

	it('trims and bounds the search query length', async () => {
		const { store, readDashboard } = fakeStore();
		const application = new DashboardApplication(store);
		const longQuery: string = `  ${'a'.repeat(300)}  `;
		await application.read(
			{ email: 'user@example.com' },
			{ view: 'all', query: longQuery, cursor: null, limit: 25 }
		);
		const [, storeQuery]: [DashboardActor, DashboardStoreQuery] = readDashboard.mock.calls[0] as [
			DashboardActor,
			DashboardStoreQuery
		];
		expect(storeQuery.query).toBe('a'.repeat(200));
	});

	it('converts an empty or whitespace-only search string to null', async () => {
		const { store, readDashboard } = fakeStore();
		const application = new DashboardApplication(store);
		await application.read(
			{ email: 'user@example.com' },
			{ view: 'all', query: '   ', cursor: null, limit: 25 }
		);
		const [, storeQuery]: [DashboardActor, DashboardStoreQuery] = readDashboard.mock.calls[0] as [
			DashboardActor,
			DashboardStoreQuery
		];
		expect(storeQuery.query).toBeNull();
	});

	it('falls back to the all view for an unrecognized view value', async () => {
		const { store, readDashboard } = fakeStore();
		const application = new DashboardApplication(store);
		await application.read(
			{ email: 'user@example.com' },
			{ view: 'bogus' as never, query: '', cursor: null, limit: 25 }
		);
		const [, storeQuery]: [DashboardActor, DashboardStoreQuery] = readDashboard.mock.calls[0] as [
			DashboardActor,
			DashboardStoreQuery
		];
		expect(storeQuery.view).toBe('all');
	});

	it('clamps a limit above the maximum down to the maximum', async () => {
		const { store, readDashboard } = fakeStore();
		const application = new DashboardApplication(store);
		await application.read(
			{ email: 'user@example.com' },
			{ view: 'all', query: '', cursor: null, limit: 10_000 }
		);
		const [, storeQuery]: [DashboardActor, DashboardStoreQuery] = readDashboard.mock.calls[0] as [
			DashboardActor,
			DashboardStoreQuery
		];
		expect(storeQuery.limit).toBe(100);
	});

	it('passes the cursor through unchanged', async () => {
		const { store, readDashboard } = fakeStore();
		const application = new DashboardApplication(store);
		await application.read(
			{ email: 'user@example.com' },
			{ view: 'completed', query: '', cursor: 'abc-cursor', limit: 25 }
		);
		const [, storeQuery]: [DashboardActor, DashboardStoreQuery] = readDashboard.mock.calls[0] as [
			DashboardActor,
			DashboardStoreQuery
		];
		expect(storeQuery.cursor).toBe('abc-cursor');
	});
});
