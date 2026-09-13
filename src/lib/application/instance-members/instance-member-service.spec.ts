import { describe, expect, it } from 'vitest';
import {
	DEFAULT_INSTANCE_MEMBER_LIST_LIMIT,
	MAX_INSTANCE_MEMBER_LIST_LIMIT,
	type AcceptInstanceInvitationCommand,
	type AcceptInstanceInvitationStoreResult,
	type BootstrapInstanceStoreResult,
	type CreateInstanceInvitationCommand,
	type CreateInstanceInvitationStoreResult,
	type InstanceActor,
	type InstanceCallerContext,
	type InstanceInvitationListQuery,
	type InstanceMemberListPage,
	type InstanceMemberListQuery,
	type InstanceMemberMetadata,
	type InstanceStore,
	type ListInstanceInvitationsStoreResult,
	type ListInstanceMembersStoreResult,
	type RevokeInstanceInvitationCommand,
	type RevokeInstanceInvitationStoreResult,
	type SetInstanceMemberRoleCommand,
	type SetInstanceMemberRoleStoreResult,
	type SetInstanceMemberStatusCommand,
	type SetInstanceMemberStatusStoreResult
} from '$lib/ports/instance-store';
import { canonicalJson, sha256Hex } from '$lib/application/instance/instance-command-fingerprint';
import {
	InstanceMemberApplication,
	InstanceMemberService,
	InvalidInstanceMemberRequestError,
	type InstanceMemberActor,
	type ListInstanceMembersInput,
	type SetInstanceMemberRoleInput,
	type SetInstanceMemberStatusInput
} from './instance-member-service';

const NOW: Date = new Date('2026-09-13T12:00:00.000Z');
const ACTOR: InstanceMemberActor = { id: 'admin-user-1' };
const TARGET_USER_ID: string = 'target-user-1';

class FakeInstanceStore implements InstanceStore {
	readonly listCalls: { actor: InstanceActor; query: InstanceMemberListQuery }[] = [];
	readonly setRoleCommands: SetInstanceMemberRoleCommand[] = [];
	readonly setStatusCommands: SetInstanceMemberStatusCommand[] = [];

	readonly #listResults: ListInstanceMembersStoreResult[];
	readonly #setRoleResults: SetInstanceMemberRoleStoreResult[];
	readonly #setStatusResults: SetInstanceMemberStatusStoreResult[];

	constructor(
		listResults: readonly ListInstanceMembersStoreResult[] = [],
		setRoleResults: readonly SetInstanceMemberRoleStoreResult[] = [],
		setStatusResults: readonly SetInstanceMemberStatusStoreResult[] = []
	) {
		this.#listResults = [...listResults];
		this.#setRoleResults = [...setRoleResults];
		this.#setStatusResults = [...setStatusResults];
	}

	async listInstanceMembers(
		actor: InstanceActor,
		query: InstanceMemberListQuery
	): Promise<ListInstanceMembersStoreResult> {
		this.listCalls.push({ actor, query });
		const scripted: ListInstanceMembersStoreResult | undefined = this.#listResults.shift();
		return scripted ?? { outcome: 'listed', page: { items: [], nextCursor: null } };
	}

	async setInstanceMemberRole(
		command: SetInstanceMemberRoleCommand
	): Promise<SetInstanceMemberRoleStoreResult> {
		this.setRoleCommands.push(command);
		const scripted: SetInstanceMemberRoleStoreResult | undefined = this.#setRoleResults.shift();
		return (
			scripted ?? {
				outcome: 'updated',
				member: memberMetadata(command.targetUserId, command.role),
				appliedAt: command.updatedAt,
				revokedInvitationCount: 0
			}
		);
	}

	async setInstanceMemberStatus(
		command: SetInstanceMemberStatusCommand
	): Promise<SetInstanceMemberStatusStoreResult> {
		this.setStatusCommands.push(command);
		const scripted: SetInstanceMemberStatusStoreResult | undefined = this.#setStatusResults.shift();
		return (
			scripted ?? {
				outcome: 'updated',
				member: memberMetadata(command.targetUserId, 'member', command.status),
				appliedAt: command.updatedAt,
				revokedInvitationCount: 0
			}
		);
	}

	async bootstrapInstance(): Promise<BootstrapInstanceStoreResult> {
		return { outcome: 'integrity_error' };
	}

	async getInstanceCallerContext(): Promise<InstanceCallerContext> {
		return { member: null, bootstrapped: false };
	}

	async createInstanceInvitation(
		command: CreateInstanceInvitationCommand
	): Promise<CreateInstanceInvitationStoreResult> {
		return {
			outcome: 'created',
			invitation: {
				id: command.invitationId,
				role: command.role,
				status: 'pending',
				invitedByUserId: command.actor.id,
				createdAt: command.createdAt,
				expiresAt: command.expiresAt,
				acceptedAt: null,
				acceptedByUserId: null,
				revokedAt: null,
				revokedByUserId: null
			}
		};
	}

	async listInstanceInvitations(
		actor: InstanceActor,
		query: InstanceInvitationListQuery
	): Promise<ListInstanceInvitationsStoreResult> {
		void actor;
		void query;
		return { outcome: 'listed', page: { items: [], nextCursor: null } };
	}

	async acceptInstanceInvitation(
		command: AcceptInstanceInvitationCommand
	): Promise<AcceptInstanceInvitationStoreResult> {
		void command;
		return { outcome: 'invitation_invalid' };
	}

	async revokeInstanceInvitation(
		command: RevokeInstanceInvitationCommand
	): Promise<RevokeInstanceInvitationStoreResult> {
		void command;
		return { outcome: 'invitation_invalid' };
	}
}

function memberMetadata(
	userId: string,
	role: 'owner' | 'admin' | 'member',
	status: 'active' | 'suspended' = 'active'
): InstanceMemberMetadata {
	return {
		userId,
		role,
		status,
		createdAt: '2026-09-01T00:00:00.000Z',
		updatedAt: NOW.toISOString()
	};
}

function createTestApp(
	store: FakeInstanceStore,
	options: { now?: Date | (() => Date) } = {}
): InstanceMemberApplication {
	const fixedNow: Date = typeof options.now === 'function' ? NOW : (options.now ?? NOW);
	const clock: () => Date = typeof options.now === 'function' ? options.now : (): Date => fixedNow;
	return new InstanceMemberApplication({ store, now: clock });
}

describe('InstanceMemberApplication', () => {
	describe('list', () => {
		it('validates, clamps limits to [1..100] and passes cursor to store', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			await app.list(ACTOR);
			expect(store.listCalls).toHaveLength(1);
			expect(store.listCalls[0].query).toEqual({
				cursor: null,
				limit: DEFAULT_INSTANCE_MEMBER_LIST_LIMIT
			});

			const input: ListInstanceMembersInput = { cursor: 'cursor-1', limit: 200 };
			await app.list(ACTOR, input);
			expect(store.listCalls[1].query).toEqual({
				cursor: 'cursor-1',
				limit: MAX_INSTANCE_MEMBER_LIST_LIMIT
			});

			await app.list(ACTOR, { limit: 0 });
			expect(store.listCalls[2].query.limit).toBe(1);

			await app.list(ACTOR, { limit: -5 });
			expect(store.listCalls[3].query.limit).toBe(1);

			await app.list(ACTOR, { limit: Number.NaN });
			expect(store.listCalls[4].query.limit).toBe(1);

			await app.list(ACTOR, { limit: 50 });
			expect(store.listCalls[5].query.limit).toBe(50);
		});

		it('forwards store results, including forbidden and member_suspended', async () => {
			const page: InstanceMemberListPage = {
				items: [memberMetadata(TARGET_USER_ID, 'member')],
				nextCursor: 'next-cur'
			};
			const store = new FakeInstanceStore([
				{ outcome: 'listed', page },
				{ outcome: 'forbidden' },
				{ outcome: 'member_suspended' }
			]);
			const app = createTestApp(store);

			expect(await app.list(ACTOR)).toEqual({ outcome: 'listed', page });
			expect(await app.list(ACTOR)).toEqual({ outcome: 'forbidden' });
			expect(await app.list(ACTOR)).toEqual({ outcome: 'member_suspended' });
		});

		it('rejects an invalid actor before calling the store', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			await expect(app.list({ id: '' })).rejects.toThrow(InvalidInstanceMemberRequestError);
			await expect(app.list({ id: 'x'.repeat(201) })).rejects.toThrow(
				InvalidInstanceMemberRequestError
			);
			expect(store.listCalls).toHaveLength(0);
		});
	});

	describe('setRole', () => {
		it('normalizes role, fingerprints canonical {operation, targetUserId, role}, and calls store', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			const input: SetInstanceMemberRoleInput = {
				idempotencyKey: 'role-idemp-1',
				targetUserId: TARGET_USER_ID,
				role: '  Admin  '
			};

			const result = await app.setRole(ACTOR, input);
			expect(result.outcome).toBe('updated');

			expect(store.setRoleCommands).toHaveLength(1);
			const command = store.setRoleCommands[0];
			expect(command.actor).toEqual({ type: 'user', id: 'admin-user-1' });
			expect(command.idempotencyKey).toBe('role-idemp-1');
			expect(command.targetUserId).toBe(TARGET_USER_ID);
			expect(command.role).toBe('admin');
			expect(command.updatedAt).toBe(NOW.toISOString());

			const expectedFingerprint = await sha256Hex(
				canonicalJson({ operation: 'setRole', targetUserId: TARGET_USER_ID, role: 'admin' })
			);
			expect(command.requestFingerprint).toBe(expectedFingerprint);
		});

		it('permits self-targeting (owner floor is enforced by the store)', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			const result = await app.setRole(ACTOR, {
				idempotencyKey: 'role-self-1',
				targetUserId: ACTOR.id,
				role: 'admin'
			});

			expect(result.outcome).toBe('updated');
			expect(store.setRoleCommands).toHaveLength(1);
			expect(store.setRoleCommands[0].targetUserId).toBe(ACTOR.id);
		});

		it('passes through updated and replayed outcomes without overwriting receipt-recorded state', async () => {
			const originalAppliedAt = '2026-09-01T08:00:00.000Z';
			const replayedMember = memberMetadata(TARGET_USER_ID, 'admin');
			const store = new FakeInstanceStore(
				[],
				[
					{
						outcome: 'replayed',
						member: replayedMember,
						appliedAt: originalAppliedAt,
						revokedInvitationCount: 2
					}
				]
			);
			const app = createTestApp(store);

			const result = await app.setRole(ACTOR, {
				idempotencyKey: 'role-replay-1',
				targetUserId: TARGET_USER_ID,
				role: 'admin'
			});

			expect(result.outcome).toBe('replayed');
			if (result.outcome === 'replayed') {
				expect(result.appliedAt).toBe(originalAppliedAt);
				expect(result.appliedAt).not.toBe(NOW.toISOString());
				expect(result.revokedInvitationCount).toBe(2);
				expect(result.member).toEqual(replayedMember);
			}
		});

		it('forwards other setRole store outcomes', async () => {
			const outcomes: SetInstanceMemberRoleStoreResult[] = [
				{ outcome: 'forbidden' },
				{ outcome: 'member_suspended' },
				{ outcome: 'role_not_permitted' },
				{ outcome: 'member_not_found' },
				{ outcome: 'last_active_owner' },
				{ outcome: 'idempotency_conflict' },
				{ outcome: 'integrity_error' }
			];

			for (const storeResult of outcomes) {
				const store = new FakeInstanceStore([], [storeResult]);
				const app = createTestApp(store);

				const result = await app.setRole(ACTOR, {
					idempotencyKey: 'key',
					targetUserId: TARGET_USER_ID,
					role: 'member'
				});

				expect(result.outcome).toBe(storeResult.outcome);
				expect(store.setRoleCommands).toHaveLength(1);
			}
		});

		it('validates and rejects invalid inputs without calling the store', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			await expect(
				app.setRole(ACTOR, { idempotencyKey: '', targetUserId: TARGET_USER_ID, role: 'member' })
			).rejects.toThrow(InvalidInstanceMemberRequestError);

			await expect(
				app.setRole(ACTOR, {
					idempotencyKey: 'with space',
					targetUserId: TARGET_USER_ID,
					role: 'member'
				})
			).rejects.toThrow(InvalidInstanceMemberRequestError);

			await expect(
				app.setRole(ACTOR, { idempotencyKey: 'key', targetUserId: '', role: 'member' })
			).rejects.toThrow(InvalidInstanceMemberRequestError);

			await expect(
				app.setRole(ACTOR, {
					idempotencyKey: 'key',
					targetUserId: 'x'.repeat(201),
					role: 'member'
				})
			).rejects.toThrow(InvalidInstanceMemberRequestError);

			await expect(
				app.setRole(ACTOR, { idempotencyKey: 'key', targetUserId: TARGET_USER_ID, role: 'king' })
			).rejects.toThrow(InvalidInstanceMemberRequestError);

			await expect(
				app.setRole(
					{ id: '' },
					{ idempotencyKey: 'key', targetUserId: TARGET_USER_ID, role: 'member' }
				)
			).rejects.toThrow(InvalidInstanceMemberRequestError);

			expect(store.setRoleCommands).toHaveLength(0);
		});
	});

	describe('setStatus', () => {
		it('normalizes status, fingerprints canonical {operation, targetUserId, status}, and calls store', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			const input: SetInstanceMemberStatusInput = {
				idempotencyKey: 'status-idemp-1',
				targetUserId: TARGET_USER_ID,
				status: '  Suspended  '
			};

			const result = await app.setStatus(ACTOR, input);
			expect(result.outcome).toBe('updated');

			expect(store.setStatusCommands).toHaveLength(1);
			const command = store.setStatusCommands[0];
			expect(command.actor).toEqual({ type: 'user', id: 'admin-user-1' });
			expect(command.idempotencyKey).toBe('status-idemp-1');
			expect(command.targetUserId).toBe(TARGET_USER_ID);
			expect(command.status).toBe('suspended');
			expect(command.updatedAt).toBe(NOW.toISOString());

			const expectedFingerprint = await sha256Hex(
				canonicalJson({
					operation: 'setStatus',
					targetUserId: TARGET_USER_ID,
					status: 'suspended'
				})
			);
			expect(command.requestFingerprint).toBe(expectedFingerprint);
		});

		it('rejects self-targeting before ever calling the store', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			const result = await app.setStatus(ACTOR, {
				idempotencyKey: 'status-self-1',
				targetUserId: ACTOR.id,
				status: 'suspended'
			});

			expect(result).toEqual({ outcome: 'cannot_target_self' });
			expect(store.setStatusCommands).toHaveLength(0);
		});

		it('passes through updated and replayed outcomes without overwriting receipt-recorded state', async () => {
			const originalAppliedAt = '2026-09-01T08:00:00.000Z';
			const replayedMember = memberMetadata(TARGET_USER_ID, 'member', 'suspended');
			const store = new FakeInstanceStore(
				[],
				[],
				[
					{
						outcome: 'replayed',
						member: replayedMember,
						appliedAt: originalAppliedAt,
						revokedInvitationCount: 1
					}
				]
			);
			const app = createTestApp(store);

			const result = await app.setStatus(ACTOR, {
				idempotencyKey: 'status-replay-1',
				targetUserId: TARGET_USER_ID,
				status: 'suspended'
			});

			expect(result.outcome).toBe('replayed');
			if (result.outcome === 'replayed') {
				expect(result.appliedAt).toBe(originalAppliedAt);
				expect(result.appliedAt).not.toBe(NOW.toISOString());
				expect(result.revokedInvitationCount).toBe(1);
				expect(result.member).toEqual(replayedMember);
			}
		});

		it('forwards other setStatus store outcomes', async () => {
			const outcomes: SetInstanceMemberStatusStoreResult[] = [
				{ outcome: 'forbidden' },
				{ outcome: 'member_suspended' },
				{ outcome: 'member_not_found' },
				{ outcome: 'last_active_owner' },
				{ outcome: 'idempotency_conflict' },
				{ outcome: 'integrity_error' }
			];

			for (const storeResult of outcomes) {
				const store = new FakeInstanceStore([], [], [storeResult]);
				const app = createTestApp(store);

				const result = await app.setStatus(ACTOR, {
					idempotencyKey: 'key',
					targetUserId: TARGET_USER_ID,
					status: 'active'
				});

				expect(result.outcome).toBe(storeResult.outcome);
				expect(store.setStatusCommands).toHaveLength(1);
			}
		});

		it('validates and rejects invalid inputs without calling the store', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			await expect(
				app.setStatus(ACTOR, { idempotencyKey: '', targetUserId: TARGET_USER_ID, status: 'active' })
			).rejects.toThrow(InvalidInstanceMemberRequestError);

			await expect(
				app.setStatus(ACTOR, { idempotencyKey: 'key', targetUserId: '', status: 'active' })
			).rejects.toThrow(InvalidInstanceMemberRequestError);

			await expect(
				app.setStatus(ACTOR, {
					idempotencyKey: 'key',
					targetUserId: 'x'.repeat(201),
					status: 'active'
				})
			).rejects.toThrow(InvalidInstanceMemberRequestError);

			await expect(
				app.setStatus(ACTOR, {
					idempotencyKey: 'key',
					targetUserId: TARGET_USER_ID,
					status: 'dormant'
				})
			).rejects.toThrow(InvalidInstanceMemberRequestError);

			await expect(
				app.setStatus(
					{ id: '' },
					{ idempotencyKey: 'key', targetUserId: TARGET_USER_ID, status: 'active' }
				)
			).rejects.toThrow(InvalidInstanceMemberRequestError);

			expect(store.setStatusCommands).toHaveLength(0);
		});
	});

	describe('fingerprint separation across operation, target, and value', () => {
		it('produces different fingerprints when only the operation differs', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			await app.setRole(ACTOR, {
				idempotencyKey: 'op-1',
				targetUserId: TARGET_USER_ID,
				role: 'admin'
			});
			await app.setStatus(ACTOR, {
				idempotencyKey: 'op-2',
				targetUserId: 'other-user',
				status: 'suspended'
			});

			// Both hash different logical payloads by construction (different keys),
			// but pin each to its own exact expected fingerprint to prove the
			// 'operation' discriminator is actually part of the hashed payload.
			const roleFingerprint = store.setRoleCommands[0].requestFingerprint;
			const statusFingerprint = store.setStatusCommands[0].requestFingerprint;

			expect(roleFingerprint).toBe(
				await sha256Hex(
					canonicalJson({ operation: 'setRole', targetUserId: TARGET_USER_ID, role: 'admin' })
				)
			);
			expect(statusFingerprint).toBe(
				await sha256Hex(
					canonicalJson({
						operation: 'setStatus',
						targetUserId: 'other-user',
						status: 'suspended'
					})
				)
			);
			expect(roleFingerprint).not.toBe(statusFingerprint);
		});

		it('produces different fingerprints when only the target differs', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			await app.setRole(ACTOR, {
				idempotencyKey: 'target-1',
				targetUserId: 'user-a',
				role: 'member'
			});
			await app.setRole(ACTOR, {
				idempotencyKey: 'target-2',
				targetUserId: 'user-b',
				role: 'member'
			});

			expect(store.setRoleCommands[0].requestFingerprint).not.toBe(
				store.setRoleCommands[1].requestFingerprint
			);
		});

		it('produces different fingerprints when only the value differs', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			await app.setRole(ACTOR, {
				idempotencyKey: 'value-1',
				targetUserId: TARGET_USER_ID,
				role: 'member'
			});
			await app.setRole(ACTOR, {
				idempotencyKey: 'value-2',
				targetUserId: TARGET_USER_ID,
				role: 'admin'
			});

			expect(store.setRoleCommands[0].requestFingerprint).not.toBe(
				store.setRoleCommands[1].requestFingerprint
			);

			const store2 = new FakeInstanceStore();
			const app2 = createTestApp(store2);

			await app2.setStatus(ACTOR, {
				idempotencyKey: 'value-3',
				targetUserId: TARGET_USER_ID,
				status: 'active'
			});
			await app2.setStatus(ACTOR, {
				idempotencyKey: 'value-4',
				targetUserId: TARGET_USER_ID,
				status: 'suspended'
			});

			expect(store2.setStatusCommands[0].requestFingerprint).not.toBe(
				store2.setStatusCommands[1].requestFingerprint
			);
		});
	});

	describe('aliases and dependency injection', () => {
		it('supports InstanceMemberService alias and method aliases', async () => {
			const store = new FakeInstanceStore();
			const service = new InstanceMemberService(store, () => NOW);

			const listRes = await service.listInstanceMembers(ACTOR);
			expect(listRes.outcome).toBe('listed');

			const roleRes = await service.setInstanceMemberRole(ACTOR, {
				idempotencyKey: 'alias-role-1',
				targetUserId: TARGET_USER_ID,
				role: 'admin'
			});
			expect(roleRes.outcome).toBe('updated');

			const statusRes = await service.setInstanceMemberStatus(ACTOR, {
				idempotencyKey: 'alias-status-1',
				targetUserId: TARGET_USER_ID,
				status: 'suspended'
			});
			expect(statusRes.outcome).toBe('updated');
		});

		it('supports constructor with positional arguments', () => {
			const store = new FakeInstanceStore();
			const app = new InstanceMemberApplication(store);
			expect(app).toBeDefined();
		});
	});
});
