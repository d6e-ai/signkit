import type { InstanceActor } from './instance-store';

/** Display-only, authorized admin-list projection. Never an authorization input. */
export type MemberDisplay =
	| {
			state: 'available';
			name: string;
			email: string;
			observedAt: string;
			expiresAt: string;
	  }
	| { state: 'unavailable' };

/** A historical accepting member is distinct from the original invitation target. */
export type InvitationDisplay =
	| { state: 'pending'; email: string }
	| { state: 'accepted'; member: MemberDisplay }
	| { state: 'redacted' }
	| { state: 'unavailable' };

export type RecordMemberDisplaySnapshotResult =
	{ outcome: 'recorded' } | { outcome: 'unchanged' } | { outcome: 'skipped' };

export interface RecordMemberDisplaySnapshotCommand {
	userId: string;
	sealedPayload: string;
	sealingKeyId: string;
	observedAt: string;
	expiresAt: string;
	storedAt: string;
}

export interface InstanceMemberDisplayRow {
	userId: string;
	sealedPayload: string;
	sealingKeyId: string;
	observedAt: string;
	expiresAt: string;
	storedAt: string;
}

export interface InstanceInvitationDisplayRow {
	invitationId: string;
	sealedPayload: string;
	sealingKeyId: string;
	createdAt: string;
	expiresAt: string;
}

export type ListInstanceDisplayRowsResult<T> =
	| { outcome: 'listed'; rows: readonly T[] }
	| { outcome: 'forbidden' }
	| { outcome: 'member_suspended' };

export interface InstanceDisplayCleanupResult {
	expired: number;
	deleted: number;
}

export interface CasResealMemberDisplayCommand {
	userId: string;
	previousSealingKeyId: string;
	previousObservedAt: string;
	previousExpiresAt: string;
	previousSealedPayload: string;
	sealedPayload: string;
	sealingKeyId: string;
	storedAt: string;
}

export interface CasResealInvitationDisplayCommand {
	invitationId: string;
	previousSealingKeyId: string;
	previousSealedPayload: string;
	sealedPayload: string;
	sealingKeyId: string;
	now: string;
}

export interface DeferMemberDisplayResealCommand {
	userId: string;
	previousSealingKeyId: string;
	previousObservedAt: string;
	previousExpiresAt: string;
	previousSealedPayload: string;
	now: string;
}

export interface DeferInvitationDisplayResealCommand {
	invitationId: string;
	previousSealingKeyId: string;
	previousSealedPayload: string;
	now: string;
}

export type CasResealDisplayResult = 'resealed' | 'stale';
export type DeferDisplayResealResult = 'deferred' | 'stale';

/**
 * Encrypted instance display persistence. Authorization for list reads is an
 * independent active owner/admin check; capture writes are the named active
 * member only. Ciphertext is never returned through public metadata ports.
 */
export interface InstanceDisplayStore {
	recordMemberSnapshot(
		command: RecordMemberDisplaySnapshotCommand
	): Promise<RecordMemberDisplaySnapshotResult>;
	listMemberDisplayRows(
		actor: InstanceActor,
		userIds: readonly string[]
	): Promise<ListInstanceDisplayRowsResult<InstanceMemberDisplayRow>>;
	listInvitationDisplayRows(
		actor: InstanceActor,
		invitationIds: readonly string[]
	): Promise<ListInstanceDisplayRowsResult<InstanceInvitationDisplayRow>>;
	cleanupExpired(now: string, limit: number): Promise<InstanceDisplayCleanupResult>;
	findMemberRowsForReseal(
		previousSealingKeyId: string,
		now: string,
		limit: number
	): Promise<readonly InstanceMemberDisplayRow[]>;
	findInvitationRowsForReseal(
		previousSealingKeyId: string,
		now: string,
		limit: number
	): Promise<readonly InstanceInvitationDisplayRow[]>;
	casResealMemberSnapshot(command: CasResealMemberDisplayCommand): Promise<CasResealDisplayResult>;
	casResealInvitationTarget(
		command: CasResealInvitationDisplayCommand
	): Promise<CasResealDisplayResult>;
	deferMemberReseal(command: DeferMemberDisplayResealCommand): Promise<DeferDisplayResealResult>;
	deferInvitationReseal(
		command: DeferInvitationDisplayResealCommand
	): Promise<DeferDisplayResealResult>;
}

export function uniqueBoundedDisplayIds(ids: readonly string[], limit: number): string[] {
	const unique: string[] = [];
	const seen: Set<string> = new Set();
	for (const id of ids) {
		if (id.length < 1 || id.length > 200 || seen.has(id)) continue;
		seen.add(id);
		unique.push(id);
		if (unique.length >= limit) break;
	}
	return unique;
}
