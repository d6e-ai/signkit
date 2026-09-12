import postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import * as bearerSecret from '$lib/security/bearer-secret';
import type {
	AcceptInstanceInvitationCommand,
	AcceptInstanceInvitationStoreResult,
	BootstrapInstanceCommand,
	BootstrapInstanceStoreResult,
	CreateInstanceInvitationCommand,
	CreateInstanceInvitationStoreResult,
	InstanceCallerContext,
	InstanceInvitationListQuery,
	ListInstanceInvitationsStoreResult,
	RevokeInstanceInvitationCommand,
	RevokeInstanceInvitationStoreResult
} from '$lib/ports/instance-store';
import { PostgresInstanceStore } from './postgres-instance-store';

const ACTOR_ID: string = 'user-owner-1';
const OWNER_ID: string = 'user-owner-1';
const ADMIN_ID: string = 'user-admin-1';
const MEMBER_ID: string = 'user-member-1';
const ACCEPTOR_ID: string = 'user-acceptor-1';
const IDEMPOTENCY_KEY: string = 'bootstrap-idem-key-1';
const REQUEST_FINGERPRINT: string = 'a'.repeat(64);
const OTHER_REQUEST_FINGERPRINT: string = 'b'.repeat(64);
const INVITATION_ID: string = '01900000-0000-7000-8000-000000000001';
const TOKEN_HASH: string = 'a'.repeat(64);
const EMAIL_BINDING: string = 'b'.repeat(64);
const CREATED_AT: Date = new Date('2026-09-12T12:00:00.000Z');
const EXPIRES_AT: Date = new Date('2026-09-19T12:00:00.000Z');
const ACCEPTED_AT: Date = new Date('2026-09-13T12:00:00.000Z');
const REVOKED_AT: Date = new Date('2026-09-13T12:00:00.000Z');

interface RecordedQuery {
	text: string;
	values: readonly unknown[];
}

type ScriptedResult = readonly object[] | Error;

class ScriptedPostgres {
	readonly queries: RecordedQuery[] = [];
	beginCalls: number = 0;
	rollbacks: number = 0;
	readonly #results: ScriptedResult[];

	constructor(results: readonly ScriptedResult[]) {
		this.#results = results.map((result: ScriptedResult): ScriptedResult =>
			result instanceof Error ? result : [...result]
		);
	}

	client(): ReturnType<typeof postgres> {
		const client: ReturnType<typeof postgres> = this.#tag();
		Object.assign(client, {
			begin: async <T>(
				callback: (transaction: ReturnType<typeof postgres>) => Promise<T>
			): Promise<T> => {
				this.beginCalls += 1;
				try {
					return await callback(this.#tag());
				} catch (error: unknown) {
					this.rollbacks += 1;
					throw error;
				}
			}
		});
		return client;
	}

	texts(): readonly string[] {
		return this.queries.map((query: RecordedQuery): string => query.text);
	}

	#tag(): ReturnType<typeof postgres> {
		const query = async (
			strings: TemplateStringsArray,
			...values: readonly unknown[]
		): Promise<readonly object[]> => {
			let text: string = '';
			const bound: unknown[] = [];
			strings.forEach((chunk: string, index: number): void => {
				text += chunk;
				if (index >= values.length) return;
				const value: unknown = values[index];
				text += '?';
				bound.push(value);
			});
			this.queries.push({ text: text.replaceAll(/\s+/g, ' ').trim(), values: bound });
			const result: ScriptedResult | undefined = this.#results.shift();
			if (result === undefined) throw new Error(`Unexpected PostgreSQL query: ${text}`);
			if (result instanceof Error) throw result;
			return result;
		};
		return query as unknown as ReturnType<typeof postgres>;
	}
}

function store(scripted: ScriptedPostgres): PostgresInstanceStore {
	return new PostgresInstanceStore(scripted.client());
}

function command(overrides: Partial<BootstrapInstanceCommand> = {}): BootstrapInstanceCommand {
	return {
		actor: { type: 'user', id: ACTOR_ID },
		idempotencyKey: IDEMPOTENCY_KEY,
		requestFingerprint: REQUEST_FINGERPRINT,
		createdAt: CREATED_AT.toISOString(),
		...overrides
	};
}

function createCommand(
	overrides: Partial<CreateInstanceInvitationCommand> = {}
): CreateInstanceInvitationCommand {
	return {
		actor: { type: 'user', id: OWNER_ID },
		idempotencyKey: 'create-idem-1',
		requestFingerprint: REQUEST_FINGERPRINT,
		invitationId: INVITATION_ID,
		role: 'member',
		tokenHash: TOKEN_HASH,
		emailBinding: EMAIL_BINDING,
		createdAt: CREATED_AT.toISOString(),
		expiresAt: EXPIRES_AT.toISOString(),
		...overrides
	};
}

function acceptCommand(
	overrides: Partial<AcceptInstanceInvitationCommand> = {}
): AcceptInstanceInvitationCommand {
	return {
		actor: { type: 'user', id: ACCEPTOR_ID },
		idempotencyKey: 'accept-idem-1',
		requestFingerprint: REQUEST_FINGERPRINT,
		tokenHash: TOKEN_HASH,
		emailBinding: EMAIL_BINDING,
		acceptedAt: ACCEPTED_AT.toISOString(),
		...overrides
	};
}

function revokeCommand(
	overrides: Partial<RevokeInstanceInvitationCommand> = {}
): RevokeInstanceInvitationCommand {
	return {
		actor: { type: 'user', id: OWNER_ID },
		idempotencyKey: 'revoke-idem-1',
		requestFingerprint: REQUEST_FINGERPRINT,
		invitationId: INVITATION_ID,
		revokedAt: REVOKED_AT.toISOString(),
		...overrides
	};
}

describe('PostgresInstanceStore', () => {
	describe('bootstrapInstance', () => {
		it('atomically claims the initial owner slot on an empty instance', async () => {
			const scripted = new ScriptedPostgres([
				[], // receipt check (none)
				[], // bootstrap table check (empty)
				[{ count: '0' }], // member table count check (0)
				[
					{
						userId: ACTOR_ID,
						role: 'owner',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					}
				], // member insert RETURNING
				[{ ownerUserId: ACTOR_ID }], // bootstrap insert RETURNING
				[{ actorId: ACTOR_ID }] // receipt insert RETURNING
			]);

			const result: BootstrapInstanceStoreResult =
				await store(scripted).bootstrapInstance(command());

			expect(result).toEqual({
				outcome: 'bootstrapped',
				member: {
					userId: ACTOR_ID,
					role: 'owner',
					status: 'active',
					createdAt: CREATED_AT.toISOString(),
					updatedAt: CREATED_AT.toISOString()
				}
			});
			expect(scripted.beginCalls).toBe(1);
			expect(scripted.rollbacks).toBe(0);
			expect(scripted.texts()[3]).toContain('INSERT INTO instance_member');
			expect(scripted.texts()[4]).toContain('INSERT INTO instance_bootstrap');
			expect(scripted.texts()[5]).toContain('INSERT INTO instance_bootstrap_command');
		});

		it('replays an exact request safely under matching receipt', async () => {
			const scripted = new ScriptedPostgres([
				[
					{
						requestHash: REQUEST_FINGERPRINT,
						ownerUserId: ACTOR_ID,
						createdAt: CREATED_AT
					}
				], // receipt found with matching hash
				[
					{
						userId: ACTOR_ID,
						role: 'owner',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					}
				], // member row
				[{ singletonKey: 1, ownerUserId: ACTOR_ID, createdAt: CREATED_AT }] // bootstrap row
			]);

			const result: BootstrapInstanceStoreResult =
				await store(scripted).bootstrapInstance(command());

			expect(result).toEqual({
				outcome: 'already_bootstrapped',
				member: {
					userId: ACTOR_ID,
					role: 'owner',
					status: 'active',
					createdAt: CREATED_AT.toISOString(),
					updatedAt: CREATED_AT.toISOString()
				},
				replayed: true
			});
			expect(scripted.beginCalls).toBe(1);
			expect(scripted.rollbacks).toBe(1);
		});

		it('returns idempotency_conflict when receipt request hash differs', async () => {
			const scripted = new ScriptedPostgres([
				[
					{
						requestHash: OTHER_REQUEST_FINGERPRINT,
						ownerUserId: ACTOR_ID,
						createdAt: CREATED_AT
					}
				] // receipt found with differing hash
			]);

			const result: BootstrapInstanceStoreResult =
				await store(scripted).bootstrapInstance(command());

			expect(result).toEqual({ outcome: 'idempotency_conflict' });
			expect(scripted.rollbacks).toBe(1);
		});

		it('returns already_bootstrapped without replay when instance is already claimed', async () => {
			const scripted = new ScriptedPostgres([
				[], // no receipt for this actor + key
				[{ singletonKey: 1, ownerUserId: 'other-user', createdAt: CREATED_AT }], // bootstrap exists
				[{ count: '1' }] // members exist
			]);

			const result: BootstrapInstanceStoreResult =
				await store(scripted).bootstrapInstance(command());

			expect(result).toEqual({
				outcome: 'already_bootstrapped',
				replayed: false
			});
			expect(scripted.rollbacks).toBe(1);
		});

		it('returns already_bootstrapped when instance_member has preexisting rows without bootstrap', async () => {
			const scripted = new ScriptedPostgres([
				[], // no receipt
				[], // no bootstrap row
				[{ count: '2' }] // member count > 0
			]);

			const result: BootstrapInstanceStoreResult =
				await store(scripted).bootstrapInstance(command());

			expect(result).toEqual({
				outcome: 'already_bootstrapped',
				replayed: false
			});
			expect(scripted.rollbacks).toBe(1);
		});

		it('returns integrity_error when replay receipt references non-owner member', async () => {
			const scripted = new ScriptedPostgres([
				[
					{
						requestHash: REQUEST_FINGERPRINT,
						ownerUserId: ACTOR_ID,
						createdAt: CREATED_AT
					}
				],
				[
					{
						userId: ACTOR_ID,
						role: 'member', // corrupted role
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					}
				],
				[{ singletonKey: 1, ownerUserId: ACTOR_ID, createdAt: CREATED_AT }]
			]);

			const result: BootstrapInstanceStoreResult =
				await store(scripted).bootstrapInstance(command());

			expect(result).toEqual({ outcome: 'integrity_error' });
			expect(scripted.rollbacks).toBe(1);
		});

		it('classifies concurrent insert conflict and does not throw', async () => {
			const scripted = new ScriptedPostgres([
				[], // receipt (none)
				[], // bootstrap (none)
				[{ count: '0' }], // member count (0)
				[], // member insert returned 0 rows due to race ON CONFLICT DO NOTHING
				// classification queries:
				[], // receipt query (none)
				[{ singletonKey: 1, ownerUserId: 'raced-owner', createdAt: CREATED_AT }], // bootstrap won by another
				[{ count: '1' }]
			]);

			const result: BootstrapInstanceStoreResult =
				await store(scripted).bootstrapInstance(command());

			expect(result).toEqual({
				outcome: 'already_bootstrapped',
				replayed: false
			});
			expect(scripted.rollbacks).toBe(1);
		});

		it('re-throws unexpected driver errors', async () => {
			const scripted = new ScriptedPostgres([new Error('PostgreSQL connection terminated')]);

			await expect(store(scripted).bootstrapInstance(command())).rejects.toThrow(
				'PostgreSQL connection terminated'
			);
			expect(scripted.rollbacks).toBe(1);
		});
	});

	describe('getInstanceCallerContext', () => {
		it('returns null member and bootstrapped false when clean', async () => {
			const scripted = new ScriptedPostgres([
				[], // no bootstrap row
				[] // no member row
			]);

			const context: InstanceCallerContext =
				await store(scripted).getInstanceCallerContext(ACTOR_ID);

			expect(context).toEqual({
				member: null,
				bootstrapped: false
			});
		});

		it('returns member metadata and bootstrapped true when member exists', async () => {
			const scripted = new ScriptedPostgres([
				[{ singletonKey: 1, ownerUserId: ACTOR_ID, createdAt: CREATED_AT }],
				[
					{
						userId: ACTOR_ID,
						role: 'owner',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					}
				]
			]);

			const context: InstanceCallerContext =
				await store(scripted).getInstanceCallerContext(ACTOR_ID);

			expect(context).toEqual({
				member: {
					userId: ACTOR_ID,
					role: 'owner',
					status: 'active',
					createdAt: CREATED_AT.toISOString(),
					updatedAt: CREATED_AT.toISOString()
				},
				bootstrapped: true
			});
		});

		it('returns null member and bootstrapped true when caller is non-member on bootstrapped instance', async () => {
			const scripted = new ScriptedPostgres([
				[{ singletonKey: 1, ownerUserId: 'other-owner', createdAt: CREATED_AT }],
				[] // caller not found in instance_member
			]);

			const context: InstanceCallerContext =
				await store(scripted).getInstanceCallerContext(ACTOR_ID);

			expect(context).toEqual({
				member: null,
				bootstrapped: true
			});
		});
	});

	describe('createInstanceInvitation', () => {
		it('atomically creates an invitation and command receipt for active owner', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'owner', status: 'active' }], // member check
				[], // advisory lock
				[], // receipt check
				[{ count: '0' }], // count check
				[{ id: INVITATION_ID }], // invitation insert
				[{ actorId: OWNER_ID }] // receipt insert
			]);

			const result: CreateInstanceInvitationStoreResult =
				await store(scripted).createInstanceInvitation(createCommand());

			expect(result).toEqual({
				outcome: 'created',
				invitation: {
					id: INVITATION_ID,
					role: 'member',
					status: 'pending',
					invitedByUserId: OWNER_ID,
					createdAt: CREATED_AT.toISOString(),
					expiresAt: EXPIRES_AT.toISOString(),
					acceptedAt: null,
					acceptedByUserId: null,
					revokedAt: null,
					revokedByUserId: null
				}
			});
			expect(scripted.beginCalls).toBe(1);
			expect(scripted.rollbacks).toBe(0);
			expect(scripted.texts()[1]).toContain('pg_advisory_xact_lock');
			expect(scripted.texts()[4]).toContain('INSERT INTO instance_invitation');
			expect(scripted.texts()[5]).toContain('INSERT INTO instance_invitation_command');
		});

		it('refuses create immediately when actor is suspended', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'owner', status: 'suspended' }] // member check
			]);

			const result: CreateInstanceInvitationStoreResult =
				await store(scripted).createInstanceInvitation(createCommand());

			expect(result).toEqual({ outcome: 'member_suspended' });
			expect(scripted.rollbacks).toBe(1);
		});

		it('refuses create immediately when actor is member role', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'member', status: 'active' }] // member check
			]);

			const result: CreateInstanceInvitationStoreResult =
				await store(scripted).createInstanceInvitation(createCommand());

			expect(result).toEqual({ outcome: 'forbidden' });
			expect(scripted.rollbacks).toBe(1);
		});

		it('refuses create when active admin invites owner (role_not_permitted)', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'admin', status: 'active' }], // member check
				[], // advisory lock
				[] // receipt check
			]);

			const result: CreateInstanceInvitationStoreResult = await store(
				scripted
			).createInstanceInvitation(
				createCommand({ actor: { type: 'user', id: ADMIN_ID }, role: 'owner' })
			);

			expect(result).toEqual({ outcome: 'role_not_permitted' });
			expect(scripted.rollbacks).toBe(1);
		});

		it('refuses create when pending count reaches cap 200 (limit)', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'owner', status: 'active' }], // member check
				[], // advisory lock
				[], // receipt check
				[{ count: '200' }] // count check
			]);

			const result: CreateInstanceInvitationStoreResult =
				await store(scripted).createInstanceInvitation(createCommand());

			expect(result).toEqual({ outcome: 'limit' });
			expect(scripted.rollbacks).toBe(1);
			expect(scripted.texts()[3]).toContain(
				"WHERE status = 'pending' AND expires_at > ?::timestamptz"
			);
			expect(scripted.queries[3].values).toEqual([CREATED_AT.toISOString()]);
		});

		it('proves 200 expired pending invitations do not block a new create, while 200 live pending still returns limit', async () => {
			// Case A: 200 expired pending invitations exist -> live-pending count query returns 0 -> create proceeds
			const scriptedExpired = new ScriptedPostgres([
				[{ role: 'owner', status: 'active' }], // member check
				[], // advisory lock
				[], // receipt check
				[{ count: '0' }], // count check (0 live pending, 200 expired filtered out)
				[{ id: INVITATION_ID }], // invitation insert RETURNING id
				[{ actorId: OWNER_ID }] // receipt insert RETURNING actor_id
			]);

			const createdResult: CreateInstanceInvitationStoreResult =
				await store(scriptedExpired).createInstanceInvitation(createCommand());

			expect(createdResult.outcome).toBe('created');
			expect(scriptedExpired.rollbacks).toBe(0);
			expect(scriptedExpired.texts()[3]).toContain(
				"WHERE status = 'pending' AND expires_at > ?::timestamptz"
			);
			expect(scriptedExpired.queries[3].values).toEqual([CREATED_AT.toISOString()]);

			// Case B: 200 live pending invitations exist -> count check returns 200 -> limit outcome returned
			const scriptedLive = new ScriptedPostgres([
				[{ role: 'owner', status: 'active' }], // member check
				[], // advisory lock
				[], // receipt check
				[{ count: '200' }] // count check (200 live pending invitations)
			]);

			const limitResult: CreateInstanceInvitationStoreResult =
				await store(scriptedLive).createInstanceInvitation(createCommand());

			expect(limitResult).toEqual({ outcome: 'limit' });
			expect(scriptedLive.rollbacks).toBe(1);
			expect(scriptedLive.texts()[3]).toContain(
				"WHERE status = 'pending' AND expires_at > ?::timestamptz"
			);
			expect(scriptedLive.queries[3].values).toEqual([CREATED_AT.toISOString()]);
		});

		it('replays safely under matching receipt ignoring newly minted candidate invitationId and tokens', async () => {
			const STORED_ID: string = '01900000-0000-7000-8000-000000000999';
			const scripted = new ScriptedPostgres([
				[{ role: 'owner', status: 'active' }], // member check
				[], // advisory lock
				[
					{
						requestHash: REQUEST_FINGERPRINT,
						commandType: 'create',
						invitationId: STORED_ID,
						role: 'member',
						resultStatus: 'pending',
						occurredAt: CREATED_AT,
						invId: STORED_ID,
						invRole: 'member',
						invStatus: 'pending',
						invInvitedByUserId: OWNER_ID,
						invCreatedAt: CREATED_AT,
						invExpiresAt: EXPIRES_AT,
						invAcceptedAt: null,
						invAcceptedByUserId: null,
						invRevokedAt: null,
						invRevokedByUserId: null
					}
				] // receipt check
			]);

			const result: CreateInstanceInvitationStoreResult = await store(
				scripted
			).createInstanceInvitation(
				createCommand({
					invitationId: '01900000-0000-7000-8000-000000000123',
					tokenHash: 'f'.repeat(64),
					emailBinding: 'e'.repeat(64)
				})
			);

			expect(result).toEqual({
				outcome: 'replayed',
				invitation: {
					id: STORED_ID,
					role: 'member',
					status: 'pending',
					invitedByUserId: OWNER_ID,
					createdAt: CREATED_AT.toISOString(),
					expiresAt: EXPIRES_AT.toISOString(),
					acceptedAt: null,
					acceptedByUserId: null,
					revokedAt: null,
					revokedByUserId: null
				}
			});
			expect(scripted.rollbacks).toBe(1);
		});

		it('returns idempotency_conflict when receipt request hash differs', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'owner', status: 'active' }],
				[], // advisory lock
				[
					{
						requestHash: OTHER_REQUEST_FINGERPRINT,
						commandType: 'create',
						invitationId: INVITATION_ID,
						role: 'member',
						resultStatus: 'pending',
						occurredAt: CREATED_AT,
						invId: INVITATION_ID,
						invRole: 'member',
						invStatus: 'pending',
						invInvitedByUserId: OWNER_ID,
						invCreatedAt: CREATED_AT,
						invExpiresAt: EXPIRES_AT,
						invAcceptedAt: null,
						invAcceptedByUserId: null,
						invRevokedAt: null,
						invRevokedByUserId: null
					}
				]
			]);

			const result: CreateInstanceInvitationStoreResult =
				await store(scripted).createInstanceInvitation(createCommand());

			expect(result).toEqual({ outcome: 'idempotency_conflict' });
			expect(scripted.rollbacks).toBe(1);
		});

		it('returns integrity_error when receipt and invitation disagree', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'owner', status: 'active' }],
				[], // advisory lock
				[
					{
						requestHash: REQUEST_FINGERPRINT,
						commandType: 'create',
						invitationId: INVITATION_ID,
						role: 'member',
						resultStatus: 'pending',
						occurredAt: CREATED_AT,
						invId: null, // missing joined invitation
						invRole: null,
						invStatus: null,
						invInvitedByUserId: null,
						invCreatedAt: null,
						invExpiresAt: null,
						invAcceptedAt: null,
						invAcceptedByUserId: null,
						invRevokedAt: null,
						invRevokedByUserId: null
					}
				]
			]);

			const result: CreateInstanceInvitationStoreResult =
				await store(scripted).createInstanceInvitation(createCommand());

			expect(result).toEqual({ outcome: 'integrity_error' });
			expect(scripted.rollbacks).toBe(1);
		});

		it('classifies concurrent insert conflict and returns replayed', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'owner', status: 'active' }], // member check
				[], // advisory lock
				[], // receipt check (none yet)
				[{ count: '0' }], // count check
				[], // invitation insert returned 0 rows (raced)
				// classification query:
				[
					{
						requestHash: REQUEST_FINGERPRINT,
						commandType: 'create',
						invitationId: INVITATION_ID,
						role: 'member',
						resultStatus: 'pending',
						occurredAt: CREATED_AT,
						invId: INVITATION_ID,
						invRole: 'member',
						invStatus: 'pending',
						invInvitedByUserId: OWNER_ID,
						invCreatedAt: CREATED_AT,
						invExpiresAt: EXPIRES_AT,
						invAcceptedAt: null,
						invAcceptedByUserId: null,
						invRevokedAt: null,
						invRevokedByUserId: null
					}
				] // receipt found on retry
			]);

			const result: CreateInstanceInvitationStoreResult =
				await store(scripted).createInstanceInvitation(createCommand());

			expect(result).toEqual({
				outcome: 'replayed',
				invitation: {
					id: INVITATION_ID,
					role: 'member',
					status: 'pending',
					invitedByUserId: OWNER_ID,
					createdAt: CREATED_AT.toISOString(),
					expiresAt: EXPIRES_AT.toISOString(),
					acceptedAt: null,
					acceptedByUserId: null,
					revokedAt: null,
					revokedByUserId: null
				}
			});
			expect(scripted.rollbacks).toBe(1);
		});

		it('returns credential_collision when candidate invitationId collision occurs during insert', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'owner', status: 'active' }], // member check
				[], // advisory lock
				[], // receipt check (none yet)
				[{ count: '0' }], // count check
				[], // invitation insert returned 0 rows (conflict on invitationId)
				// classify queries:
				[], // receipt check
				[{ role: 'owner', status: 'active' }], // member check
				[{ count: '0' }], // count check
				[{ id: INVITATION_ID }] // existingId found
			]);

			const result: CreateInstanceInvitationStoreResult =
				await store(scripted).createInstanceInvitation(createCommand());

			expect(result).toEqual({ outcome: 'credential_collision' });
			expect(scripted.rollbacks).toBe(1);
		});

		it('returns credential_collision when candidate tokenHash collision occurs during insert', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'owner', status: 'active' }], // member check
				[], // advisory lock
				[], // receipt check (none yet)
				[{ count: '0' }], // count check
				[], // invitation insert returned 0 rows (conflict on tokenHash)
				// classify queries:
				[], // receipt check
				[{ role: 'owner', status: 'active' }], // member check
				[{ count: '0' }], // count check
				[], // existingId not found
				[{ id: INVITATION_ID }] // existingHash found
			]);

			const result: CreateInstanceInvitationStoreResult =
				await store(scripted).createInstanceInvitation(createCommand());

			expect(result).toEqual({ outcome: 'credential_collision' });
			expect(scripted.rollbacks).toBe(1);
		});

		it('outer catch returns credential_collision when driver throws and collision is classified', async () => {
			const scripted = new ScriptedPostgres([
				new Error('simulated driver insert conflict'), // transaction throws
				// outer catch classify queries:
				[], // receipt check
				[{ role: 'owner', status: 'active' }], // member check
				[{ count: '0' }], // count check
				[{ id: INVITATION_ID }] // existingId found
			]);

			const result: CreateInstanceInvitationStoreResult =
				await store(scripted).createInstanceInvitation(createCommand());

			expect(result).toEqual({ outcome: 'credential_collision' });
		});

		it('outer catch re-throws unknown/integrity provider failures when no collision exists', async () => {
			const scripted = new ScriptedPostgres([
				new Error('connection failure'), // transaction throws
				// outer catch classify queries:
				[], // receipt check
				[{ role: 'owner', status: 'active' }], // member check
				[{ count: '0' }], // count check
				[], // existingId not found
				[] // existingHash not found -> classify returns integrity_error
			]);

			await expect(store(scripted).createInstanceInvitation(createCommand())).rejects.toThrow(
				'connection failure'
			);
		});

		it('outer catch re-throws driver error if classification query fails', async () => {
			const scripted = new ScriptedPostgres([
				new Error('database offline') // transaction throws and classification cannot proceed
			]);

			await expect(store(scripted).createInstanceInvitation(createCommand())).rejects.toThrow(
				'database offline'
			);
		});
	});

	describe('listInstanceInvitations', () => {
		it('lists invitations with bounded limit in newest-first order', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'owner', status: 'active' }], // member check
				[
					{
						id: INVITATION_ID,
						role: 'member',
						status: 'pending',
						invitedByUserId: OWNER_ID,
						createdAt: CREATED_AT,
						expiresAt: EXPIRES_AT,
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: null,
						revokedByUserId: null
					}
				] // page query
			]);

			const query: InstanceInvitationListQuery = { cursor: null, limit: 10 };
			const result: ListInstanceInvitationsStoreResult = await store(
				scripted
			).listInstanceInvitations({ type: 'user', id: OWNER_ID }, query);

			expect(result).toEqual({
				outcome: 'listed',
				page: {
					items: [
						{
							id: INVITATION_ID,
							role: 'member',
							status: 'pending',
							invitedByUserId: OWNER_ID,
							createdAt: CREATED_AT.toISOString(),
							expiresAt: EXPIRES_AT.toISOString(),
							acceptedAt: null,
							acceptedByUserId: null,
							revokedAt: null,
							revokedByUserId: null
						}
					],
					nextCursor: null
				}
			});
			expect(scripted.texts()[1]).toContain('ORDER BY created_at DESC, id DESC');
		});

		it('refuses listing when caller is member role', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'member', status: 'active' }] // member check
			]);

			const result: ListInstanceInvitationsStoreResult = await store(
				scripted
			).listInstanceInvitations({ type: 'user', id: MEMBER_ID }, { cursor: null, limit: 10 });

			expect(result).toEqual({ outcome: 'forbidden' });
		});

		it('refuses listing when caller is suspended', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'owner', status: 'suspended' }] // member check
			]);

			const result: ListInstanceInvitationsStoreResult = await store(
				scripted
			).listInstanceInvitations({ type: 'user', id: OWNER_ID }, { cursor: null, limit: 10 });

			expect(result).toEqual({ outcome: 'member_suspended' });
		});

		it('fails closed without DB leakage on malformed cursor', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'owner', status: 'active' }] // member check
			]);

			const result: ListInstanceInvitationsStoreResult = await store(
				scripted
			).listInstanceInvitations(
				{ type: 'user', id: OWNER_ID },
				{ cursor: 'malformed-cursor-not-uuid', limit: 10 }
			);

			expect(result).toEqual({
				outcome: 'listed',
				page: { items: [], nextCursor: null }
			});
			// Only member check was executed, no invitation query
			expect(scripted.queries).toHaveLength(1);
		});
	});

	describe('acceptInstanceInvitation', () => {
		it('atomically accepts invitation, enrolls active member with invited role, and records receipt', async () => {
			const scripted = new ScriptedPostgres([
				[], // existing member check (none)
				[], // receipt check (none)
				[
					{
						id: INVITATION_ID,
						role: 'member',
						status: 'pending',
						emailBinding: EMAIL_BINDING,
						invitedByUserId: OWNER_ID,
						createdAt: CREATED_AT,
						expiresAt: EXPIRES_AT,
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: null,
						revokedByUserId: null
					}
				], // invitation lock FOR UPDATE
				[], // insert member ON CONFLICT DO NOTHING
				[
					{
						userId: ACCEPTOR_ID,
						role: 'member',
						status: 'active',
						createdAt: ACCEPTED_AT,
						updatedAt: ACCEPTED_AT
					}
				], // select enrolled member
				[{ id: INVITATION_ID }], // update invitation
				[{ actorId: ACCEPTOR_ID }] // insert receipt
			]);

			const result: AcceptInstanceInvitationStoreResult =
				await store(scripted).acceptInstanceInvitation(acceptCommand());

			expect(result).toEqual({
				outcome: 'accepted',
				invitation: {
					id: INVITATION_ID,
					role: 'member',
					status: 'accepted',
					invitedByUserId: OWNER_ID,
					createdAt: CREATED_AT.toISOString(),
					expiresAt: EXPIRES_AT.toISOString(),
					acceptedAt: ACCEPTED_AT.toISOString(),
					acceptedByUserId: ACCEPTOR_ID,
					revokedAt: null,
					revokedByUserId: null
				},
				member: {
					userId: ACCEPTOR_ID,
					role: 'member',
					status: 'active',
					createdAt: ACCEPTED_AT.toISOString(),
					updatedAt: ACCEPTED_AT.toISOString()
				}
			});
			expect(scripted.beginCalls).toBe(1);
			expect(scripted.rollbacks).toBe(0);
		});

		it('returns already_member without locking or mutating the invitation when actor is already an active member', async () => {
			const scripted = new ScriptedPostgres([
				[
					{
						userId: ACCEPTOR_ID,
						role: 'admin',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					}
				], // existing member check (active admin)
				[] // receipt check (none)
			]);

			const result: AcceptInstanceInvitationStoreResult =
				await store(scripted).acceptInstanceInvitation(acceptCommand());

			expect(result).toEqual({
				outcome: 'already_member',
				member: {
					userId: ACCEPTOR_ID,
					role: 'admin',
					status: 'active',
					createdAt: CREATED_AT.toISOString(),
					updatedAt: CREATED_AT.toISOString()
				}
			});
			// Only the member lock and receipt check ran: no invitation lock, member
			// insert, invitation update, or receipt insert.
			expect(scripted.queries).toHaveLength(2);
			expect(scripted.rollbacks).toBe(1);
		});

		it('refuses accept when subject is suspended (member_suspended)', async () => {
			const scripted = new ScriptedPostgres([
				[
					{
						userId: ACCEPTOR_ID,
						role: 'member',
						status: 'suspended',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					}
				], // existing member check
				[] // receipt check (none): checked before the suspended branch
			]);

			const result: AcceptInstanceInvitationStoreResult =
				await store(scripted).acceptInstanceInvitation(acceptCommand());

			expect(result).toEqual({ outcome: 'member_suspended' });
			expect(scripted.rollbacks).toBe(1);
		});

		it('refuses accept when email binding mismatch (invitation_invalid) and proves secretsEqual usage', async () => {
			const secretsEqualSpy = vi.spyOn(bearerSecret, 'secretsEqual');
			const scripted = new ScriptedPostgres([
				[], // existing member check
				[], // receipt check
				[
					{
						id: INVITATION_ID,
						role: 'member',
						status: 'pending',
						emailBinding: 'wrong'.padStart(64, '0'),
						invitedByUserId: OWNER_ID,
						createdAt: CREATED_AT,
						expiresAt: EXPIRES_AT,
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: null,
						revokedByUserId: null
					}
				] // invitation lock FOR UPDATE
			]);

			const result: AcceptInstanceInvitationStoreResult =
				await store(scripted).acceptInstanceInvitation(acceptCommand());

			expect(result).toEqual({ outcome: 'invitation_invalid' });
			expect(scripted.rollbacks).toBe(1);
			expect(secretsEqualSpy).toHaveBeenCalledWith(
				acceptCommand().emailBinding,
				'wrong'.padStart(64, '0')
			);
			// Verify token_hash lookup query was not weakened
			expect(scripted.queries[2].text).toContain('WHERE token_hash =');
			expect(scripted.queries[2].values).toContain(TOKEN_HASH);
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

			const scripted = new ScriptedPostgres([
				[], // existing member check
				[], // receipt check
				[
					{
						id: INVITATION_ID,
						role: 'member',
						status: 'pending',
						emailBinding: 'wrong'.padStart(64, '0'),
						invitedByUserId: OWNER_ID,
						createdAt: CREATED_AT,
						expiresAt: EXPIRES_AT,
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: null,
						revokedByUserId: null
					}
				] // invitation lock FOR UPDATE
			]);

			const result: AcceptInstanceInvitationStoreResult =
				await store(scripted).acceptInstanceInvitation(acceptCommand());

			expect(result).toEqual({ outcome: 'invitation_invalid' });
			expect(asyncEvaluated).toBe(true);
			expect(scripted.rollbacks).toBe(1);
			secretsEqualSpy.mockRestore();
		});

		it('classifies failure as invitation_invalid via secretsEqual when email binding differs in classification path', async () => {
			const secretsEqualSpy = vi.spyOn(bearerSecret, 'secretsEqual');
			const wrongBinding = 'different'.padStart(64, '0');
			const scripted = new ScriptedPostgres([
				[], // 1. existing member check
				[], // 2. receipt check
				[
					{
						id: INVITATION_ID,
						role: 'member',
						status: 'pending',
						emailBinding: EMAIL_BINDING, // Gate passes initially
						invitedByUserId: OWNER_ID,
						createdAt: CREATED_AT,
						expiresAt: EXPIRES_AT,
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: null,
						revokedByUserId: null
					}
				], // 3. invitation lock FOR UPDATE
				[], // 4. insert instance_member
				[
					{
						userId: ACCEPTOR_ID,
						role: 'member',
						status: 'active',
						createdAt: ACCEPTED_AT,
						updatedAt: ACCEPTED_AT
					}
				], // 5. select enrolled member FOR UPDATE
				[], // 6. UPDATE instance_invitation returns 0 rows (concurrent mutation / conflict)
				// classifyAcceptFailure queries:
				[
					{
						userId: ACCEPTOR_ID,
						role: 'member',
						status: 'active',
						createdAt: ACCEPTED_AT,
						updatedAt: ACCEPTED_AT
					}
				], // 7. member check
				[], // 8. receipt check
				[
					{
						id: INVITATION_ID,
						role: 'member',
						status: 'pending',
						emailBinding: wrongBinding, // re-read invitation has different email binding
						invitedByUserId: OWNER_ID,
						createdAt: CREATED_AT,
						expiresAt: EXPIRES_AT,
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: null,
						revokedByUserId: null
					}
				] // 9. invitation check in classifyAcceptFailure
			]);

			const result: AcceptInstanceInvitationStoreResult =
				await store(scripted).acceptInstanceInvitation(acceptCommand());

			expect(result).toEqual({ outcome: 'invitation_invalid' });
			expect(scripted.rollbacks).toBe(1);
			expect(secretsEqualSpy).toHaveBeenCalledWith(acceptCommand().emailBinding, wrongBinding);
			secretsEqualSpy.mockRestore();
		});

		it('refuses accept when invitation expired (invitation_invalid)', async () => {
			const scripted = new ScriptedPostgres([
				[], // existing member check
				[], // receipt check
				[
					{
						id: INVITATION_ID,
						role: 'member',
						status: 'pending',
						emailBinding: EMAIL_BINDING,
						invitedByUserId: OWNER_ID,
						createdAt: CREATED_AT,
						expiresAt: '2026-09-12T12:00:00.000Z', // already expired
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: null,
						revokedByUserId: null
					}
				] // invitation lock FOR UPDATE
			]);

			const result: AcceptInstanceInvitationStoreResult =
				await store(scripted).acceptInstanceInvitation(acceptCommand());

			expect(result).toEqual({ outcome: 'invitation_invalid' });
			expect(scripted.rollbacks).toBe(1);
		});

		it('replays safely under matching receipt comparing stored terminal timestamp to receipt occurred_at', async () => {
			const scripted = new ScriptedPostgres([
				[
					{
						userId: ACCEPTOR_ID,
						role: 'member',
						status: 'active',
						createdAt: ACCEPTED_AT,
						updatedAt: ACCEPTED_AT
					}
				], // existing member check
				[
					{
						requestHash: REQUEST_FINGERPRINT,
						commandType: 'accept',
						invitationId: INVITATION_ID,
						role: 'member',
						resultStatus: 'accepted',
						occurredAt: ACCEPTED_AT,
						invId: INVITATION_ID,
						invRole: 'member',
						invStatus: 'accepted',
						invInvitedByUserId: OWNER_ID,
						invCreatedAt: CREATED_AT,
						invExpiresAt: EXPIRES_AT,
						invAcceptedAt: ACCEPTED_AT,
						invAcceptedByUserId: ACCEPTOR_ID,
						invRevokedAt: null,
						invRevokedByUserId: null,
						memberUserId: ACCEPTOR_ID,
						memberRole: 'member',
						memberStatus: 'active',
						memberCreatedAt: ACCEPTED_AT,
						memberUpdatedAt: ACCEPTED_AT
					}
				] // receipt check
			]);

			// Command passes a fresh acceptedAt timestamp
			const result: AcceptInstanceInvitationStoreResult = await store(
				scripted
			).acceptInstanceInvitation(acceptCommand({ acceptedAt: '2026-09-13T12:30:00.000Z' }));

			expect(result).toEqual({
				outcome: 'replayed',
				invitation: {
					id: INVITATION_ID,
					role: 'member',
					status: 'accepted',
					invitedByUserId: OWNER_ID,
					createdAt: CREATED_AT.toISOString(),
					expiresAt: EXPIRES_AT.toISOString(),
					acceptedAt: ACCEPTED_AT.toISOString(),
					acceptedByUserId: ACCEPTOR_ID,
					revokedAt: null,
					revokedByUserId: null
				},
				member: {
					userId: ACCEPTOR_ID,
					role: 'member',
					status: 'active',
					createdAt: ACCEPTED_AT.toISOString(),
					updatedAt: ACCEPTED_AT.toISOString()
				}
			});
			expect(scripted.rollbacks).toBe(1);
		});

		it('returns idempotency_conflict when receipt request fingerprint differs', async () => {
			const scripted = new ScriptedPostgres([
				[], // existing member
				[
					{
						requestHash: OTHER_REQUEST_FINGERPRINT,
						commandType: 'accept',
						invitationId: INVITATION_ID,
						role: 'member',
						resultStatus: 'accepted',
						occurredAt: ACCEPTED_AT,
						invId: INVITATION_ID,
						invRole: 'member',
						invStatus: 'accepted',
						invInvitedByUserId: OWNER_ID,
						invCreatedAt: CREATED_AT,
						invExpiresAt: EXPIRES_AT,
						invAcceptedAt: ACCEPTED_AT,
						invAcceptedByUserId: ACCEPTOR_ID,
						invRevokedAt: null,
						invRevokedByUserId: null,
						memberUserId: ACCEPTOR_ID,
						memberRole: 'member',
						memberStatus: 'active',
						memberCreatedAt: ACCEPTED_AT,
						memberUpdatedAt: ACCEPTED_AT
					}
				] // receipt check
			]);

			const result: AcceptInstanceInvitationStoreResult =
				await store(scripted).acceptInstanceInvitation(acceptCommand());

			expect(result).toEqual({ outcome: 'idempotency_conflict' });
			expect(scripted.rollbacks).toBe(1);
		});
	});

	describe('revokeInstanceInvitation', () => {
		it('atomically revokes pending invitation and writes command receipt', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'owner', status: 'active' }], // member check
				[], // receipt check
				[
					{
						id: INVITATION_ID,
						role: 'member',
						status: 'pending',
						invitedByUserId: OWNER_ID,
						createdAt: CREATED_AT,
						expiresAt: EXPIRES_AT,
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: null,
						revokedByUserId: null
					}
				], // invitation lock FOR UPDATE
				[{ id: INVITATION_ID }], // update invitation
				[{ actorId: OWNER_ID }] // insert receipt
			]);

			const result: RevokeInstanceInvitationStoreResult =
				await store(scripted).revokeInstanceInvitation(revokeCommand());

			expect(result).toEqual({
				outcome: 'revoked',
				invitation: {
					id: INVITATION_ID,
					role: 'member',
					status: 'revoked',
					invitedByUserId: OWNER_ID,
					createdAt: CREATED_AT.toISOString(),
					expiresAt: EXPIRES_AT.toISOString(),
					acceptedAt: null,
					acceptedByUserId: null,
					revokedAt: REVOKED_AT.toISOString(),
					revokedByUserId: OWNER_ID
				}
			});
			expect(scripted.beginCalls).toBe(1);
			expect(scripted.rollbacks).toBe(0);
		});

		it('refuses revoke when admin attempts to revoke owner invitation (forbidden)', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'admin', status: 'active' }], // member check
				[], // receipt check
				[
					{
						id: INVITATION_ID,
						role: 'owner',
						status: 'pending',
						invitedByUserId: OWNER_ID,
						createdAt: CREATED_AT,
						expiresAt: EXPIRES_AT,
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: null,
						revokedByUserId: null
					}
				] // invitation lock FOR UPDATE
			]);

			const result: RevokeInstanceInvitationStoreResult = await store(
				scripted
			).revokeInstanceInvitation(revokeCommand({ actor: { type: 'user', id: ADMIN_ID } }));

			expect(result).toEqual({ outcome: 'forbidden' });
			expect(scripted.rollbacks).toBe(1);
		});

		it('refuses revoke when actor is member role (forbidden)', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'member', status: 'active' }] // member check
			]);

			const result: RevokeInstanceInvitationStoreResult = await store(
				scripted
			).revokeInstanceInvitation(revokeCommand({ actor: { type: 'user', id: MEMBER_ID } }));

			expect(result).toEqual({ outcome: 'forbidden' });
			expect(scripted.rollbacks).toBe(1);
		});

		it('refuses revoke when invitation is not pending (invitation_invalid)', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'owner', status: 'active' }], // member check
				[], // receipt check
				[
					{
						id: INVITATION_ID,
						role: 'member',
						status: 'accepted',
						invitedByUserId: OWNER_ID,
						createdAt: CREATED_AT,
						expiresAt: EXPIRES_AT,
						acceptedAt: ACCEPTED_AT,
						acceptedByUserId: ACCEPTOR_ID,
						revokedAt: null,
						revokedByUserId: null
					}
				], // invitation lock FOR UPDATE
				[] // raced receipt check
			]);

			const result: RevokeInstanceInvitationStoreResult =
				await store(scripted).revokeInstanceInvitation(revokeCommand());

			expect(result).toEqual({ outcome: 'invitation_invalid' });
			expect(scripted.rollbacks).toBe(1);
		});

		it('replays safely under matching receipt comparing stored terminal timestamp to receipt occurred_at', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'owner', status: 'active' }], // member check
				[
					{
						requestHash: REQUEST_FINGERPRINT,
						commandType: 'revoke',
						invitationId: INVITATION_ID,
						role: 'member',
						resultStatus: 'revoked',
						occurredAt: REVOKED_AT,
						invId: INVITATION_ID,
						invRole: 'member',
						invStatus: 'revoked',
						invInvitedByUserId: OWNER_ID,
						invCreatedAt: CREATED_AT,
						invExpiresAt: EXPIRES_AT,
						invAcceptedAt: null,
						invAcceptedByUserId: null,
						invRevokedAt: REVOKED_AT,
						invRevokedByUserId: OWNER_ID
					}
				] // receipt check
			]);

			const result: RevokeInstanceInvitationStoreResult = await store(
				scripted
			).revokeInstanceInvitation(revokeCommand({ revokedAt: '2026-09-13T12:30:00.000Z' }));

			expect(result).toEqual({
				outcome: 'replayed',
				invitation: {
					id: INVITATION_ID,
					role: 'member',
					status: 'revoked',
					invitedByUserId: OWNER_ID,
					createdAt: CREATED_AT.toISOString(),
					expiresAt: EXPIRES_AT.toISOString(),
					acceptedAt: null,
					acceptedByUserId: null,
					revokedAt: REVOKED_AT.toISOString(),
					revokedByUserId: OWNER_ID
				}
			});
			expect(scripted.rollbacks).toBe(1);
		});

		it('returns idempotency_conflict when request fingerprint differs', async () => {
			const scripted = new ScriptedPostgres([
				[{ role: 'owner', status: 'active' }], // member check
				[
					{
						requestHash: OTHER_REQUEST_FINGERPRINT,
						commandType: 'revoke',
						invitationId: INVITATION_ID,
						role: 'member',
						resultStatus: 'revoked',
						occurredAt: REVOKED_AT,
						invId: INVITATION_ID,
						invRole: 'member',
						invStatus: 'revoked',
						invInvitedByUserId: OWNER_ID,
						invCreatedAt: CREATED_AT,
						invExpiresAt: EXPIRES_AT,
						invAcceptedAt: null,
						invAcceptedByUserId: null,
						invRevokedAt: REVOKED_AT,
						invRevokedByUserId: OWNER_ID
					}
				] // receipt check
			]);

			const result: RevokeInstanceInvitationStoreResult =
				await store(scripted).revokeInstanceInvitation(revokeCommand());

			expect(result).toEqual({ outcome: 'idempotency_conflict' });
			expect(scripted.rollbacks).toBe(1);
		});
	});
});
