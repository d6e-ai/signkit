import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyD1Migrations, d1MigrationPaths } from './sqlite-d1-test-support';

type Role = 'owner' | 'admin' | 'member';
type Status = 'active' | 'suspended';
type CommandType = 'set_role' | 'set_status';

const OWNER_ID: string = 'user-owner-1';
const OTHER_OWNER_ID: string = 'user-owner-2';
const ADMIN_ID: string = 'user-admin-1';
const MEMBER_ID: string = 'user-member-1';
const CREATED_AT: string = '2026-09-12T12:00:00.000Z';
const T1: string = '2026-09-12T13:00:00.000Z';
const T2: string = '2026-09-12T14:00:00.000Z';
const T3: string = '2026-09-12T15:00:00.000Z';
const REQUEST_HASH: string = 'c'.repeat(64);
const INVITATION_EXPIRES_AT: string = '2026-09-19T12:00:00.000Z';

interface SqliteColumn {
	name: string;
}

function database(): DatabaseSync {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	return sqlite;
}

function columnNames(sqlite: DatabaseSync, table: string): readonly string[] {
	return sqlite
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.map((row: unknown): string => (row as SqliteColumn).name);
}

function insertMember(
	sqlite: DatabaseSync,
	userId: string,
	role: Role = 'member',
	status: Status = 'active',
	createdAt: string = CREATED_AT,
	updatedAt: string = createdAt
): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${userId}', '${role}', '${status}', '${createdAt}', '${updatedAt}')
	`);
}

function setMember(
	sqlite: DatabaseSync,
	userId: string,
	options: { role: Role; status: Status; updatedAt: string }
): void {
	sqlite.exec(`
		UPDATE instance_member
		SET role = '${options.role}', status = '${options.status}', updated_at = '${options.updatedAt}'
		WHERE user_id = '${userId}'
	`);
}

interface MemberRow {
	user_id: string;
	role: Role;
	status: Status;
	created_at: string;
	updated_at: string;
	display_name: string | null;
	email: string | null;
}

function memberRow(sqlite: DatabaseSync, userId: string): MemberRow {
	return sqlite
		.prepare(`SELECT * FROM instance_member WHERE user_id = '${userId}'`)
		.get() as unknown as MemberRow;
}

function insertInvitation(
	sqlite: DatabaseSync,
	options: {
		id: string;
		invitedByUserId: string;
		tokenHash: string;
		emailBinding: string;
		role?: Role;
		createdAt?: string;
	}
): void {
	sqlite.exec(`
		INSERT INTO instance_invitation (
			id, role, status, token_hash, email_binding, invited_by_user_id, created_at, expires_at
		) VALUES (
			'${options.id}', '${options.role ?? 'member'}', 'pending',
			'${options.tokenHash}', '${options.emailBinding}', '${options.invitedByUserId}',
			'${options.createdAt ?? CREATED_AT}', '${INVITATION_EXPIRES_AT}'
		)
	`);
}

function revokeInvitation(
	sqlite: DatabaseSync,
	id: string,
	revokedAt: string,
	revokedByUserId: string
): void {
	sqlite.exec(`
		UPDATE instance_invitation
		SET status = 'revoked', revoked_at = '${revokedAt}', revoked_by_user_id = '${revokedByUserId}'
		WHERE id = '${id}'
	`);
}

function insertCommand(
	sqlite: DatabaseSync,
	options: {
		actorId?: string;
		idempotencyKey?: string;
		commandType?: CommandType;
		requestHash?: string;
		targetUserId?: string;
		previousRole?: Role;
		previousStatus?: Status;
		resultRole?: Role;
		resultStatus?: Status;
		revokedInvitationCount?: number;
		occurredAt?: string;
	} = {}
): void {
	sqlite.exec(`
		INSERT INTO instance_member_command (
			actor_type, actor_id, idempotency_key, command_type, request_hash,
			target_user_id, previous_role, previous_status, result_role, result_status,
			revoked_invitation_count, occurred_at
		) VALUES (
			'user',
			'${options.actorId ?? OWNER_ID}',
			'${options.idempotencyKey ?? 'member-cmd-1'}',
			'${options.commandType ?? 'set_role'}',
			'${options.requestHash ?? REQUEST_HASH}',
			'${options.targetUserId ?? MEMBER_ID}',
			'${options.previousRole ?? 'member'}',
			'${options.previousStatus ?? 'active'}',
			'${options.resultRole ?? 'admin'}',
			'${options.resultStatus ?? 'active'}',
			${options.revokedInvitationCount ?? 0},
			'${options.occurredAt ?? CREATED_AT}'
		)
	`);
}

describe('D1 instance member command migration', () => {
	it('applies every migration and establishes a zero-PII receipt table', () => {
		expect(d1MigrationPaths()).toContain('migrations/d1/0021_instance_member_command.sql');
		const sqlite: DatabaseSync = database();
		try {
			expect(columnNames(sqlite, 'instance_member_command')).toEqual([
				'actor_type',
				'actor_id',
				'idempotency_key',
				'command_type',
				'request_hash',
				'target_user_id',
				'previous_role',
				'previous_status',
				'result_role',
				'result_status',
				'revoked_invitation_count',
				'occurred_at'
			]);

			const piiColumns = ['email', 'name', 'token', 'secret', 'plaintext', 'credential'];
			for (const column of piiColumns) {
				expect(columnNames(sqlite, 'instance_member_command')).not.toContain(column);
			}
		} finally {
			sqlite.close();
		}
	});

	it('enforces command_type, role, and status enum checks', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner');
			insertMember(sqlite, MEMBER_ID, 'member');

			expect((): void => insertCommand(sqlite, { commandType: 'delete' as CommandType })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void => insertCommand(sqlite, { previousRole: 'superadmin' as Role })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void => insertCommand(sqlite, { previousStatus: 'invited' as Status })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void => insertCommand(sqlite, { resultRole: 'superadmin' as Role })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void => insertCommand(sqlite, { resultStatus: 'invited' as Status })).toThrow(
				/CHECK constraint failed/
			);
		} finally {
			sqlite.close();
		}
	});

	it('enforces request hash shape and idempotency key charset bounds', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner');
			insertMember(sqlite, MEMBER_ID, 'member');

			expect((): void => insertCommand(sqlite, { requestHash: 'not-sha256' })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void => insertCommand(sqlite, { idempotencyKey: '' })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void => insertCommand(sqlite, { idempotencyKey: 'has space' })).toThrow(
				/CHECK constraint failed/
			);
		} finally {
			sqlite.close();
		}
	});

	it('enforces actor and target foreign keys into instance_member', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner');
			insertMember(sqlite, MEMBER_ID, 'member');
			setMember(sqlite, MEMBER_ID, { role: 'admin', status: 'active', updatedAt: CREATED_AT });

			// Every other invariant (state match, evidence, owner floor) is satisfied here,
			// isolating the foreign key check itself.
			expect((): void =>
				insertCommand(sqlite, { actorId: 'missing-actor', occurredAt: CREATED_AT })
			).toThrow(/FOREIGN KEY constraint failed/);

			// A nonexistent target can never satisfy the receipt/state-match evidence
			// check either (there is no row to match), so the evidence guard rejects it
			// before the deferred foreign key check would even run.
			expect((): void =>
				insertCommand(sqlite, { targetUserId: 'missing-target', occurredAt: CREATED_AT })
			).toThrow(/instance member command receipt state mismatch/);
		} finally {
			sqlite.close();
		}
	});

	it('enforces the command-type/field pairing invariant', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner');
			insertMember(sqlite, MEMBER_ID, 'member');

			// set_role must not also change status.
			expect((): void =>
				insertCommand(sqlite, {
					commandType: 'set_role',
					previousStatus: 'active',
					resultStatus: 'suspended'
				})
			).toThrow(/CHECK constraint failed/);

			// set_status must not also change role.
			expect((): void =>
				insertCommand(sqlite, {
					commandType: 'set_status',
					targetUserId: OWNER_ID,
					previousRole: 'owner',
					resultRole: 'admin',
					previousStatus: 'active',
					resultStatus: 'suspended'
				})
			).toThrow(/CHECK constraint failed/);
		} finally {
			sqlite.close();
		}
	});

	it('rejects a set_status command that self-targets', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner');

			expect((): void =>
				insertCommand(sqlite, {
					commandType: 'set_status',
					targetUserId: OWNER_ID,
					previousRole: 'owner',
					resultRole: 'owner',
					previousStatus: 'active',
					resultStatus: 'suspended'
				})
			).toThrow(/CHECK constraint failed/);
		} finally {
			sqlite.close();
		}
	});

	it('rejects a negative revoked invitation count', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner');
			insertMember(sqlite, MEMBER_ID, 'member');

			expect((): void => insertCommand(sqlite, { revokedInvitationCount: -1 })).toThrow(
				/CHECK constraint failed/
			);
		} finally {
			sqlite.close();
		}
	});

	it('enforces primary key uniqueness per actor and Idempotency-Key', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner');
			insertMember(sqlite, MEMBER_ID, 'member');
			setMember(sqlite, MEMBER_ID, { role: 'admin', status: 'active', updatedAt: CREATED_AT });
			insertCommand(sqlite, { occurredAt: CREATED_AT });

			// Same (actor_type, actor_id, idempotency_key) as above, otherwise a
			// well-formed and internally consistent row: only the primary key conflicts.
			expect((): void =>
				insertCommand(sqlite, {
					idempotencyKey: 'member-cmd-1',
					requestHash: 'd'.repeat(64),
					occurredAt: CREATED_AT
				})
			).toThrow(/UNIQUE constraint failed/);
		} finally {
			sqlite.close();
		}
	});

	it('protects instance_member identity, created_at, and updated_at monotonicity', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, MEMBER_ID, 'member');

			expect((): void => {
				sqlite.exec(
					`UPDATE instance_member SET user_id = 'renamed' WHERE user_id = '${MEMBER_ID}'`
				);
			}).toThrow(/cannot modify immutable instance member fields/);

			expect((): void => {
				sqlite.exec(
					`UPDATE instance_member SET created_at = '${T1}' WHERE user_id = '${MEMBER_ID}'`
				);
			}).toThrow(/cannot modify immutable instance member fields/);

			expect((): void => {
				sqlite.exec(
					`UPDATE instance_member SET updated_at = '2020-01-01T00:00:00.000Z' WHERE user_id = '${MEMBER_ID}'`
				);
			}).toThrow(/cannot modify immutable instance member fields/);

			// Advancing role/status with a non-regressing updated_at is fine.
			expect((): void => {
				setMember(sqlite, MEMBER_ID, { role: 'admin', status: 'active', updatedAt: T1 });
			}).not.toThrow();
		} finally {
			sqlite.close();
		}
	});

	it('rejects deleting instance members', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, MEMBER_ID, 'member');

			expect((): void => {
				sqlite.exec(`DELETE FROM instance_member WHERE user_id = '${MEMBER_ID}'`);
			}).toThrow(/instance members cannot be deleted/);
		} finally {
			sqlite.close();
		}
	});

	it('evidence guard rejects a stale or non-owner/admin actor', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner', 'active');
			insertMember(sqlite, 'user-suspended-owner', 'owner', 'suspended');
			insertMember(sqlite, 'user-plain-member', 'member', 'active');
			insertMember(sqlite, MEMBER_ID, 'member', 'active');
			setMember(sqlite, MEMBER_ID, { role: 'admin', status: 'active', updatedAt: T1 });

			// Actor exists but is suspended.
			expect((): void =>
				insertCommand(sqlite, {
					actorId: 'user-suspended-owner',
					idempotencyKey: 'suspended-actor',
					targetUserId: MEMBER_ID,
					previousRole: 'member',
					resultRole: 'admin',
					occurredAt: T1
				})
			).toThrow(/instance member command actor evidence conflict/);

			// Actor exists and is active, but only a plain member.
			expect((): void =>
				insertCommand(sqlite, {
					actorId: 'user-plain-member',
					idempotencyKey: 'non-admin-actor',
					targetUserId: MEMBER_ID,
					previousRole: 'member',
					resultRole: 'admin',
					occurredAt: T1
				})
			).toThrow(/instance member command actor evidence conflict/);
		} finally {
			sqlite.close();
		}
	});

	it('evidence guard enforces the admin role ceiling', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner', 'active');
			insertMember(sqlite, ADMIN_ID, 'admin', 'active');
			insertMember(sqlite, 'user-other-admin', 'admin', 'active');
			insertMember(sqlite, MEMBER_ID, 'member', 'active');

			// Admin may not administer a target that is not currently a plain member.
			setMember(sqlite, 'user-other-admin', {
				role: 'admin',
				status: 'suspended',
				updatedAt: T1
			});
			expect((): void =>
				insertCommand(sqlite, {
					actorId: ADMIN_ID,
					idempotencyKey: 'admin-targets-admin',
					commandType: 'set_status',
					targetUserId: 'user-other-admin',
					previousRole: 'admin',
					resultRole: 'admin',
					previousStatus: 'active',
					resultStatus: 'suspended',
					occurredAt: T1
				})
			).toThrow(/instance member command role ceiling conflict/);

			// Admin may not grant a role above member via set_role.
			setMember(sqlite, MEMBER_ID, { role: 'admin', status: 'active', updatedAt: T1 });
			expect((): void =>
				insertCommand(sqlite, {
					actorId: ADMIN_ID,
					idempotencyKey: 'admin-grants-above-member',
					commandType: 'set_role',
					targetUserId: MEMBER_ID,
					previousRole: 'member',
					resultRole: 'admin',
					occurredAt: T1
				})
			).toThrow(/instance member command role ceiling conflict/);

			// Admin suspending a plain member is within the ceiling.
			setMember(sqlite, MEMBER_ID, { role: 'member', status: 'suspended', updatedAt: T2 });
			expect((): void =>
				insertCommand(sqlite, {
					actorId: ADMIN_ID,
					idempotencyKey: 'admin-suspends-member',
					commandType: 'set_status',
					targetUserId: MEMBER_ID,
					previousRole: 'member',
					resultRole: 'member',
					previousStatus: 'active',
					resultStatus: 'suspended',
					occurredAt: T2
				})
			).not.toThrow();
		} finally {
			sqlite.close();
		}
	});

	it('evidence guard rejects a receipt whose claimed result does not match the current member row', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner', 'active');
			insertMember(sqlite, MEMBER_ID, 'member', 'active');
			// No update applied: instance_member still shows the pre-command state.

			expect((): void =>
				insertCommand(sqlite, {
					targetUserId: MEMBER_ID,
					previousRole: 'member',
					resultRole: 'admin',
					occurredAt: CREATED_AT
				})
			).toThrow(/instance member command receipt state mismatch/);
		} finally {
			sqlite.close();
		}
	});

	it('evidence guard rejects a revoked_invitation_count the invitation table cannot back', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner', 'active');
			insertMember(sqlite, ADMIN_ID, 'admin', 'active');
			insertInvitation(sqlite, {
				id: '01900000-0000-7000-8000-000000000501',
				invitedByUserId: ADMIN_ID,
				tokenHash: 'a'.repeat(64),
				emailBinding: 'b'.repeat(64)
			});

			// Demotion applied, but the invitation was never actually revoked.
			setMember(sqlite, ADMIN_ID, { role: 'member', status: 'active', updatedAt: T1 });
			expect((): void =>
				insertCommand(sqlite, {
					actorId: OWNER_ID,
					idempotencyKey: 'demote-overclaims',
					commandType: 'set_role',
					targetUserId: ADMIN_ID,
					previousRole: 'admin',
					resultRole: 'member',
					revokedInvitationCount: 1,
					occurredAt: T1
				})
			).toThrow(/instance member command revoked invitation count exceeds revoked invitations/);

			// A count the revoked invitations do back is accepted. Claiming fewer
			// than were revoked is not an error the schema can detect: no column
			// links an individual revoke to an individual command, so the count is
			// adapter-recorded evidence bounded from above, not an attribution.
			setMember(sqlite, ADMIN_ID, { role: 'admin', status: 'active', updatedAt: T2 });
			revokeInvitation(sqlite, '01900000-0000-7000-8000-000000000501', T2, OWNER_ID);
			setMember(sqlite, ADMIN_ID, { role: 'member', status: 'active', updatedAt: T2 });
			expect((): void =>
				insertCommand(sqlite, {
					actorId: OWNER_ID,
					idempotencyKey: 'demote-matches',
					commandType: 'set_role',
					targetUserId: ADMIN_ID,
					previousRole: 'admin',
					resultRole: 'member',
					revokedInvitationCount: 1,
					occurredAt: T2
				})
			).not.toThrow();

			// An invitation revoked at some other instant backs nothing here.
			insertMember(sqlite, 'user-admin-2', 'admin', 'active');
			insertInvitation(sqlite, {
				id: '01900000-0000-7000-8000-000000000502',
				invitedByUserId: 'user-admin-2',
				tokenHash: 'c'.repeat(64),
				emailBinding: 'd'.repeat(64)
			});
			revokeInvitation(sqlite, '01900000-0000-7000-8000-000000000502', T2, OWNER_ID);
			setMember(sqlite, 'user-admin-2', { role: 'member', status: 'active', updatedAt: T3 });
			expect((): void =>
				insertCommand(sqlite, {
					actorId: OWNER_ID,
					idempotencyKey: 'demote-wrong-instant',
					commandType: 'set_role',
					targetUserId: 'user-admin-2',
					previousRole: 'admin',
					resultRole: 'member',
					revokedInvitationCount: 1,
					occurredAt: T3
				})
			).toThrow(/instance member command revoked invitation count exceeds revoked invitations/);
		} finally {
			sqlite.close();
		}
	});

	it('accepts a valid receipt when unrelated revokes share the same millisecond', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner', 'active');
			insertMember(sqlite, ADMIN_ID, 'admin', 'active');
			for (const id of [
				'01900000-0000-7000-8000-000000000501',
				'01900000-0000-7000-8000-000000000502',
				'01900000-0000-7000-8000-000000000503'
			]) {
				insertInvitation(sqlite, {
					id,
					invitedByUserId: ADMIN_ID,
					tokenHash: id.slice(-1).repeat(64),
					emailBinding: `b${id.slice(-1)}`.repeat(32)
				});
			}

			// One invitation cascade-revoked by this command, and two unrelated
			// revokes of the same inviter's invitations landing on the very same
			// millisecond -- an explicit revoke by an owner, say, racing the
			// demotion. D1 batches are not serializable, so the collision is real.
			revokeInvitation(sqlite, '01900000-0000-7000-8000-000000000501', T1, OWNER_ID);
			revokeInvitation(sqlite, '01900000-0000-7000-8000-000000000502', T1, OWNER_ID);
			revokeInvitation(sqlite, '01900000-0000-7000-8000-000000000503', T1, OWNER_ID);
			setMember(sqlite, ADMIN_ID, { role: 'member', status: 'active', updatedAt: T1 });

			expect((): void =>
				insertCommand(sqlite, {
					actorId: OWNER_ID,
					idempotencyKey: 'demote-with-same-instant-revokes',
					commandType: 'set_role',
					targetUserId: ADMIN_ID,
					previousRole: 'admin',
					resultRole: 'member',
					revokedInvitationCount: 1,
					occurredAt: T1
				})
			).not.toThrow();
		} finally {
			sqlite.close();
		}
	});

	it('rejects a direct update that demotes or suspends the last active owner', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner', 'active');
			insertMember(sqlite, MEMBER_ID, 'member', 'active');

			// A raw UPDATE with no receipt at all: the owner floor holds on the
			// write itself, not only on the receipt an adapter is meant to append.
			expect((): void => {
				setMember(sqlite, OWNER_ID, { role: 'admin', status: 'active', updatedAt: T1 });
			}).toThrow(/instance must retain at least one active owner/);

			expect((): void => {
				setMember(sqlite, OWNER_ID, { role: 'member', status: 'active', updatedAt: T1 });
			}).toThrow(/instance must retain at least one active owner/);

			expect((): void => {
				setMember(sqlite, OWNER_ID, { role: 'owner', status: 'suspended', updatedAt: T1 });
			}).toThrow(/instance must retain at least one active owner/);

			// The rejected updates left the owner exactly as it was.
			expect(memberRow(sqlite, OWNER_ID)).toEqual({
				user_id: OWNER_ID,
				role: 'owner',
				status: 'active',
				created_at: CREATED_AT,
				updated_at: CREATED_AT,
				display_name: null,
				email: null
			});

			// Touching the last active owner without leaving the active-owner set
			// is still allowed.
			expect((): void => {
				setMember(sqlite, OWNER_ID, { role: 'owner', status: 'active', updatedAt: T1 });
			}).not.toThrow();
		} finally {
			sqlite.close();
		}
	});

	it('rejects a multi-row update that drains the active owners one row at a time', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner', 'active');
			insertMember(sqlite, OTHER_OWNER_ID, 'owner', 'active');

			// Each row passes the floor when considered alone, so the guard has to
			// see the table as the statement has already mutated it.
			expect((): void => {
				sqlite.exec(`
					UPDATE instance_member
					SET role = 'admin', updated_at = '${T1}'
					WHERE role = 'owner'
				`);
			}).toThrow(/instance must retain at least one active owner/);

			expect(
				sqlite
					.prepare(
						`SELECT COUNT(*) AS count FROM instance_member WHERE role = 'owner' AND status = 'active'`
					)
					.get()
			).toEqual({ count: 2 });
		} finally {
			sqlite.close();
		}
	});

	it('allows demoting an owner while another active owner remains', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner', 'active');
			insertMember(sqlite, OTHER_OWNER_ID, 'owner', 'active');

			expect((): void => {
				setMember(sqlite, OWNER_ID, { role: 'admin', status: 'active', updatedAt: T1 });
			}).not.toThrow();

			// A suspended owner is not an active owner, so it may be demoted freely.
			insertMember(sqlite, 'user-suspended-owner', 'owner', 'suspended');
			expect((): void => {
				setMember(sqlite, 'user-suspended-owner', {
					role: 'member',
					status: 'suspended',
					updatedAt: T1
				});
			}).not.toThrow();
		} finally {
			sqlite.close();
		}
	});

	it('leaves an instance that has no active owner yet updatable', () => {
		const sqlite: DatabaseSync = database();
		try {
			// Nothing bootstrapped: the floor guard preserves active owners, it does
			// not demand one exist before any member row may change.
			insertMember(sqlite, MEMBER_ID, 'member', 'active');

			expect((): void => {
				setMember(sqlite, MEMBER_ID, { role: 'member', status: 'suspended', updatedAt: T1 });
			}).not.toThrow();
		} finally {
			sqlite.close();
		}
	});

	it('evidence guard rejects a receipt recorded against an instance with no active owner', () => {
		const sqlite: DatabaseSync = database();
		try {
			// Reachable only without a bootstrapped owner: every other path into a
			// zero-active-owner instance is closed by the update and delete guards.
			insertMember(sqlite, ADMIN_ID, 'admin', 'active');
			insertMember(sqlite, MEMBER_ID, 'member', 'active');
			setMember(sqlite, MEMBER_ID, { role: 'member', status: 'suspended', updatedAt: T1 });

			expect((): void =>
				insertCommand(sqlite, {
					actorId: ADMIN_ID,
					idempotencyKey: 'no-owner-instance',
					commandType: 'set_status',
					targetUserId: MEMBER_ID,
					previousRole: 'member',
					resultRole: 'member',
					previousStatus: 'active',
					resultStatus: 'suspended',
					occurredAt: T1
				})
			).toThrow(/instance member command leaves no active owner/);
		} finally {
			sqlite.close();
		}
	});

	it('keeps receipts append-only', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner', 'active');
			insertMember(sqlite, MEMBER_ID, 'member', 'active');
			setMember(sqlite, MEMBER_ID, { role: 'admin', status: 'active', updatedAt: T1 });
			insertCommand(sqlite, { occurredAt: T1 });

			expect((): void => {
				sqlite.exec(`
					UPDATE instance_member_command
					SET revoked_invitation_count = 7
					WHERE idempotency_key = 'member-cmd-1'
				`);
			}).toThrow(/instance member command receipts are append-only/);

			expect((): void => {
				sqlite.exec(`DELETE FROM instance_member_command WHERE idempotency_key = 'member-cmd-1'`);
			}).toThrow(/instance member command receipts are append-only/);
		} finally {
			sqlite.close();
		}
	});

	it('rejects a self-targeting receipt that claims anything but an active owner', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner', 'active');
			insertMember(sqlite, ADMIN_ID, 'admin', 'active');
			setMember(sqlite, ADMIN_ID, { role: 'member', status: 'active', updatedAt: T1 });

			// An admin self-demoting: an admin may only administer a current
			// member-role target, which its own row never is.
			expect((): void =>
				insertCommand(sqlite, {
					actorId: ADMIN_ID,
					idempotencyKey: 'admin-self-demote',
					commandType: 'set_role',
					targetUserId: ADMIN_ID,
					previousRole: 'admin',
					resultRole: 'member',
					occurredAt: T1
				})
			).toThrow(/CHECK constraint failed: instance_member_command_self_target_active_owner/);

			// Nor may a self-target claim it was suspended when the command ran.
			expect((): void =>
				insertCommand(sqlite, {
					actorId: ADMIN_ID,
					idempotencyKey: 'suspended-self',
					commandType: 'set_role',
					targetUserId: ADMIN_ID,
					previousRole: 'owner',
					previousStatus: 'suspended',
					resultRole: 'member',
					resultStatus: 'suspended',
					occurredAt: T1
				})
			).toThrow(/CHECK constraint failed: instance_member_command_self_target_active_owner/);
		} finally {
			sqlite.close();
		}
	});

	it('rejects a cascade count on a command that cannot revoke anything', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner', 'active');
			insertMember(sqlite, MEMBER_ID, 'member', 'active');

			// Promotion revokes nothing.
			expect((): void =>
				insertCommand(sqlite, {
					idempotencyKey: 'promotion-cascade',
					commandType: 'set_role',
					targetUserId: MEMBER_ID,
					previousRole: 'member',
					resultRole: 'admin',
					revokedInvitationCount: 1,
					occurredAt: T1
				})
			).toThrow(/CHECK constraint failed: instance_member_command_cascade_requires_demotion/);

			// Nor does reactivation.
			expect((): void =>
				insertCommand(sqlite, {
					idempotencyKey: 'reactivation-cascade',
					commandType: 'set_status',
					targetUserId: MEMBER_ID,
					previousRole: 'member',
					resultRole: 'member',
					previousStatus: 'suspended',
					resultStatus: 'active',
					revokedInvitationCount: 1,
					occurredAt: T1
				})
			).toThrow(/CHECK constraint failed: instance_member_command_cascade_requires_demotion/);
		} finally {
			sqlite.close();
		}
	});

	it('allows a legitimate self-targeting role change when another active owner remains', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner', 'active');
			insertMember(sqlite, OTHER_OWNER_ID, 'owner', 'active');
			setMember(sqlite, OWNER_ID, { role: 'admin', status: 'active', updatedAt: T1 });

			expect((): void =>
				insertCommand(sqlite, {
					actorId: OWNER_ID,
					idempotencyKey: 'self-demote-safe',
					commandType: 'set_role',
					targetUserId: OWNER_ID,
					previousRole: 'owner',
					resultRole: 'admin',
					occurredAt: T1
				})
			).not.toThrow();
		} finally {
			sqlite.close();
		}
	});

	it('allows a legitimate owner-administered role change on another member', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, OWNER_ID, 'owner', 'active');
			insertMember(sqlite, MEMBER_ID, 'member', 'active');
			setMember(sqlite, MEMBER_ID, { role: 'admin', status: 'active', updatedAt: T3 });

			expect((): void =>
				insertCommand(sqlite, {
					actorId: OWNER_ID,
					idempotencyKey: 'owner-promotes-member',
					commandType: 'set_role',
					targetUserId: MEMBER_ID,
					previousRole: 'member',
					resultRole: 'admin',
					occurredAt: T3
				})
			).not.toThrow();
		} finally {
			sqlite.close();
		}
	});
});
