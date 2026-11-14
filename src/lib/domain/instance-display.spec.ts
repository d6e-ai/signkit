import { describe, expect, it } from 'vitest';
import {
	invitationDisplayState,
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
