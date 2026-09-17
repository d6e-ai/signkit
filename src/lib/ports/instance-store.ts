import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';
import type { InstanceInvitationDeliveryLocale } from '$lib/security/instance-invitation-delivery-payload';

export const INSTANCE_IDEMPOTENCY_KEY_PATTERN: RegExp = /^[!-~]{1,200}$/;
/** Instance invitations are SignKit-owned, so their IDs are UUIDv7. */
export const INSTANCE_INVITATION_ID_PATTERN: RegExp = UUID_V7_PATTERN;
export const INSTANCE_INVITATION_DEFAULT_EXPIRY_DAYS: number = 7;
export const INSTANCE_INVITATION_MAX_EXPIRY_DAYS: number = 7;
export const INSTANCE_INVITATION_DEFAULT_EXPIRY_MS: number =
	INSTANCE_INVITATION_DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
export const INSTANCE_INVITATION_MAX_EXPIRY_MS: number =
	INSTANCE_INVITATION_MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
export const MAX_INSTANCE_INVITATION_LIST_LIMIT: number = 100;
export const DEFAULT_INSTANCE_INVITATION_LIST_LIMIT: number = 25;
/** Maximum number of simultaneously live (unexpired) pending invitations per instance. */
export const MAX_PENDING_INSTANCE_INVITATIONS: number = 200;
export const MAX_INSTANCE_MEMBER_LIST_LIMIT: number = 100;
export const DEFAULT_INSTANCE_MEMBER_LIST_LIMIT: number = 25;

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

export type InstanceInvitationStatus = 'pending' | 'accepted' | 'revoked';

/**
 * The only invitation projection any caller may observe. Zero-PII by
 * construction: no email, name, raw token, `tokenHash`, or `emailBinding`
 * column is ever exposed here. `status` and the accepted/revoked pairs below
 * are always mutually exclusive — see the durable schema's terminal
 * exclusivity constraint.
 */
export interface InstanceInvitationMetadata {
	id: string;
	role: InstanceMemberRole;
	status: InstanceInvitationStatus;
	invitedByUserId: string;
	createdAt: string;
	expiresAt: string;
	acceptedAt: string | null;
	acceptedByUserId: string | null;
	revokedAt: string | null;
	revokedByUserId: string | null;
}

/**
 * One create attempt. `tokenHash`/`emailBinding` are the only credential- and
 * email-derived values persisted; the plaintext `ski1_` token and the invited
 * address never reach this port. The actor is the inviter and must be a
 * currently active `owner` or `admin` instance member.
 */
export interface CreateInstanceInvitationCommand {
	actor: InstanceActor;
	idempotencyKey: string;
	requestFingerprint: string;
	previousRequestFingerprint?: string;
	invitationId: string;
	role: InstanceMemberRole;
	tokenHash: string;
	emailBinding: string;
	deliveryId: string;
	deliveryLocale: InstanceInvitationDeliveryLocale;
	sealedDeliveryPayload: string;
	deliverySealingKeyId: string;
	sealedDeliveryPayloadSha256: string;
	createdAt: string;
	expiresAt: string;
}

/**
 * Provider-independent create outcomes.
 *
 * - `created`: the invitation and its receipt landed atomically.
 * - `replayed`: an exact replay of the same request under the same
 *   Idempotency-Key. The one-time token cannot be recovered, so only the
 *   current metadata of the originally created invitation is returned.
 * - `forbidden`: the actor is not currently an active `owner` or `admin`
 *   member, so it may not invite anyone.
 * - `role_not_permitted`: the actor is an active `owner` or `admin` but may
 *   not grant the requested role (an `admin` inviting an `owner`, for
 *   example).
 * - `limit`: the instance already holds the maximum number of pending
 *   invitations.
 * - `idempotency_conflict`: the Idempotency-Key was reused for a different
 *   request, or the durable receipt cannot be proven against the invitation
 *   it references.
 * - `credential_collision`: candidate invitationId or tokenHash already exists
 *   without a matching idempotency receipt.
 * - `member_suspended`: the actor exists but is not `active`. Fail closed; no
 *   invitation or receipt is written.
 * - `integrity_error`: the receipt and invitation rows cannot be reconciled.
 */
export type CreateInstanceInvitationStoreResult =
	| { outcome: 'created'; invitation: InstanceInvitationMetadata }
	| { outcome: 'replayed'; invitation: InstanceInvitationMetadata }
	| { outcome: 'forbidden' }
	| { outcome: 'role_not_permitted' }
	| { outcome: 'limit' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'credential_collision' }
	| { outcome: 'member_suspended' }
	| { outcome: 'integrity_error' };

export interface InstanceInvitationListQuery {
	cursor: string | null;
	limit: number;
}

export interface InstanceInvitationListPage {
	items: readonly InstanceInvitationMetadata[];
	nextCursor: string | null;
}

/**
 * - `listed`: the page was resolved for a currently active `owner` or
 *   `admin` actor.
 * - `forbidden`: the actor is not currently an active `owner` or `admin`.
 * - `member_suspended`: the actor exists but is not `active`.
 */
export type ListInstanceInvitationsStoreResult =
	| { outcome: 'listed'; page: InstanceInvitationListPage }
	| { outcome: 'forbidden' }
	| { outcome: 'member_suspended' };

/**
 * One accept attempt. `tokenHash` locates the invitation; `emailBinding` is
 * recomputed by the caller from the bearer token and the asserted email and
 * must equal the stored value byte-for-byte. The actor is the accepting
 * user, who does not need to already be an instance member.
 */
export interface AcceptInstanceInvitationCommand {
	actor: InstanceActor;
	idempotencyKey: string;
	requestFingerprint: string;
	tokenHash: string;
	emailBinding: string;
	acceptedAt: string;
}

/**
 * Provider-independent accept outcomes.
 *
 * - `accepted`: the invitation was `pending` and unexpired, the email
 *   binding matched, and the actor was durably enrolled as an instance
 *   member with the invited role.
 * - `replayed`: an exact replay of the same request under the same
 *   Idempotency-Key, proven against the current invitation and member rows.
 * - `already_member`: no receipt matched, but the actor is already a
 *   currently active instance member. The invitation is neither consumed
 *   nor mutated and no receipt is written — an existing active member
 *   cannot re-accept an invitation into a different role or re-trigger
 *   enrollment side effects. Carries only the actor's own current member
 *   metadata, never invitation data (no token, tokenHash, or emailBinding),
 *   since the caller already knows their own membership.
 * - `invitation_invalid`: no invitation matches `tokenHash`, it is expired,
 *   it is not `pending`, or `emailBinding` does not match. Reported
 *   opaquely so an invalid token and a wrong email are indistinguishable.
 * - `idempotency_conflict`: the Idempotency-Key was reused for a different
 *   request.
 * - `member_suspended`: the actor already exists as a suspended instance
 *   member. Fail closed; the invitation is not consumed.
 * - `integrity_error`: the receipt and invitation/member rows disagree.
 */
export type AcceptInstanceInvitationStoreResult =
	| { outcome: 'accepted'; invitation: InstanceInvitationMetadata; member: InstanceMemberMetadata }
	| { outcome: 'replayed'; invitation: InstanceInvitationMetadata; member: InstanceMemberMetadata }
	| { outcome: 'already_member'; member: InstanceMemberMetadata }
	| { outcome: 'invitation_invalid' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'member_suspended' }
	| { outcome: 'integrity_error' };

export interface RevokeInstanceInvitationCommand {
	actor: InstanceActor;
	idempotencyKey: string;
	requestFingerprint: string;
	invitationId: string;
	revokedAt: string;
}

/**
 * Provider-independent revoke outcomes.
 *
 * - `revoked`: this call recorded the revocation plus the single revoke
 *   receipt for this invitation.
 * - `replayed`: an exact replay under the original Idempotency-Key, proven
 *   against the current invitation row.
 * - `forbidden`: the actor is not currently an active `owner` or `admin`.
 * - `invitation_invalid`: unknown invitation id, or a fresh Idempotency-Key
 *   against an invitation that is not `pending`.
 * - `idempotency_conflict`: the Idempotency-Key was reused for a different
 *   invitation or a different request fingerprint.
 * - `member_suspended`: the actor exists but is not `active`.
 * - `integrity_error`: the receipt and invitation rows disagree.
 */
export type RevokeInstanceInvitationStoreResult =
	| { outcome: 'revoked'; invitation: InstanceInvitationMetadata }
	| { outcome: 'replayed'; invitation: InstanceInvitationMetadata }
	| { outcome: 'forbidden' }
	| { outcome: 'invitation_invalid' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'member_suspended' }
	| { outcome: 'integrity_error' };

export interface InstanceMemberListQuery {
	cursor: string | null;
	limit: number;
}

export interface InstanceMemberListPage {
	items: readonly InstanceMemberMetadata[];
	nextCursor: string | null;
}

/**
 * - `listed`: the page was resolved for a currently active `owner` or
 *   `admin` actor.
 * - `forbidden`: the actor is not currently an active `owner` or `admin`.
 * - `member_suspended`: the actor exists but is not `active`.
 */
export type ListInstanceMembersStoreResult =
	| { outcome: 'listed'; page: InstanceMemberListPage }
	| { outcome: 'forbidden' }
	| { outcome: 'member_suspended' };

/**
 * One role-change attempt. The actor is the administrator; `targetUserId`
 * identifies the member whose role is being set. Self-targeting
 * (`targetUserId === actor.id`) is permitted, subject to the owner floor
 * captured by the `last_active_owner` outcome below.
 */
export interface SetInstanceMemberRoleCommand {
	actor: InstanceActor;
	idempotencyKey: string;
	requestFingerprint: string;
	targetUserId: string;
	role: InstanceMemberRole;
	updatedAt: string;
}

/**
 * Provider-independent role-change outcomes.
 *
 * - `updated`: the target's role was durably changed and the command
 *   receipt was written atomically. Demoting the target may atomically
 *   revoke pending invitations the target invited that its new role can no
 *   longer permit; `revokedInvitationCount` reports how many.
 * - `replayed`: an exact replay of the same request under the same
 *   Idempotency-Key, returning the receipt-recorded member state,
 *   `appliedAt`, and `revokedInvitationCount` from the original call rather
 *   than any state produced by later commands.
 * - `forbidden`: the actor is not currently an active `owner` or `admin`,
 *   or the actor is an `admin` requesting `member` for a target whose
 *   current role is not `member` (an `admin` may only administer current
 *   `member`-role targets). Checked only after `role_not_permitted` below,
 *   so an admin requesting a role above `member` never falls through to
 *   this outcome merely because the target (possibly the admin itself)
 *   also happens to not currently be a plain member.
 * - `member_suspended`: the actor exists but is not `active`.
 * - `role_not_permitted`: the actor is an active `admin` requesting a role
 *   above `member`, checked before `forbidden` above (an `admin` cannot
 *   grant `admin` or `owner`, including to itself, regardless of the
 *   target's current role).
 * - `member_not_found`: `targetUserId` does not identify a current instance
 *   member.
 * - `last_active_owner`: the target is the last active `owner` and this
 *   change would leave the instance with no active owner.
 * - `idempotency_conflict`: the Idempotency-Key was reused for a different
 *   request.
 * - `integrity_error`: the receipt and member rows disagree, or `updatedAt`
 *   regresses behind the target's current `updatedAt` (member rows are
 *   monotonic in `updatedAt`; a command claiming an earlier instant is
 *   rejected rather than silently applied or corrupting ordering).
 */
export type SetInstanceMemberRoleStoreResult =
	| {
			outcome: 'updated';
			member: InstanceMemberMetadata;
			appliedAt: string;
			revokedInvitationCount: number;
	  }
	| {
			outcome: 'replayed';
			member: InstanceMemberMetadata;
			appliedAt: string;
			revokedInvitationCount: number;
	  }
	| { outcome: 'forbidden' }
	| { outcome: 'member_suspended' }
	| { outcome: 'role_not_permitted' }
	| { outcome: 'member_not_found' }
	| { outcome: 'last_active_owner' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'integrity_error' };

/**
 * One status-change attempt (suspend or reactivate). Self-targeting is
 * never permitted — see `cannot_target_self` below.
 */
export interface SetInstanceMemberStatusCommand {
	actor: InstanceActor;
	idempotencyKey: string;
	requestFingerprint: string;
	targetUserId: string;
	status: InstanceMemberStatus;
	updatedAt: string;
}

/**
 * Provider-independent status-change outcomes.
 *
 * - `updated`: the target's status was durably changed and the command
 *   receipt was written atomically. Suspending the target atomically
 *   revokes the target's own pending invitations, since a suspended member
 *   may no longer act as an inviter; `revokedInvitationCount` reports how
 *   many.
 * - `replayed`: an exact replay of the same request under the same
 *   Idempotency-Key, returning the receipt-recorded member state,
 *   `appliedAt`, and `revokedInvitationCount` from the original call rather
 *   than any state produced by later commands.
 * - `forbidden`: the actor is not currently an active `owner` or `admin`,
 *   or the actor is an `admin` targeting a member whose current role is not
 *   `member` (an `admin` may only administer current `member`-role
 *   targets).
 * - `member_suspended`: the actor exists but is not `active`.
 * - `member_not_found`: `targetUserId` does not identify a current instance
 *   member.
 * - `last_active_owner`: the target is the last active `owner` and
 *   suspending them would leave the instance with no active owner.
 * - `cannot_target_self`: `targetUserId` is the actor's own id. Unlike role
 *   changes, status self-change is never permitted regardless of the
 *   actor's role.
 * - `idempotency_conflict`: the Idempotency-Key was reused for a different
 *   request.
 * - `integrity_error`: the receipt and member rows disagree, or `updatedAt`
 *   regresses behind the target's current `updatedAt` (member rows are
 *   monotonic in `updatedAt`; a command claiming an earlier instant is
 *   rejected rather than silently applied or corrupting ordering).
 */
export type SetInstanceMemberStatusStoreResult =
	| {
			outcome: 'updated';
			member: InstanceMemberMetadata;
			appliedAt: string;
			revokedInvitationCount: number;
	  }
	| {
			outcome: 'replayed';
			member: InstanceMemberMetadata;
			appliedAt: string;
			revokedInvitationCount: number;
	  }
	| { outcome: 'forbidden' }
	| { outcome: 'member_suspended' }
	| { outcome: 'member_not_found' }
	| { outcome: 'last_active_owner' }
	| { outcome: 'cannot_target_self' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'integrity_error' };

/**
 * Durable zero-PII instance invitation and member administration, extending
 * the same `InstanceStore` port rather than a separate membership port.
 * Create and list invitations require the actor to be a currently active
 * `owner` or `admin`. Accept requires only that the bearer token and
 * asserted email resolve a `pending`, unexpired invitation; it enrolls the
 * actor as an instance member atomically with consuming the invitation.
 * Member administration (`setInstanceMemberRole`, `setInstanceMemberStatus`)
 * lets an `owner` administer any member and lets an `admin` administer only
 * current `member`-role targets, never granting above `member`. Create,
 * accept, revoke, and the member administration commands are each single
 * atomic units that write the state change and its command receipt
 * together. Idempotency is primary-keyed by actor plus Idempotency-Key,
 * matching {@link BootstrapInstanceCommand} and the API key store.
 */
export interface InstanceStore {
	bootstrapInstance(command: BootstrapInstanceCommand): Promise<BootstrapInstanceStoreResult>;
	getInstanceCallerContext(userId: string): Promise<InstanceCallerContext>;
	createInstanceInvitation(
		command: CreateInstanceInvitationCommand
	): Promise<CreateInstanceInvitationStoreResult>;
	listInstanceInvitations(
		actor: InstanceActor,
		query: InstanceInvitationListQuery
	): Promise<ListInstanceInvitationsStoreResult>;
	acceptInstanceInvitation(
		command: AcceptInstanceInvitationCommand
	): Promise<AcceptInstanceInvitationStoreResult>;
	revokeInstanceInvitation(
		command: RevokeInstanceInvitationCommand
	): Promise<RevokeInstanceInvitationStoreResult>;
	listInstanceMembers(
		actor: InstanceActor,
		query: InstanceMemberListQuery
	): Promise<ListInstanceMembersStoreResult>;
	setInstanceMemberRole(
		command: SetInstanceMemberRoleCommand
	): Promise<SetInstanceMemberRoleStoreResult>;
	setInstanceMemberStatus(
		command: SetInstanceMemberStatusCommand
	): Promise<SetInstanceMemberStatusStoreResult>;
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

export function isInstanceInvitationId(value: string): boolean {
	return INSTANCE_INVITATION_ID_PATTERN.test(value);
}

export function isInstanceInvitationStatus(value: unknown): value is InstanceInvitationStatus {
	return value === 'pending' || value === 'accepted' || value === 'revoked';
}

export function boundInstanceInvitationListLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_INSTANCE_INVITATION_LIST_LIMIT);
}

export function boundInstanceMemberListLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_INSTANCE_MEMBER_LIST_LIMIT);
}

/**
 * Defaults to the fixed 7-day lifetime; instance invitations cannot outlive
 * it and, unlike API keys, cannot be requested with no expiry at all.
 */
export function resolveInstanceInvitationExpiresAt(
	now: Date,
	requestedExpiresAt?: string | null
): string {
	if (requestedExpiresAt === null) {
		throw new Error('Instance invitations must expire');
	}
	if (requestedExpiresAt === undefined) {
		return new Date(now.valueOf() + INSTANCE_INVITATION_DEFAULT_EXPIRY_MS).toISOString();
	}
	const expiresAtMs: number = Date.parse(requestedExpiresAt);
	if (!Number.isFinite(expiresAtMs)) {
		throw new Error('Invalid instance invitation expiry');
	}
	if (expiresAtMs <= now.valueOf()) {
		throw new Error('Instance invitation expiry must be in the future');
	}
	if (expiresAtMs > now.valueOf() + INSTANCE_INVITATION_MAX_EXPIRY_MS) {
		throw new Error('Instance invitation expiry must be at most 7 days');
	}
	return new Date(expiresAtMs).toISOString();
}
