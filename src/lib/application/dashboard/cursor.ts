import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';
import type { DashboardView } from './model';

/** Decoded keyset position: the exact `(updated_at, id)` tie-break pair every store query orders by. */
export interface DashboardCursorPosition {
	updatedAt: string;
	id: string;
}

export type DashboardCursorFailureReason = 'malformed' | 'context_mismatch';

export type DashboardCursorDecodeResult =
	| { ok: true; value: DashboardCursorPosition }
	| { ok: false; reason: DashboardCursorFailureReason };

const MAX_ENCODED_CURSOR_LENGTH: number = 2000;

/**
 * Captures calendar/time fields so they can be range-checked explicitly.
 * `Date.parse` is deliberately never used for this validation: it normalizes
 * an out-of-range date by rolling it over into the next one (`2026-02-30`
 * silently becomes `2026-03-02`) instead of rejecting it, and this cursor
 * must reject a tampered or malformed timestamp outright rather than
 * silently reinterpreting it as a different, rolled-over instant.
 */
const TIMESTAMP_PATTERN: RegExp =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Explicit calendar/time range validation. Rejects year `0000` (PostgreSQL's
 * `timestamptz` has no year zero -- 1 BC is immediately followed by 1 AD),
 * any month/day combination that is not a real calendar date for that
 * year (including non-leap-year February 29), and any hour/minute/second
 * outside its valid range.
 */
function isValidCalendarTimestamp(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number
): boolean {
	if (year < 1 || year > 9999) return false;
	if (month < 1 || month > 12) return false;
	if (hour > 23 || minute > 59 || second > 59) return false;
	const daysInMonth: number = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
	return day >= 1 && day <= daysInMonth;
}

function isValidTimestampString(value: string): boolean {
	const match: RegExpExecArray | null = TIMESTAMP_PATTERN.exec(value);
	if (match === null) return false;
	return isValidCalendarTimestamp(
		Number(match[1]),
		Number(match[2]),
		Number(match[3]),
		Number(match[4]),
		Number(match[5]),
		Number(match[6])
	);
}

interface CursorPayload {
	u: string;
	i: string;
	v: DashboardView;
	q: string;
}

function toBase64Url(bytes: Uint8Array): string {
	let binary: string = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	const padded: string = value.replaceAll('-', '+').replaceAll('_', '/');
	const padding: number = (4 - (padded.length % 4)) % 4;
	try {
		const binary: string = atob(padded + '='.repeat(padding));
		const bytes: Uint8Array = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		return bytes;
	} catch {
		return null;
	}
}

function isCursorPayload(value: unknown): value is CursorPayload {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as Record<string, unknown>).u === 'string' &&
		typeof (value as Record<string, unknown>).i === 'string' &&
		typeof (value as Record<string, unknown>).v === 'string' &&
		typeof (value as Record<string, unknown>).q === 'string'
	);
}

/**
 * Encodes an opaque, self-contained keyset cursor: `(updatedAt, id)` plus the
 * exact `(view, query)` context it was minted under. Self-contained on
 * purpose -- decoding never performs a database lookup, so a cursor stays
 * valid even if its anchor envelope is later updated or deleted, and never
 * silently shifts the page boundary or empties the page the way a live
 * row-id lookup would.
 */
export function encodeDashboardCursor(
	view: DashboardView,
	query: string | null,
	position: DashboardCursorPosition
): string {
	const payload: CursorPayload = {
		u: position.updatedAt,
		i: position.id,
		v: view,
		q: query ?? ''
	};
	return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

/**
 * Decodes a cursor minted by {@link encodeDashboardCursor}, requiring it to
 * match the exact `(view, query)` the caller is currently requesting.
 * Changing the view or the search text invalidates any cursor minted under a
 * different one (`context_mismatch`) rather than silently reinterpreting it
 * against the new filter.
 */
export function decodeDashboardCursor(
	cursor: string,
	context: { view: DashboardView; query: string | null }
): DashboardCursorDecodeResult {
	if (cursor.length === 0 || cursor.length > MAX_ENCODED_CURSOR_LENGTH) {
		return { ok: false, reason: 'malformed' };
	}
	const bytes: Uint8Array | null = fromBase64Url(cursor);
	if (bytes === null) return { ok: false, reason: 'malformed' };

	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	if (!isCursorPayload(parsed)) return { ok: false, reason: 'malformed' };
	if (!isValidTimestampString(parsed.u)) {
		return { ok: false, reason: 'malformed' };
	}
	if (!UUID_V7_PATTERN.test(parsed.i)) return { ok: false, reason: 'malformed' };

	const expectedQuery: string = context.query ?? '';
	if (parsed.v !== context.view || parsed.q !== expectedQuery) {
		return { ok: false, reason: 'context_mismatch' };
	}
	return { ok: true, value: { updatedAt: parsed.u, id: parsed.i } };
}
