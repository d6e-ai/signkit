import { describe, expect, it } from 'vitest';
import { decodeDashboardCursor, encodeDashboardCursor } from './cursor';

function cursorWithRawTimestamp(timestamp: string): string {
	const payload = {
		u: timestamp,
		i: '01910000-0000-7000-8000-000000000001',
		v: 'all',
		q: ''
	};
	const json: string = JSON.stringify(payload);
	const bytes: Uint8Array = new TextEncoder().encode(json);
	let binary: string = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

describe('encodeDashboardCursor / decodeDashboardCursor', () => {
	it('round-trips a valid position under the same (view, query) context', () => {
		const cursor = encodeDashboardCursor('all', null, {
			updatedAt: '2026-09-11T00:00:00.123456Z',
			id: '01910000-0000-7000-8000-000000000001'
		});
		const decoded = decodeDashboardCursor(cursor, { view: 'all', query: null });
		expect(decoded).toEqual({
			ok: true,
			value: {
				updatedAt: '2026-09-11T00:00:00.123456Z',
				id: '01910000-0000-7000-8000-000000000001'
			}
		});
	});

	it('preserves full microsecond precision through the round trip', () => {
		for (const timestamp of [
			'2026-09-11T00:00:00.123456Z',
			'2026-09-11T00:00:00.123123Z',
			'2026-09-11T00:00:00.123000Z',
			'2026-09-11T00:00:00.000001Z'
		]) {
			const cursor = encodeDashboardCursor('all', null, {
				updatedAt: timestamp,
				id: '01910000-0000-7000-8000-000000000001'
			});
			const decoded = decodeDashboardCursor(cursor, { view: 'all', query: null });
			expect(decoded.ok).toBe(true);
			if (decoded.ok) expect(decoded.value.updatedAt).toBe(timestamp);
		}
	});

	describe('rejects impossible calendar dates instead of accepting Date.parse rollover', () => {
		it.each([
			'2026-02-30T00:00:00Z', // February never has 30 days
			'2026-04-31T00:00:00Z', // April has 30 days
			'2025-02-29T00:00:00Z', // 2025 is not a leap year
			'2026-13-01T00:00:00Z', // month 13
			'2026-00-01T00:00:00Z', // month 0
			'2026-01-00T00:00:00Z', // day 0
			'2026-01-32T00:00:00Z', // day 32
			'2026-01-01T24:00:00Z', // hour 24
			'2026-01-01T00:60:00Z', // minute 60
			'2026-01-01T00:00:60Z', // second 60
			'0000-01-01T00:00:00Z' // year zero, which PostgreSQL has no representation for
		])('rejects %s as malformed', (timestamp) => {
			const cursor = cursorWithRawTimestamp(timestamp);
			expect(decodeDashboardCursor(cursor, { view: 'all', query: null })).toEqual({
				ok: false,
				reason: 'malformed'
			});
		});
	});

	it('accepts the real leap day in a leap year', () => {
		const cursor = cursorWithRawTimestamp('2024-02-29T00:00:00Z');
		const decoded = decodeDashboardCursor(cursor, { view: 'all', query: null });
		expect(decoded.ok).toBe(true);
	});

	it('accepts a century leap year (divisible by 400)', () => {
		const cursor = cursorWithRawTimestamp('2000-02-29T00:00:00Z');
		expect(decodeDashboardCursor(cursor, { view: 'all', query: null }).ok).toBe(true);
	});

	it('rejects a non-leap century year (divisible by 100 but not 400)', () => {
		const cursor = cursorWithRawTimestamp('1900-02-29T00:00:00Z');
		expect(decodeDashboardCursor(cursor, { view: 'all', query: null })).toEqual({
			ok: false,
			reason: 'malformed'
		});
	});

	it('rejects a cursor whose timestamp field is not a string at all', () => {
		const payload = { u: 12345, i: '01910000-0000-7000-8000-000000000001', v: 'all', q: '' };
		const bytes: Uint8Array = new TextEncoder().encode(JSON.stringify(payload));
		let binary: string = '';
		for (const byte of bytes) binary += String.fromCharCode(byte);
		const cursor: string = btoa(binary)
			.replaceAll('+', '-')
			.replaceAll('/', '_')
			.replace(/=+$/, '');
		expect(decodeDashboardCursor(cursor, { view: 'all', query: null })).toEqual({
			ok: false,
			reason: 'malformed'
		});
	});

	it('rejects empty, non-base64url, and oversized cursors', () => {
		expect(decodeDashboardCursor('', { view: 'all', query: null }).ok).toBe(false);
		expect(decodeDashboardCursor('not valid!!', { view: 'all', query: null }).ok).toBe(false);
		expect(decodeDashboardCursor('a'.repeat(3000), { view: 'all', query: null }).ok).toBe(false);
	});

	it('rejects a non-UUIDv7 id', () => {
		const cursor = encodeDashboardCursor('all', null, {
			updatedAt: '2026-09-11T00:00:00.000000Z',
			id: 'not-a-uuid'
		});
		expect(decodeDashboardCursor(cursor, { view: 'all', query: null })).toEqual({
			ok: false,
			reason: 'malformed'
		});
	});

	it('requires an exact (view, query) context match, independent of calendar validity', () => {
		const cursor = encodeDashboardCursor('drafts', 'invoice', {
			updatedAt: '2026-09-11T00:00:00.000000Z',
			id: '01910000-0000-7000-8000-000000000001'
		});
		expect(decodeDashboardCursor(cursor, { view: 'all', query: 'invoice' })).toEqual({
			ok: false,
			reason: 'context_mismatch'
		});
		expect(decodeDashboardCursor(cursor, { view: 'drafts', query: 'different' })).toEqual({
			ok: false,
			reason: 'context_mismatch'
		});
	});

	it('malformed-timestamp validation runs independently of any store call: the decoder itself rejects before any query would run', () => {
		// Regression guard for "fails 400 before touching any store": this
		// asserts the pure decoder's own contract, which `DashboardApplication.read`
		// relies on by decoding before calling `store.readDashboard` at all
		// (see `dashboard-service.spec.ts`).
		const cursor = cursorWithRawTimestamp('2026-02-30T00:00:00Z');
		const result = decodeDashboardCursor(cursor, { view: 'all', query: null });
		expect(result.ok).toBe(false);
	});
});
