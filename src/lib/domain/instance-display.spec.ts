import { describe, expect, it } from 'vitest';
import {
	boundInstanceDisplayCleanupLimit,
	boundInstanceDisplayResealLimit,
	emptyDisplayMap,
	invitationDisplayState,
	isIsoInstant,
	memberDisplayExpiresAt,
	projectAvailableMemberDisplay,
	unavailableMemberDisplay
} from './instance-display';

const OBSERVED_AT: string = '2026-09-12T12:00:00.000Z';

describe('instance display domain', () => {
	it('expires a snapshot 90 days after the original observation', () => {
		expect(memberDisplayExpiresAt(OBSERVED_AT)).toBe('2026-12-11T12:00:00.000Z');
	});

	it('returns unavailable for expired or lifetime-mismatched member payloads', () => {
		const expiresAt: string = memberDisplayExpiresAt(OBSERVED_AT);
		expect(
			projectAvailableMemberDisplay({
				name: 'Ada',
				email: 'ada@example.com',
				observedAt: OBSERVED_AT,
				expiresAt,
				now: expiresAt
			})
		).toEqual(unavailableMemberDisplay());
		expect(
			projectAvailableMemberDisplay({
				name: 'Ada',
				email: 'ada@example.com',
				observedAt: OBSERVED_AT,
				expiresAt: '2026-09-13T12:00:00.000Z',
				now: OBSERVED_AT
			})
		).toEqual(unavailableMemberDisplay());
	});

	it('rejects malformed calendar instants without throwing', () => {
		expect(isIsoInstant('2026-99-99T00:00:00.000Z')).toBe(false);
		expect(isIsoInstant('2026-02-30T00:00:00.000Z')).toBe(false);
		expect(isIsoInstant('2026-09-12T12:00:00.000Z')).toBe(true);
	});

	it('does not clamp a spent cleanup or reseal budget back to one', () => {
		expect(boundInstanceDisplayCleanupLimit(0)).toBe(0);
		expect(boundInstanceDisplayCleanupLimit(-1)).toBe(0);
		expect(boundInstanceDisplayResealLimit(0)).toBe(0);
		expect(boundInstanceDisplayCleanupLimit(100)).toBe(100);
		expect(boundInstanceDisplayCleanupLimit(101)).toBe(100);
	});

	it('keeps __proto__ and constructor as own map keys', () => {
		const displays = emptyDisplayMap<string>();
		displays['__proto__'] = 'unavailable';
		displays['constructor'] = 'unavailable';
		expect(Object.getPrototypeOf(displays)).toBeNull();
		expect(Object.hasOwn(displays, '__proto__')).toBe(true);
		expect(Object.hasOwn(displays, 'constructor')).toBe(true);
		expect(JSON.parse(JSON.stringify(displays))['__proto__']).toBe('unavailable');
	});

	it('hides expired pending invitations immediately', () => {
		expect(
			invitationDisplayState(
				{ status: 'pending', expiresAt: '2026-09-12T12:00:00.000Z' },
				'2026-09-12T12:00:00.001Z'
			)
		).toBe('redacted');
		expect(
			invitationDisplayState(
				{ status: 'pending', expiresAt: '2026-09-19T12:00:00.000Z' },
				OBSERVED_AT
			)
		).toBe('pending');
		expect(
			invitationDisplayState(
				{ status: 'revoked', expiresAt: '2026-09-19T12:00:00.000Z' },
				OBSERVED_AT
			)
		).toBe('redacted');
	});
});
