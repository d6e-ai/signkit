import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type {
	ListInstanceMembersStoreResult,
	SetInstanceMemberRoleCommand,
	SetInstanceMemberRoleStoreResult,
	SetInstanceMemberStatusCommand,
	SetInstanceMemberStatusStoreResult
} from '$lib/ports/instance-store';
import { D1InstanceStore } from './d1-instance-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const OWNER_ID: string = 'owner-1';
const OWNER2_ID: string = 'owner-2';
const ADMIN_ID: string = 'admin-1';
const TARGET_ID: string = 'target-1';
const CREATED_AT: string = '2026-09-12T12:00:00.000Z';
const UPDATED_AT: string = '2026-09-13T12:00:00.000Z';
const LATER_AT: string = '2026-09-14T12:00:00.000Z';
const REQUEST_FINGERPRINT: string = 'a'.repeat(64);
const OTHER_REQUEST_FINGERPRINT: string = 'b'.repeat(64);
const INVITATION_ID: string = '01900000-0000-7000-8000-000000000201';
const OTHER_INVITATION_ID: string = '01900000-0000-7000-8000-000000000202';
const TOKEN_HASH: string = 'c'.repeat(64);
const OTHER_TOKEN_HASH: string = 'd'.repeat(64);
const EMAIL_BINDING: string = 'e'.repeat(64);

function insertMember(
	sqlite: DatabaseSync,
	userId: string,
	role: 'owner' | 'admin' | 'member' = 'member',
	status: 'active' | 'suspended' = 'active',
	createdAt: string = CREATED_AT
): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${userId}', '${role}', '${status}', '${createdAt}', '${createdAt}')
	`);
}

function insertInvitation(
	sqlite: DatabaseSync,
	options: {
		id: string;
		invitedByUserId: string;
		tokenHash: string;
		role?: 'owner' | 'admin' | 'member';
		status?: 'pending' | 'revoked';
	}
): void {
	sqlite.exec(`
		INSERT INTO instance_invitation (
			id, role, status, token_hash, email_binding, invited_by_user_id, created_at, expires_at
		) VALUES (
			'${options.id}', '${options.role ?? 'member'}', '${options.status ?? 'pending'}',
			'${options.tokenHash}', '${EMAIL_BINDING}', '${options.invitedByUserId}',
			'${CREATED_AT}', '2026-09-19T12:00:00.000Z'
		)
	`);
}

function setRoleCommand(
	overrides: Partial<SetInstanceMemberRoleCommand> = {}
): SetInstanceMemberRoleCommand {
	return {
		actor: { type: 'user', id: OWNER_ID },
		idempotencyKey: 'role-cmd-key-1',
		requestFingerprint: REQUEST_FINGERPRINT,
		targetUserId: TARGET_ID,
		role: 'member',
		updatedAt: UPDATED_AT,
		...overrides
	};
}

function setStatusCommand(
	overrides: Partial<SetInstanceMemberStatusCommand> = {}
): SetInstanceMemberStatusCommand {
	return {
		actor: { type: 'user', id: OWNER_ID },
		idempotencyKey: 'status-cmd-key-1',
		requestFingerprint: REQUEST_FINGERPRINT,
		targetUserId: TARGET_ID,
		status: 'suspended',
		updatedAt: UPDATED_AT,
		...overrides
	};
}

interface Fixture {
	sqlite: DatabaseSync;
	store: D1InstanceStore;
}

function createFixture(): Fixture {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	const store = new D1InstanceStore(sqliteD1Database(sqlite));
	return { sqlite, store };
}

interface HookedFixture extends Fixture {
	armBatchHook(hook: (batchIndex: number) => void): void;
}

function createHookedFixture(): HookedFixture {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	const delegate: D1Database = sqliteD1Database(sqlite);
	let hook: ((batchIndex: number) => void) | null = null;
	let batchIndex: number = 0;
	const database = {
		prepare: (sql: string): D1PreparedStatement => delegate.prepare(sql),
		batch: async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
			if (hook !== null) hook(batchIndex++);
			return await delegate.batch<T>(statements);
		}
	} as unknown as D1Database;
	return {
		sqlite,
		store: new D1InstanceStore(database),
		armBatchHook: (next: (index: number) => void): void => {
			hook = next;
			batchIndex = 0;
		}
	};
}

function commandCount(sqlite: DatabaseSync, targetUserId: string): number {
	return (
		sqlite
			.prepare('SELECT COUNT(*) as count FROM instance_member_command WHERE target_user_id = ?')
			.get(targetUserId) as { count: number }
	).count;
}

describe('D1InstanceStore member administration', () => {
	describe('listInstanceMembers', () => {
		it('lists for active owner/admin, and forbids member, unknown, or suspended actors', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, OWNER2_ID, 'owner');
				insertMember(sqlite, ADMIN_ID, 'admin');
				insertMember(sqlite, TARGET_ID, 'member');

				const ownerList = await store.listInstanceMembers(
					{ type: 'user', id: OWNER_ID },
					{ cursor: null, limit: 10 }
				);
				expect(ownerList.outcome).toBe('listed');
				if (ownerList.outcome === 'listed') expect(ownerList.page.items).toHaveLength(4);

				const adminList = await store.listInstanceMembers(
					{ type: 'user', id: ADMIN_ID },
					{ cursor: null, limit: 10 }
				);
				expect(adminList.outcome).toBe('listed');

				const memberList = await store.listInstanceMembers(
					{ type: 'user', id: TARGET_ID },
					{ cursor: null, limit: 10 }
				);
				expect(memberList).toEqual({ outcome: 'forbidden' });

				const ghostList = await store.listInstanceMembers(
					{ type: 'user', id: 'ghost' },
					{ cursor: null, limit: 10 }
				);
				expect(ghostList).toEqual({ outcome: 'forbidden' });

				sqlite.exec(
					`UPDATE instance_member SET status = 'suspended' WHERE user_id = '${OWNER_ID}'`
				);
				const suspendedList = await store.listInstanceMembers(
					{ type: 'user', id: OWNER_ID },
					{ cursor: null, limit: 10 }
				);
				expect(suspendedList).toEqual({ outcome: 'member_suspended' });
			} finally {
				sqlite.close();
			}
		});

		it('paginates deterministically by user_id ascending with a bounded limit', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, 'member-a', 'member');
				insertMember(sqlite, 'member-b', 'member');
				insertMember(sqlite, 'member-c', 'member');

				const page1: ListInstanceMembersStoreResult = await store.listInstanceMembers(
					{ type: 'user', id: OWNER_ID },
					{ cursor: null, limit: 2 }
				);
				expect(page1.outcome).toBe('listed');
				if (page1.outcome !== 'listed') return;
				expect(page1.page.items.map((m) => m.userId)).toEqual(['member-a', 'member-b']);
				expect(page1.page.nextCursor).toBe('member-b');

				const page2 = await store.listInstanceMembers(
					{ type: 'user', id: OWNER_ID },
					{ cursor: page1.page.nextCursor, limit: 2 }
				);
				expect(page2.outcome).toBe('listed');
				if (page2.outcome !== 'listed') return;
				expect(page2.page.items.map((m) => m.userId)).toEqual(['member-c', OWNER_ID]);
				expect(page2.page.nextCursor).toBeNull();
			} finally {
				sqlite.close();
			}
		});
	});

	describe('setInstanceMemberRole / setInstanceMemberStatus success', () => {
		it('owner updates a target role, applies it durably, and writes a matching receipt', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, TARGET_ID, 'member');

				const result: SetInstanceMemberRoleStoreResult = await store.setInstanceMemberRole(
					setRoleCommand({ role: 'admin' })
				);
				expect(result).toEqual({
					outcome: 'updated',
					member: {
						userId: TARGET_ID,
						role: 'admin',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: UPDATED_AT
					},
					appliedAt: UPDATED_AT,
					revokedInvitationCount: 0
				});

				const row = sqlite
					.prepare('SELECT role, status FROM instance_member WHERE user_id = ?')
					.get(TARGET_ID) as { role: string; status: string };
				expect(row).toEqual({ role: 'admin', status: 'active' });
				expect(commandCount(sqlite, TARGET_ID)).toBe(1);
			} finally {
				sqlite.close();
			}
		});

		it('owner updates a target status, applies it durably, and writes a matching receipt', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, TARGET_ID, 'member');

				const result: SetInstanceMemberStatusStoreResult = await store.setInstanceMemberStatus(
					setStatusCommand({ status: 'suspended' })
				);
				expect(result).toEqual({
					outcome: 'updated',
					member: {
						userId: TARGET_ID,
						role: 'member',
						status: 'suspended',
						createdAt: CREATED_AT,
						updatedAt: UPDATED_AT
					},
					appliedAt: UPDATED_AT,
					revokedInvitationCount: 0
				});

				const row = sqlite
					.prepare('SELECT role, status FROM instance_member WHERE user_id = ?')
					.get(TARGET_ID) as { role: string; status: string };
				expect(row).toEqual({ role: 'member', status: 'suspended' });
				expect(commandCount(sqlite, TARGET_ID)).toBe(1);
			} finally {
				sqlite.close();
			}
		});
	});

	describe('admin ceiling', () => {
		it('lets an admin administer only current member-role targets and never grant above member', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, ADMIN_ID, 'admin');
				insertMember(sqlite, TARGET_ID, 'member');
				insertMember(sqlite, 'other-admin', 'admin');

				const grantAboveMember = await store.setInstanceMemberRole(
					setRoleCommand({
						actor: { type: 'user', id: ADMIN_ID },
						targetUserId: TARGET_ID,
						role: 'owner',
						idempotencyKey: 'adm-grant-owner'
					})
				);
				expect(grantAboveMember).toEqual({ outcome: 'role_not_permitted' });

				const targetNonMember = await store.setInstanceMemberRole(
					setRoleCommand({
						actor: { type: 'user', id: ADMIN_ID },
						targetUserId: 'other-admin',
						role: 'member',
						idempotencyKey: 'adm-other'
					})
				);
				expect(targetNonMember).toEqual({ outcome: 'forbidden' });

				const suspendNonMember = await store.setInstanceMemberStatus(
					setStatusCommand({
						actor: { type: 'user', id: ADMIN_ID },
						targetUserId: 'other-admin',
						idempotencyKey: 'adm-status-other'
					})
				);
				expect(suspendNonMember).toEqual({ outcome: 'forbidden' });

				const allowed = await store.setInstanceMemberStatus(
					setStatusCommand({
						actor: { type: 'user', id: ADMIN_ID },
						targetUserId: TARGET_ID,
						idempotencyKey: 'adm-status-target'
					})
				);
				expect(allowed.outcome).toBe('updated');
			} finally {
				sqlite.close();
			}
		});
	});

	describe('self-status and last-owner rejection', () => {
		it('rejects status self-targeting regardless of role', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, OWNER2_ID, 'owner');

				const result = await store.setInstanceMemberStatus(
					setStatusCommand({ actor: { type: 'user', id: OWNER_ID }, targetUserId: OWNER_ID })
				);
				expect(result).toEqual({ outcome: 'cannot_target_self' });
			} finally {
				sqlite.close();
			}
		});

		it('blocks demoting or suspending the sole active owner, but allows it once another active owner exists', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');

				const demoteAlone = await store.setInstanceMemberRole(
					setRoleCommand({ targetUserId: OWNER_ID, role: 'admin', idempotencyKey: 'role-alone' })
				);
				expect(demoteAlone).toEqual({ outcome: 'last_active_owner' });

				insertMember(sqlite, OWNER2_ID, 'owner');
				const suspendOther = await store.setInstanceMemberStatus(
					setStatusCommand({
						actor: { type: 'user', id: OWNER_ID },
						targetUserId: OWNER2_ID,
						idempotencyKey: 'status-with-backup'
					})
				);
				expect(suspendOther.outcome).toBe('updated');

				const demoteWithBackup = await store.setInstanceMemberRole(
					setRoleCommand({
						targetUserId: OWNER_ID,
						role: 'admin',
						idempotencyKey: 'role-with-backup-2'
					})
				);
				expect(demoteWithBackup).toEqual({ outcome: 'last_active_owner' });
			} finally {
				sqlite.close();
			}
		});
	});

	describe('exact replay after later mutation', () => {
		it('setInstanceMemberRole replays the originally recorded state, not state produced by a later command', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, TARGET_ID, 'member');

				const first = await store.setInstanceMemberRole(setRoleCommand({ role: 'admin' }));
				expect(first.outcome).toBe('updated');

				await store.setInstanceMemberRole(
					setRoleCommand({ role: 'member', idempotencyKey: 'role-cmd-key-2', updatedAt: LATER_AT })
				);

				const replay = await store.setInstanceMemberRole(
					setRoleCommand({ role: 'admin', updatedAt: LATER_AT })
				);
				expect(replay).toEqual({
					outcome: 'replayed',
					member: {
						userId: TARGET_ID,
						role: 'admin',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: UPDATED_AT
					},
					appliedAt: UPDATED_AT,
					revokedInvitationCount: 0
				});
			} finally {
				sqlite.close();
			}
		});

		it('setInstanceMemberStatus replays the originally recorded state, not state produced by a later command', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, TARGET_ID, 'member');

				const first = await store.setInstanceMemberStatus(
					setStatusCommand({ status: 'suspended' })
				);
				expect(first.outcome).toBe('updated');

				await store.setInstanceMemberStatus(
					setStatusCommand({
						status: 'active',
						idempotencyKey: 'status-cmd-key-2',
						updatedAt: LATER_AT
					})
				);

				const replay = await store.setInstanceMemberStatus(
					setStatusCommand({ status: 'suspended', updatedAt: LATER_AT })
				);
				expect(replay).toEqual({
					outcome: 'replayed',
					member: {
						userId: TARGET_ID,
						role: 'member',
						status: 'suspended',
						createdAt: CREATED_AT,
						updatedAt: UPDATED_AT
					},
					appliedAt: UPDATED_AT,
					revokedInvitationCount: 0
				});
			} finally {
				sqlite.close();
			}
		});
	});

	describe('idempotency conflict', () => {
		it('rejects a reused key with a conflicting request fingerprint for role and status commands', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, TARGET_ID, 'member');

				await store.setInstanceMemberRole(setRoleCommand({ role: 'admin' }));
				const roleConflict = await store.setInstanceMemberRole(
					setRoleCommand({ role: 'admin', requestFingerprint: OTHER_REQUEST_FINGERPRINT })
				);
				expect(roleConflict).toEqual({ outcome: 'idempotency_conflict' });

				await store.setInstanceMemberStatus(setStatusCommand({ status: 'suspended' }));
				const statusConflict = await store.setInstanceMemberStatus(
					setStatusCommand({ status: 'suspended', requestFingerprint: OTHER_REQUEST_FINGERPRINT })
				);
				expect(statusConflict).toEqual({ outcome: 'idempotency_conflict' });
			} finally {
				sqlite.close();
			}
		});
	});

	describe('replay reachable despite later actor demotion or suspension', () => {
		it('setInstanceMemberRole replays for an actor since demoted to member', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, OWNER2_ID, 'owner');
				insertMember(sqlite, TARGET_ID, 'member');

				const first = await store.setInstanceMemberRole(setRoleCommand({ role: 'admin' }));
				expect(first.outcome).toBe('updated');

				sqlite.exec(`UPDATE instance_member SET role = 'member' WHERE user_id = '${OWNER_ID}'`);

				const replay = await store.setInstanceMemberRole(setRoleCommand({ role: 'admin' }));
				expect(replay).toEqual({
					outcome: 'replayed',
					member: {
						userId: TARGET_ID,
						role: 'admin',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: UPDATED_AT
					},
					appliedAt: UPDATED_AT,
					revokedInvitationCount: 0
				});
			} finally {
				sqlite.close();
			}
		});

		it('setInstanceMemberRole replays for an actor since suspended', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, OWNER2_ID, 'owner');
				insertMember(sqlite, TARGET_ID, 'member');

				const first = await store.setInstanceMemberRole(setRoleCommand({ role: 'admin' }));
				expect(first.outcome).toBe('updated');

				sqlite.exec(
					`UPDATE instance_member SET status = 'suspended' WHERE user_id = '${OWNER_ID}'`
				);

				const replay = await store.setInstanceMemberRole(setRoleCommand({ role: 'admin' }));
				expect(replay.outcome).toBe('replayed');
			} finally {
				sqlite.close();
			}
		});

		it('setInstanceMemberStatus replays for an actor since demoted to member', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, OWNER2_ID, 'owner');
				insertMember(sqlite, TARGET_ID, 'member');

				const first = await store.setInstanceMemberStatus(
					setStatusCommand({ status: 'suspended' })
				);
				expect(first.outcome).toBe('updated');

				sqlite.exec(`UPDATE instance_member SET role = 'member' WHERE user_id = '${OWNER_ID}'`);

				const replay = await store.setInstanceMemberStatus(
					setStatusCommand({ status: 'suspended' })
				);
				expect(replay).toEqual({
					outcome: 'replayed',
					member: {
						userId: TARGET_ID,
						role: 'member',
						status: 'suspended',
						createdAt: CREATED_AT,
						updatedAt: UPDATED_AT
					},
					appliedAt: UPDATED_AT,
					revokedInvitationCount: 0
				});
			} finally {
				sqlite.close();
			}
		});

		it('setInstanceMemberStatus replays for an actor since suspended', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, OWNER2_ID, 'owner');
				insertMember(sqlite, TARGET_ID, 'member');

				const first = await store.setInstanceMemberStatus(
					setStatusCommand({ status: 'suspended' })
				);
				expect(first.outcome).toBe('updated');

				sqlite.exec(
					`UPDATE instance_member SET status = 'suspended' WHERE user_id = '${OWNER_ID}'`
				);

				const replay = await store.setInstanceMemberStatus(
					setStatusCommand({ status: 'suspended' })
				);
				expect(replay.outcome).toBe('replayed');
			} finally {
				sqlite.close();
			}
		});
	});

	describe('updatedAt monotonicity', () => {
		it('classifies a set_role command whose updatedAt regresses as integrity_error, without a raw trigger throw', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, TARGET_ID, 'member');
				sqlite.exec(
					`UPDATE instance_member SET updated_at = '${LATER_AT}' WHERE user_id = '${TARGET_ID}'`
				);

				const result = await store.setInstanceMemberRole(setRoleCommand({ role: 'admin' }));
				expect(result).toEqual({ outcome: 'integrity_error' });

				const row = sqlite
					.prepare('SELECT role, updated_at FROM instance_member WHERE user_id = ?')
					.get(TARGET_ID) as { role: string; updated_at: string };
				expect(row).toEqual({ role: 'member', updated_at: LATER_AT });
				expect(commandCount(sqlite, TARGET_ID)).toBe(0);
			} finally {
				sqlite.close();
			}
		});

		it('classifies a set_status command whose updatedAt regresses as integrity_error, without a raw trigger throw', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, TARGET_ID, 'member');
				sqlite.exec(
					`UPDATE instance_member SET updated_at = '${LATER_AT}' WHERE user_id = '${TARGET_ID}'`
				);

				const result = await store.setInstanceMemberStatus(
					setStatusCommand({ status: 'suspended' })
				);
				expect(result).toEqual({ outcome: 'integrity_error' });

				const row = sqlite
					.prepare('SELECT status, updated_at FROM instance_member WHERE user_id = ?')
					.get(TARGET_ID) as { status: string; updated_at: string };
				expect(row).toEqual({ status: 'active', updated_at: LATER_AT });
				expect(commandCount(sqlite, TARGET_ID)).toBe(0);
			} finally {
				sqlite.close();
			}
		});
	});

	describe('admin requesting a role above member on itself', () => {
		it('returns role_not_permitted rather than forbidden for an admin self-targeting admin or owner', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, ADMIN_ID, 'admin');

				const selfGrantAdmin = await store.setInstanceMemberRole(
					setRoleCommand({
						actor: { type: 'user', id: ADMIN_ID },
						targetUserId: ADMIN_ID,
						role: 'admin',
						idempotencyKey: 'adm-self-admin'
					})
				);
				expect(selfGrantAdmin).toEqual({ outcome: 'role_not_permitted' });

				const selfGrantOwner = await store.setInstanceMemberRole(
					setRoleCommand({
						actor: { type: 'user', id: ADMIN_ID },
						targetUserId: ADMIN_ID,
						role: 'owner',
						idempotencyKey: 'adm-self-owner'
					})
				);
				expect(selfGrantOwner).toEqual({ outcome: 'role_not_permitted' });
			} finally {
				sqlite.close();
			}
		});
	});

	describe('invitation cascade rules', () => {
		it('owner->admin cascades only the non-member invitations the target can no longer hold', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, TARGET_ID, 'owner');
				insertInvitation(sqlite, {
					id: INVITATION_ID,
					invitedByUserId: TARGET_ID,
					tokenHash: TOKEN_HASH,
					role: 'owner'
				});
				insertInvitation(sqlite, {
					id: OTHER_INVITATION_ID,
					invitedByUserId: TARGET_ID,
					tokenHash: OTHER_TOKEN_HASH,
					role: 'member'
				});

				const result = await store.setInstanceMemberRole(setRoleCommand({ role: 'admin' }));
				expect(result.outcome).toBe('updated');
				if (result.outcome === 'updated') expect(result.revokedInvitationCount).toBe(1);

				const statuses = sqlite
					.prepare('SELECT id, status FROM instance_invitation ORDER BY id')
					.all() as { id: string; status: string }[];
				expect(statuses).toEqual([
					{ id: INVITATION_ID, status: 'revoked' },
					{ id: OTHER_INVITATION_ID, status: 'pending' }
				]);
			} finally {
				sqlite.close();
			}
		});

		it('a demotion down to member, and a suspension, both cascade-revoke every pending invitation of the target', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, TARGET_ID, 'admin');
				insertInvitation(sqlite, {
					id: INVITATION_ID,
					invitedByUserId: TARGET_ID,
					tokenHash: TOKEN_HASH,
					role: 'member'
				});

				const demote = await store.setInstanceMemberRole(setRoleCommand({ role: 'member' }));
				expect(demote.outcome).toBe('updated');
				if (demote.outcome === 'updated') expect(demote.revokedInvitationCount).toBe(1);

				insertInvitation(sqlite, {
					id: OTHER_INVITATION_ID,
					invitedByUserId: TARGET_ID,
					tokenHash: OTHER_TOKEN_HASH,
					role: 'member'
				});
				sqlite.exec(`UPDATE instance_member SET role = 'admin' WHERE user_id = '${TARGET_ID}'`);

				const suspend = await store.setInstanceMemberStatus(
					setStatusCommand({ status: 'suspended', idempotencyKey: 'status-cascade' })
				);
				expect(suspend.outcome).toBe('updated');
				if (suspend.outcome === 'updated') expect(suspend.revokedInvitationCount).toBe(1);

				const otherInv = sqlite
					.prepare('SELECT status FROM instance_invitation WHERE id = ?')
					.get(OTHER_INVITATION_ID) as { status: string };
				expect(otherInv.status).toBe('revoked');
			} finally {
				sqlite.close();
			}
		});

		it('persists revoked_invitation_count on the receipt row and returns the same count on replay', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, TARGET_ID, 'admin');
				insertInvitation(sqlite, {
					id: INVITATION_ID,
					invitedByUserId: TARGET_ID,
					tokenHash: TOKEN_HASH,
					role: 'member'
				});
				insertInvitation(sqlite, {
					id: OTHER_INVITATION_ID,
					invitedByUserId: TARGET_ID,
					tokenHash: OTHER_TOKEN_HASH,
					role: 'member'
				});

				const demote = await store.setInstanceMemberRole(setRoleCommand({ role: 'member' }));
				expect(demote.outcome).toBe('updated');
				if (demote.outcome === 'updated') expect(demote.revokedInvitationCount).toBe(2);

				// Read the persisted column directly, not the transient
				// meta.changes value the adapter returned above, so this proves
				// the count actually landed in the receipt row rather than only
				// having been computed in memory for this one response.
				const persisted = sqlite
					.prepare(
						'SELECT revoked_invitation_count AS count FROM instance_member_command WHERE target_user_id = ?'
					)
					.get(TARGET_ID) as { count: number };
				expect(persisted.count).toBe(2);

				// A replay must answer from that same persisted receipt evidence,
				// not recompute a fresh (and here, zero) cascade count.
				const replay = await store.setInstanceMemberRole(setRoleCommand({ role: 'member' }));
				expect(replay).toEqual({
					outcome: 'replayed',
					member: {
						userId: TARGET_ID,
						role: 'member',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: UPDATED_AT
					},
					appliedAt: UPDATED_AT,
					revokedInvitationCount: 2
				});
			} finally {
				sqlite.close();
			}
		});

		it('promotions and reactivation cascade nothing', async () => {
			const { store, sqlite } = createFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, TARGET_ID, 'member', 'suspended');
				insertInvitation(sqlite, {
					id: INVITATION_ID,
					invitedByUserId: TARGET_ID,
					tokenHash: TOKEN_HASH,
					role: 'member'
				});

				const promote = await store.setInstanceMemberRole(
					setRoleCommand({ role: 'owner', idempotencyKey: 'promote-1' })
				);
				expect(promote.outcome).toBe('updated');
				if (promote.outcome === 'updated') expect(promote.revokedInvitationCount).toBe(0);

				const reactivate = await store.setInstanceMemberStatus(
					setStatusCommand({ status: 'active', idempotencyKey: 'reactivate-1' })
				);
				expect(reactivate.outcome).toBe('updated');
				if (reactivate.outcome === 'updated') expect(reactivate.revokedInvitationCount).toBe(0);

				const inv = sqlite
					.prepare('SELECT status FROM instance_invitation WHERE id = ?')
					.get(INVITATION_ID) as { status: string };
				expect(inv.status).toBe('pending');
			} finally {
				sqlite.close();
			}
		});
	});

	describe('atomicity and invariant rollback', () => {
		it('rolls back the member update, cascade revocation, and receipt together when the acting owner is suspended mid-flight', async () => {
			const { store, sqlite, armBatchHook } = createHookedFixture();
			try {
				insertMember(sqlite, OWNER_ID, 'owner');
				insertMember(sqlite, TARGET_ID, 'owner');
				insertInvitation(sqlite, {
					id: INVITATION_ID,
					invitedByUserId: TARGET_ID,
					tokenHash: TOKEN_HASH,
					role: 'member'
				});

				// Batch 0 is the read-only gate, batch 1 is the mutation batch.
				// Suspending the acting owner here lands after the gate already
				// approved the demotion but before the receipt insert's evidence
				// trigger re-checks the actor, so the whole batch must roll back.
				armBatchHook((batchIndex: number): void => {
					if (batchIndex !== 1) return;
					sqlite.exec(
						`UPDATE instance_member SET status = 'suspended' WHERE user_id = '${OWNER_ID}'`
					);
				});

				const result: SetInstanceMemberRoleStoreResult = await store.setInstanceMemberRole(
					setRoleCommand({ targetUserId: TARGET_ID, role: 'member' })
				);
				expect(result).toEqual({ outcome: 'member_suspended' });

				const target = sqlite
					.prepare('SELECT role, status FROM instance_member WHERE user_id = ?')
					.get(TARGET_ID) as { role: string; status: string };
				expect(target).toEqual({ role: 'owner', status: 'active' });

				const inv = sqlite
					.prepare('SELECT status FROM instance_invitation WHERE id = ?')
					.get(INVITATION_ID) as { status: string };
				expect(inv.status).toBe('pending');

				expect(commandCount(sqlite, TARGET_ID)).toBe(0);
			} finally {
				sqlite.close();
			}
		});

		it('reclassifies as last_active_owner when a concurrent demotion removes the backup owner between the gate and the write', async () => {
			const { store, sqlite, armBatchHook } = createHookedFixture();
			try {
				// TARGET_ID is both actor and target: an active owner may demote
				// itself, and self-targeting is the only way to exclude the
				// acting owner from its own "other active owners" gate count, so
				// a concurrent change to the one remaining backup owner is what
				// can flip the outcome between the gate and the write.
				insertMember(sqlite, TARGET_ID, 'owner');
				insertMember(sqlite, OWNER2_ID, 'owner');

				// Batch 0 is the read-only gate: with two active owners, it sees
				// one other than TARGET_ID and approves the self-demotion. Batch
				// 1 is the mutation batch. Suspending the backup owner here lands
				// after the gate already approved the demotion but before the
				// member UPDATE runs, so the durable
				// instance_member_owner_floor_guard trigger aborts the mutation
				// batch, and the adapter must re-derive last_active_owner from
				// fresh state rather than surface the raw trigger failure.
				armBatchHook((batchIndex: number): void => {
					if (batchIndex !== 1) return;
					sqlite.exec(
						`UPDATE instance_member SET status = 'suspended' WHERE user_id = '${OWNER2_ID}'`
					);
				});

				const result: SetInstanceMemberRoleStoreResult = await store.setInstanceMemberRole(
					setRoleCommand({
						actor: { type: 'user', id: TARGET_ID },
						targetUserId: TARGET_ID,
						role: 'admin'
					})
				);
				expect(result).toEqual({ outcome: 'last_active_owner' });

				const target = sqlite
					.prepare('SELECT role, status FROM instance_member WHERE user_id = ?')
					.get(TARGET_ID) as { role: string; status: string };
				expect(target).toEqual({ role: 'owner', status: 'active' });

				expect(commandCount(sqlite, TARGET_ID)).toBe(0);
			} finally {
				sqlite.close();
			}
		});
	});
});
