import { describe, expect, it, vi } from 'vitest';
import type {
	DashboardActor,
	DashboardStore,
	DashboardStoreQuery
} from '$lib/ports/dashboard-store';
import { encodeDashboardCursor } from './cursor';
import type { DashboardPage } from './model';
import { DashboardApplication, InvalidDashboardCursorError } from './dashboard-service';

const EMPTY_PAGE: DashboardPage = {
	items: [],
	nextCursor: null,
	counts: { all: 0, actionRequired: 0, waiting: 0, drafts: 0, completed: 0 }
};

function fakeStore(): { store: DashboardStore; readDashboard: ReturnType<typeof vi.fn> } {
	const readDashboard = vi.fn().mockResolvedValue(EMPTY_PAGE);
	return { store: { readDashboard }, readDashboard };
}

function lastCall(readDashboard: ReturnType<typeof vi.fn>): [DashboardActor, DashboardStoreQuery] {
	return readDashboard.mock.calls[0] as [DashboardActor, DashboardStoreQuery];
}

describe('DashboardApplication', () => {
	it('normalizes the caller email to lowercase before querying the store', async () => {
		const { store, readDashboard } = fakeStore();
		const application = new DashboardApplication(store);
		await application.read(
			{ email: 'User@Example.com' },
			{ view: 'all', query: '', cursor: null, limit: 25 }
		);
		const [actor] = lastCall(readDashboard);
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
		const [, storeQuery] = lastCall(readDashboard);
		expect(storeQuery.query).toBe('a'.repeat(200));
	});

	it('converts an empty or whitespace-only search string to null', async () => {
		const { store, readDashboard } = fakeStore();
		const application = new DashboardApplication(store);
		await application.read(
			{ email: 'user@example.com' },
			{ view: 'all', query: '   ', cursor: null, limit: 25 }
		);
		const [, storeQuery] = lastCall(readDashboard);
		expect(storeQuery.query).toBeNull();
	});

	it('falls back to the all view for an unrecognized view value', async () => {
		const { store, readDashboard } = fakeStore();
		const application = new DashboardApplication(store);
		await application.read(
			{ email: 'user@example.com' },
			{ view: 'bogus' as never, query: '', cursor: null, limit: 25 }
		);
		const [, storeQuery] = lastCall(readDashboard);
		expect(storeQuery.view).toBe('all');
	});

	it('clamps a limit above the maximum down to the maximum', async () => {
		const { store, readDashboard } = fakeStore();
		const application = new DashboardApplication(store);
		await application.read(
			{ email: 'user@example.com' },
			{ view: 'all', query: '', cursor: null, limit: 10_000 }
		);
		const [, storeQuery] = lastCall(readDashboard);
		expect(storeQuery.limit).toBe(100);
	});

	it('decodes a cursor minted under the same normalized view and query into its keyset position', async () => {
		const { store, readDashboard } = fakeStore();
		const application = new DashboardApplication(store);
		const cursor: string = encodeDashboardCursor('completed', 'invoice', {
			updatedAt: '2026-09-11T00:00:00.000Z',
			id: '01910000-0000-7000-8000-000000000001'
		});
		await application.read(
			{ email: 'user@example.com' },
			{ view: 'completed', query: 'invoice', cursor, limit: 25 }
		);
		const [, storeQuery] = lastCall(readDashboard);
		expect(storeQuery.cursor).toEqual({
			updatedAt: '2026-09-11T00:00:00.000Z',
			id: '01910000-0000-7000-8000-000000000001'
		});
	});

	it('passes a null cursor through as null without decoding', async () => {
		const { store, readDashboard } = fakeStore();
		const application = new DashboardApplication(store);
		await application.read(
			{ email: 'user@example.com' },
			{ view: 'all', query: '', cursor: null, limit: 25 }
		);
		const [, storeQuery] = lastCall(readDashboard);
		expect(storeQuery.cursor).toBeNull();
	});

	it('throws InvalidDashboardCursorError for a malformed cursor instead of reaching the store', async () => {
		const { store, readDashboard } = fakeStore();
		const application = new DashboardApplication(store);
		await expect(
			application.read(
				{ email: 'user@example.com' },
				{ view: 'all', query: '', cursor: 'not-a-valid-cursor', limit: 25 }
			)
		).rejects.toBeInstanceOf(InvalidDashboardCursorError);
		expect(readDashboard).not.toHaveBeenCalled();
	});

	it('throws InvalidDashboardCursorError when the cursor was minted for a different view or search text', async () => {
		const { store, readDashboard } = fakeStore();
		const application = new DashboardApplication(store);
		const cursor: string = encodeDashboardCursor('drafts', null, {
			updatedAt: '2026-09-11T00:00:00.000Z',
			id: '01910000-0000-7000-8000-000000000001'
		});
		const error = await application
			.read({ email: 'user@example.com' }, { view: 'completed', query: '', cursor, limit: 25 })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(InvalidDashboardCursorError);
		expect((error as InvalidDashboardCursorError).reason).toBe('context_mismatch');
		expect(readDashboard).not.toHaveBeenCalled();
	});

	it('binds cursor decoding to the post-normalization query text, not the raw untrimmed input', async () => {
		const { store, readDashboard } = fakeStore();
		const application = new DashboardApplication(store);
		const cursor: string = encodeDashboardCursor('all', 'invoice', {
			updatedAt: '2026-09-11T00:00:00.000Z',
			id: '01910000-0000-7000-8000-000000000001'
		});
		await application.read(
			{ email: 'user@example.com' },
			{ view: 'all', query: '  invoice  ', cursor, limit: 25 }
		);
		const [, storeQuery] = lastCall(readDashboard);
		expect(storeQuery.cursor).not.toBeNull();
	});
});
