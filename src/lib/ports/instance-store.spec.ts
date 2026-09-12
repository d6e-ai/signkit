import { describe, expect, it } from 'vitest';
import {
	boundInstanceInvitationListLimit,
	isInstanceIdempotencyKey,
	isInstanceInvitationId,
	isInstanceInvitationStatus,
	isInstanceMemberRole,
	isInstanceMemberStatus,
	resolveInstanceInvitationExpiresAt,
	MAX_INSTANCE_INVITATION_LIST_LIMIT,
	INSTANCE_INVITATION_DEFAULT_EXPIRY_MS,
	INSTANCE_INVITATION_MAX_EXPIRY_MS
} from './instance-store';

describe('instance-store port helpers', () => {
	it('accepts bounded printable idempotency keys only', () => {
		expect(isInstanceIdempotencyKey('invite-1')).toBe(true);
		expect(isInstanceIdempotencyKey('a'.repeat(200))).toBe(true);
		expect(isInstanceIdempotencyKey('a'.repeat(201))).toBe(false);
		expect(isInstanceIdempotencyKey('')).toBe(false);
		expect(isInstanceIdempotencyKey('has space')).toBe(false);
	});

	it('recognizes only the three known member roles and statuses', () => {
		expect(isInstanceMemberRole('owner')).toBe(true);
		expect(isInstanceMemberRole('admin')).toBe(true);
		expect(isInstanceMemberRole('member')).toBe(true);
		expect(isInstanceMemberRole('superadmin')).toBe(false);
		expect(isInstanceMemberStatus('active')).toBe(true);
		expect(isInstanceMemberStatus('suspended')).toBe(true);
		expect(isInstanceMemberStatus('invited')).toBe(false);
	});

	it('accepts canonical lowercase hyphenated UUIDv7 invitation ids only', () => {
		expect(isInstanceInvitationId('01900000-0000-7000-8000-000000000201')).toBe(true);
		expect(isInstanceInvitationId('01900000-0000-7000-8000-00000000020A')).toBe(false);
		expect(isInstanceInvitationId('9f1c6f8e-0a1d-4f3b-8b0e-7c2f9a4d6e11')).toBe(false);
		expect(isInstanceInvitationId('')).toBe(false);
	});

	it('recognizes only the three known invitation statuses', () => {
		expect(isInstanceInvitationStatus('pending')).toBe(true);
		expect(isInstanceInvitationStatus('accepted')).toBe(true);
		expect(isInstanceInvitationStatus('revoked')).toBe(true);
		expect(isInstanceInvitationStatus('expired')).toBe(false);
	});

	it('bounds the invitation list limit to 1..100', () => {
		expect(MAX_INSTANCE_INVITATION_LIST_LIMIT).toBe(100);
		expect(boundInstanceInvitationListLimit(0)).toBe(1);
		expect(boundInstanceInvitationListLimit(-10)).toBe(1);
		expect(boundInstanceInvitationListLimit(Number.NaN)).toBe(1);
		expect(boundInstanceInvitationListLimit(1.5)).toBe(1);
		expect(boundInstanceInvitationListLimit(25)).toBe(25);
		expect(boundInstanceInvitationListLimit(1000)).toBe(100);
	});

	it('defaults expiry to 7 days and refuses to exceed the fixed 7-day maximum', () => {
		const now: Date = new Date('2026-09-12T12:00:00.000Z');
		expect(resolveInstanceInvitationExpiresAt(now)).toBe('2026-09-19T12:00:00.000Z');
		expect(Date.parse(resolveInstanceInvitationExpiresAt(now)) - now.valueOf()).toBe(
			INSTANCE_INVITATION_DEFAULT_EXPIRY_MS
		);
		expect(INSTANCE_INVITATION_MAX_EXPIRY_MS).toBe(INSTANCE_INVITATION_DEFAULT_EXPIRY_MS);
		expect(resolveInstanceInvitationExpiresAt(now, '2026-09-19T12:00:00.000Z')).toBe(
			'2026-09-19T12:00:00.000Z'
		);
		expect((): string => resolveInstanceInvitationExpiresAt(now, null)).toThrow(
			'Instance invitations must expire'
		);
		expect((): string => resolveInstanceInvitationExpiresAt(now, 'not-a-date')).toThrow(
			'Invalid instance invitation expiry'
		);
		expect((): string =>
			resolveInstanceInvitationExpiresAt(now, '2026-09-12T12:00:00.000Z')
		).toThrow('Instance invitation expiry must be in the future');
		expect((): string =>
			resolveInstanceInvitationExpiresAt(now, '2026-09-19T12:00:00.001Z')
		).toThrow('Instance invitation expiry must be at most 7 days');
	});
});
