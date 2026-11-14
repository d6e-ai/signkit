import { describe, expect, it } from 'vitest';
import { readInvitationDisplays, readMemberDisplay, readMemberDisplays } from './instance-display';
import type { InstanceInvitationMetadata } from '$lib/ports/instance-store';

const now = Date.parse('2026-11-14T00:00:00.000Z');
const snapshot = {
	state: 'available',
	name: 'Alex Rivera',
	email: 'alex@example.com',
	observedAt: '2026-11-01T00:00:00.000Z',
	expiresAt: '2027-01-30T00:00:00.000Z'
};
const invitation = (
	status: 'pending' | 'accepted' | 'revoked',
	expiresAt = '2026-11-20T00:00:00.000Z'
): InstanceInvitationMetadata => ({
	id: 'invite-1',
	role: 'member',
	status,
	invitedByUserId: 'owner',
	createdAt: '2026-11-13T00:00:00.000Z',
	expiresAt,
	acceptedAt: status === 'accepted' ? '2026-11-14T00:00:00.000Z' : null,
	acceptedByUserId: status === 'accepted' ? 'member-1' : null,
	revokedAt: status === 'revoked' ? '2026-11-14T00:00:00.000Z' : null,
	revokedByUserId: status === 'revoked' ? 'owner' : null
});

describe('display-only list decoding', () => {
	it('copies just public snapshot fields and rejects expired or malformed display data', () => {
		expect(
			readMemberDisplay(
				{ ...snapshot, token: 'hidden', sealedPayload: 'hidden', keyId: 'hidden' },
				now
			)
		).toEqual(snapshot);
		for (const value of [
			null,
			{},
			{ ...snapshot, observedAt: 'invalid' },
			{ ...snapshot, expiresAt: '2026-11-14T00:00:00.000Z' },
			{ ...snapshot, name: '' },
			{ ...snapshot, email: 12 }
		]) {
			expect(readMemberDisplay(value, now)).toEqual({ state: 'unavailable' });
		}
	});

	it('keeps display maps scoped to the current page, including unusual subject keys', () => {
		const current = {
			...snapshot,
			observedAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 86400000).toISOString()
		};
		const input = JSON.parse(
			JSON.stringify({ requested: current, unrequested: current, ['__proto__']: current })
		);
		const values = readMemberDisplays(input, ['requested', 'missing', '__proto__']);
		expect(Object.keys(values)).toEqual(['requested', 'missing', '__proto__']);
		expect(values.missing).toEqual({ state: 'unavailable' });
		expect(values.__proto__).toEqual(current);
		expect(Object.getPrototypeOf(values)).toBeNull();
	});

	it('does not render a cached target for revoked, expired or accepted invitations', () => {
		const cached = {
			'invite-1': { state: 'pending', email: 'old-target@example.com', token: 'hidden' }
		};
		for (const item of [invitation('revoked'), invitation('pending', '2026-11-14T00:00:00.000Z')]) {
			expect(readInvitationDisplays(cached, [item], now)).toEqual({
				'invite-1': { state: 'redacted' }
			});
		}
		expect(readInvitationDisplays(cached, [invitation('accepted')], now)).toEqual({
			'invite-1': { state: 'unavailable' }
		});
		expect(readInvitationDisplays(cached, [invitation('pending')], now)).toEqual({
			'invite-1': { state: 'pending', email: 'old-target@example.com' }
		});
	});

	it('separates the accepting member snapshot from the original target and handles legacy absence', () => {
		expect(
			readInvitationDisplays(
				{ 'invite-1': { state: 'accepted', member: { ...snapshot, token: 'hidden' } } },
				[invitation('accepted')],
				now
			)
		).toEqual({ 'invite-1': { state: 'accepted', member: snapshot } });
		expect(readInvitationDisplays(undefined, [invitation('pending')], now)).toEqual({
			'invite-1': { state: 'unavailable' }
		});
	});
});
