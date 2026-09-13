import { describe, expect, it } from 'vitest';
import {
	boundInstanceInvitationListLimit,
	boundInstanceMemberListLimit,
	isInstanceIdempotencyKey,
	isInstanceInvitationId,
	isInstanceInvitationStatus,
	isInstanceMemberRole,
	isInstanceMemberStatus,
	resolveInstanceInvitationExpiresAt,
	MAX_INSTANCE_INVITATION_LIST_LIMIT,
	MAX_INSTANCE_MEMBER_LIST_LIMIT,
	DEFAULT_INSTANCE_MEMBER_LIST_LIMIT,
	INSTANCE_INVITATION_DEFAULT_EXPIRY_MS,
	INSTANCE_INVITATION_MAX_EXPIRY_MS,
	type CreateInstanceInvitationStoreResult,
	type SetInstanceMemberRoleStoreResult,
	type SetInstanceMemberStatusStoreResult,
	type ListInstanceMembersStoreResult
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

	it('includes credential_collision in CreateInstanceInvitationStoreResult outcomes', () => {
		const result: CreateInstanceInvitationStoreResult = { outcome: 'credential_collision' };
		expect(result.outcome).toBe('credential_collision');
	});

	it('bounds the member list limit to 1..100, defaulting to 25', () => {
		expect(MAX_INSTANCE_MEMBER_LIST_LIMIT).toBe(100);
		expect(DEFAULT_INSTANCE_MEMBER_LIST_LIMIT).toBe(25);
		expect(boundInstanceMemberListLimit(0)).toBe(1);
		expect(boundInstanceMemberListLimit(-10)).toBe(1);
		expect(boundInstanceMemberListLimit(Number.NaN)).toBe(1);
		expect(boundInstanceMemberListLimit(1.5)).toBe(1);
		expect(boundInstanceMemberListLimit(25)).toBe(25);
		expect(boundInstanceMemberListLimit(1000)).toBe(100);
	});

	it('includes forbidden and member_suspended in ListInstanceMembersStoreResult outcomes', () => {
		const forbidden: ListInstanceMembersStoreResult = { outcome: 'forbidden' };
		const suspended: ListInstanceMembersStoreResult = { outcome: 'member_suspended' };
		expect(forbidden.outcome).toBe('forbidden');
		expect(suspended.outcome).toBe('member_suspended');
	});

	it('covers every SetInstanceMemberRoleStoreResult outcome, with receipt metadata on updated/replayed', () => {
		const member = {
			userId: 'user-1',
			role: 'member' as const,
			status: 'active' as const,
			createdAt: '2026-09-12T12:00:00.000Z',
			updatedAt: '2026-09-13T00:00:00.000Z'
		};
		const updated: SetInstanceMemberRoleStoreResult = {
			outcome: 'updated',
			member,
			appliedAt: '2026-09-13T00:00:00.000Z',
			revokedInvitationCount: 2
		};
		const replayed: SetInstanceMemberRoleStoreResult = {
			outcome: 'replayed',
			member,
			appliedAt: '2026-09-13T00:00:00.000Z',
			revokedInvitationCount: 2
		};
		expect(updated.member.userId).toBe('user-1');
		expect(updated.revokedInvitationCount).toBe(2);
		expect(replayed.appliedAt).toBe('2026-09-13T00:00:00.000Z');

		const outcomes: readonly SetInstanceMemberRoleStoreResult['outcome'][] = [
			'updated',
			'replayed',
			'forbidden',
			'member_suspended',
			'role_not_permitted',
			'member_not_found',
			'last_active_owner',
			'idempotency_conflict',
			'integrity_error'
		];
		for (const outcome of outcomes) {
			expect(typeof outcome).toBe('string');
		}
	});

	it('covers every SetInstanceMemberStatusStoreResult outcome, including cannot_target_self', () => {
		const member = {
			userId: 'user-1',
			role: 'member' as const,
			status: 'suspended' as const,
			createdAt: '2026-09-12T12:00:00.000Z',
			updatedAt: '2026-09-13T00:00:00.000Z'
		};
		const updated: SetInstanceMemberStatusStoreResult = {
			outcome: 'updated',
			member,
			appliedAt: '2026-09-13T00:00:00.000Z',
			revokedInvitationCount: 0
		};
		const cannotTargetSelf: SetInstanceMemberStatusStoreResult = { outcome: 'cannot_target_self' };
		expect(updated.member.status).toBe('suspended');
		expect(cannotTargetSelf.outcome).toBe('cannot_target_self');

		const outcomes: readonly SetInstanceMemberStatusStoreResult['outcome'][] = [
			'updated',
			'replayed',
			'forbidden',
			'member_suspended',
			'member_not_found',
			'last_active_owner',
			'cannot_target_self',
			'idempotency_conflict',
			'integrity_error'
		];
		for (const outcome of outcomes) {
			expect(typeof outcome).toBe('string');
		}
	});
});
