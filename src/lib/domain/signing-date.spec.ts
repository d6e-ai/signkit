import { describe, expect, it } from 'vitest';
import {
	automaticDatesMatchDeclarations,
	canonicalizeDateFieldOptions,
	canonicalizeTimeZone,
	dateFieldOptionsFromColumns,
	dateOptionsProperties,
	formatSigningDate,
	InvalidDateFieldOptionsError,
	isDateSignedField,
	placementDateOptionsMatch
} from './signing-date';

describe('isDateSignedField', () => {
	it('is true only for date fields in signed_at mode', () => {
		expect(isDateSignedField({ fieldType: 'date', dateMode: 'signed_at' })).toBe(true);
		expect(isDateSignedField({ fieldType: 'date' })).toBe(false);
		expect(isDateSignedField({ fieldType: 'date', dateMode: null })).toBe(false);
		expect(isDateSignedField({ fieldType: 'text', dateMode: 'signed_at' })).toBe(false);
	});
});

describe('canonicalizeDateFieldOptions', () => {
	it('emits nothing for legacy/manual fields of any type', () => {
		expect(canonicalizeDateFieldOptions('date', {})).toEqual({});
		expect(canonicalizeDateFieldOptions('signature', {})).toEqual({});
		expect(Object.keys(canonicalizeDateFieldOptions('date', {}))).toEqual([]);
	});

	it('canonicalizes the IANA zone through Intl', () => {
		expect(
			canonicalizeDateFieldOptions('date', { dateMode: 'signed_at', dateTimeZone: 'asia/tokyo' })
		).toEqual({ dateMode: 'signed_at', dateTimeZone: 'Asia/Tokyo' });
		expect(
			canonicalizeDateFieldOptions('date', { dateMode: 'signed_at', dateTimeZone: 'UTC' })
		).toEqual({ dateMode: 'signed_at', dateTimeZone: 'UTC' });
	});

	it.each([
		['date', { dateMode: 'signed_at' }],
		['date', { dateTimeZone: 'Asia/Tokyo' }],
		['text', { dateMode: 'signed_at', dateTimeZone: 'Asia/Tokyo' }],
		['signature', { dateTimeZone: 'Asia/Tokyo' }],
		['date', { dateMode: 'manual', dateTimeZone: 'Asia/Tokyo' }],
		['date', { dateMode: 'signed_at', dateTimeZone: 'Mars/Olympus' }],
		['date', { dateMode: 'signed_at', dateTimeZone: '+09:00' }],
		['date', { dateMode: 'signed_at', dateTimeZone: '' }],
		['date', { dateMode: 'signed_at', dateTimeZone: 42 }],
		['date', { dateMode: 'signed_at', dateTimeZone: 'A'.repeat(65) }]
	])('rejects the nonsensical combination %s %j', (fieldType, options) => {
		expect(() => canonicalizeDateFieldOptions(fieldType, options)).toThrow(
			InvalidDateFieldOptionsError
		);
	});
});

describe('canonicalizeTimeZone / dateFieldOptionsFromColumns', () => {
	it('rejects offsets and unknown names', () => {
		expect(canonicalizeTimeZone('Europe/Paris')).toBe('Europe/Paris');
		expect(canonicalizeTimeZone('-05:00')).toBeNull();
		expect(canonicalizeTimeZone('Nowhere/City')).toBeNull();
	});

	it('maps both-null columns to a manual field and rejects every partial shape', () => {
		expect(dateFieldOptionsFromColumns('date', null, null)).toEqual({});
		expect(dateFieldOptionsFromColumns('date', undefined, undefined)).toEqual({});
		expect(dateFieldOptionsFromColumns('date', 'signed_at', 'Asia/Tokyo')).toEqual({
			dateMode: 'signed_at',
			dateTimeZone: 'Asia/Tokyo'
		});
		expect(dateFieldOptionsFromColumns('date', 'signed_at', null)).toBeNull();
		expect(dateFieldOptionsFromColumns('date', null, 'Asia/Tokyo')).toBeNull();
		expect(dateFieldOptionsFromColumns('text', 'signed_at', 'Asia/Tokyo')).toBeNull();
		expect(dateFieldOptionsFromColumns('date', 'other', 'Asia/Tokyo')).toBeNull();
		expect(dateFieldOptionsFromColumns('date', 'signed_at', 'Mars/Olympus')).toBeNull();
	});

	it('spreads no keys for manual fields', () => {
		expect(dateOptionsProperties({})).toEqual({});
		expect(JSON.stringify({ a: 1, ...dateOptionsProperties({}) })).toBe('{"a":1}');
	});
});

describe('formatSigningDate', () => {
	it('formats the same instant as different calendar days per zone around midnight', () => {
		const instant: string = '2026-03-31T15:30:00.000Z';
		expect(formatSigningDate(instant, 'UTC')).toBe('2026-03-31');
		expect(formatSigningDate(instant, 'Asia/Tokyo')).toBe('2026-04-01');
		expect(formatSigningDate(instant, 'America/Los_Angeles')).toBe('2026-03-31');
		expect(formatSigningDate('2026-04-01T06:59:59.999Z', 'America/Los_Angeles')).toBe('2026-03-31');
		expect(formatSigningDate('2026-04-01T07:00:00.000Z', 'America/Los_Angeles')).toBe('2026-04-01');
	});

	it('follows DST transitions exactly at the instant', () => {
		// US spring forward 2026-03-08 02:00 local (10:00Z): offset becomes -07:00.
		expect(formatSigningDate('2026-03-08T07:59:59.999Z', 'America/Los_Angeles')).toBe('2026-03-07');
		expect(formatSigningDate('2026-03-08T08:00:00.000Z', 'America/Los_Angeles')).toBe('2026-03-08');
		// US fall back 2026-11-01: 08:59Z is still PDT (01:59 local), 09:00Z is 01:00 PST.
		expect(formatSigningDate('2026-11-01T08:59:59.999Z', 'America/Los_Angeles')).toBe('2026-11-01');
		// Europe/London ends BST 2026-10-25 01:00Z; 23:30Z on the 24th is already the 25th in BST.
		expect(formatSigningDate('2026-10-24T23:30:00.000Z', 'Europe/London')).toBe('2026-10-25');
		expect(formatSigningDate('2026-10-25T23:30:00.000Z', 'Europe/London')).toBe('2026-10-25');
	});

	it('uses real leap days and zero-pads', () => {
		expect(formatSigningDate('2028-02-29T12:00:00.000Z', 'UTC')).toBe('2028-02-29');
		expect(formatSigningDate('2026-01-05T00:00:00.000Z', 'UTC')).toBe('2026-01-05');
		expect(formatSigningDate('2028-02-29T20:00:00.000Z', 'Pacific/Kiritimati')).toBe('2028-03-01');
	});

	it('rejects an invalid instant', () => {
		expect(() => formatSigningDate('not-a-date', 'UTC')).toThrow(RangeError);
	});
});

describe('placementDateOptionsMatch', () => {
	const payload = (fields: unknown[]): string => JSON.stringify({ fields });
	const auto = { dateMode: 'signed_at', dateTimeZone: 'Asia/Tokyo' } as const;

	it('accepts identical options and tolerates manual fields absent from history', () => {
		expect(
			placementDateOptionsMatch(payload([{ id: 'a', ...auto }, { id: 'b' }]), [
				{ id: 'a', ...auto },
				{ id: 'b' },
				{ id: 'c' }
			])
		).toBe(true);
	});

	it('fails closed when a time zone, mode, or flag differs from the placement evidence', () => {
		expect(
			placementDateOptionsMatch(payload([{ id: 'a', ...auto }]), [
				{ id: 'a', dateMode: 'signed_at', dateTimeZone: 'UTC' }
			])
		).toBe(false);
		expect(placementDateOptionsMatch(payload([{ id: 'a', ...auto }]), [{ id: 'a' }])).toBe(false);
		expect(placementDateOptionsMatch(payload([{ id: 'a' }]), [{ id: 'a', ...auto }])).toBe(false);
		expect(placementDateOptionsMatch(payload([]), [{ id: 'a', ...auto }])).toBe(false);
		expect(placementDateOptionsMatch('{', [{ id: 'a' }])).toBe(false);
		expect(placementDateOptionsMatch('{}', [{ id: 'a' }])).toBe(false);
	});
});

describe('automaticDatesMatchDeclarations', () => {
	const auto = { dateMode: 'signed_at', dateTimeZone: 'Asia/Tokyo' } as const;

	it('accepts the server-derived date for the command instant only', () => {
		const signedAt: string = '2026-03-31T15:30:00.000Z';
		const declared = [{ id: 'a', ...auto }, { id: 'b' }];
		expect(
			automaticDatesMatchDeclarations(
				declared,
				[
					{ fieldId: 'a', valueJson: JSON.stringify('2026-04-01'), ...auto },
					{ fieldId: 'b', valueJson: JSON.stringify('2026-03-31') }
				],
				signedAt
			)
		).toBe(true);
		expect(
			automaticDatesMatchDeclarations(
				declared,
				[
					{ fieldId: 'a', valueJson: JSON.stringify('2026-03-31'), ...auto },
					{ fieldId: 'b', valueJson: JSON.stringify('2026-03-31') }
				],
				signedAt
			)
		).toBe(false);
	});

	it('rejects options that differ from the declaration and unknown fields', () => {
		const declared = [{ id: 'a', ...auto }];
		const value = JSON.stringify('2026-04-01');
		expect(
			automaticDatesMatchDeclarations(
				declared,
				[{ fieldId: 'a', valueJson: value }],
				'2026-03-31T15:30:00.000Z'
			)
		).toBe(false);
		expect(
			automaticDatesMatchDeclarations(
				declared,
				[{ fieldId: 'zzz', valueJson: value, ...auto }],
				'2026-03-31T15:30:00.000Z'
			)
		).toBe(false);
	});
});
