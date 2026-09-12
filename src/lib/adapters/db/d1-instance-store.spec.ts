import { describe, expect, it, vi } from 'vitest';
import type {
	AcceptInstanceInvitationCommand,
	CreateInstanceInvitationCommand,
	InstanceInvitationListQuery,
	RevokeInstanceInvitationCommand
} from '$lib/ports/instance-store';
import { D1InstanceStore } from './d1-instance-store';

interface RecordedStatement {
	sql: string;
	bindings: readonly unknown[];
	statement: D1PreparedStatement;
}

interface FakeD1Options {
	batchResults?: readonly unknown[][];
	firstResult?: unknown | null;
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
			first: async (): Promise<unknown | null> => options.firstResult ?? null,
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
			batches.push(records);
			return statements.map((_, index: number) => ({
				meta: { changes: 1 },
				results: (options.batchResults?.[index] ?? []) as unknown[]
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
		it('prepares 3-statement atomic batch: member insert on conflict, invitation update, receipt insert', async () => {
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
			expect(mutationBatch[0].sql).toContain('INSERT INTO instance_member');
			expect(mutationBatch[0].sql).toContain('ON CONFLICT (user_id) DO NOTHING');
			expect(mutationBatch[1].sql).toContain('UPDATE instance_invitation');
			expect(mutationBatch[1].sql).toContain("status = 'accepted'");
			expect(mutationBatch[2].sql).toContain('INSERT INTO instance_invitation_command');
			expect(mutationBatch[2].sql).toContain("'accept'");
			expect(mutationBatch[2].bindings[3]).toBe(INVITATION_ID);
		});

		it('refuses accept when asserted email binding does not match', async () => {
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
});
