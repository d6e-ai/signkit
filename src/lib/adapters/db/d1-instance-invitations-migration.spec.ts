import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyD1Migrations, d1MigrationPaths } from './sqlite-d1-test-support';

const OWNER_ID: string = 'user-owner-1';
const OTHER_MEMBER_ID: string = 'user-member-2';
const INVITATION_ID: string = '01900000-0000-7000-8000-000000000401';
const OTHER_INVITATION_ID: string = '01900000-0000-7000-8000-000000000402';
const CREATED_AT: string = '2026-09-12T12:00:00.000Z';
const EXPIRES_AT: string = '2026-09-19T12:00:00.000Z';
const TOKEN_HASH: string = 'a'.repeat(64);
const EMAIL_BINDING: string = 'b'.repeat(64);
const REQUEST_HASH: string = 'c'.repeat(64);

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
	userId: string = OWNER_ID,
	role: 'owner' | 'admin' | 'member' = 'owner'
): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${userId}', '${role}', 'active', '${CREATED_AT}', '${CREATED_AT}')
	`);
}

function insertInvitation(
	sqlite: DatabaseSync,
	options: {
		id?: string;
		role?: 'owner' | 'admin' | 'member';
		status?: 'pending' | 'accepted' | 'revoked';
		tokenHash?: string;
		emailBinding?: string;
		invitedByUserId?: string;
		createdAt?: string;
		expiresAt?: string;
		acceptedAt?: string | null;
		acceptedByUserId?: string | null;
		revokedAt?: string | null;
		revokedByUserId?: string | null;
	} = {}
): void {
	const value: (v: string | null | undefined) => string = (v: string | null | undefined): string =>
		v === null || v === undefined ? 'NULL' : `'${v}'`;
	sqlite.exec(`
		INSERT INTO instance_invitation (
			id, role, status, token_hash, email_binding, invited_by_user_id,
			created_at, expires_at, accepted_at, accepted_by_user_id, revoked_at, revoked_by_user_id
		) VALUES (
			'${options.id ?? INVITATION_ID}',
			'${options.role ?? 'member'}',
			'${options.status ?? 'pending'}',
			'${options.tokenHash ?? TOKEN_HASH}',
			'${options.emailBinding ?? EMAIL_BINDING}',
			'${options.invitedByUserId ?? OWNER_ID}',
			'${options.createdAt ?? CREATED_AT}',
			'${options.expiresAt ?? EXPIRES_AT}',
			${value(options.acceptedAt)},
			${value(options.acceptedByUserId)},
			${value(options.revokedAt)},
			${value(options.revokedByUserId)}
		)
	`);
}

function insertCommand(
	sqlite: DatabaseSync,
	options: {
		actorId?: string;
		idempotencyKey?: string;
		commandType?: 'create' | 'accept' | 'revoke';
		requestHash?: string;
		invitationId?: string;
		role?: 'owner' | 'admin' | 'member';
		resultStatus?: 'pending' | 'accepted' | 'revoked';
		occurredAt?: string;
	} = {}
): void {
	sqlite.exec(`
		INSERT INTO instance_invitation_command (
			actor_type, actor_id, idempotency_key, command_type, request_hash,
			invitation_id, role, result_status, occurred_at
		) VALUES (
			'user',
			'${options.actorId ?? OWNER_ID}',
			'${options.idempotencyKey ?? 'invite-create-1'}',
			'${options.commandType ?? 'create'}',
			'${options.requestHash ?? REQUEST_HASH}',
			'${options.invitationId ?? INVITATION_ID}',
			'${options.role ?? 'member'}',
			'${options.resultStatus ?? 'pending'}',
			'${options.occurredAt ?? CREATED_AT}'
		)
	`);
}

describe('D1 instance invitation migration', () => {
	it('applies every migration and establishes zero-PII invitation and receipt tables', () => {
		expect(d1MigrationPaths()).toContain('migrations/d1/0020_instance_invitations.sql');
		const sqlite: DatabaseSync = database();
		try {
			const tables = sqlite
				.prepare(
					`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
						'instance_member', 'instance_invitation', 'instance_invitation_command'
					) ORDER BY name`
				)
				.all()
				.map((row: unknown): string => (row as { name: string }).name);
			expect(tables).toEqual([
				'instance_invitation',
				'instance_invitation_command',
				'instance_member'
			]);

			expect(columnNames(sqlite, 'instance_invitation')).toEqual([
				'id',
				'role',
				'status',
				'token_hash',
				'email_binding',
				'invited_by_user_id',
				'created_at',
				'expires_at',
				'accepted_at',
				'accepted_by_user_id',
				'revoked_at',
				'revoked_by_user_id'
			]);
			expect(columnNames(sqlite, 'instance_invitation_command')).toEqual([
				'actor_type',
				'actor_id',
				'idempotency_key',
				'command_type',
				'request_hash',
				'invitation_id',
				'role',
				'result_status',
				'occurred_at'
			]);

			const piiColumns = ['email', 'name', 'token', 'secret', 'plaintext', 'credential'];
			for (const table of ['instance_invitation', 'instance_invitation_command']) {
				for (const column of piiColumns) {
					expect(columnNames(sqlite, table)).not.toContain(column);
				}
			}
		} finally {
			sqlite.close();
		}
	});

	it('enforces the id, role, status, and hash shapes on instance_invitation', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite);
			insertInvitation(sqlite);

			expect((): void => insertInvitation(sqlite, { id: 'not-a-uuid' })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void =>
				insertInvitation(sqlite, { id: OTHER_INVITATION_ID, role: 'superadmin' as 'member' })
			).toThrow(/CHECK constraint failed/);
			expect((): void =>
				insertInvitation(sqlite, { id: OTHER_INVITATION_ID, status: 'expired' as 'pending' })
			).toThrow(/CHECK constraint failed/);
			expect((): void =>
				insertInvitation(sqlite, { id: OTHER_INVITATION_ID, tokenHash: 'not-sha256' })
			).toThrow(/CHECK constraint failed/);
			expect((): void =>
				insertInvitation(sqlite, { id: OTHER_INVITATION_ID, emailBinding: 'not-sha256' })
			).toThrow(/CHECK constraint failed/);
		} finally {
			sqlite.close();
		}
	});

	it('enforces global token_hash uniqueness and the invited-by foreign key', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite);
			insertInvitation(sqlite);

			expect((): void =>
				insertInvitation(sqlite, { id: OTHER_INVITATION_ID, tokenHash: TOKEN_HASH })
			).toThrow(/UNIQUE constraint failed/);
			expect((): void =>
				insertInvitation(sqlite, {
					id: OTHER_INVITATION_ID,
					tokenHash: 'd'.repeat(64),
					invitedByUserId: 'missing-user'
				})
			).toThrow(/FOREIGN KEY constraint failed/);
		} finally {
			sqlite.close();
		}
	});

	it('bounds expiry to at most 7 days after creation', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite);
			expect((): void =>
				insertInvitation(sqlite, { expiresAt: '2026-09-20T12:00:00.000Z' })
			).toThrow(/CHECK constraint failed/);
			expect((): void => insertInvitation(sqlite, { expiresAt: CREATED_AT })).toThrow(
				/CHECK constraint failed/
			);
			insertInvitation(sqlite, { id: OTHER_INVITATION_ID, expiresAt: EXPIRES_AT });
		} finally {
			sqlite.close();
		}
	});

	it('enforces terminal exclusivity between pending, accepted, and revoked pairs', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite);
			insertMember(sqlite, OTHER_MEMBER_ID, 'member');

			expect((): void => insertInvitation(sqlite, { status: 'accepted' })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void => insertInvitation(sqlite, { status: 'revoked' })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void => insertInvitation(sqlite, { acceptedAt: CREATED_AT })).toThrow(
				/CHECK constraint failed/
			);

			insertInvitation(sqlite, {
				status: 'accepted',
				acceptedAt: CREATED_AT,
				acceptedByUserId: OTHER_MEMBER_ID
			});
			expect((): void =>
				insertInvitation(sqlite, {
					id: OTHER_INVITATION_ID,
					tokenHash: 'd'.repeat(64),
					status: 'accepted',
					acceptedAt: CREATED_AT,
					acceptedByUserId: OTHER_MEMBER_ID,
					revokedAt: CREATED_AT,
					revokedByUserId: OWNER_ID
				})
			).toThrow(/CHECK constraint failed/);

			insertInvitation(sqlite, {
				id: OTHER_INVITATION_ID,
				tokenHash: 'e'.repeat(64),
				status: 'revoked',
				revokedAt: CREATED_AT,
				revokedByUserId: OWNER_ID
			});
		} finally {
			sqlite.close();
		}
	});

	it('enforces receipt primary key, per-invitation-per-type uniqueness, and the type/status pairing', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite);
			insertInvitation(sqlite);
			insertCommand(sqlite);

			// Same (actor_type, actor_id, idempotency_key): primary key conflict.
			expect((): void =>
				insertCommand(sqlite, {
					idempotencyKey: 'invite-create-1',
					commandType: 'accept',
					resultStatus: 'accepted'
				})
			).toThrow(/UNIQUE constraint failed/);

			// Fresh idempotency key but the same (invitation_id, command_type) pair.
			expect((): void => insertCommand(sqlite, { idempotencyKey: 'invite-create-2' })).toThrow(
				/UNIQUE constraint failed/
			);

			// Fresh idempotency key and invitation, but command_type/result_status disagree.
			insertInvitation(sqlite, { id: OTHER_INVITATION_ID, tokenHash: 'd'.repeat(64) });
			expect((): void =>
				insertCommand(sqlite, {
					idempotencyKey: 'invite-accept-mismatch',
					commandType: 'accept',
					resultStatus: 'revoked',
					invitationId: OTHER_INVITATION_ID
				})
			).toThrow(/CHECK constraint failed/);

			// Fresh idempotency key and invitation, but a malformed request hash.
			const thirdInvitationId: string = '01900000-0000-7000-8000-000000000403';
			insertInvitation(sqlite, { id: thirdInvitationId, tokenHash: 'e'.repeat(64) });
			expect((): void =>
				insertCommand(sqlite, {
					idempotencyKey: 'invite-bad-hash',
					requestHash: 'not-sha256',
					invitationId: thirdInvitationId
				})
			).toThrow(/CHECK constraint failed/);
		} finally {
			sqlite.close();
		}
	});
});
