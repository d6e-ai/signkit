import { describe, expect, it } from 'vitest';
import type {
	AcceptInstanceInvitationCommand,
	AcceptInstanceInvitationStoreResult,
	BootstrapInstanceCommand,
	BootstrapInstanceStoreResult,
	CreateInstanceInvitationCommand,
	CreateInstanceInvitationStoreResult,
	InstanceActor,
	InstanceCallerContext,
	InstanceInvitationListQuery,
	InstanceMemberListQuery,
	InstanceStore,
	ListInstanceInvitationsStoreResult,
	ListInstanceMembersStoreResult,
	RevokeInstanceInvitationCommand,
	RevokeInstanceInvitationStoreResult,
	SetInstanceMemberRoleCommand,
	SetInstanceMemberRoleStoreResult,
	SetInstanceMemberStatusCommand,
	SetInstanceMemberStatusStoreResult
} from '$lib/ports/instance-store';
import { InstanceApplication, InvalidInstanceBootstrapRequestError } from './instance-service';

const NOW: Date = new Date('2026-09-12T12:00:00.000Z');
const EXPECTED_HASH: string = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'; // SHA-256 of "{}"

class MockInstanceStore implements InstanceStore {
	lastCommand: BootstrapInstanceCommand | null = null;
	lastUserId: string | null = null;
	lastIdentityRefresh: { userId: string; displayName: string | null; email: string | null } | null =
		null;
	bootstrapResult: BootstrapInstanceStoreResult = {
		outcome: 'bootstrapped',
		member: {
			userId: 'user-1',
			role: 'owner',
			status: 'active',
			createdAt: NOW.toISOString(),
			updatedAt: NOW.toISOString()
		}
	};
	callerContext: InstanceCallerContext = {
		member: null,
		bootstrapped: false
	};

	async bootstrapInstance(
		command: BootstrapInstanceCommand
	): Promise<BootstrapInstanceStoreResult> {
		this.lastCommand = command;
		return this.bootstrapResult;
	}

	async getInstanceCallerContext(userId: string): Promise<InstanceCallerContext> {
		this.lastUserId = userId;
		return this.callerContext;
	}

	async refreshInstanceMemberIdentity(command: {
		userId: string;
		identity: { displayName: string | null; email: string | null };
	}): Promise<void> {
		this.lastIdentityRefresh = { userId: command.userId, ...command.identity };
	}

	async createInstanceInvitation(
		command: CreateInstanceInvitationCommand
	): Promise<CreateInstanceInvitationStoreResult> {
		void command;
		return { outcome: 'forbidden' };
	}

	async listInstanceInvitations(
		actor: InstanceActor,
		query: InstanceInvitationListQuery
	): Promise<ListInstanceInvitationsStoreResult> {
		void actor;
		void query;
		return { outcome: 'forbidden' };
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
		return { outcome: 'forbidden' };
	}

	async listInstanceMembers(
		actor: InstanceActor,
		query: InstanceMemberListQuery
	): Promise<ListInstanceMembersStoreResult> {
		void actor;
		void query;
		return { outcome: 'forbidden' };
	}

	async setInstanceMemberRole(
		command: SetInstanceMemberRoleCommand
	): Promise<SetInstanceMemberRoleStoreResult> {
		void command;
		return { outcome: 'forbidden' };
	}

	async setInstanceMemberStatus(
		command: SetInstanceMemberStatusCommand
	): Promise<SetInstanceMemberStatusStoreResult> {
		void command;
		return { outcome: 'forbidden' };
	}
}

describe('InstanceApplication', () => {
	it('calculates request fingerprint over empty body and invokes store', async () => {
		const store = new MockInstanceStore();
		const app = new InstanceApplication(store, () => NOW);

		const result = await app.bootstrapInstance(
			{ id: 'user-1' },
			{ idempotencyKey: 'valid-idem-key' }
		);

		expect(result).toEqual(store.bootstrapResult);
		expect(store.lastCommand).toEqual({
			actor: { type: 'user', id: 'user-1' },
			identity: { displayName: null, email: null },
			idempotencyKey: 'valid-idem-key',
			requestFingerprint: EXPECTED_HASH,
			createdAt: NOW.toISOString()
		});
	});

	it('rejects invalid actor identifier', async () => {
		const store = new MockInstanceStore();
		const app = new InstanceApplication(store, () => NOW);

		await expect(
			app.bootstrapInstance({ id: '' }, { idempotencyKey: 'valid-idem-key' })
		).rejects.toThrow(InvalidInstanceBootstrapRequestError);

		await expect(
			app.bootstrapInstance({ id: 'x'.repeat(201) }, { idempotencyKey: 'valid-idem-key' })
		).rejects.toThrow(InvalidInstanceBootstrapRequestError);
	});

	it('rejects malformed idempotency keys', async () => {
		const store = new MockInstanceStore();
		const app = new InstanceApplication(store, () => NOW);

		await expect(app.bootstrapInstance({ id: 'user-1' }, { idempotencyKey: '' })).rejects.toThrow(
			InvalidInstanceBootstrapRequestError
		);

		await expect(
			app.bootstrapInstance({ id: 'user-1' }, { idempotencyKey: 'has space' })
		).rejects.toThrow(InvalidInstanceBootstrapRequestError);

		await expect(
			app.bootstrapInstance({ id: 'user-1' }, { idempotencyKey: 'x'.repeat(201) })
		).rejects.toThrow(InvalidInstanceBootstrapRequestError);
	});

	it('forwards getCurrentMember to store', async () => {
		const store = new MockInstanceStore();
		store.callerContext = {
			member: {
				userId: 'user-1',
				role: 'owner',
				status: 'active',
				createdAt: NOW.toISOString(),
				updatedAt: NOW.toISOString()
			},
			bootstrapped: true
		};
		const app = new InstanceApplication(store, () => NOW);

		const context = await app.getCurrentMember({ id: 'user-1' });
		expect(context).toEqual(store.callerContext);
		expect(store.lastUserId).toBe('user-1');
	});

	it('refreshes bounded display-only identity snapshots for an existing member', async () => {
		const store = new MockInstanceStore();
		store.callerContext = {
			member: {
				userId: 'user-1',
				role: 'owner',
				status: 'active',
				createdAt: NOW.toISOString(),
				updatedAt: NOW.toISOString()
			},
			bootstrapped: true
		};
		const app = new InstanceApplication(store, () => NOW);

		await app.getCurrentMember({
			id: 'user-1',
			displayName: '  KIMURA Yu  ',
			email: '  YU.KIMURA@CAUCHYE.COM '
		});

		expect(store.lastIdentityRefresh).toEqual({
			userId: 'user-1',
			displayName: 'KIMURA Yu',
			email: 'yu.kimura@cauchye.com'
		});
	});
});
