export const INSTANCE_IDEMPOTENCY_KEY_PATTERN: RegExp = /^[!-~]{1,200}$/;

export type InstanceActorType = 'user';

export interface InstanceActor {
	type: InstanceActorType;
	id: string;
}

export type InstanceMemberRole = 'owner' | 'admin' | 'member';
export type InstanceMemberStatus = 'active' | 'suspended';

export interface InstanceMemberMetadata {
	userId: string;
	role: InstanceMemberRole;
	status: InstanceMemberStatus;
	createdAt: string;
	updatedAt: string;
}

export interface InstanceCallerContext {
	member: InstanceMemberMetadata | null;
	bootstrapped: boolean;
}

export interface BootstrapInstanceCommand {
	actor: InstanceActor;
	idempotencyKey: string;
	requestFingerprint: string;
	createdAt: string;
}

/**
 * Provider-independent bootstrap outcomes.
 *
 * - `bootstrapped`: the caller claimed the first active owner slot on an empty
 *   instance, recording the singleton bootstrap row and command receipt.
 * - `already_bootstrapped` (replayed: true): exact idempotent replay of the
 *   original bootstrap command under the same actor, Idempotency-Key, and
 *   request fingerprint. Safe replay returning current owner member metadata.
 * - `already_bootstrapped` (replayed: false): cross-subject attempt or fresh
 *   idempotency key against an already-bootstrapped or non-empty instance.
 * - `idempotency_conflict`: same actor and Idempotency-Key but different
 *   request fingerprint.
 * - `integrity_error`: the receipt and member/bootstrap rows disagree.
 */
export type BootstrapInstanceStoreResult =
	| { outcome: 'bootstrapped'; member: InstanceMemberMetadata }
	| { outcome: 'already_bootstrapped'; member: InstanceMemberMetadata; replayed: true }
	| { outcome: 'already_bootstrapped'; replayed: false }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'integrity_error' };

export interface InstanceStore {
	bootstrapInstance(command: BootstrapInstanceCommand): Promise<BootstrapInstanceStoreResult>;
	getInstanceCallerContext(userId: string): Promise<InstanceCallerContext>;
}

export function isInstanceIdempotencyKey(value: string): boolean {
	return INSTANCE_IDEMPOTENCY_KEY_PATTERN.test(value);
}

export function isInstanceMemberRole(value: unknown): value is InstanceMemberRole {
	return value === 'owner' || value === 'admin' || value === 'member';
}

export function isInstanceMemberStatus(value: unknown): value is InstanceMemberStatus {
	return value === 'active' || value === 'suspended';
}
