import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type {
	AcceptInstanceInvitationCommand,
	AcceptInstanceInvitationStoreResult,
	BootstrapInstanceCommand,
	BootstrapInstanceStoreResult,
	CreateInstanceInvitationCommand,
	CreateInstanceInvitationStoreResult,
	InstanceCallerContext,
	ListInstanceInvitationsStoreResult,
	RevokeInstanceInvitationCommand,
	RevokeInstanceInvitationStoreResult
} from '$lib/ports/instance-store';
import { D1InstanceStore } from './d1-instance-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ACTOR_ID: string = 'user-owner-1';
const OTHER_ACTOR_ID: string = 'user-other-2';
const IDEMPOTENCY_KEY: string = 'bootstrap-idem-key-1';
const REQUEST_FINGERPRINT: string = 'a'.repeat(64);
const OTHER_REQUEST_FINGERPRINT: string = 'b'.repeat(64);
const CREATED_AT: string = '2026-09-12T12:00:00.000Z';
const EXPIRES_AT: string = '2026-09-19T12:00:00.000Z';

const INVITATION_ID: string = '01900000-0000-7000-8000-000000000101';
const OTHER_INVITATION_ID: string = '01900000-0000-7000-8000-000000000102';
const THIRD_INVITATION_ID: string = '01900000-0000-7000-8000-000000000103';
const TOKEN_HASH: string = 'c'.repeat(64);
const OTHER_TOKEN_HASH: string = 'd'.repeat(64);
const EMAIL_BINDING: string = 'e'.repeat(64);
const OTHER_EMAIL_BINDING: string = 'f'.repeat(64);

function bootstrapCommand(
	overrides: Partial<BootstrapInstanceCommand> = {}
): BootstrapInstanceCommand {
	return {
		actor: { type: 'user', id: ACTOR_ID },
		idempotencyKey: IDEMPOTENCY_KEY,
		requestFingerprint: REQUEST_FINGERPRINT,
		createdAt: CREATED_AT,
		...overrides
	};
}

function createInvitationCommand(
	overrides: Partial<CreateInstanceInvitationCommand> = {}
): CreateInstanceInvitationCommand {
	return {
		actor: { type: 'user', id: ACTOR_ID },
		idempotencyKey: 'invite-create-key-1',
		requestFingerprint: REQUEST_FINGERPRINT,
		invitationId: INVITATION_ID,
		role: 'member',
		tokenHash: TOKEN_HASH,
		emailBinding: EMAIL_BINDING,
		createdAt: CREATED_AT,
		expiresAt: EXPIRES_AT,
		...overrides
	};
}

function acceptInvitationCommand(
	overrides: Partial<AcceptInstanceInvitationCommand> = {}
): AcceptInstanceInvitationCommand {
	return {
		actor: { type: 'user', id: 'accepting-user-1' },
		idempotencyKey: 'invite-accept-key-1',
		requestFingerprint: REQUEST_FINGERPRINT,
		tokenHash: TOKEN_HASH,
		emailBinding: EMAIL_BINDING,
		acceptedAt: '2026-09-13T12:00:00.000Z',
		...overrides
	};
}

function revokeInvitationCommand(
	overrides: Partial<RevokeInstanceInvitationCommand> = {}
): RevokeInstanceInvitationCommand {
	return {
		actor: { type: 'user', id: ACTOR_ID },
		idempotencyKey: 'invite-revoke-key-1',
		requestFingerprint: REQUEST_FINGERPRINT,
		invitationId: INVITATION_ID,
		revokedAt: '2026-09-13T12:00:00.000Z',
		...overrides
	};
}

function insertMember(
	sqlite: DatabaseSync,
	userId: string,
	role: 'owner' | 'admin' | 'member' = 'member',
	status: 'active' | 'suspended' = 'active'
): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${userId}', '${role}', '${status}', '${CREATED_AT}', '${CREATED_AT}')
	`);
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
	/**
	 * Installs a hook that runs immediately before each subsequent `batch()`
	 * call, numbered from zero at the moment it is installed. It is the only
	 * way to land a competing write in the window between a store method's
	 * read-only gate batch and its mutation batch.
	 */
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

describe('D1InstanceStore', () => {
	describe('bootstrapInstance', () => {
		it('atomically claims the first active owner slot on an empty instance', async () => {
			const { store, sqlite } = createFixture();
			try {
				const result: BootstrapInstanceStoreResult =
					await store.bootstrapInstance(bootstrapCommand());
				expect(result).toEqual({
					outcome: 'bootstrapped',
					member: {
						userId: ACTOR_ID,
						role: 'owner',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					}
				});

				const member = sqlite
					.prepare('SELECT user_id, role, status FROM instance_member WHERE user_id = ?')
					.get(ACTOR_ID) as { user_id: string; role: string; status: string };
				expect(member).toEqual({
					user_id: ACTOR_ID,
					role: 'owner',
					status: 'active'
				});

				const bootstrap = sqlite
					.prepare('SELECT singleton_key, owner_user_id FROM instance_bootstrap')
					.get() as { singleton_key: number; owner_user_id: string };
				expect(bootstrap).toEqual({
					singleton_key: 1,
					owner_user_id: ACTOR_ID
				});

				const receipt = sqlite
					.prepare(
						'SELECT actor_type, actor_id, idempotency_key, request_hash, owner_user_id FROM instance_bootstrap_command'
					)
					.get() as {
					actor_type: string;
					actor_id: string;
					idempotency_key: string;
					request_hash: string;
					owner_user_id: string;
				};
				expect(receipt).toEqual({
					actor_type: 'user',
					actor_id: ACTOR_ID,
					idempotency_key: IDEMPOTENCY_KEY,
					request_hash: REQUEST_FINGERPRINT,
					owner_user_id: ACTOR_ID
				});
			} finally {
				sqlite.close();
			}
		});

		it('leaves exactly one owner and no orphan member under concurrent different-subject bootstrap', async () => {
			const { store, sqlite } = createFixture();
			try {
				const [first, second]: BootstrapInstanceStoreResult[] = await Promise.all([
					store.bootstrapInstance(bootstrapCommand({ actor: { type: 'user', id: ACTOR_ID } })),
					store.bootstrapInstance(
						bootstrapCommand({
							actor: { type: 'user', id: OTHER_ACTOR_ID },
							idempotencyKey: 'other-idem-key',
							requestFingerprint: OTHER_REQUEST_FINGERPRINT
						})
					)
				]);

				const outcomes: string[] = [first.outcome, second.outcome].sort();
				expect(outcomes).toEqual(['already_bootstrapped', 'bootstrapped']);

				const members = sqlite.prepare('SELECT user_id, role FROM instance_member').all() as {
					user_id: string;
					role: string;
				}[];
				expect(members).toHaveLength(1);
				expect(members[0].role).toBe('owner');

				const bootstrapRows = sqlite
					.prepare('SELECT owner_user_id FROM instance_bootstrap')
					.all() as { owner_user_id: string }[];
				expect(bootstrapRows).toHaveLength(1);
				expect(bootstrapRows[0].owner_user_id).toBe(members[0].user_id);
			} finally {
				sqlite.close();
			}
		});

		it('safely replays an exact request under the original idempotency key', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const replay: BootstrapInstanceStoreResult =
					await store.bootstrapInstance(bootstrapCommand());
				expect(replay).toEqual({
					outcome: 'already_bootstrapped',
					member: {
						userId: ACTOR_ID,
						role: 'owner',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					},
					replayed: true
				});
			} finally {
				sqlite.close();
			}
		});

		it('rejects a reused idempotency key with a conflicting request fingerprint', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const conflict: BootstrapInstanceStoreResult = await store.bootstrapInstance(
					bootstrapCommand({ requestFingerprint: OTHER_REQUEST_FINGERPRINT })
				);
				expect(conflict).toEqual({ outcome: 'idempotency_conflict' });
			} finally {
				sqlite.close();
			}
		});

		it('classifies cross-subject attempt as already_bootstrapped without replay', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const otherAttempt: BootstrapInstanceStoreResult = await store.bootstrapInstance(
					bootstrapCommand({ actor: { type: 'user', id: OTHER_ACTOR_ID } })
				);
				expect(otherAttempt).toEqual({
					outcome: 'already_bootstrapped',
					replayed: false
				});
			} finally {
				sqlite.close();
			}
		});

		it('classifies same-subject fresh idempotency key as already_bootstrapped without replay', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const freshKeyAttempt: BootstrapInstanceStoreResult = await store.bootstrapInstance(
					bootstrapCommand({ idempotencyKey: 'different-idem-key' })
				);
				expect(freshKeyAttempt).toEqual({
					outcome: 'already_bootstrapped',
					replayed: false
				});
			} finally {
				sqlite.close();
			}
		});

		it('refuses bootstrap when instance_member has preexisting members', async () => {
			const { store, sqlite } = createFixture();
			try {
				sqlite.exec(`
					INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
					VALUES ('preexisting-user', 'member', 'active', '${CREATED_AT}', '${CREATED_AT}')
				`);

				const result: BootstrapInstanceStoreResult =
					await store.bootstrapInstance(bootstrapCommand());
				expect(result).toEqual({
					outcome: 'already_bootstrapped',
					replayed: false
				});
			} finally {
				sqlite.close();
			}
		});

		it('detects receipt drift or missing owner as integrity_error on replay', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				insertMember(sqlite, 'standby-owner-1', 'owner');

				// Corrupt owner member state
				sqlite.exec(
					`UPDATE instance_member SET status = 'suspended' WHERE user_id = '${ACTOR_ID}'`
				);

				const replay: BootstrapInstanceStoreResult =
					await store.bootstrapInstance(bootstrapCommand());
				expect(replay).toEqual({ outcome: 'integrity_error' });
			} finally {
				sqlite.close();
			}
		});
	});

	describe('getInstanceCallerContext', () => {
		it('returns null member and bootstrapped false when instance is clean', async () => {
			const { store, sqlite } = createFixture();
			try {
				const context: InstanceCallerContext = await store.getInstanceCallerContext(ACTOR_ID);
				expect(context).toEqual({
					member: null,
					bootstrapped: false
				});
			} finally {
				sqlite.close();
			}
		});

		it('returns owner metadata and bootstrapped true when caller is owner', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const context: InstanceCallerContext = await store.getInstanceCallerContext(ACTOR_ID);
				expect(context).toEqual({
					member: {
						userId: ACTOR_ID,
						role: 'owner',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					},
					bootstrapped: true
				});
			} finally {
				sqlite.close();
			}
		});

		it('returns null member and bootstrapped true when caller is non-member', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const context: InstanceCallerContext = await store.getInstanceCallerContext(OTHER_ACTOR_ID);
				expect(context).toEqual({
					member: null,
					bootstrapped: true
				});
			} finally {
				sqlite.close();
			}
		});

		it('returns suspended member metadata and bootstrapped true when caller is suspended', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				sqlite.exec(`
					INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
					VALUES ('suspended-user', 'member', 'suspended', '${CREATED_AT}', '${CREATED_AT}')
				`);

				const context: InstanceCallerContext =
					await store.getInstanceCallerContext('suspended-user');
				expect(context).toEqual({
					member: {
						userId: 'suspended-user',
						role: 'member',
						status: 'suspended',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					},
					bootstrapped: true
				});
			} finally {
				sqlite.close();
			}
		});
	});

	describe('createInstanceInvitation', () => {
		it('atomically creates an invitation and command receipt for active owner', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const result: CreateInstanceInvitationStoreResult =
					await store.createInstanceInvitation(createInvitationCommand());
				expect(result).toEqual({
					outcome: 'created',
					invitation: {
						id: INVITATION_ID,
						role: 'member',
						status: 'pending',
						invitedByUserId: ACTOR_ID,
						createdAt: CREATED_AT,
						expiresAt: EXPIRES_AT,
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: null,
						revokedByUserId: null
					}
				});

				const inv = sqlite
					.prepare(
						'SELECT id, role, status, token_hash, email_binding, invited_by_user_id FROM instance_invitation WHERE id = ?'
					)
					.get(INVITATION_ID) as {
					id: string;
					role: string;
					status: string;
					token_hash: string;
					email_binding: string;
					invited_by_user_id: string;
				};
				expect(inv).toEqual({
					id: INVITATION_ID,
					role: 'member',
					status: 'pending',
					token_hash: TOKEN_HASH,
					email_binding: EMAIL_BINDING,
					invited_by_user_id: ACTOR_ID
				});

				const receipt = sqlite
					.prepare(
						'SELECT actor_type, actor_id, idempotency_key, command_type, request_hash, invitation_id, role, result_status FROM instance_invitation_command WHERE invitation_id = ?'
					)
					.get(INVITATION_ID) as {
					actor_type: string;
					actor_id: string;
					idempotency_key: string;
					command_type: string;
					request_hash: string;
					invitation_id: string;
					role: string;
					result_status: string;
				};
				expect(receipt).toEqual({
					actor_type: 'user',
					actor_id: ACTOR_ID,
					idempotency_key: 'invite-create-key-1',
					command_type: 'create',
					request_hash: REQUEST_FINGERPRINT,
					invitation_id: INVITATION_ID,
					role: 'member',
					result_status: 'pending'
				});
			} finally {
				sqlite.close();
			}
		});

		it('allows active owner to invite owner, admin, or member', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const resOwner = await store.createInstanceInvitation(
					createInvitationCommand({
						invitationId: INVITATION_ID,
						role: 'owner',
						tokenHash: '1'.repeat(64),
						idempotencyKey: 'k-1'
					})
				);
				expect(resOwner.outcome).toBe('created');

				const resAdmin = await store.createInstanceInvitation(
					createInvitationCommand({
						invitationId: OTHER_INVITATION_ID,
						role: 'admin',
						tokenHash: '2'.repeat(64),
						idempotencyKey: 'k-2'
					})
				);
				expect(resAdmin.outcome).toBe('created');

				const resMember = await store.createInstanceInvitation(
					createInvitationCommand({
						invitationId: THIRD_INVITATION_ID,
						role: 'member',
						tokenHash: '3'.repeat(64),
						idempotencyKey: 'k-3'
					})
				);
				expect(resMember.outcome).toBe('created');
			} finally {
				sqlite.close();
			}
		});

		it('allows active admin to invite member only', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				insertMember(sqlite, 'admin-user', 'admin');

				const resMember = await store.createInstanceInvitation(
					createInvitationCommand({ actor: { type: 'user', id: 'admin-user' }, role: 'member' })
				);
				expect(resMember.outcome).toBe('created');
			} finally {
				sqlite.close();
			}
		});

		it('refuses active admin inviting owner or admin with role_not_permitted and writes nothing', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				insertMember(sqlite, 'admin-user', 'admin');

				const resOwner = await store.createInstanceInvitation(
					createInvitationCommand({
						actor: { type: 'user', id: 'admin-user' },
						role: 'owner',
						idempotencyKey: 'adm-1'
					})
				);
				expect(resOwner).toEqual({ outcome: 'role_not_permitted' });

				const resAdmin = await store.createInstanceInvitation(
					createInvitationCommand({
						actor: { type: 'user', id: 'admin-user' },
						role: 'admin',
						idempotencyKey: 'adm-2'
					})
				);
				expect(resAdmin).toEqual({ outcome: 'role_not_permitted' });

				const count = sqlite.prepare('SELECT COUNT(*) as count FROM instance_invitation').get() as {
					count: number;
				};
				expect(count.count).toBe(0);
			} finally {
				sqlite.close();
			}
		});

		it('refuses non-owner/admin (role member) with forbidden and writes nothing', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				insertMember(sqlite, 'regular-member', 'member');

				const res = await store.createInstanceInvitation(
					createInvitationCommand({ actor: { type: 'user', id: 'regular-member' } })
				);
				expect(res).toEqual({ outcome: 'forbidden' });

				const count = sqlite.prepare('SELECT COUNT(*) as count FROM instance_invitation').get() as {
					count: number;
				};
				expect(count.count).toBe(0);
			} finally {
				sqlite.close();
			}
		});

		it('refuses unknown actor with forbidden and writes nothing', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const res = await store.createInstanceInvitation(
					createInvitationCommand({ actor: { type: 'user', id: 'ghost-user' } })
				);
				expect(res).toEqual({ outcome: 'forbidden' });
			} finally {
				sqlite.close();
			}
		});

		it('refuses suspended owner or admin with member_suspended and writes nothing', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				insertMember(sqlite, 'standby-owner-1', 'owner');
				sqlite.exec(
					`UPDATE instance_member SET status = 'suspended' WHERE user_id = '${ACTOR_ID}'`
				);

				const res = await store.createInstanceInvitation(createInvitationCommand());
				expect(res).toEqual({ outcome: 'member_suspended' });

				const count = sqlite.prepare('SELECT COUNT(*) as count FROM instance_invitation').get() as {
					count: number;
				};
				expect(count.count).toBe(0);
			} finally {
				sqlite.close();
			}
		});

		it('enforces pending cap 200: returns limit when 200 pending invitations already exist', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				for (let i = 1; i <= 200; i++) {
					const hexId = i.toString(16).padStart(12, '0');
					const invId = `01900000-0000-7000-8000-${hexId}`;
					const tHash = i.toString(16).padStart(64, '0');
					sqlite.exec(`
						INSERT INTO instance_invitation (id, role, status, token_hash, email_binding, invited_by_user_id, created_at, expires_at)
						VALUES ('${invId}', 'member', 'pending', '${tHash}', '${EMAIL_BINDING}', '${ACTOR_ID}', '${CREATED_AT}', '${EXPIRES_AT}')
					`);
				}

				const res = await store.createInstanceInvitation(
					createInvitationCommand({
						invitationId: '01900000-0000-7000-8000-000000000999',
						tokenHash: '9'.repeat(64)
					})
				);
				expect(res).toEqual({ outcome: 'limit' });
			} finally {
				sqlite.close();
			}
		});

		it('proves 200 expired pending invitations do not block a new create, while 200 live pending still returns limit', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				// Seed 200 expired pending invitations
				const expiredCreatedAt = '2026-09-01T12:00:00.000Z';
				const expiredExpiresAt = '2026-09-08T12:00:00.000Z';
				const insertStmt = sqlite.prepare(`
					INSERT INTO instance_invitation (id, role, status, token_hash, email_binding, invited_by_user_id, created_at, expires_at)
					VALUES (?, 'member', 'pending', ?, ?, ?, ?, ?)
				`);

				for (let i = 1; i <= 200; i++) {
					const hexId = i.toString(16).padStart(12, '0');
					const invId = `01900000-0000-7000-8000-${hexId}`;
					const tHash = i.toString(16).padStart(64, '0');
					insertStmt.run(invId, tHash, EMAIL_BINDING, ACTOR_ID, expiredCreatedAt, expiredExpiresAt);
				}

				// 200 expired pending invitations do not block creating a new live invitation
				const allowedRes = await store.createInstanceInvitation(
					createInvitationCommand({
						invitationId: '01900000-0000-7000-8000-000000000998',
						tokenHash: '8'.repeat(64)
					})
				);
				expect(allowedRes.outcome).toBe('created');

				// Now clean up invitations/commands and seed 200 live pending invitations
				sqlite.exec('DELETE FROM instance_invitation_command');
				sqlite.exec('DELETE FROM instance_invitation');

				for (let i = 1; i <= 200; i++) {
					const hexId = i.toString(16).padStart(12, '0');
					const invId = `01900000-0000-7000-8000-${hexId}`;
					const tHash = '1' + i.toString(16).padStart(63, '0');
					insertStmt.run(invId, tHash, EMAIL_BINDING, ACTOR_ID, CREATED_AT, EXPIRES_AT);
				}

				// 200 live pending invitations block creating a new invitation and return limit
				const limitRes = await store.createInstanceInvitation(
					createInvitationCommand({
						invitationId: '01900000-0000-7000-8000-000000000999',
						tokenHash: '9'.repeat(64)
					})
				);
				expect(limitRes).toEqual({ outcome: 'limit' });
			} finally {
				sqlite.close();
			}
		});

		it('safely replays an exact request under the original idempotency key returning current metadata', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const initial = await store.createInstanceInvitation(createInvitationCommand());
				expect(initial.outcome).toBe('created');

				const replay = await store.createInstanceInvitation(createInvitationCommand());
				expect(replay).toEqual({
					outcome: 'replayed',
					invitation: {
						id: INVITATION_ID,
						role: 'member',
						status: 'pending',
						invitedByUserId: ACTOR_ID,
						createdAt: CREATED_AT,
						expiresAt: EXPIRES_AT,
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: null,
						revokedByUserId: null
					}
				});
			} finally {
				sqlite.close();
			}
		});

		it('rejects a reused idempotency key with a conflicting request fingerprint', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());

				const conflict = await store.createInstanceInvitation(
					createInvitationCommand({ requestFingerprint: OTHER_REQUEST_FINGERPRINT })
				);
				expect(conflict).toEqual({ outcome: 'idempotency_conflict' });
			} finally {
				sqlite.close();
			}
		});

		it('rejects a reused idempotency key with conflicting role', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());

				const conflictRole = await store.createInstanceInvitation(
					createInvitationCommand({ role: 'admin' })
				);
				expect(conflictRole).toEqual({ outcome: 'idempotency_conflict' });
			} finally {
				sqlite.close();
			}
		});

		it('safely replays realistic service retry where candidate invitationId, tokens, and timestamps are re-minted under same key and fingerprint', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const initial = await store.createInstanceInvitation(createInvitationCommand());
				expect(initial.outcome).toBe('created');

				// A service retry re-mints candidate invitationId, tokens, and timestamps before store sees the receipt
				const retry = await store.createInstanceInvitation(
					createInvitationCommand({
						invitationId: OTHER_INVITATION_ID,
						tokenHash: 'b'.repeat(64),
						emailBinding: 'c'.repeat(64),
						createdAt: '2026-09-12T12:05:00.000Z',
						expiresAt: '2026-09-19T12:05:00.000Z'
					})
				);

				expect(retry).toEqual({
					outcome: 'replayed',
					invitation: {
						id: INVITATION_ID,
						role: 'member',
						status: 'pending',
						invitedByUserId: ACTOR_ID,
						createdAt: CREATED_AT,
						expiresAt: EXPIRES_AT,
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: null,
						revokedByUserId: null
					}
				});
			} finally {
				sqlite.close();
			}
		});

		it('detects receipt drift as integrity_error on replay', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());

				sqlite.exec(
					`UPDATE instance_invitation_command SET role = 'owner' WHERE invitation_id = '${INVITATION_ID}'`
				);

				const res = await store.createInstanceInvitation(
					createInvitationCommand({ role: 'owner' })
				);
				expect(res).toEqual({ outcome: 'integrity_error' });
			} finally {
				sqlite.close();
			}
		});

		it('classifies a candidate invitationId collision as credential_collision when no matching receipt exists', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const initial = await store.createInstanceInvitation(createInvitationCommand());
				expect(initial.outcome).toBe('created');

				const collision = await store.createInstanceInvitation(
					createInvitationCommand({
						idempotencyKey: 'invite-create-key-2',
						requestFingerprint: OTHER_REQUEST_FINGERPRINT,
						tokenHash: OTHER_TOKEN_HASH,
						emailBinding: OTHER_EMAIL_BINDING
					})
				);

				expect(collision).toEqual({ outcome: 'credential_collision' });
			} finally {
				sqlite.close();
			}
		});

		it('classifies a candidate tokenHash collision as credential_collision when no matching receipt exists', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const initial = await store.createInstanceInvitation(createInvitationCommand());
				expect(initial.outcome).toBe('created');

				const collision = await store.createInstanceInvitation(
					createInvitationCommand({
						idempotencyKey: 'invite-create-key-2',
						requestFingerprint: OTHER_REQUEST_FINGERPRINT,
						invitationId: OTHER_INVITATION_ID,
						emailBinding: OTHER_EMAIL_BINDING
					})
				);

				expect(collision).toEqual({ outcome: 'credential_collision' });
			} finally {
				sqlite.close();
			}
		});

		it('refuses replay if actor was subsequently suspended', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());
				insertMember(sqlite, 'standby-owner-1', 'owner');

				sqlite.exec(
					`UPDATE instance_member SET status = 'suspended' WHERE user_id = '${ACTOR_ID}'`
				);

				const replay = await store.createInstanceInvitation(createInvitationCommand());
				expect(replay).toEqual({ outcome: 'member_suspended' });
			} finally {
				sqlite.close();
			}
		});

		it('reports current metadata on replay even if invitation was later revoked', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());

				await store.revokeInstanceInvitation(revokeInvitationCommand());

				const replay = await store.createInstanceInvitation(createInvitationCommand());
				expect(replay).toEqual({
					outcome: 'replayed',
					invitation: {
						id: INVITATION_ID,
						role: 'member',
						status: 'revoked',
						invitedByUserId: ACTOR_ID,
						createdAt: CREATED_AT,
						expiresAt: EXPIRES_AT,
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: '2026-09-13T12:00:00.000Z',
						revokedByUserId: ACTOR_ID
					}
				});
			} finally {
				sqlite.close();
			}
		});
	});

	describe('listInstanceInvitations', () => {
		it('allows active owner and admin to list invitations in newest-first order (created_at DESC, id DESC)', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				insertMember(sqlite, 'admin-1', 'admin');

				await store.createInstanceInvitation(
					createInvitationCommand({
						invitationId: INVITATION_ID,
						createdAt: '2026-09-12T10:00:00.000Z',
						expiresAt: '2026-09-19T10:00:00.000Z',
						tokenHash: '1'.repeat(64),
						idempotencyKey: 'list-c-1'
					})
				);
				await store.createInstanceInvitation(
					createInvitationCommand({
						invitationId: OTHER_INVITATION_ID,
						createdAt: '2026-09-12T11:00:00.000Z',
						expiresAt: '2026-09-19T11:00:00.000Z',
						tokenHash: '2'.repeat(64),
						idempotencyKey: 'list-c-2'
					})
				);

				const ownerList: ListInstanceInvitationsStoreResult = await store.listInstanceInvitations(
					{ type: 'user', id: ACTOR_ID },
					{ cursor: null, limit: 10 }
				);
				expect(ownerList.outcome).toBe('listed');
				if (ownerList.outcome !== 'listed') return;
				expect(ownerList.page.items).toHaveLength(2);
				expect(ownerList.page.items[0].id).toBe(OTHER_INVITATION_ID);
				expect(ownerList.page.items[1].id).toBe(INVITATION_ID);
				expect(ownerList.page.nextCursor).toBeNull();

				const adminList: ListInstanceInvitationsStoreResult = await store.listInstanceInvitations(
					{ type: 'user', id: 'admin-1' },
					{ cursor: null, limit: 10 }
				);
				expect(adminList.outcome).toBe('listed');
			} finally {
				sqlite.close();
			}
		});

		it('refuses role member or non-member with forbidden', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				insertMember(sqlite, 'regular-user', 'member');

				const memberRes = await store.listInstanceInvitations(
					{ type: 'user', id: 'regular-user' },
					{ cursor: null, limit: 10 }
				);
				expect(memberRes).toEqual({ outcome: 'forbidden' });

				const nonMemberRes = await store.listInstanceInvitations(
					{ type: 'user', id: 'ghost-user' },
					{ cursor: null, limit: 10 }
				);
				expect(nonMemberRes).toEqual({ outcome: 'forbidden' });
			} finally {
				sqlite.close();
			}
		});

		it('refuses suspended member with member_suspended', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				insertMember(sqlite, 'standby-owner-1', 'owner');
				sqlite.exec(
					`UPDATE instance_member SET status = 'suspended' WHERE user_id = '${ACTOR_ID}'`
				);

				const res = await store.listInstanceInvitations(
					{ type: 'user', id: ACTOR_ID },
					{ cursor: null, limit: 10 }
				);
				expect(res).toEqual({ outcome: 'member_suspended' });
			} finally {
				sqlite.close();
			}
		});

		it('paginates deterministically with keyset cursor and bounded limit', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				await store.createInstanceInvitation(
					createInvitationCommand({
						invitationId: INVITATION_ID,
						createdAt: '2026-09-12T10:00:00.000Z',
						expiresAt: '2026-09-19T10:00:00.000Z',
						tokenHash: '1'.repeat(64),
						idempotencyKey: 'p-1'
					})
				);
				await store.createInstanceInvitation(
					createInvitationCommand({
						invitationId: OTHER_INVITATION_ID,
						createdAt: '2026-09-12T11:00:00.000Z',
						expiresAt: '2026-09-19T11:00:00.000Z',
						tokenHash: '2'.repeat(64),
						idempotencyKey: 'p-2'
					})
				);
				await store.createInstanceInvitation(
					createInvitationCommand({
						invitationId: THIRD_INVITATION_ID,
						createdAt: '2026-09-12T12:00:00.000Z',
						expiresAt: '2026-09-19T12:00:00.000Z',
						tokenHash: '3'.repeat(64),
						idempotencyKey: 'p-3'
					})
				);

				const page1 = await store.listInstanceInvitations(
					{ type: 'user', id: ACTOR_ID },
					{ cursor: null, limit: 2 }
				);
				expect(page1.outcome).toBe('listed');
				if (page1.outcome !== 'listed') return;
				expect(page1.page.items).toHaveLength(2);
				expect(page1.page.items[0].id).toBe(THIRD_INVITATION_ID);
				expect(page1.page.items[1].id).toBe(OTHER_INVITATION_ID);
				expect(page1.page.nextCursor).toBe(OTHER_INVITATION_ID);

				const page2 = await store.listInstanceInvitations(
					{ type: 'user', id: ACTOR_ID },
					{ cursor: page1.page.nextCursor, limit: 2 }
				);
				expect(page2.outcome).toBe('listed');
				if (page2.outcome !== 'listed') return;
				expect(page2.page.items).toHaveLength(1);
				expect(page2.page.items[0].id).toBe(INVITATION_ID);
				expect(page2.page.nextCursor).toBeNull();
			} finally {
				sqlite.close();
			}
		});

		it('returns empty page for unknown valid cursor', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const res = await store.listInstanceInvitations(
					{ type: 'user', id: ACTOR_ID },
					{ cursor: '01900000-0000-7000-8000-000000000999', limit: 10 }
				);
				expect(res).toEqual({
					outcome: 'listed',
					page: { items: [], nextCursor: null }
				});
			} finally {
				sqlite.close();
			}
		});

		it('fails closed without DB leakage for malformed cursor', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const resOwner = await store.listInstanceInvitations(
					{ type: 'user', id: ACTOR_ID },
					{ cursor: 'malformed-cursor-not-uuid', limit: 10 }
				);
				expect(resOwner).toEqual({
					outcome: 'listed',
					page: { items: [], nextCursor: null }
				});

				const resNonMember = await store.listInstanceInvitations(
					{ type: 'user', id: 'ghost-user' },
					{ cursor: 'malformed-cursor-not-uuid', limit: 10 }
				);
				expect(resNonMember).toEqual({ outcome: 'forbidden' });

				insertMember(sqlite, 'standby-owner-1', 'owner');
				sqlite.exec(
					`UPDATE instance_member SET status = 'suspended' WHERE user_id = '${ACTOR_ID}'`
				);
				const resSuspended = await store.listInstanceInvitations(
					{ type: 'user', id: ACTOR_ID },
					{ cursor: 'malformed-cursor-not-uuid', limit: 10 }
				);
				expect(resSuspended).toEqual({ outcome: 'member_suspended' });
			} finally {
				sqlite.close();
			}
		});

		it('returns zero-PII metadata: no token_hash or email_binding exposed', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());

				const res = await store.listInstanceInvitations(
					{ type: 'user', id: ACTOR_ID },
					{ cursor: null, limit: 10 }
				);
				expect(res.outcome).toBe('listed');
				if (res.outcome !== 'listed') return;

				const item = res.page.items[0] as unknown as Record<string, unknown>;
				expect(item.token_hash).toBeUndefined();
				expect(item.tokenHash).toBeUndefined();
				expect(item.email_binding).toBeUndefined();
				expect(item.emailBinding).toBeUndefined();
				expect(item.email).toBeUndefined();
			} finally {
				sqlite.close();
			}
		});
	});

	describe('acceptInstanceInvitation', () => {
		it('atomically consumes pending unexpired invitation and enrolls new active member with invited role', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand({ role: 'admin' }));

				const result: AcceptInstanceInvitationStoreResult =
					await store.acceptInstanceInvitation(acceptInvitationCommand());
				expect(result).toEqual({
					outcome: 'accepted',
					invitation: {
						id: INVITATION_ID,
						role: 'admin',
						status: 'accepted',
						invitedByUserId: ACTOR_ID,
						createdAt: CREATED_AT,
						expiresAt: EXPIRES_AT,
						acceptedAt: '2026-09-13T12:00:00.000Z',
						acceptedByUserId: 'accepting-user-1',
						revokedAt: null,
						revokedByUserId: null
					},
					member: {
						userId: 'accepting-user-1',
						role: 'admin',
						status: 'active',
						createdAt: '2026-09-13T12:00:00.000Z',
						updatedAt: '2026-09-13T12:00:00.000Z'
					}
				});

				const member = sqlite
					.prepare('SELECT user_id, role, status FROM instance_member WHERE user_id = ?')
					.get('accepting-user-1') as { user_id: string; role: string; status: string };
				expect(member).toEqual({
					user_id: 'accepting-user-1',
					role: 'admin',
					status: 'active'
				});

				const inv = sqlite
					.prepare(
						'SELECT status, accepted_by_user_id, accepted_at FROM instance_invitation WHERE id = ?'
					)
					.get(INVITATION_ID) as {
					status: string;
					accepted_by_user_id: string;
					accepted_at: string;
				};
				expect(inv).toEqual({
					status: 'accepted',
					accepted_by_user_id: 'accepting-user-1',
					accepted_at: '2026-09-13T12:00:00.000Z'
				});

				const receipt = sqlite
					.prepare(
						'SELECT actor_type, actor_id, idempotency_key, command_type, request_hash, invitation_id, role, result_status FROM instance_invitation_command WHERE invitation_id = ? AND command_type = ?'
					)
					.get(INVITATION_ID, 'accept') as {
					actor_type: string;
					actor_id: string;
					idempotency_key: string;
					command_type: string;
					request_hash: string;
					invitation_id: string;
					role: string;
					result_status: string;
				};
				expect(receipt).toEqual({
					actor_type: 'user',
					actor_id: 'accepting-user-1',
					idempotency_key: 'invite-accept-key-1',
					command_type: 'accept',
					request_hash: REQUEST_FINGERPRINT,
					invitation_id: INVITATION_ID,
					role: 'admin',
					result_status: 'accepted'
				});
			} finally {
				sqlite.close();
			}
		});

		it('returns already_member, leaves a higher-role invitation pending, and writes zero accept receipts when an existing active member accepts', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				insertMember(sqlite, 'existing-admin', 'admin');
				await store.createInstanceInvitation(createInvitationCommand({ role: 'owner' }));

				const result = await store.acceptInstanceInvitation(
					acceptInvitationCommand({ actor: { type: 'user', id: 'existing-admin' } })
				);
				expect(result).toEqual({
					outcome: 'already_member',
					member: {
						userId: 'existing-admin',
						role: 'admin',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					}
				});

				const member = sqlite
					.prepare('SELECT role, status FROM instance_member WHERE user_id = ?')
					.get('existing-admin') as { role: string; status: string };
				expect(member).toEqual({ role: 'admin', status: 'active' });

				const inv = sqlite
					.prepare(
						'SELECT status, accepted_at, accepted_by_user_id FROM instance_invitation WHERE id = ?'
					)
					.get(INVITATION_ID) as {
					status: string;
					accepted_at: string | null;
					accepted_by_user_id: string | null;
				};
				expect(inv).toEqual({ status: 'pending', accepted_at: null, accepted_by_user_id: null });

				const receiptCount = sqlite
					.prepare(
						"SELECT COUNT(*) as count FROM instance_invitation_command WHERE command_type = 'accept'"
					)
					.get() as { count: number };
				expect(receiptCount.count).toBe(0);
			} finally {
				sqlite.close();
			}
		});

		it('refuses suspended member with member_suspended and does not consume invitation', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				insertMember(sqlite, 'suspended-user', 'member', 'suspended');
				await store.createInstanceInvitation(createInvitationCommand());

				const result = await store.acceptInstanceInvitation(
					acceptInvitationCommand({ actor: { type: 'user', id: 'suspended-user' } })
				);
				expect(result).toEqual({ outcome: 'member_suspended' });

				const inv = sqlite
					.prepare('SELECT status FROM instance_invitation WHERE id = ?')
					.get(INVITATION_ID) as { status: string };
				expect(inv.status).toBe('pending');
			} finally {
				sqlite.close();
			}
		});

		it('refuses invalid token_hash, wrong email_binding, expired, or terminal invitation with invitation_invalid', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());

				const wrongToken = await store.acceptInstanceInvitation(
					acceptInvitationCommand({ tokenHash: OTHER_TOKEN_HASH, idempotencyKey: 'acc-1' })
				);
				expect(wrongToken).toEqual({ outcome: 'invitation_invalid' });

				const wrongEmail = await store.acceptInstanceInvitation(
					acceptInvitationCommand({ emailBinding: OTHER_EMAIL_BINDING, idempotencyKey: 'acc-2' })
				);
				expect(wrongEmail).toEqual({ outcome: 'invitation_invalid' });

				const expired = await store.acceptInstanceInvitation(
					acceptInvitationCommand({
						acceptedAt: '2026-09-20T12:00:00.000Z',
						idempotencyKey: 'acc-3'
					})
				);
				expect(expired).toEqual({ outcome: 'invitation_invalid' });

				const beforeCreated = await store.acceptInstanceInvitation(
					acceptInvitationCommand({
						acceptedAt: '2026-09-11T12:00:00.000Z',
						idempotencyKey: 'acc-4'
					})
				);
				expect(beforeCreated).toEqual({ outcome: 'invitation_invalid' });
			} finally {
				sqlite.close();
			}
		});

		it('consumes exactly once: subsequent accept with different key returns invitation_invalid', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());

				const first = await store.acceptInstanceInvitation(acceptInvitationCommand());
				expect(first.outcome).toBe('accepted');

				const second = await store.acceptInstanceInvitation(
					acceptInvitationCommand({
						actor: { type: 'user', id: 'other-user' },
						idempotencyKey: 'second-accept-key'
					})
				);
				expect(second).toEqual({ outcome: 'invitation_invalid' });
			} finally {
				sqlite.close();
			}
		});

		it('safely replays an exact accept request under original idempotency key', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());

				const first = await store.acceptInstanceInvitation(acceptInvitationCommand());
				expect(first.outcome).toBe('accepted');

				const replay = await store.acceptInstanceInvitation(acceptInvitationCommand());
				expect(replay).toEqual({
					outcome: 'replayed',
					invitation: {
						id: INVITATION_ID,
						role: 'member',
						status: 'accepted',
						invitedByUserId: ACTOR_ID,
						createdAt: CREATED_AT,
						expiresAt: EXPIRES_AT,
						acceptedAt: '2026-09-13T12:00:00.000Z',
						acceptedByUserId: 'accepting-user-1',
						revokedAt: null,
						revokedByUserId: null
					},
					member: {
						userId: 'accepting-user-1',
						role: 'member',
						status: 'active',
						createdAt: '2026-09-13T12:00:00.000Z',
						updatedAt: '2026-09-13T12:00:00.000Z'
					}
				});
			} finally {
				sqlite.close();
			}
		});

		it('safely replays accept retry with newly minted acceptedAt comparing to receipt occurred_at', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());

				const first = await store.acceptInstanceInvitation(
					acceptInvitationCommand({ acceptedAt: '2026-09-13T12:00:00.000Z' })
				);
				expect(first.outcome).toBe('accepted');

				// Retry passes newer acceptedAt timestamp under same key and fingerprint
				const replay = await store.acceptInstanceInvitation(
					acceptInvitationCommand({ acceptedAt: '2026-09-13T12:10:00.000Z' })
				);
				expect(replay.outcome).toBe('replayed');
				if (replay.outcome === 'replayed') {
					expect(replay.invitation.acceptedAt).toBe('2026-09-13T12:00:00.000Z');
				}
			} finally {
				sqlite.close();
			}
		});

		it('rejects reused idempotency key with conflicting fingerprint', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());
				await store.acceptInstanceInvitation(acceptInvitationCommand());

				const conflict = await store.acceptInstanceInvitation(
					acceptInvitationCommand({ requestFingerprint: OTHER_REQUEST_FINGERPRINT })
				);
				expect(conflict).toEqual({ outcome: 'idempotency_conflict' });
			} finally {
				sqlite.close();
			}
		});

		it('refuses replay if accepted member is now suspended', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());
				await store.acceptInstanceInvitation(acceptInvitationCommand());

				sqlite.exec(
					"UPDATE instance_member SET status = 'suspended' WHERE user_id = 'accepting-user-1'"
				);

				const replay = await store.acceptInstanceInvitation(acceptInvitationCommand());
				expect(replay).toEqual({ outcome: 'member_suspended' });
			} finally {
				sqlite.close();
			}
		});

		it('detects receipt/member drift as integrity_error on replay', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());
				await store.acceptInstanceInvitation(acceptInvitationCommand());

				sqlite.exec(
					`UPDATE instance_invitation_command SET role = 'owner' WHERE invitation_id = '${INVITATION_ID}' AND command_type = 'accept'`
				);

				const replay = await store.acceptInstanceInvitation(acceptInvitationCommand());
				expect(replay).toEqual({ outcome: 'integrity_error' });
			} finally {
				sqlite.close();
			}
		});
	});

	describe('revokeInstanceInvitation', () => {
		it('atomically revokes pending invitation and writes command receipt for active owner', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());

				const result: RevokeInstanceInvitationStoreResult =
					await store.revokeInstanceInvitation(revokeInvitationCommand());
				expect(result).toEqual({
					outcome: 'revoked',
					invitation: {
						id: INVITATION_ID,
						role: 'member',
						status: 'revoked',
						invitedByUserId: ACTOR_ID,
						createdAt: CREATED_AT,
						expiresAt: EXPIRES_AT,
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: '2026-09-13T12:00:00.000Z',
						revokedByUserId: ACTOR_ID
					}
				});

				const inv = sqlite
					.prepare(
						'SELECT status, revoked_by_user_id, revoked_at FROM instance_invitation WHERE id = ?'
					)
					.get(INVITATION_ID) as { status: string; revoked_by_user_id: string; revoked_at: string };
				expect(inv).toEqual({
					status: 'revoked',
					revoked_by_user_id: ACTOR_ID,
					revoked_at: '2026-09-13T12:00:00.000Z'
				});

				const receipt = sqlite
					.prepare(
						'SELECT actor_type, actor_id, idempotency_key, command_type, request_hash, invitation_id, role, result_status FROM instance_invitation_command WHERE invitation_id = ? AND command_type = ?'
					)
					.get(INVITATION_ID, 'revoke') as {
					actor_type: string;
					actor_id: string;
					idempotency_key: string;
					command_type: string;
					request_hash: string;
					invitation_id: string;
					role: string;
					result_status: string;
				};
				expect(receipt).toEqual({
					actor_type: 'user',
					actor_id: ACTOR_ID,
					idempotency_key: 'invite-revoke-key-1',
					command_type: 'revoke',
					request_hash: REQUEST_FINGERPRINT,
					invitation_id: INVITATION_ID,
					role: 'member',
					result_status: 'revoked'
				});
			} finally {
				sqlite.close();
			}
		});

		it('allows active admin to revoke member invitation', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				insertMember(sqlite, 'admin-1', 'admin');
				await store.createInstanceInvitation(createInvitationCommand({ role: 'member' }));

				const res = await store.revokeInstanceInvitation(
					revokeInvitationCommand({ actor: { type: 'user', id: 'admin-1' } })
				);
				expect(res.outcome).toBe('revoked');
			} finally {
				sqlite.close();
			}
		});

		it('refuses active admin revoking owner or admin invitation with forbidden', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				insertMember(sqlite, 'admin-1', 'admin');

				await store.createInstanceInvitation(
					createInvitationCommand({
						invitationId: INVITATION_ID,
						role: 'owner',
						tokenHash: '1'.repeat(64),
						idempotencyKey: 'c-1'
					})
				);
				const resOwner = await store.revokeInstanceInvitation(
					revokeInvitationCommand({
						actor: { type: 'user', id: 'admin-1' },
						invitationId: INVITATION_ID,
						idempotencyKey: 'r-1'
					})
				);
				expect(resOwner).toEqual({ outcome: 'forbidden' });

				await store.createInstanceInvitation(
					createInvitationCommand({
						invitationId: OTHER_INVITATION_ID,
						role: 'admin',
						tokenHash: '2'.repeat(64),
						idempotencyKey: 'c-2'
					})
				);
				const resAdmin = await store.revokeInstanceInvitation(
					revokeInvitationCommand({
						actor: { type: 'user', id: 'admin-1' },
						invitationId: OTHER_INVITATION_ID,
						idempotencyKey: 'r-2'
					})
				);
				expect(resAdmin).toEqual({ outcome: 'forbidden' });
			} finally {
				sqlite.close();
			}
		});

		it('refuses role member or non-member with forbidden', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				insertMember(sqlite, 'member-1', 'member');
				await store.createInstanceInvitation(createInvitationCommand());

				const resMember = await store.revokeInstanceInvitation(
					revokeInvitationCommand({
						actor: { type: 'user', id: 'member-1' },
						idempotencyKey: 'rm-1'
					})
				);
				expect(resMember).toEqual({ outcome: 'forbidden' });

				const resGhost = await store.revokeInstanceInvitation(
					revokeInvitationCommand({
						actor: { type: 'user', id: 'ghost-user' },
						idempotencyKey: 'rg-1'
					})
				);
				expect(resGhost).toEqual({ outcome: 'forbidden' });
			} finally {
				sqlite.close();
			}
		});

		it('refuses suspended actor with member_suspended', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());
				insertMember(sqlite, 'standby-owner-1', 'owner');
				sqlite.exec(
					`UPDATE instance_member SET status = 'suspended' WHERE user_id = '${ACTOR_ID}'`
				);

				const res = await store.revokeInstanceInvitation(revokeInvitationCommand());
				expect(res).toEqual({ outcome: 'member_suspended' });
			} finally {
				sqlite.close();
			}
		});

		it('refuses revoking an already accepted or revoked invitation with invitation_invalid', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());

				await store.revokeInstanceInvitation(revokeInvitationCommand());

				const secondRevoke = await store.revokeInstanceInvitation(
					revokeInvitationCommand({ idempotencyKey: 'fresh-revoke-key' })
				);
				expect(secondRevoke).toEqual({ outcome: 'invitation_invalid' });

				await store.createInstanceInvitation(
					createInvitationCommand({
						invitationId: OTHER_INVITATION_ID,
						tokenHash: OTHER_TOKEN_HASH,
						idempotencyKey: 'c-other'
					})
				);
				await store.acceptInstanceInvitation(
					acceptInvitationCommand({ tokenHash: OTHER_TOKEN_HASH })
				);

				const revokeAccepted = await store.revokeInstanceInvitation(
					revokeInvitationCommand({
						invitationId: OTHER_INVITATION_ID,
						idempotencyKey: 'revoke-accepted'
					})
				);
				expect(revokeAccepted).toEqual({ outcome: 'invitation_invalid' });
			} finally {
				sqlite.close();
			}
		});

		it('refuses revoking an unknown invitation with invitation_invalid', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const res = await store.revokeInstanceInvitation(
					revokeInvitationCommand({ invitationId: '01900000-0000-7000-8000-000000000999' })
				);
				expect(res).toEqual({ outcome: 'invitation_invalid' });
			} finally {
				sqlite.close();
			}
		});

		it('safely replays an exact revoke request under original idempotency key', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());

				const first = await store.revokeInstanceInvitation(revokeInvitationCommand());
				expect(first.outcome).toBe('revoked');

				const replay = await store.revokeInstanceInvitation(revokeInvitationCommand());
				expect(replay).toEqual({
					outcome: 'replayed',
					invitation: {
						id: INVITATION_ID,
						role: 'member',
						status: 'revoked',
						invitedByUserId: ACTOR_ID,
						createdAt: CREATED_AT,
						expiresAt: EXPIRES_AT,
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: '2026-09-13T12:00:00.000Z',
						revokedByUserId: ACTOR_ID
					}
				});
			} finally {
				sqlite.close();
			}
		});

		it('safely replays revoke retry with newly minted revokedAt comparing to receipt occurred_at', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());

				const first = await store.revokeInstanceInvitation(
					revokeInvitationCommand({ revokedAt: '2026-09-13T12:00:00.000Z' })
				);
				expect(first.outcome).toBe('revoked');

				// Retry passes newer revokedAt timestamp under same key and fingerprint
				const replay = await store.revokeInstanceInvitation(
					revokeInvitationCommand({ revokedAt: '2026-09-13T12:10:00.000Z' })
				);
				expect(replay.outcome).toBe('replayed');
				if (replay.outcome === 'replayed') {
					expect(replay.invitation.revokedAt).toBe('2026-09-13T12:00:00.000Z');
				}
			} finally {
				sqlite.close();
			}
		});

		it('rejects reused idempotency key with conflicting fingerprint', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());
				await store.revokeInstanceInvitation(revokeInvitationCommand());

				const conflict = await store.revokeInstanceInvitation(
					revokeInvitationCommand({ requestFingerprint: OTHER_REQUEST_FINGERPRINT })
				);
				expect(conflict).toEqual({ outcome: 'idempotency_conflict' });
			} finally {
				sqlite.close();
			}
		});

		it('refuses replay if actor is now suspended', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());
				await store.revokeInstanceInvitation(revokeInvitationCommand());
				insertMember(sqlite, 'standby-owner-1', 'owner');

				sqlite.exec(
					`UPDATE instance_member SET status = 'suspended' WHERE user_id = '${ACTOR_ID}'`
				);

				const replay = await store.revokeInstanceInvitation(revokeInvitationCommand());
				expect(replay).toEqual({ outcome: 'member_suspended' });
			} finally {
				sqlite.close();
			}
		});

		it('detects receipt drift as integrity_error on replay', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());
				await store.revokeInstanceInvitation(revokeInvitationCommand());

				sqlite.exec(
					`UPDATE instance_invitation_command SET role = 'owner' WHERE invitation_id = '${INVITATION_ID}' AND command_type = 'revoke'`
				);

				const replay = await store.revokeInstanceInvitation(revokeInvitationCommand());
				expect(replay).toEqual({ outcome: 'integrity_error' });
			} finally {
				sqlite.close();
			}
		});
	});

	describe('atomicity and invariant rollback', () => {
		it('concurrent accepts on the same invitation: exactly one succeeds, other gets invitation_invalid without partial mutation', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());

				const [result1, result2] = await Promise.all([
					store.acceptInstanceInvitation(
						acceptInvitationCommand({
							actor: { type: 'user', id: 'concurrent-user-1' },
							idempotencyKey: 'conc-accept-1'
						})
					),
					store.acceptInstanceInvitation(
						acceptInvitationCommand({
							actor: { type: 'user', id: 'concurrent-user-2' },
							idempotencyKey: 'conc-accept-2'
						})
					)
				]);

				const outcomes = [result1.outcome, result2.outcome].sort();
				expect(outcomes).toEqual(['accepted', 'invitation_invalid']);

				const acceptedUserId =
					result1.outcome === 'accepted' ? 'concurrent-user-1' : 'concurrent-user-2';
				const rejectedUserId =
					result1.outcome === 'accepted' ? 'concurrent-user-2' : 'concurrent-user-1';

				const acceptedMember = sqlite
					.prepare('SELECT user_id, role, status FROM instance_member WHERE user_id = ?')
					.get(acceptedUserId) as { user_id: string; role: string; status: string } | undefined;
				expect(acceptedMember).toBeDefined();

				const rejectedMember = sqlite
					.prepare('SELECT user_id FROM instance_member WHERE user_id = ?')
					.get(rejectedUserId);
				expect(rejectedMember).toBeUndefined();

				const inv = sqlite
					.prepare('SELECT status, accepted_by_user_id FROM instance_invitation WHERE id = ?')
					.get(INVITATION_ID) as { status: string; accepted_by_user_id: string };
				expect(inv.status).toBe('accepted');
				expect(inv.accepted_by_user_id).toBe(acceptedUserId);
			} finally {
				sqlite.close();
			}
		});

		it('concurrently: a fresh actor accepts while an already-active member accepting the same invitation gets already_member, invitation stays consumed exactly once', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				insertMember(sqlite, 'existing-admin', 'admin');
				await store.createInstanceInvitation(createInvitationCommand({ role: 'owner' }));

				const [freshResult, existingResult] = await Promise.all([
					store.acceptInstanceInvitation(
						acceptInvitationCommand({
							actor: { type: 'user', id: 'fresh-acceptor' },
							idempotencyKey: 'conc-fresh-accept'
						})
					),
					store.acceptInstanceInvitation(
						acceptInvitationCommand({
							actor: { type: 'user', id: 'existing-admin' },
							idempotencyKey: 'conc-existing-accept'
						})
					)
				]);

				expect(freshResult.outcome).toBe('accepted');
				expect(existingResult).toEqual({
					outcome: 'already_member',
					member: {
						userId: 'existing-admin',
						role: 'admin',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					}
				});

				const inv = sqlite
					.prepare('SELECT status, accepted_by_user_id FROM instance_invitation WHERE id = ?')
					.get(INVITATION_ID) as { status: string; accepted_by_user_id: string };
				expect(inv.status).toBe('accepted');
				expect(inv.accepted_by_user_id).toBe('fresh-acceptor');

				const existingAdminRole = sqlite
					.prepare('SELECT role FROM instance_member WHERE user_id = ?')
					.get('existing-admin') as { role: string };
				expect(existingAdminRole.role).toBe('admin');

				const acceptReceiptCount = sqlite
					.prepare(
						"SELECT COUNT(*) as count FROM instance_invitation_command WHERE command_type = 'accept'"
					)
					.get() as { count: number };
				expect(acceptReceiptCount.count).toBe(1);
			} finally {
				sqlite.close();
			}
		});

		it('concurrently accepting two different pending invitations as the same previously-new actor consumes exactly one invitation', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(
					createInvitationCommand({
						invitationId: INVITATION_ID,
						tokenHash: TOKEN_HASH,
						emailBinding: EMAIL_BINDING,
						role: 'member',
						idempotencyKey: 'invite-create-key-1'
					})
				);
				await store.createInstanceInvitation(
					createInvitationCommand({
						invitationId: OTHER_INVITATION_ID,
						tokenHash: OTHER_TOKEN_HASH,
						emailBinding: OTHER_EMAIL_BINDING,
						role: 'admin',
						idempotencyKey: 'invite-create-key-2'
					})
				);

				const [result1, result2] = await Promise.all([
					store.acceptInstanceInvitation(
						acceptInvitationCommand({
							actor: { type: 'user', id: 'race-new-user' },
							idempotencyKey: 'race-accept-1',
							tokenHash: TOKEN_HASH,
							emailBinding: EMAIL_BINDING
						})
					),
					store.acceptInstanceInvitation(
						acceptInvitationCommand({
							actor: { type: 'user', id: 'race-new-user' },
							idempotencyKey: 'race-accept-2',
							tokenHash: OTHER_TOKEN_HASH,
							emailBinding: OTHER_EMAIL_BINDING
						})
					)
				]);

				const outcomes = [result1.outcome, result2.outcome].sort();
				expect(outcomes).toEqual(['accepted', 'already_member']);

				const memberRows = sqlite
					.prepare('SELECT user_id, role, status FROM instance_member WHERE user_id = ?')
					.all('race-new-user') as { user_id: string; role: string; status: string }[];
				expect(memberRows).toHaveLength(1);
				const wonRole = memberRows[0].role;
				expect(['member', 'admin']).toContain(wonRole);

				const winningInvitationId = wonRole === 'member' ? INVITATION_ID : OTHER_INVITATION_ID;
				const losingInvitationId = wonRole === 'member' ? OTHER_INVITATION_ID : INVITATION_ID;

				const winningInv = sqlite
					.prepare('SELECT status, accepted_by_user_id FROM instance_invitation WHERE id = ?')
					.get(winningInvitationId) as { status: string; accepted_by_user_id: string };
				expect(winningInv.status).toBe('accepted');
				expect(winningInv.accepted_by_user_id).toBe('race-new-user');

				// The losing invitation must remain pending and unconsumed.
				const losingInv = sqlite
					.prepare(
						'SELECT status, accepted_at, accepted_by_user_id FROM instance_invitation WHERE id = ?'
					)
					.get(losingInvitationId) as {
					status: string;
					accepted_at: string | null;
					accepted_by_user_id: string | null;
				};
				expect(losingInv.status).toBe('pending');
				expect(losingInv.accepted_at).toBeNull();
				expect(losingInv.accepted_by_user_id).toBeNull();

				const acceptReceipts = sqlite
					.prepare(
						"SELECT invitation_id FROM instance_invitation_command WHERE command_type = 'accept'"
					)
					.all() as { invitation_id: string }[];
				expect(acceptReceipts).toEqual([{ invitation_id: winningInvitationId }]);
			} finally {
				sqlite.close();
			}
		});

		it('does not enroll a member when the invitation is revoked between the accept gate and the mutation batch', async () => {
			const { store, sqlite, armBatchHook } = createHookedFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				await store.createInstanceInvitation(createInvitationCommand());

				// Batch 0 is accept's read-only gate, batch 1 its mutation batch.
				// Landing a revoke in between is the interleaving that makes the
				// invitation UPDATE match zero rows while every other statement in
				// the batch would still have run happily.
				armBatchHook((batchIndex: number): void => {
					if (batchIndex !== 1) return;
					sqlite.exec(
						`UPDATE instance_invitation
						 SET status = 'revoked',
						     revoked_at = '2026-09-13T11:00:00.000Z',
						     revoked_by_user_id = '${ACTOR_ID}'
						 WHERE id = '${INVITATION_ID}'`
					);
				});

				const result: AcceptInstanceInvitationStoreResult = await store.acceptInstanceInvitation(
					acceptInvitationCommand({
						actor: { type: 'user', id: 'stale-accept-user' },
						idempotencyKey: 'stale-accept-key'
					})
				);
				expect(result).toEqual({ outcome: 'invitation_invalid' });

				// The whole point: no membership may exist without an accepted
				// invitation behind it.
				const memberRows = sqlite
					.prepare('SELECT user_id FROM instance_member WHERE user_id = ?')
					.all('stale-accept-user') as { user_id: string }[];
				expect(memberRows).toHaveLength(0);

				const invitation = sqlite
					.prepare(
						'SELECT status, accepted_at, accepted_by_user_id FROM instance_invitation WHERE id = ?'
					)
					.get(INVITATION_ID) as {
					status: string;
					accepted_at: string | null;
					accepted_by_user_id: string | null;
				};
				expect(invitation.status).toBe('revoked');
				expect(invitation.accepted_at).toBeNull();
				expect(invitation.accepted_by_user_id).toBeNull();

				const acceptReceipts = sqlite
					.prepare(
						"SELECT COUNT(*) AS count FROM instance_invitation_command WHERE command_type = 'accept'"
					)
					.get() as { count: number };
				expect(acceptReceipts.count).toBe(0);
			} finally {
				sqlite.close();
			}
		});

		it('concurrent same-key creation with different candidate values resolves created+replayed without orphan invitations', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const cmd1 = createInvitationCommand({
					invitationId: INVITATION_ID,
					tokenHash: TOKEN_HASH,
					emailBinding: EMAIL_BINDING,
					createdAt: CREATED_AT,
					expiresAt: EXPIRES_AT
				});
				const cmd2 = createInvitationCommand({
					invitationId: OTHER_INVITATION_ID,
					tokenHash: 'c'.repeat(64),
					emailBinding: 'd'.repeat(64),
					createdAt: '2026-09-12T12:00:01.000Z',
					expiresAt: '2026-09-19T12:00:01.000Z'
				});

				const [res1, res2] = await Promise.all([
					store.createInstanceInvitation(cmd1),
					store.createInstanceInvitation(cmd2)
				]);

				const outcomes = [res1.outcome, res2.outcome].sort();
				expect(outcomes).toEqual(['created', 'replayed']);

				const createdResult = res1.outcome === 'created' ? res1 : res2;
				const replayedResult = res1.outcome === 'replayed' ? res1 : res2;

				if (createdResult.outcome === 'created' && replayedResult.outcome === 'replayed') {
					expect(replayedResult.invitation.id).toBe(createdResult.invitation.id);
					expect(replayedResult.invitation.createdAt).toBe(createdResult.invitation.createdAt);
				}

				// Only one invitation is stored in the database, no orphan rows
				const invitations = sqlite.prepare('SELECT id, status FROM instance_invitation').all() as {
					id: string;
					status: string;
				}[];
				expect(invitations).toHaveLength(1);

				const commands = sqlite
					.prepare('SELECT invitation_id, idempotency_key FROM instance_invitation_command')
					.all() as { invitation_id: string; idempotency_key: string }[];
				expect(commands).toHaveLength(1);
			} finally {
				sqlite.close();
			}
		});
	});
});
