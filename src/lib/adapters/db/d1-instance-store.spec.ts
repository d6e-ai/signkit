import { describe, expect, it, vi } from 'vitest';
import type {
	AcceptInstanceInvitationCommand,
	CreateInstanceInvitationCommand,
	InstanceInvitationListQuery,
	InstanceMemberListQuery,
	RevokeInstanceInvitationCommand,
	SetInstanceMemberRoleCommand,
	SetInstanceMemberStatusCommand
} from '$lib/ports/instance-store';
import * as bearerSecret from '$lib/security/bearer-secret';
import { D1InstanceStore } from './d1-instance-store';

interface RecordedStatement {
	sql: string;
	bindings: readonly unknown[];
	statement: D1PreparedStatement;
}

interface FakeD1Options {
	batchResults?:
		| readonly unknown[][]
		| ((batchIndex: number, statements: D1PreparedStatement[]) => readonly unknown[][]);
	batchChanges?: (batchIndex: number, statementIndex: number) => number;
	firstResult?: unknown | null | ((sql: string, bindings: readonly unknown[]) => unknown | null);
	batchError?: Error | ((batchIndex: number) => Error | undefined);
}

function fakeD1(options: FakeD1Options = {}) {
	const prepared: RecordedStatement[] = [];
	const batches: RecordedStatement[][] = [];
	const prepare = vi.fn((sql: string): D1PreparedStatement => {
		const record: RecordedStatement = { sql, bindings: [], statement: undefined as never };
		const statement = {
			bind: (...bindings: unknown[]): D1PreparedStatement => {
				record.bindings = bindings;
				return statement;
			},
			run: async (): Promise<{ meta: { changes: number } }> => ({
				meta: { changes: 1 }
			}),
			first: async (): Promise<unknown | null> => {
				if (typeof options.firstResult === 'function') {
					return options.firstResult(record.sql, record.bindings);
				}
				return options.firstResult ?? null;
			},
			all: async (): Promise<{ results: unknown[] }> => ({
				results: []
			})
		} as unknown as D1PreparedStatement;
		record.statement = statement;
		prepared.push(record);
		return statement;
	});
	const batch = vi.fn(
		async (
			statements: D1PreparedStatement[]
		): Promise<{ meta: { changes: number }; results: unknown[] }[]> => {
			const records: RecordedStatement[] = statements.map((statement) =>
				prepared.find((item) => item.statement === statement)!
			);
			const batchIndex: number = batches.length;
			batches.push(records);
			if (typeof options.batchError === 'function') {
				const error = options.batchError(batchIndex);
				if (error !== undefined) throw error;
			} else if (options.batchError !== undefined) {
				throw options.batchError;
			}
			const resolvedBatchResults =
				typeof options.batchResults === 'function'
					? options.batchResults(batchIndex, statements)
					: options.batchResults;
			return statements.map((_, index: number) => ({
				meta: {
					changes: options.batchChanges !== undefined ? options.batchChanges(batchIndex, index) : 1
				},
				results: (resolvedBatchResults?.[index] ?? []) as unknown[]
			}));
		}
	);
	return { database: { prepare, batch } as unknown as D1Database, prepared, batches };
}

const OWNER_ID: string = 'user-owner-1';
const INVITATION_ID: string = '01900000-0000-7000-8000-000000000001';
const TOKEN_HASH: string = 'a'.repeat(64);
const EMAIL_BINDING: string = 'b'.repeat(64);
const REQUEST_FINGERPRINT: string = 'c'.repeat(64);
const CREATED_AT: string = '2026-09-12T12:00:00.000Z';
const EXPIRES_AT: string = '2026-09-19T12:00:00.000Z';

const createCommand: CreateInstanceInvitationCommand = {
	actor: { type: 'user', id: OWNER_ID },
	idempotencyKey: 'create-idem-1',
	requestFingerprint: REQUEST_FINGERPRINT,
	invitationId: INVITATION_ID,
	role: 'member',
	tokenHash: TOKEN_HASH,
	emailBinding: EMAIL_BINDING,
	createdAt: CREATED_AT,
	expiresAt: EXPIRES_AT
};

const acceptCommand: AcceptInstanceInvitationCommand = {
	actor: { type: 'user', id: 'accepting-user-1' },
	idempotencyKey: 'accept-idem-1',
	requestFingerprint: REQUEST_FINGERPRINT,
	tokenHash: TOKEN_HASH,
	emailBinding: EMAIL_BINDING,
	acceptedAt: '2026-09-13T12:00:00.000Z'
};

const revokeCommand: RevokeInstanceInvitationCommand = {
	actor: { type: 'user', id: OWNER_ID },
	idempotencyKey: 'revoke-idem-1',
	requestFingerprint: REQUEST_FINGERPRINT,
	invitationId: INVITATION_ID,
	revokedAt: '2026-09-13T12:00:00.000Z'
};

describe('D1InstanceStore unit tests', () => {
	describe('createInstanceInvitation', () => {
		it('prepares single batch of invitation insert and command receipt when gate passes', async () => {
			const fake = fakeD1({
				batchResults: [
					[{ role: 'owner', status: 'active' }], // member
					[], // receipt
					[{ count: 0 }] // pending count
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.createInstanceInvitation(createCommand);
			expect(result.outcome).toBe('created');
			expect(fake.batches).toHaveLength(2); // batch 0: gate, batch 1: mutations

			const mutationBatch = fake.batches[1];
			expect(mutationBatch).toHaveLength(2);
			expect(mutationBatch[0].sql).toContain('INSERT INTO instance_invitation');
			expect(mutationBatch[0].bindings).toEqual([
				INVITATION_ID,
				'member',
				TOKEN_HASH,
				EMAIL_BINDING,
				OWNER_ID,
				CREATED_AT,
				EXPIRES_AT
			]);
			expect(mutationBatch[1].sql).toContain('INSERT INTO instance_invitation_command');
			expect(mutationBatch[1].bindings).toEqual([
				OWNER_ID,
				'create-idem-1',
				REQUEST_FINGERPRINT,
				INVITATION_ID,
				'member',
				CREATED_AT
			]);
		});

		it('refuses create immediately at gate when actor is suspended', async () => {
			const fake = fakeD1({
				batchResults: [[{ role: 'owner', status: 'suspended' }], [], [{ count: 0 }]]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.createInstanceInvitation(createCommand);
			expect(result).toEqual({ outcome: 'member_suspended' });
			expect(fake.batches).toHaveLength(1); // gate only, no mutations
		});

		it('refuses create immediately at gate when actor is admin inviting owner', async () => {
			const fake = fakeD1({
				batchResults: [[{ role: 'admin', status: 'active' }], [], [{ count: 0 }]]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.createInstanceInvitation({
				...createCommand,
				role: 'owner'
			});
			expect(result).toEqual({ outcome: 'role_not_permitted' });
			expect(fake.batches).toHaveLength(1);
		});

		it('refuses create immediately at gate when pending count is 200', async () => {
			const fake = fakeD1({
				batchResults: [[{ role: 'owner', status: 'active' }], [], [{ count: 200 }]]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.createInstanceInvitation(createCommand);
			expect(result).toEqual({ outcome: 'limit' });
			expect(fake.batches).toHaveLength(1);
			expect(fake.batches[0][2].sql).toContain('expires_at > ?');
			expect(fake.batches[0][2].bindings).toEqual([CREATED_AT]);
		});

		it('proves 200 expired pending invitations do not block a new create, while 200 live pending returns limit', async () => {
			// When expired pending invitations exist, live-pending count query returns 0
			const fakeExpired = fakeD1({
				batchResults: [
					[{ role: 'owner', status: 'active' }], // member
					[], // receipt
					[{ count: 0 }] // live pending count is 0 because 200 expired are filtered out
				]
			});
			const storeExpired = new D1InstanceStore(fakeExpired.database);
			const allowedResult = await storeExpired.createInstanceInvitation(createCommand);
			expect(allowedResult.outcome).toBe('created');
			expect(fakeExpired.batches).toHaveLength(2);
			expect(fakeExpired.batches[0][2].sql).toContain('expires_at > ?');
			expect(fakeExpired.batches[0][2].bindings).toEqual([CREATED_AT]);

			// When 200 live pending invitations exist, live-pending count returns 200 -> limit
			const fakeLive = fakeD1({
				batchResults: [[{ role: 'owner', status: 'active' }], [], [{ count: 200 }]]
			});
			const storeLive = new D1InstanceStore(fakeLive.database);
			const limitResult = await storeLive.createInstanceInvitation(createCommand);
			expect(limitResult).toEqual({ outcome: 'limit' });
			expect(fakeLive.batches).toHaveLength(1);
			expect(fakeLive.batches[0][2].sql).toContain('expires_at > ?');
			expect(fakeLive.batches[0][2].bindings).toEqual([CREATED_AT]);
		});

		it('classifies candidate invitationId collision as credential_collision when batch fails', async () => {
			const fake = fakeD1({
				batchResults: [
					[{ role: 'owner', status: 'active' }], // member (gate)
					[], // receipt
					[{ count: 0 }] // pending count
				],
				batchError: (batchIndex: number) =>
					batchIndex === 1
						? new Error('D1_ERROR: UNIQUE constraint failed: instance_invitation.id')
						: undefined,
				firstResult: (sql: string) => (sql.includes('WHERE id = ?') ? { 1: 1 } : null)
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.createInstanceInvitation(createCommand);
			expect(result).toEqual({ outcome: 'credential_collision' });
		});

		it('classifies candidate tokenHash collision as credential_collision when batch fails', async () => {
			const fake = fakeD1({
				batchResults: [
					[{ role: 'owner', status: 'active' }], // member (gate)
					[], // receipt
					[{ count: 0 }] // pending count
				],
				batchError: (batchIndex: number) =>
					batchIndex === 1
						? new Error('D1_ERROR: UNIQUE constraint failed: instance_invitation.token_hash')
						: undefined,
				firstResult: (sql: string) => (sql.includes('WHERE token_hash = ?') ? { 1: 1 } : null)
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.createInstanceInvitation(createCommand);
			expect(result).toEqual({ outcome: 'credential_collision' });
		});

		it('re-throws unknown batch error when no collision exists during classification', async () => {
			const fake = fakeD1({
				batchResults: [
					[{ role: 'owner', status: 'active' }], // member (gate)
					[], // receipt
					[{ count: 0 }] // pending count
				],
				batchError: (batchIndex: number) =>
					batchIndex === 1 ? new Error('D1_ERROR: storage write failure') : undefined,
				firstResult: () => null
			});
			const store = new D1InstanceStore(fake.database);

			await expect(store.createInstanceInvitation(createCommand)).rejects.toThrow(
				'D1_ERROR: storage write failure'
			);
		});
	});

	describe('listInstanceInvitations', () => {
		it('bounds limit and executes member check and page in one batch', async () => {
			const fake = fakeD1({
				batchResults: [[{ role: 'owner', status: 'active' }], []]
			});
			const store = new D1InstanceStore(fake.database);

			const query: InstanceInvitationListQuery = { cursor: null, limit: 200 };
			const result = await store.listInstanceInvitations({ type: 'user', id: OWNER_ID }, query);
			expect(result.outcome).toBe('listed');
			expect(fake.batches).toHaveLength(1);

			const batch = fake.batches[0];
			expect(batch).toHaveLength(2);
			expect(batch[0].sql).toContain('SELECT role, status FROM instance_member');
			expect(batch[1].sql).toContain('SELECT id, role, status');
			expect(batch[1].sql).toContain('LIMIT ?');
			// Bounded to 100 + 1 = 101
			expect(batch[1].bindings).toEqual([101]);
		});

		it('fails closed on malformed cursor without executing page query', async () => {
			const fake = fakeD1({
				firstResult: { role: 'owner', status: 'active' }
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.listInstanceInvitations(
				{ type: 'user', id: OWNER_ID },
				{ cursor: 'not-a-uuid-cursor', limit: 10 }
			);
			expect(result).toEqual({
				outcome: 'listed',
				page: { items: [], nextCursor: null }
			});
			// No batch was executed, only single statement check on member
			expect(fake.batches).toHaveLength(0);
		});
	});

	describe('acceptInstanceInvitation', () => {
		it('prepares a 3-statement atomic batch whose member insert and invitation update carry the same invitation predicate and a no-other-accepted-invitation guard', async () => {
			const fake = fakeD1({
				firstResult: {
					user_id: 'accepting-user-1',
					role: 'member',
					status: 'active',
					created_at: '2026-09-13T12:00:00.000Z',
					updated_at: '2026-09-13T12:00:00.000Z'
				},
				batchResults: [
					[], // receipt
					[], // member
					[
						{
							id: INVITATION_ID,
							role: 'member',
							status: 'pending',
							email_binding: EMAIL_BINDING,
							invited_by_user_id: OWNER_ID,
							created_at: CREATED_AT,
							expires_at: EXPIRES_AT,
							accepted_at: null,
							accepted_by_user_id: null,
							revoked_at: null,
							revoked_by_user_id: null
						}
					] // invitation
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.acceptInstanceInvitation(acceptCommand);
			expect(result.outcome).toBe('accepted');

			const mutationBatch = fake.batches[1];
			expect(mutationBatch).toHaveLength(3);
			// instance_invitation.accepted_by_user_id is a foreign key into
			// instance_member, so the member row has to be written first. The
			// insert therefore has to re-check the invitation itself rather than
			// trust the gate snapshot, and must refuse to enroll an actor who
			// already consumed another invitation.
			expect(mutationBatch[0].sql).toContain('INSERT INTO instance_member');
			expect(mutationBatch[0].sql).toContain('FROM instance_invitation invitation');
			expect(mutationBatch[0].sql).toContain("invitation.status = 'pending'");
			expect(mutationBatch[0].sql).toContain('invitation.token_hash = ?');
			expect(mutationBatch[0].sql).toContain('invitation.email_binding = ?');
			expect(mutationBatch[0].sql).toContain(
				"WHERE consumed.accepted_by_user_id = ? AND consumed.status = 'accepted'"
			);
			expect(mutationBatch[0].sql).toContain('ON CONFLICT (user_id) DO NOTHING');
			expect(mutationBatch[0].bindings[3]).toBe(INVITATION_ID);

			// The update is causally tied to that insert by EXISTS, and carries the
			// same no-other-accepted-invitation guard.
			expect(mutationBatch[1].sql).toContain('UPDATE instance_invitation');
			expect(mutationBatch[1].sql).toContain("status = 'accepted'");
			expect(mutationBatch[1].sql).toContain(
				"SELECT 1 FROM instance_member WHERE user_id = ? AND status = 'active'"
			);
			expect(mutationBatch[1].sql).toContain(
				"WHERE consumed.accepted_by_user_id = ? AND consumed.status = 'accepted'"
			);
			expect(mutationBatch[1].bindings[2]).toBe(INVITATION_ID);

			// The receipt stays unconditional so the accept-evidence trigger can
			// abort — and therefore roll back — a batch whose update matched no rows.
			expect(mutationBatch[2].sql).toContain('INSERT INTO instance_invitation_command');
			expect(mutationBatch[2].sql).toContain("'accept'");
			expect(mutationBatch[2].sql).toContain('VALUES');
			expect(mutationBatch[2].bindings[3]).toBe(INVITATION_ID);
		});

		it('treats a batch where the member insert landed but the invitation update did not as unapplied', async () => {
			const invitationRow = {
				id: INVITATION_ID,
				role: 'member',
				status: 'pending',
				email_binding: EMAIL_BINDING,
				invited_by_user_id: OWNER_ID,
				created_at: CREATED_AT,
				expires_at: EXPIRES_AT,
				accepted_at: null,
				accepted_by_user_id: null,
				revoked_at: null,
				revoked_by_user_id: null
			};
			const fake = fakeD1({
				batchResults: (batchIndex: number) =>
					batchIndex === 1 ? [[], [], []] : [[], [], [invitationRow]],
				batchChanges: (batchIndex: number, statementIndex: number) =>
					// Mutation batch: the invitation update matched zero rows.
					batchIndex === 1 && statementIndex === 1 ? 0 : 1
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.acceptInstanceInvitation(acceptCommand);

			// Falls through to classification instead of reporting a phantom accept.
			// Against a real database the unconditional receipt insert would have
			// aborted this batch outright; the check on every statement's change
			// count is the adapter-side backstop for that.
			expect(result).toEqual({ outcome: 'integrity_error' });
			expect(fake.batches).toHaveLength(3);
		});

		it('returns already_member without locking or mutating the invitation when actor is already an active member', async () => {
			const fake = fakeD1({
				batchResults: [
					[], // receipt: none
					[
						{
							user_id: 'accepting-user-1',
							role: 'admin',
							status: 'active',
							created_at: '2026-09-01T00:00:00.000Z',
							updated_at: '2026-09-01T00:00:00.000Z'
						}
					], // member: already active
					[
						{
							id: INVITATION_ID,
							role: 'owner',
							status: 'pending',
							email_binding: EMAIL_BINDING,
							invited_by_user_id: OWNER_ID,
							created_at: CREATED_AT,
							expires_at: EXPIRES_AT,
							accepted_at: null,
							accepted_by_user_id: null,
							revoked_at: null,
							revoked_by_user_id: null
						}
					] // invitation: pending, invites a higher role
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.acceptInstanceInvitation(acceptCommand);
			expect(result).toEqual({
				outcome: 'already_member',
				member: {
					userId: 'accepting-user-1',
					role: 'admin',
					status: 'active',
					createdAt: '2026-09-01T00:00:00.000Z',
					updatedAt: '2026-09-01T00:00:00.000Z'
				}
			});
			// Gate batch only: no member/invitation mutation or receipt batch was ever run.
			expect(fake.batches).toHaveLength(1);
		});

		it('refuses accept when asserted email binding does not match and proves secretsEqual async flow', async () => {
			const secretsEqualSpy = vi.spyOn(bearerSecret, 'secretsEqual');
			const fake = fakeD1({
				batchResults: [
					[],
					[],
					[
						{
							id: INVITATION_ID,
							role: 'member',
							status: 'pending',
							email_binding: 'wrong-binding'.padStart(64, '0'),
							invited_by_user_id: OWNER_ID,
							created_at: CREATED_AT,
							expires_at: EXPIRES_AT
						}
					]
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.acceptInstanceInvitation(acceptCommand);
			expect(result).toEqual({ outcome: 'invitation_invalid' });
			expect(fake.batches).toHaveLength(1); // Gate check only
			expect(secretsEqualSpy).toHaveBeenCalledWith(
				acceptCommand.emailBinding,
				'wrong-binding'.padStart(64, '0')
			);
			// Verify token_hash lookup query was not weakened
			expect(fake.batches[0][2].sql).toContain('WHERE token_hash = ?');
			expect(fake.batches[0][2].bindings).toEqual([TOKEN_HASH]);
			secretsEqualSpy.mockRestore();
		});

		it('proves secretsEqual async resolution correctly gates accept outcome', async () => {
			let asyncEvaluated = false;
			const secretsEqualSpy = vi
				.spyOn(bearerSecret, 'secretsEqual')
				.mockImplementation(async () => {
					await new Promise((resolve) => queueMicrotask(resolve));
					asyncEvaluated = true;
					return false;
				});

			const fake = fakeD1({
				batchResults: [
					[],
					[],
					[
						{
							id: INVITATION_ID,
							role: 'member',
							status: 'pending',
							email_binding: 'wrong-binding'.padStart(64, '0'),
							invited_by_user_id: OWNER_ID,
							created_at: CREATED_AT,
							expires_at: EXPIRES_AT
						}
					]
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.acceptInstanceInvitation(acceptCommand);
			expect(result).toEqual({ outcome: 'invitation_invalid' });
			expect(asyncEvaluated).toBe(true);
			expect(fake.batches).toHaveLength(1);
			secretsEqualSpy.mockRestore();
		});

		it('classifies mutation failure as invitation_invalid via secretsEqual when email binding differs in classification path', async () => {
			const secretsEqualSpy = vi.spyOn(bearerSecret, 'secretsEqual');
			const wrongBinding = 'different-binding'.padStart(64, '0');
			const fake = fakeD1({
				batchResults: (batchIndex: number) => {
					if (batchIndex === 0) {
						// Batch 0: gate check passes
						return [
							[],
							[],
							[
								{
									id: INVITATION_ID,
									role: 'member',
									status: 'pending',
									email_binding: EMAIL_BINDING,
									invited_by_user_id: OWNER_ID,
									created_at: CREATED_AT,
									expires_at: EXPIRES_AT
								}
							]
						];
					}
					if (batchIndex === 1) {
						// Batch 1: mutation applied = false
						return [[], [], []];
					}
					// Batch 2: classifyAcceptFailure gate check re-reads invitation with changed email binding
					return [
						[],
						[],
						[
							{
								id: INVITATION_ID,
								role: 'member',
								status: 'pending',
								email_binding: wrongBinding,
								invited_by_user_id: OWNER_ID,
								created_at: CREATED_AT,
								expires_at: EXPIRES_AT
							}
						]
					];
				},
				batchChanges: (batchIndex: number, statementIndex: number) => {
					// In batch 1 (mutations), the invitation update changed 0 rows
					if (batchIndex === 1 && statementIndex === 1) return 0;
					return 1;
				}
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.acceptInstanceInvitation(acceptCommand);
			expect(result).toEqual({ outcome: 'invitation_invalid' });
			expect(secretsEqualSpy).toHaveBeenCalledWith(acceptCommand.emailBinding, wrongBinding);
			secretsEqualSpy.mockRestore();
		});
	});

	describe('revokeInstanceInvitation', () => {
		it('prepares 2-statement atomic batch: invitation update and receipt insert', async () => {
			const fake = fakeD1({
				batchResults: [
					[{ role: 'owner', status: 'active' }], // member
					[], // receipt
					[
						{
							id: INVITATION_ID,
							role: 'member',
							status: 'pending',
							invited_by_user_id: OWNER_ID,
							created_at: CREATED_AT,
							expires_at: EXPIRES_AT
						}
					] // invitation
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.revokeInstanceInvitation(revokeCommand);
			expect(result.outcome).toBe('revoked');

			const mutationBatch = fake.batches[1];
			expect(mutationBatch).toHaveLength(2);
			expect(mutationBatch[0].sql).toContain('UPDATE instance_invitation');
			expect(mutationBatch[0].sql).toContain("status = 'revoked'");
			expect(mutationBatch[1].sql).toContain('INSERT INTO instance_invitation_command');
			expect(mutationBatch[1].sql).toContain("'revoke'");
			expect(mutationBatch[1].bindings[3]).toBe(INVITATION_ID);
		});

		it('refuses revoke when admin tries to revoke owner invitation', async () => {
			const fake = fakeD1({
				batchResults: [
					[{ role: 'admin', status: 'active' }], // member
					[], // receipt
					[
						{
							id: INVITATION_ID,
							role: 'owner',
							status: 'pending',
							invited_by_user_id: OWNER_ID,
							created_at: CREATED_AT,
							expires_at: EXPIRES_AT
						}
					] // invitation
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.revokeInstanceInvitation({
				...revokeCommand,
				actor: { type: 'user', id: 'admin-1' }
			});
			expect(result).toEqual({ outcome: 'forbidden' });
			expect(fake.batches).toHaveLength(1);
		});
	});

	describe('listInstanceMembers', () => {
		it('bounds limit and executes member check and page ordered by user_id in one batch', async () => {
			const fake = fakeD1({
				batchResults: [[{ role: 'owner', status: 'active' }], []]
			});
			const store = new D1InstanceStore(fake.database);

			const query: InstanceMemberListQuery = { cursor: null, limit: 500 };
			const result = await store.listInstanceMembers({ type: 'user', id: OWNER_ID }, query);
			expect(result.outcome).toBe('listed');
			expect(fake.batches).toHaveLength(1);

			const batch = fake.batches[0];
			expect(batch).toHaveLength(2);
			expect(batch[0].sql).toContain('SELECT role, status FROM instance_member');
			expect(batch[1].sql).toContain('ORDER BY user_id ASC');
			expect(batch[1].sql).not.toContain('WHERE user_id >');
			// Bounded to 100 + 1 = 101
			expect(batch[1].bindings).toEqual([101]);
		});

		it('uses a direct user_id keyset predicate when a cursor is supplied', async () => {
			const fake = fakeD1({
				batchResults: [[{ role: 'admin', status: 'active' }], []]
			});
			const store = new D1InstanceStore(fake.database);

			await store.listInstanceMembers(
				{ type: 'user', id: OWNER_ID },
				{ cursor: 'user-abc', limit: 10 }
			);
			const batch = fake.batches[0];
			expect(batch[1].sql).toContain('WHERE user_id > ?');
			expect(batch[1].bindings).toEqual(['user-abc', 11]);
		});

		it('refuses list for a member-role or unknown actor with forbidden', async () => {
			const fake = fakeD1({ batchResults: [[{ role: 'member', status: 'active' }], []] });
			const store = new D1InstanceStore(fake.database);

			const result = await store.listInstanceMembers(
				{ type: 'user', id: OWNER_ID },
				{ cursor: null, limit: 10 }
			);
			expect(result).toEqual({ outcome: 'forbidden' });
		});

		it('refuses list for a suspended actor with member_suspended', async () => {
			const fake = fakeD1({ batchResults: [[{ role: 'owner', status: 'suspended' }], []] });
			const store = new D1InstanceStore(fake.database);

			const result = await store.listInstanceMembers(
				{ type: 'user', id: OWNER_ID },
				{ cursor: null, limit: 10 }
			);
			expect(result).toEqual({ outcome: 'member_suspended' });
		});
	});

	describe('setInstanceMemberRole', () => {
		const TARGET_ID: string = 'target-admin-1';
		const UPDATED_AT: string = '2026-09-13T12:00:00.000Z';
		const setRoleCommand: SetInstanceMemberRoleCommand = {
			actor: { type: 'user', id: OWNER_ID },
			idempotencyKey: 'role-idem-1',
			requestFingerprint: REQUEST_FINGERPRINT,
			targetUserId: TARGET_ID,
			role: 'member',
			updatedAt: UPDATED_AT
		};

		it('prepares a gate batch then a 3-statement mutation batch (update, cascade-all, receipt) for an owner->member demotion', async () => {
			const fake = fakeD1({
				batchResults: (batchIndex: number) =>
					batchIndex === 0
						? [
								[{ role: 'owner', status: 'active' }], // actor
								[
									{
										user_id: TARGET_ID,
										role: 'admin',
										status: 'active',
										created_at: CREATED_AT,
										updated_at: CREATED_AT
									}
								], // target
								[], // receipt
								[{ count: 1 }] // other active owners
							]
						: [[], [], []],
				batchChanges: (batchIndex: number, statementIndex: number) =>
					batchIndex === 1 && statementIndex === 1 ? 3 : 1
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberRole(setRoleCommand);
			expect(result).toEqual({
				outcome: 'updated',
				member: {
					userId: TARGET_ID,
					role: 'member',
					status: 'active',
					createdAt: CREATED_AT,
					updatedAt: UPDATED_AT
				},
				appliedAt: UPDATED_AT,
				revokedInvitationCount: 3
			});

			expect(fake.batches).toHaveLength(2);
			const mutationBatch = fake.batches[1];
			expect(mutationBatch).toHaveLength(3);
			expect(mutationBatch[0].sql).toContain('UPDATE instance_member');
			expect(mutationBatch[0].sql).toContain('SET role = ?, updated_at = ?');
			expect(mutationBatch[0].bindings).toEqual([
				'member',
				UPDATED_AT,
				TARGET_ID,
				'admin',
				'active'
			]);
			expect(mutationBatch[1].sql).toContain('UPDATE instance_invitation');
			expect(mutationBatch[1].sql).not.toContain("role <> 'member'");
			expect(mutationBatch[1].bindings).toEqual([UPDATED_AT, OWNER_ID, TARGET_ID, UPDATED_AT]);
			expect(mutationBatch[2].sql).toContain('INSERT INTO instance_member_command');
			expect(mutationBatch[2].sql).toContain("'set_role'");
			expect(mutationBatch[2].sql).toContain('(SELECT changes())');
		});

		it('scopes the cascade to non-member invitations for an owner->admin demotion', async () => {
			const fake = fakeD1({
				batchResults: (batchIndex: number) =>
					batchIndex === 0
						? [
								[{ role: 'owner', status: 'active' }],
								[
									{
										user_id: 'target-owner-1',
										role: 'owner',
										status: 'active',
										created_at: CREATED_AT,
										updated_at: CREATED_AT
									}
								],
								[],
								[{ count: 1 }]
							]
						: [[], [], []]
			});
			const store = new D1InstanceStore(fake.database);

			await store.setInstanceMemberRole({
				...setRoleCommand,
				targetUserId: 'target-owner-1',
				role: 'admin'
			});
			const mutationBatch = fake.batches[1];
			expect(mutationBatch[1].sql).toContain("role <> 'member'");
		});

		it('omits the cascade statement entirely for a promotion, recording revokedInvitationCount 0', async () => {
			const fake = fakeD1({
				batchResults: (batchIndex: number) =>
					batchIndex === 0
						? [
								[{ role: 'owner', status: 'active' }],
								[
									{
										user_id: 'target-member-1',
										role: 'member',
										status: 'active',
										created_at: CREATED_AT,
										updated_at: CREATED_AT
									}
								],
								[],
								[{ count: 1 }]
							]
						: [[], []]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberRole({
				...setRoleCommand,
				targetUserId: 'target-member-1',
				role: 'admin'
			});
			expect(result.outcome).toBe('updated');
			if (result.outcome === 'updated') {
				expect(result.revokedInvitationCount).toBe(0);
			}
			const mutationBatch = fake.batches[1];
			expect(mutationBatch).toHaveLength(2);
			expect(mutationBatch[1].sql).toContain('INSERT INTO instance_member_command');
			expect(mutationBatch[1].sql).not.toContain('(SELECT changes())');
		});

		it('refuses at the gate when the actor is suspended, running no mutation batch', async () => {
			const fake = fakeD1({
				batchResults: [[{ role: 'owner', status: 'suspended' }], [], [], [{ count: 1 }]]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberRole(setRoleCommand);
			expect(result).toEqual({ outcome: 'member_suspended' });
			expect(fake.batches).toHaveLength(1);
		});

		it('refuses at the gate when an admin actor targets a non-member with forbidden', async () => {
			const fake = fakeD1({
				batchResults: [
					[{ role: 'admin', status: 'active' }],
					[
						{
							user_id: 'target-admin-2',
							role: 'admin',
							status: 'active',
							created_at: CREATED_AT,
							updated_at: CREATED_AT
						}
					],
					[],
					[{ count: 1 }]
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberRole({
				...setRoleCommand,
				actor: { type: 'user', id: 'admin-1' },
				targetUserId: 'target-admin-2'
			});
			expect(result).toEqual({ outcome: 'forbidden' });
			expect(fake.batches).toHaveLength(1);
		});

		it('refuses at the gate when an admin actor requests a role above member with role_not_permitted', async () => {
			const fake = fakeD1({
				batchResults: [
					[{ role: 'admin', status: 'active' }],
					[
						{
							user_id: 'target-member-2',
							role: 'member',
							status: 'active',
							created_at: CREATED_AT,
							updated_at: CREATED_AT
						}
					],
					[],
					[{ count: 1 }]
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberRole({
				...setRoleCommand,
				actor: { type: 'user', id: 'admin-1' },
				targetUserId: 'target-member-2',
				role: 'admin'
			});
			expect(result).toEqual({ outcome: 'role_not_permitted' });
		});

		it('refuses an unknown target with member_not_found', async () => {
			const fake = fakeD1({
				batchResults: [[{ role: 'owner', status: 'active' }], [], [], [{ count: 1 }]]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberRole({
				...setRoleCommand,
				targetUserId: 'ghost'
			});
			expect(result).toEqual({ outcome: 'member_not_found' });
		});

		it('refuses with last_active_owner when self-demoting as the sole active owner', async () => {
			const fake = fakeD1({
				batchResults: [
					[{ role: 'owner', status: 'active' }],
					[
						{
							user_id: OWNER_ID,
							role: 'owner',
							status: 'active',
							created_at: CREATED_AT,
							updated_at: CREATED_AT
						}
					],
					[],
					[{ count: 0 }]
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberRole({
				...setRoleCommand,
				targetUserId: OWNER_ID,
				role: 'admin'
			});
			expect(result).toEqual({ outcome: 'last_active_owner' });
			expect(fake.batches).toHaveLength(1);
		});

		it('replays a matching receipt without running any mutation batch', async () => {
			const fake = fakeD1({
				batchResults: [
					[{ role: 'owner', status: 'active' }],
					[
						{
							user_id: TARGET_ID,
							role: 'member',
							status: 'active',
							created_at: CREATED_AT,
							updated_at: UPDATED_AT
						}
					],
					[
						{
							request_hash: REQUEST_FINGERPRINT,
							command_type: 'set_role',
							target_user_id: TARGET_ID,
							previous_role: 'admin',
							previous_status: 'active',
							result_role: 'member',
							result_status: 'active',
							revoked_invitation_count: 2,
							occurred_at: UPDATED_AT,
							target_row_user_id: TARGET_ID,
							target_row_created_at: CREATED_AT
						}
					],
					[{ count: 1 }]
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberRole(setRoleCommand);
			expect(result).toEqual({
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
			expect(fake.batches).toHaveLength(1);
		});

		it('rejects a reused idempotency key with a conflicting request fingerprint', async () => {
			const fake = fakeD1({
				batchResults: [
					[{ role: 'owner', status: 'active' }],
					[
						{
							user_id: TARGET_ID,
							role: 'member',
							status: 'active',
							created_at: CREATED_AT,
							updated_at: UPDATED_AT
						}
					],
					[
						{
							request_hash: 'different-hash'.padStart(64, '0'),
							command_type: 'set_role',
							target_user_id: TARGET_ID,
							previous_role: 'admin',
							previous_status: 'active',
							result_role: 'member',
							result_status: 'active',
							revoked_invitation_count: 0,
							occurred_at: UPDATED_AT,
							target_row_user_id: TARGET_ID,
							target_row_created_at: CREATED_AT
						}
					],
					[{ count: 1 }]
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberRole(setRoleCommand);
			expect(result).toEqual({ outcome: 'idempotency_conflict' });
		});

		it('replays a matching receipt even when the actor row now shows a demoted or suspended actor', async () => {
			const receiptRow = {
				request_hash: REQUEST_FINGERPRINT,
				command_type: 'set_role',
				target_user_id: TARGET_ID,
				previous_role: 'admin',
				previous_status: 'active',
				result_role: 'member',
				result_status: 'active',
				revoked_invitation_count: 2,
				occurred_at: UPDATED_AT,
				target_row_user_id: TARGET_ID,
				target_row_created_at: CREATED_AT
			};
			const targetRow = [
				{
					user_id: TARGET_ID,
					role: 'member',
					status: 'active',
					created_at: CREATED_AT,
					updated_at: UPDATED_AT
				}
			];
			const expected = {
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
			};

			const demotedActor = fakeD1({
				batchResults: [
					[{ role: 'member', status: 'active' }],
					targetRow,
					[receiptRow],
					[{ count: 1 }]
				]
			});
			const demotedResult = await new D1InstanceStore(demotedActor.database).setInstanceMemberRole(
				setRoleCommand
			);
			expect(demotedResult).toEqual(expected);
			expect(demotedActor.batches).toHaveLength(1);

			const suspendedActor = fakeD1({
				batchResults: [
					[{ role: 'owner', status: 'suspended' }],
					targetRow,
					[receiptRow],
					[{ count: 1 }]
				]
			});
			const suspendedResult = await new D1InstanceStore(
				suspendedActor.database
			).setInstanceMemberRole(setRoleCommand);
			expect(suspendedResult).toEqual(expected);
			expect(suspendedActor.batches).toHaveLength(1);
		});

		it('refuses at the gate with role_not_permitted, not forbidden, when an admin requests a role above member on itself', async () => {
			const fake = fakeD1({
				batchResults: [
					[{ role: 'admin', status: 'active' }],
					[
						{
							user_id: 'admin-1',
							role: 'admin',
							status: 'active',
							created_at: CREATED_AT,
							updated_at: CREATED_AT
						}
					],
					[],
					[{ count: 1 }]
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberRole({
				...setRoleCommand,
				actor: { type: 'user', id: 'admin-1' },
				targetUserId: 'admin-1',
				role: 'admin'
			});
			expect(result).toEqual({ outcome: 'role_not_permitted' });
			expect(fake.batches).toHaveLength(1);
		});

		it('classifies at the gate as integrity_error when updatedAt regresses behind the target current updatedAt, running no mutation batch', async () => {
			const LATER_AT: string = '2026-09-14T12:00:00.000Z';
			const fake = fakeD1({
				batchResults: [
					[{ role: 'owner', status: 'active' }],
					[
						{
							user_id: TARGET_ID,
							role: 'admin',
							status: 'active',
							created_at: CREATED_AT,
							updated_at: LATER_AT
						}
					],
					[],
					[{ count: 1 }]
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberRole(setRoleCommand);
			expect(result).toEqual({ outcome: 'integrity_error' });
			expect(fake.batches).toHaveLength(1);
		});
	});

	describe('setInstanceMemberStatus', () => {
		const TARGET_ID: string = 'target-member-1';
		const UPDATED_AT: string = '2026-09-13T12:00:00.000Z';
		const setStatusCommand: SetInstanceMemberStatusCommand = {
			actor: { type: 'user', id: OWNER_ID },
			idempotencyKey: 'status-idem-1',
			requestFingerprint: REQUEST_FINGERPRINT,
			targetUserId: TARGET_ID,
			status: 'suspended',
			updatedAt: UPDATED_AT
		};

		it('prepares a gate batch then a 3-statement mutation batch (update, cascade, receipt) when suspending', async () => {
			const fake = fakeD1({
				batchResults: (batchIndex: number) =>
					batchIndex === 0
						? [
								[{ role: 'owner', status: 'active' }],
								[
									{
										user_id: TARGET_ID,
										role: 'member',
										status: 'active',
										created_at: CREATED_AT,
										updated_at: CREATED_AT
									}
								],
								[],
								[{ count: 1 }]
							]
						: [[], [], []],
				batchChanges: (batchIndex: number, statementIndex: number) =>
					batchIndex === 1 && statementIndex === 1 ? 2 : 1
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberStatus(setStatusCommand);
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
				revokedInvitationCount: 2
			});

			const mutationBatch = fake.batches[1];
			expect(mutationBatch).toHaveLength(3);
			expect(mutationBatch[0].sql).toContain('UPDATE instance_member');
			expect(mutationBatch[0].sql).toContain('SET status = ?, updated_at = ?');
			expect(mutationBatch[1].sql).toContain('UPDATE instance_invitation');
			expect(mutationBatch[2].sql).toContain('INSERT INTO instance_member_command');
			expect(mutationBatch[2].sql).toContain("'set_status'");
			expect(mutationBatch[2].sql).toContain('(SELECT changes())');
		});

		it('omits the cascade statement for reactivation, recording revokedInvitationCount 0', async () => {
			const fake = fakeD1({
				batchResults: (batchIndex: number) =>
					batchIndex === 0
						? [
								[{ role: 'owner', status: 'active' }],
								[
									{
										user_id: TARGET_ID,
										role: 'member',
										status: 'suspended',
										created_at: CREATED_AT,
										updated_at: CREATED_AT
									}
								],
								[],
								[{ count: 1 }]
							]
						: [[], []]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberStatus({ ...setStatusCommand, status: 'active' });
			expect(result.outcome).toBe('updated');
			if (result.outcome === 'updated') {
				expect(result.revokedInvitationCount).toBe(0);
			}
			expect(fake.batches[1]).toHaveLength(2);
		});

		it('refuses self-targeting with cannot_target_self ahead of the target lookup', async () => {
			const fake = fakeD1({
				batchResults: [[{ role: 'owner', status: 'active' }], [], [], [{ count: 1 }]]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberStatus({
				...setStatusCommand,
				targetUserId: OWNER_ID
			});
			expect(result).toEqual({ outcome: 'cannot_target_self' });
			expect(fake.batches).toHaveLength(1);
		});

		it('refuses at the gate when an admin actor targets a non-member with forbidden', async () => {
			const fake = fakeD1({
				batchResults: [
					[{ role: 'admin', status: 'active' }],
					[
						{
							user_id: 'target-admin-2',
							role: 'admin',
							status: 'active',
							created_at: CREATED_AT,
							updated_at: CREATED_AT
						}
					],
					[],
					[{ count: 1 }]
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberStatus({
				...setStatusCommand,
				actor: { type: 'user', id: 'admin-1' },
				targetUserId: 'target-admin-2'
			});
			expect(result).toEqual({ outcome: 'forbidden' });
		});

		it('refuses an unknown target with member_not_found', async () => {
			const fake = fakeD1({
				batchResults: [[{ role: 'owner', status: 'active' }], [], [], [{ count: 1 }]]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberStatus({
				...setStatusCommand,
				targetUserId: 'ghost'
			});
			expect(result).toEqual({ outcome: 'member_not_found' });
		});

		it('reaches last_active_owner at the gate when the snapshot shows no other active owner', async () => {
			// This snapshot (an active-owner actor, a distinct active-owner target,
			// and zero other active owners) is only internally consistent as the
			// post-failure reclassification snapshot after a concurrent floor
			// violation already suspended the actor's own row; see the
			// integration suite for that real race. It still exercises the
			// dedicated branch directly here.
			const fake = fakeD1({
				batchResults: [
					[{ role: 'owner', status: 'active' }],
					[
						{
							user_id: 'target-owner-1',
							role: 'owner',
							status: 'active',
							created_at: CREATED_AT,
							updated_at: CREATED_AT
						}
					],
					[],
					[{ count: 0 }]
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberStatus({
				...setStatusCommand,
				targetUserId: 'target-owner-1'
			});
			expect(result).toEqual({ outcome: 'last_active_owner' });
			expect(fake.batches).toHaveLength(1);
		});

		it('replays a matching receipt without running any mutation batch', async () => {
			const fake = fakeD1({
				batchResults: [
					[{ role: 'owner', status: 'active' }],
					[
						{
							user_id: TARGET_ID,
							role: 'member',
							status: 'suspended',
							created_at: CREATED_AT,
							updated_at: UPDATED_AT
						}
					],
					[
						{
							request_hash: REQUEST_FINGERPRINT,
							command_type: 'set_status',
							target_user_id: TARGET_ID,
							previous_role: 'member',
							previous_status: 'active',
							result_role: 'member',
							result_status: 'suspended',
							revoked_invitation_count: 1,
							occurred_at: UPDATED_AT,
							target_row_user_id: TARGET_ID,
							target_row_created_at: CREATED_AT
						}
					],
					[{ count: 1 }]
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberStatus(setStatusCommand);
			expect(result).toEqual({
				outcome: 'replayed',
				member: {
					userId: TARGET_ID,
					role: 'member',
					status: 'suspended',
					createdAt: CREATED_AT,
					updatedAt: UPDATED_AT
				},
				appliedAt: UPDATED_AT,
				revokedInvitationCount: 1
			});
			expect(fake.batches).toHaveLength(1);
		});

		it('replays a matching receipt even when the actor row now shows a demoted or suspended actor', async () => {
			const receiptRow = {
				request_hash: REQUEST_FINGERPRINT,
				command_type: 'set_status',
				target_user_id: TARGET_ID,
				previous_role: 'member',
				previous_status: 'active',
				result_role: 'member',
				result_status: 'suspended',
				revoked_invitation_count: 1,
				occurred_at: UPDATED_AT,
				target_row_user_id: TARGET_ID,
				target_row_created_at: CREATED_AT
			};
			const targetRow = [
				{
					user_id: TARGET_ID,
					role: 'member',
					status: 'suspended',
					created_at: CREATED_AT,
					updated_at: UPDATED_AT
				}
			];
			const expected = {
				outcome: 'replayed',
				member: {
					userId: TARGET_ID,
					role: 'member',
					status: 'suspended',
					createdAt: CREATED_AT,
					updatedAt: UPDATED_AT
				},
				appliedAt: UPDATED_AT,
				revokedInvitationCount: 1
			};

			const demotedActor = fakeD1({
				batchResults: [
					[{ role: 'member', status: 'active' }],
					targetRow,
					[receiptRow],
					[{ count: 1 }]
				]
			});
			const demotedResult = await new D1InstanceStore(
				demotedActor.database
			).setInstanceMemberStatus(setStatusCommand);
			expect(demotedResult).toEqual(expected);
			expect(demotedActor.batches).toHaveLength(1);

			const suspendedActor = fakeD1({
				batchResults: [
					[{ role: 'owner', status: 'suspended' }],
					targetRow,
					[receiptRow],
					[{ count: 1 }]
				]
			});
			const suspendedResult = await new D1InstanceStore(
				suspendedActor.database
			).setInstanceMemberStatus(setStatusCommand);
			expect(suspendedResult).toEqual(expected);
			expect(suspendedActor.batches).toHaveLength(1);
		});

		it('classifies at the gate as integrity_error when updatedAt regresses behind the target current updatedAt, running no mutation batch', async () => {
			const LATER_AT: string = '2026-09-14T12:00:00.000Z';
			const fake = fakeD1({
				batchResults: [
					[{ role: 'owner', status: 'active' }],
					[
						{
							user_id: TARGET_ID,
							role: 'member',
							status: 'active',
							created_at: CREATED_AT,
							updated_at: LATER_AT
						}
					],
					[],
					[{ count: 1 }]
				]
			});
			const store = new D1InstanceStore(fake.database);

			const result = await store.setInstanceMemberStatus(setStatusCommand);
			expect(result).toEqual({ outcome: 'integrity_error' });
			expect(fake.batches).toHaveLength(1);
		});
	});
});
