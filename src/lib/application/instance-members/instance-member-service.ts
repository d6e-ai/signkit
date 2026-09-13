import {
	boundInstanceMemberListLimit,
	DEFAULT_INSTANCE_MEMBER_LIST_LIMIT,
	isInstanceIdempotencyKey,
	isInstanceMemberRole,
	isInstanceMemberStatus,
	type InstanceActor,
	type InstanceMemberListQuery,
	type InstanceMemberRole,
	type InstanceMemberStatus,
	type InstanceStore,
	type ListInstanceMembersStoreResult,
	type SetInstanceMemberRoleCommand,
	type SetInstanceMemberRoleStoreResult,
	type SetInstanceMemberStatusCommand,
	type SetInstanceMemberStatusStoreResult
} from '$lib/ports/instance-store';
import { canonicalJson, sha256Hex } from '$lib/application/instance/instance-command-fingerprint';

/**
 * Caller identity representation. Accepts either the full port `InstanceActor`
 * (`{ type: 'user', id }`) or an actor with `id` and optional `type: 'user'`.
 */
export interface InstanceMemberActor {
	id: string;
	type?: 'user';
}

export interface ListInstanceMembersInput {
	cursor?: string | null;
	limit?: number;
}

export type ListInstanceMembersResult = ListInstanceMembersStoreResult;

export interface SetInstanceMemberRoleInput {
	idempotencyKey: string;
	targetUserId: string;
	role: InstanceMemberRole | string;
}

export type SetInstanceMemberRoleResult = SetInstanceMemberRoleStoreResult;

export interface SetInstanceMemberStatusInput {
	idempotencyKey: string;
	targetUserId: string;
	status: InstanceMemberStatus | string;
}

export type SetInstanceMemberStatusResult = SetInstanceMemberStatusStoreResult;

export interface InstanceMemberApplicationPort {
	list(
		actor: InstanceMemberActor,
		query?: ListInstanceMembersInput
	): Promise<ListInstanceMembersResult>;
	listInstanceMembers(
		actor: InstanceMemberActor,
		query?: ListInstanceMembersInput
	): Promise<ListInstanceMembersResult>;
	setRole(
		actor: InstanceMemberActor,
		input: SetInstanceMemberRoleInput
	): Promise<SetInstanceMemberRoleResult>;
	setInstanceMemberRole(
		actor: InstanceMemberActor,
		input: SetInstanceMemberRoleInput
	): Promise<SetInstanceMemberRoleResult>;
	setStatus(
		actor: InstanceMemberActor,
		input: SetInstanceMemberStatusInput
	): Promise<SetInstanceMemberStatusResult>;
	setInstanceMemberStatus(
		actor: InstanceMemberActor,
		input: SetInstanceMemberStatusInput
	): Promise<SetInstanceMemberStatusResult>;
}

export type InstanceMemberServicePort = InstanceMemberApplicationPort;

export class InvalidInstanceMemberRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidInstanceMemberRequestError';
	}
}

export interface InstanceMemberApplicationDependencies {
	readonly store: InstanceStore;
	readonly now?: () => Date;
}

/**
 * Pure application service coordinating zero-PII instance member
 * administration workflows:
 *
 * - `list`: validates/clamps limits and passes pagination cursor to store.
 * - `setRole`: validates/normalizes the target id and role, fingerprints the
 *   canonical `{ operation, targetUserId, role }` triple (zero-PII), and
 *   forwards the command. Self-targeting is left to the store's owner-floor
 *   check (`last_active_owner`).
 * - `setStatus`: validates/normalizes the target id and status, rejects
 *   self-targeting before ever reaching the store, and otherwise fingerprints
 *   the canonical `{ operation, targetUserId, status }` triple and forwards
 *   the command.
 *
 * All three pass store outcomes straight through: `updated` and `replayed`
 * already carry the receipt-recorded `appliedAt` and `revokedInvitationCount`
 * from the store, so this layer never recomputes or overwrites replayed
 * state with a fresh clock reading.
 */
export class InstanceMemberApplication implements InstanceMemberApplicationPort {
	private readonly store: InstanceStore;
	private readonly now: () => Date;

	constructor(
		storeOrDependencies: InstanceStore | InstanceMemberApplicationDependencies,
		now: () => Date = (): Date => new Date()
	) {
		if (
			'store' in storeOrDependencies &&
			typeof (storeOrDependencies as InstanceMemberApplicationDependencies).store === 'object' &&
			(storeOrDependencies as InstanceMemberApplicationDependencies).store !== null
		) {
			const deps: InstanceMemberApplicationDependencies =
				storeOrDependencies as InstanceMemberApplicationDependencies;
			this.store = deps.store;
			this.now = deps.now ?? ((): Date => new Date());
		} else {
			this.store = storeOrDependencies as InstanceStore;
			this.now = now;
		}
	}

	async list(
		actor: InstanceMemberActor,
		query: ListInstanceMembersInput = {}
	): Promise<ListInstanceMembersResult> {
		const commandActor: InstanceActor = assertActor(actor);
		const limit: number =
			typeof query?.limit === 'number'
				? boundInstanceMemberListLimit(query.limit)
				: DEFAULT_INSTANCE_MEMBER_LIST_LIMIT;
		const cursor: string | null = query?.cursor ?? null;

		const listQuery: InstanceMemberListQuery = {
			cursor,
			limit
		};

		return await this.store.listInstanceMembers(commandActor, listQuery);
	}

	async listInstanceMembers(
		actor: InstanceMemberActor,
		query: ListInstanceMembersInput = {}
	): Promise<ListInstanceMembersResult> {
		return this.list(actor, query);
	}

	async setRole(
		actor: InstanceMemberActor,
		input: SetInstanceMemberRoleInput
	): Promise<SetInstanceMemberRoleResult> {
		const commandActor: InstanceActor = assertActor(actor);
		const idempotencyKey: string = assertIdempotencyKey(input.idempotencyKey);
		const targetUserId: string = assertTargetUserId(input.targetUserId);
		const role: InstanceMemberRole = normalizeRole(input.role);

		const updatedAt: string = this.now().toISOString();
		const requestFingerprint: string = await sha256Hex(
			canonicalJson({ operation: 'setRole', targetUserId, role })
		);

		const command: SetInstanceMemberRoleCommand = {
			actor: commandActor,
			idempotencyKey,
			requestFingerprint,
			targetUserId,
			role,
			updatedAt
		};

		return await this.store.setInstanceMemberRole(command);
	}

	async setInstanceMemberRole(
		actor: InstanceMemberActor,
		input: SetInstanceMemberRoleInput
	): Promise<SetInstanceMemberRoleResult> {
		return this.setRole(actor, input);
	}

	async setStatus(
		actor: InstanceMemberActor,
		input: SetInstanceMemberStatusInput
	): Promise<SetInstanceMemberStatusResult> {
		const commandActor: InstanceActor = assertActor(actor);
		const idempotencyKey: string = assertIdempotencyKey(input.idempotencyKey);
		const targetUserId: string = assertTargetUserId(input.targetUserId);
		const status: InstanceMemberStatus = normalizeStatus(input.status);

		if (targetUserId === commandActor.id) {
			return { outcome: 'cannot_target_self' };
		}

		const updatedAt: string = this.now().toISOString();
		const requestFingerprint: string = await sha256Hex(
			canonicalJson({ operation: 'setStatus', targetUserId, status })
		);

		const command: SetInstanceMemberStatusCommand = {
			actor: commandActor,
			idempotencyKey,
			requestFingerprint,
			targetUserId,
			status,
			updatedAt
		};

		return await this.store.setInstanceMemberStatus(command);
	}

	async setInstanceMemberStatus(
		actor: InstanceMemberActor,
		input: SetInstanceMemberStatusInput
	): Promise<SetInstanceMemberStatusResult> {
		return this.setStatus(actor, input);
	}
}

export { InstanceMemberApplication as InstanceMemberService };

function assertActor(actor: InstanceMemberActor): InstanceActor {
	if (!actor || typeof actor.id !== 'string' || actor.id.length < 1 || actor.id.length > 200) {
		throw new InvalidInstanceMemberRequestError('Invalid actor user identifier.');
	}
	if (actor.type !== undefined && actor.type !== 'user') {
		throw new InvalidInstanceMemberRequestError('Invalid actor user identifier.');
	}
	return { type: 'user', id: actor.id };
}

function assertTargetUserId(id: unknown): string {
	if (typeof id !== 'string' || id.length < 1 || id.length > 200) {
		throw new InvalidInstanceMemberRequestError('Invalid target user identifier.');
	}
	return id;
}

function assertIdempotencyKey(key: unknown): string {
	if (typeof key !== 'string' || !isInstanceIdempotencyKey(key)) {
		throw new InvalidInstanceMemberRequestError(
			'Idempotency-Key must contain visible ASCII characters only.'
		);
	}
	return key;
}

function normalizeRole(role: unknown): InstanceMemberRole {
	if (typeof role !== 'string') {
		throw new InvalidInstanceMemberRequestError('Invalid instance member role');
	}
	const trimmed: string = role.trim().toLowerCase();
	if (!isInstanceMemberRole(trimmed)) {
		throw new InvalidInstanceMemberRequestError('Invalid instance member role');
	}
	return trimmed;
}

function normalizeStatus(status: unknown): InstanceMemberStatus {
	if (typeof status !== 'string') {
		throw new InvalidInstanceMemberRequestError('Invalid instance member status');
	}
	const trimmed: string = status.trim().toLowerCase();
	if (!isInstanceMemberStatus(trimmed)) {
		throw new InvalidInstanceMemberRequestError('Invalid instance member status');
	}
	return trimmed;
}
