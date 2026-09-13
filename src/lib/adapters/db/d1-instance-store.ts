import {
	boundInstanceInvitationListLimit,
	boundInstanceMemberListLimit,
	isInstanceInvitationId,
	isInstanceInvitationStatus,
	isInstanceMemberRole,
	isInstanceMemberStatus,
	MAX_PENDING_INSTANCE_INVITATIONS,
	type AcceptInstanceInvitationCommand,
	type AcceptInstanceInvitationStoreResult,
	type BootstrapInstanceCommand,
	type BootstrapInstanceStoreResult,
	type CreateInstanceInvitationCommand,
	type CreateInstanceInvitationStoreResult,
	type InstanceActor,
	type InstanceCallerContext,
	type InstanceInvitationMetadata,
	type InstanceInvitationListQuery,
	type InstanceMemberListQuery,
	type InstanceMemberMetadata,
	type InstanceMemberRole,
	type InstanceMemberStatus,
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
import { secretsEqual } from '$lib/security/bearer-secret';

interface BootstrapCommandReceiptRow {
	request_hash: string;
	owner_user_id: string;
	created_at: string;
}

interface MemberRow {
	user_id: string;
	role: string;
	status: string;
	created_at: string;
	updated_at: string;
}

interface MemberRoleStatusRow {
	role: string;
	status: string;
}

interface BootstrapRow {
	singleton_key: number;
	owner_user_id: string;
	created_at: string;
}

interface CountRow {
	count: number;
}

interface InvitationMetadataRow {
	id: string;
	role: string;
	status: string;
	invited_by_user_id: string;
	created_at: string;
	expires_at: string;
	accepted_at: string | null;
	accepted_by_user_id: string | null;
	revoked_at: string | null;
	revoked_by_user_id: string | null;
}

interface InvitationCandidateRow {
	id: string;
	role: string;
	status: string;
	email_binding: string;
	invited_by_user_id: string;
	created_at: string;
	expires_at: string;
	accepted_at: string | null;
	accepted_by_user_id: string | null;
	revoked_at: string | null;
	revoked_by_user_id: string | null;
}

interface CreateInvitationReceiptRow {
	request_hash: string;
	command_type: string;
	invitation_id: string;
	role: string;
	result_status: string;
	occurred_at: string;
	inv_id: string | null;
	inv_role: string | null;
	inv_status: string | null;
	inv_invited_by_user_id: string | null;
	inv_created_at: string | null;
	inv_expires_at: string | null;
	inv_accepted_at: string | null;
	inv_accepted_by_user_id: string | null;
	inv_revoked_at: string | null;
	inv_revoked_by_user_id: string | null;
}

interface AcceptInvitationReceiptRow {
	request_hash: string;
	command_type: string;
	invitation_id: string;
	role: string;
	result_status: string;
	occurred_at: string;
	inv_id: string | null;
	inv_role: string | null;
	inv_status: string | null;
	inv_invited_by_user_id: string | null;
	inv_created_at: string | null;
	inv_expires_at: string | null;
	inv_accepted_at: string | null;
	inv_accepted_by_user_id: string | null;
	inv_revoked_at: string | null;
	inv_revoked_by_user_id: string | null;
	member_user_id: string | null;
	member_role: string | null;
	member_status: string | null;
	member_created_at: string | null;
	member_updated_at: string | null;
}

interface RevokeInvitationReceiptRow {
	request_hash: string;
	command_type: string;
	invitation_id: string;
	role: string;
	result_status: string;
	occurred_at: string;
	inv_id: string | null;
	inv_role: string | null;
	inv_status: string | null;
	inv_invited_by_user_id: string | null;
	inv_created_at: string | null;
	inv_expires_at: string | null;
	inv_accepted_at: string | null;
	inv_accepted_by_user_id: string | null;
	inv_revoked_at: string | null;
	inv_revoked_by_user_id: string | null;
}

const INVITATION_METADATA_COLUMNS: string = `id, role, status, invited_by_user_id, created_at,
	expires_at, accepted_at, accepted_by_user_id, revoked_at, revoked_by_user_id`;

const CREATE_RECEIPT_JOIN_COLUMNS: string = `command.request_hash, command.command_type,
	command.invitation_id, command.role, command.result_status, command.occurred_at,
	invitation.id AS inv_id, invitation.role AS inv_role, invitation.status AS inv_status,
	invitation.invited_by_user_id AS inv_invited_by_user_id,
	invitation.created_at AS inv_created_at, invitation.expires_at AS inv_expires_at,
	invitation.accepted_at AS inv_accepted_at, invitation.accepted_by_user_id AS inv_accepted_by_user_id,
	invitation.revoked_at AS inv_revoked_at, invitation.revoked_by_user_id AS inv_revoked_by_user_id`;

const ACCEPT_RECEIPT_JOIN_COLUMNS: string = `command.request_hash, command.command_type,
	command.invitation_id, command.role, command.result_status, command.occurred_at,
	invitation.id AS inv_id, invitation.role AS inv_role, invitation.status AS inv_status,
	invitation.invited_by_user_id AS inv_invited_by_user_id,
	invitation.created_at AS inv_created_at, invitation.expires_at AS inv_expires_at,
	invitation.accepted_at AS inv_accepted_at, invitation.accepted_by_user_id AS inv_accepted_by_user_id,
	invitation.revoked_at AS inv_revoked_at, invitation.revoked_by_user_id AS inv_revoked_by_user_id,
	member.user_id AS member_user_id, member.role AS member_role,
	member.status AS member_status, member.created_at AS member_created_at,
	member.updated_at AS member_updated_at`;

const REVOKE_RECEIPT_JOIN_COLUMNS: string = CREATE_RECEIPT_JOIN_COLUMNS;

interface MemberCommandReceiptRow {
	request_hash: string;
	command_type: string;
	target_user_id: string;
	previous_role: string;
	previous_status: string;
	result_role: string;
	result_status: string;
	revoked_invitation_count: number;
	occurred_at: string;
	target_row_user_id: string | null;
	target_row_created_at: string | null;
}

/**
 * Unlike instance_invitation, a member row keeps changing across its
 * lifetime, so a replay cannot cross-check the receipt's claimed role/status
 * against the target's *current* row the way create/accept/revoke check
 * against an invitation's terminal, never-mutated-again state -- a
 * legitimate replay requested after some later command has moved the target
 * on would otherwise be misclassified as integrity_error. Only `user_id`
 * (existence) and `created_at` (immutable once the row exists) are safe to
 * join for cross-checking; the replayed role/status/timestamp come from the
 * receipt's own result_role/result_status/occurred_at, which the evidence
 * trigger already proved correct at the instant this receipt was written.
 */
const MEMBER_COMMAND_RECEIPT_JOIN_COLUMNS: string = `command.request_hash, command.command_type,
	command.target_user_id, command.previous_role, command.previous_status,
	command.result_role, command.result_status, command.revoked_invitation_count, command.occurred_at,
	target.user_id AS target_row_user_id, target.created_at AS target_row_created_at`;

type RoleCascadeKind = 'none' | 'non_member' | 'all';

/**
 * Which of the target's own live pending invitations (as inviter) stop being
 * grantable once its role changes. Promotions and no-op role changes never
 * shrink what the target may grant, so only the two demotion paths the
 * migration's `instance_member_command_cascade_requires_demotion` constraint
 * recognizes can cascade: owner -> admin/member revokes everything above
 * `member`-role invites the target can no longer hold (member-role invites
 * survive only when landing on `admin`), and any demotion down to `member`
 * revokes everything, since a plain member cannot invite at all.
 */
function roleCascadeKind(previousRole: string, resultRole: string): RoleCascadeKind {
	if (resultRole === 'member' && previousRole !== 'member') return 'all';
	if (resultRole === 'admin' && previousRole === 'owner') return 'non_member';
	return 'none';
}

type SetRoleGateResult =
	| { kind: 'outcome'; result: SetInstanceMemberRoleStoreResult }
	| { kind: 'proceed'; target: MemberRow };

type SetStatusGateResult =
	| { kind: 'outcome'; result: SetInstanceMemberStatusStoreResult }
	| { kind: 'proceed'; target: MemberRow };

type AcceptGateResult =
	| { kind: 'outcome'; result: AcceptInstanceInvitationStoreResult }
	| {
			kind: 'proceed';
			invitation: InvitationCandidateRow;
			existingMember: MemberRow | null;
	  };

type RevokeGateResult =
	| { kind: 'outcome'; result: RevokeInstanceInvitationStoreResult }
	| {
			kind: 'proceed';
			invitation: InvitationMetadataRow;
	  };

export class D1InstanceStore implements InstanceStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async bootstrapInstance(
		command: BootstrapInstanceCommand
	): Promise<BootstrapInstanceStoreResult> {
		const gate: BootstrapInstanceStoreResult | null = await this.#resolveBootstrapGate(command);
		if (gate !== null) return gate;

		const memberStmt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
				SELECT ?, 'owner', 'active', ?, ?
				WHERE NOT EXISTS (SELECT 1 FROM instance_bootstrap)
				  AND NOT EXISTS (SELECT 1 FROM instance_member)`
			)
			.bind(command.actor.id, command.createdAt, command.createdAt);

		const bootstrapStmt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO instance_bootstrap (singleton_key, owner_user_id, created_at)
				SELECT 1, user_id, ?
				FROM instance_member
				WHERE user_id = ? AND role = 'owner'`
			)
			.bind(command.createdAt, command.actor.id);

		const receiptStmt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO instance_bootstrap_command (
					actor_type, actor_id, idempotency_key, request_hash, owner_user_id, created_at
				)
				SELECT 'user', owner_user_id, ?, ?, owner_user_id, ?
				FROM instance_bootstrap
				WHERE singleton_key = 1 AND owner_user_id = ?`
			)
			.bind(
				command.idempotencyKey,
				command.requestFingerprint,
				command.createdAt,
				command.actor.id
			);

		let applied: boolean;
		try {
			const results: D1Result[] = await this.#database.batch([
				memberStmt,
				bootstrapStmt,
				receiptStmt
			]);
			applied = results.every((result: D1Result): boolean => changeCount(result) === 1);
		} catch (error: unknown) {
			const classified: BootstrapInstanceStoreResult | null =
				await this.#classifyBootstrapFailure(command);
			if (classified !== null) return classified;
			throw error;
		}

		if (applied) {
			return {
				outcome: 'bootstrapped',
				member: {
					userId: command.actor.id,
					role: 'owner',
					status: 'active',
					createdAt: command.createdAt,
					updatedAt: command.createdAt
				}
			};
		}

		const classified: BootstrapInstanceStoreResult | null =
			await this.#classifyBootstrapFailure(command);
		return classified ?? { outcome: 'integrity_error' };
	}

	async getInstanceCallerContext(userId: string): Promise<InstanceCallerContext> {
		const batched: D1Result<BootstrapRow | MemberRow>[] = await this.#database.batch<
			BootstrapRow | MemberRow
		>([
			this.#database.prepare(
				'SELECT owner_user_id, created_at FROM instance_bootstrap WHERE singleton_key = 1'
			),
			this.#database
				.prepare(
					'SELECT user_id, role, status, created_at, updated_at FROM instance_member WHERE user_id = ?'
				)
				.bind(userId)
		]);
		const bootstrapResult: BootstrapRow | null = firstRow<BootstrapRow>(batched[0]);
		const memberResult: MemberRow | null = firstRow<MemberRow>(batched[1]);

		const bootstrapped: boolean = bootstrapResult !== null;
		let member: InstanceMemberMetadata | null = null;
		if (memberResult !== null) {
			if (
				!isInstanceMemberRole(memberResult.role) ||
				!isInstanceMemberStatus(memberResult.status)
			) {
				throw new Error('Stored instance member state is corrupted.');
			}
			member = {
				userId: memberResult.user_id,
				role: memberResult.role,
				status: memberResult.status,
				createdAt: memberResult.created_at,
				updatedAt: memberResult.updated_at
			};
		}

		return { member, bootstrapped };
	}

	/**
	 * One batch snapshot of the bootstrap and member-count evidence, so the two
	 * reads observe the same point in time instead of two independently
	 * scheduled `Promise.all` requests.
	 */
	async #snapshotEmptiness(): Promise<[BootstrapRow | null, CountRow | null]> {
		const batched: D1Result<BootstrapRow | CountRow>[] = await this.#database.batch<
			BootstrapRow | CountRow
		>([
			this.#database.prepare(
				'SELECT singleton_key, owner_user_id, created_at FROM instance_bootstrap WHERE singleton_key = 1'
			),
			this.#database.prepare('SELECT COUNT(*) AS count FROM instance_member')
		]);
		return [firstRow<BootstrapRow>(batched[0]), firstRow<CountRow>(batched[1])];
	}

	async #resolveBootstrapGate(
		command: BootstrapInstanceCommand
	): Promise<BootstrapInstanceStoreResult | null> {
		const receipt = await this.#database
			.prepare(
				`SELECT request_hash, owner_user_id, created_at
				FROM instance_bootstrap_command
				WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?`
			)
			.bind(command.actor.type, command.actor.id, command.idempotencyKey)
			.first<BootstrapCommandReceiptRow>();

		if (receipt !== null) {
			return this.#evaluateReceipt(receipt, command);
		}

		const [bootstrap, memberCount] = await this.#snapshotEmptiness();

		if (bootstrap !== null || (memberCount !== null && memberCount.count > 0)) {
			return { outcome: 'already_bootstrapped', replayed: false };
		}

		return null;
	}

	async #classifyBootstrapFailure(
		command: BootstrapInstanceCommand
	): Promise<BootstrapInstanceStoreResult | null> {
		const receipt = await this.#database
			.prepare(
				`SELECT request_hash, owner_user_id, created_at
				FROM instance_bootstrap_command
				WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?`
			)
			.bind(command.actor.type, command.actor.id, command.idempotencyKey)
			.first<BootstrapCommandReceiptRow>();

		if (receipt !== null) {
			return this.#evaluateReceipt(receipt, command);
		}

		const [bootstrap, memberCount] = await this.#snapshotEmptiness();

		if (bootstrap !== null || (memberCount !== null && memberCount.count > 0)) {
			return { outcome: 'already_bootstrapped', replayed: false };
		}

		return null;
	}

	async #evaluateReceipt(
		receipt: BootstrapCommandReceiptRow,
		command: BootstrapInstanceCommand
	): Promise<BootstrapInstanceStoreResult> {
		if (receipt.request_hash !== command.requestFingerprint) {
			return { outcome: 'idempotency_conflict' };
		}
		// Self-bootstrap only: the receipt owner must be the replaying actor, or
		// another member's metadata could otherwise be disclosed on replay.
		if (receipt.owner_user_id !== command.actor.id) {
			return { outcome: 'integrity_error' };
		}

		const batched: D1Result<MemberRow | BootstrapRow>[] = await this.#database.batch<
			MemberRow | BootstrapRow
		>([
			this.#database
				.prepare(
					'SELECT user_id, role, status, created_at, updated_at FROM instance_member WHERE user_id = ?'
				)
				.bind(receipt.owner_user_id),
			this.#database.prepare(
				'SELECT singleton_key, owner_user_id, created_at FROM instance_bootstrap WHERE singleton_key = 1'
			)
		]);
		const ownerMember: MemberRow | null = firstRow<MemberRow>(batched[0]);
		const bootstrap: BootstrapRow | null = firstRow<BootstrapRow>(batched[1]);

		if (
			ownerMember === null ||
			bootstrap === null ||
			bootstrap.owner_user_id !== receipt.owner_user_id ||
			!isInstanceMemberRole(ownerMember.role) ||
			!isInstanceMemberStatus(ownerMember.status) ||
			ownerMember.role !== 'owner' ||
			ownerMember.status !== 'active'
		) {
			return { outcome: 'integrity_error' };
		}

		return {
			outcome: 'already_bootstrapped',
			member: {
				userId: ownerMember.user_id,
				role: ownerMember.role,
				status: ownerMember.status,
				createdAt: ownerMember.created_at,
				updatedAt: ownerMember.updated_at
			},
			replayed: true
		};
	}

	async createInstanceInvitation(
		command: CreateInstanceInvitationCommand
	): Promise<CreateInstanceInvitationStoreResult> {
		const gate: CreateInstanceInvitationStoreResult | null = await this.#resolveCreateGate(command);
		if (gate !== null) return gate;

		const invitationStmt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO instance_invitation (
					id, role, status, token_hash, email_binding, invited_by_user_id,
					created_at, expires_at, accepted_at, accepted_by_user_id, revoked_at, revoked_by_user_id
				) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`
			)
			.bind(
				command.invitationId,
				command.role,
				command.tokenHash,
				command.emailBinding,
				command.actor.id,
				command.createdAt,
				command.expiresAt
			);

		const receiptStmt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO instance_invitation_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					invitation_id, role, result_status, occurred_at
				) VALUES ('user', ?, ?, 'create', ?, ?, ?, 'pending', ?)`
			)
			.bind(
				command.actor.id,
				command.idempotencyKey,
				command.requestFingerprint,
				command.invitationId,
				command.role,
				command.createdAt
			);

		let applied: boolean;
		try {
			const results: D1Result[] = await this.#database.batch([invitationStmt, receiptStmt]);
			applied = results.every((result: D1Result): boolean => changeCount(result) === 1);
		} catch (error: unknown) {
			const classified: CreateInstanceInvitationStoreResult | null =
				await this.#classifyCreateFailure(command);
			if (classified !== null) return classified;
			throw error;
		}

		if (applied) {
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

		const classified: CreateInstanceInvitationStoreResult | null =
			await this.#classifyCreateFailure(command);
		return classified ?? { outcome: 'integrity_error' };
	}

	async listInstanceInvitations(
		actor: InstanceActor,
		query: InstanceInvitationListQuery
	): Promise<ListInstanceInvitationsStoreResult> {
		const limit: number = boundInstanceInvitationListLimit(query.limit);
		const fetchLimit: number = limit + 1;

		const memberStmt: D1PreparedStatement = this.#database
			.prepare('SELECT role, status FROM instance_member WHERE user_id = ? LIMIT 1')
			.bind(actor.id);

		if (query.cursor !== null && !isInstanceInvitationId(query.cursor)) {
			const memberRow: MemberRoleStatusRow | null = await memberStmt.first<MemberRoleStatusRow>();
			if (memberRow === null || memberRow.role === 'member') {
				return { outcome: 'forbidden' };
			}
			if (memberRow.status === 'suspended') {
				return { outcome: 'member_suspended' };
			}
			return { outcome: 'listed', page: { items: [], nextCursor: null } };
		}

		const pageStmt: D1PreparedStatement =
			query.cursor === null
				? this.#database
						.prepare(
							`SELECT ${INVITATION_METADATA_COLUMNS}
							 FROM instance_invitation
							 ORDER BY created_at DESC, id DESC
							 LIMIT ?`
						)
						.bind(fetchLimit)
				: this.#database
						.prepare(
							`SELECT ${INVITATION_METADATA_COLUMNS}
							 FROM instance_invitation
							 WHERE (created_at, id) < (
								 SELECT created_at, id FROM instance_invitation WHERE id = ? LIMIT 1
							 )
							 ORDER BY created_at DESC, id DESC
							 LIMIT ?`
						)
						.bind(query.cursor, fetchLimit);

		const results: D1Result<MemberRoleStatusRow | InvitationMetadataRow>[] =
			await this.#database.batch<MemberRoleStatusRow | InvitationMetadataRow>([
				memberStmt,
				pageStmt
			]);

		const memberRow: MemberRoleStatusRow | null = firstRow<MemberRoleStatusRow>(results[0]);
		if (memberRow === null || memberRow.role === 'member') {
			return { outcome: 'forbidden' };
		}
		if (memberRow.status === 'suspended') {
			return { outcome: 'member_suspended' };
		}

		const invitationRows: InvitationMetadataRow[] = (results[1]?.results ??
			[]) as InvitationMetadataRow[];
		const hasNextPage: boolean = invitationRows.length > limit;
		const rows: InvitationMetadataRow[] = hasNextPage
			? invitationRows.slice(0, limit)
			: invitationRows;
		const items: readonly InstanceInvitationMetadata[] = rows.map(metadataFromInvitationRow);
		const lastItem: InstanceInvitationMetadata | undefined = items.at(-1);

		return {
			outcome: 'listed',
			page: {
				items,
				nextCursor: hasNextPage && lastItem !== undefined ? lastItem.id : null
			}
		};
	}

	async acceptInstanceInvitation(
		command: AcceptInstanceInvitationCommand
	): Promise<AcceptInstanceInvitationStoreResult> {
		const gate: AcceptGateResult = await this.#resolveAcceptGate(command);
		if (gate.kind === 'outcome') return gate.result;

		// D1 runs a batch as a single write transaction and rolls the whole
		// batch back if any statement raises, so these three statements are
		// ordered and guarded to make one acceptance all-or-nothing.
		//
		// The order is forced by the schema: instance_invitation.accepted_by_user_id
		// is a foreign key into instance_member, so the member row has to exist
		// before the invitation can be marked accepted, and
		// instance_invitation_command.actor_id plus the accept-evidence trigger
		// require both to be in place before the receipt.
		//
		// Enrolling first therefore cannot be avoided, so the INSERT carries the
		// same invitation predicate the UPDATE below applies: the pre-batch gate
		// is only an advisory snapshot, and a concurrent revoke or accept can
		// land in between. Nothing between these two statements touches
		// instance_invitation, so the predicate holding here means it still holds
		// there. `NOT EXISTS (... status = 'accepted')` is what makes the same
		// actor's concurrent acceptances consume exactly one invitation: whoever
		// commits first leaves an accepted invitation bound to this actor, and
		// the loser's predicate is false from then on. ON CONFLICT DO NOTHING
		// keeps that loser from clobbering the winner's membership.
		const memberStmt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
				 SELECT ?, invitation.role, 'active', ?, ?
				 FROM instance_invitation invitation
				 WHERE invitation.id = ? AND invitation.status = 'pending'
				   AND invitation.token_hash = ? AND invitation.email_binding = ?
				   AND invitation.expires_at > ?
				   AND NOT EXISTS (
				     SELECT 1 FROM instance_invitation consumed
				     WHERE consumed.accepted_by_user_id = ? AND consumed.status = 'accepted'
				   )
				 ON CONFLICT (user_id) DO NOTHING`
			)
			.bind(
				command.actor.id,
				command.acceptedAt,
				command.acceptedAt,
				gate.invitation.id,
				command.tokenHash,
				command.emailBinding,
				command.acceptedAt,
				command.actor.id
			);

		// Consumes the invitation only for an actor this same batch just enrolled
		// and who holds no other accepted invitation.
		//
		// `(SELECT changes()) = 1` is the causal link back to memberStmt: D1 runs
		// the batch as one transaction on one connection, so changes() here is
		// that INSERT's row count. An enrollment that did not happen — because
		// the invitation went stale, or because ON CONFLICT DO NOTHING swallowed
		// the insert for an actor some concurrent path had already enrolled —
		// leaves zero changes and cannot consume this invitation. That matters
		// even where the actor does end up an active member by way of another
		// path entirely (a concurrent bootstrap, say): without this guard such a
		// batch would burn the invitation to pay for a membership carrying a
		// role the invitation never granted.
		//
		// The EXISTS guards then restate that same invariant directly against the
		// tables — the actor is an active member, and no other invitation is
		// already accepted for them — so this statement holds on its own terms
		// rather than only by way of a connection-level counter.
		const invitationStmt: D1PreparedStatement = this.#database
			.prepare(
				`UPDATE instance_invitation
				 SET status = 'accepted', accepted_at = ?, accepted_by_user_id = ?
				 WHERE id = ? AND status = 'pending' AND token_hash = ? AND email_binding = ?
				   AND expires_at > ?
				   AND (SELECT changes()) = 1
				   AND EXISTS (
				     SELECT 1 FROM instance_member WHERE user_id = ? AND status = 'active'
				   )
				   AND NOT EXISTS (
				     SELECT 1 FROM instance_invitation consumed
				     WHERE consumed.accepted_by_user_id = ? AND consumed.status = 'accepted'
				   )`
			)
			.bind(
				command.acceptedAt,
				command.actor.id,
				gate.invitation.id,
				command.tokenHash,
				command.emailBinding,
				command.acceptedAt,
				command.actor.id,
				command.actor.id
			);

		// Deliberately unconditional, exactly like the create and revoke
		// receipts. instance_invitation_command's accept-evidence trigger RAISEs
		// unless the invitation really is accepted by this actor at this instant
		// and the actor really is an active member, so an invitationStmt that
		// matched no rows — its changes() chain broke, or a concurrent
		// revoke/accept beat it — aborts the batch and rolls the member INSERT
		// back with it. Guarding this INSERT with its own
		// `SELECT ... WHERE (SELECT changes()) = 1` instead would turn that abort
		// into a silent skip, letting the enrollment commit without any
		// invitation ever having been consumed for it.
		const receiptStmt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO instance_invitation_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					invitation_id, role, result_status, occurred_at
				) VALUES ('user', ?, ?, 'accept', ?, ?, ?, 'accepted', ?)`
			)
			.bind(
				command.actor.id,
				command.idempotencyKey,
				command.requestFingerprint,
				gate.invitation.id,
				gate.invitation.role,
				command.acceptedAt
			);

		let applied: boolean;
		try {
			const results: D1Result[] = await this.#database.batch([
				memberStmt,
				invitationStmt,
				receiptStmt
			]);
			// A well-formed acceptance writes exactly one row per statement, so
			// anything short of all three means the invariant did not hold — even
			// where the guards above and the evidence trigger left no exception
			// behind to catch.
			applied = results.every((result: D1Result): boolean => changeCount(result) === 1);
		} catch (error: unknown) {
			const classified: AcceptInstanceInvitationStoreResult | null =
				await this.#classifyAcceptFailure(command);
			if (classified !== null) return classified;
			throw error;
		}

		if (applied) {
			const memberRow: MemberRow | null = await this.#readMember(command.actor.id);
			if (memberRow === null || memberRow.status !== 'active') {
				return { outcome: 'integrity_error' };
			}
			return {
				outcome: 'accepted',
				invitation: {
					id: gate.invitation.id,
					role: gate.invitation.role as InstanceMemberRole,
					status: 'accepted',
					invitedByUserId: gate.invitation.invited_by_user_id,
					createdAt: gate.invitation.created_at,
					expiresAt: gate.invitation.expires_at,
					acceptedAt: command.acceptedAt,
					acceptedByUserId: command.actor.id,
					revokedAt: null,
					revokedByUserId: null
				},
				member: metadataFromMemberRow(memberRow)
			};
		}

		const classified: AcceptInstanceInvitationStoreResult | null =
			await this.#classifyAcceptFailure(command);
		return classified ?? { outcome: 'integrity_error' };
	}

	async revokeInstanceInvitation(
		command: RevokeInstanceInvitationCommand
	): Promise<RevokeInstanceInvitationStoreResult> {
		const gate: RevokeGateResult = await this.#resolveRevokeGate(command);
		if (gate.kind === 'outcome') return gate.result;

		const updateStmt: D1PreparedStatement = this.#database
			.prepare(
				`UPDATE instance_invitation
				 SET status = 'revoked', revoked_at = ?, revoked_by_user_id = ?
				 WHERE id = ? AND status = 'pending'`
			)
			.bind(command.revokedAt, command.actor.id, command.invitationId);

		const receiptStmt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO instance_invitation_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					invitation_id, role, result_status, occurred_at
				) VALUES ('user', ?, ?, 'revoke', ?, ?, ?, 'revoked', ?)`
			)
			.bind(
				command.actor.id,
				command.idempotencyKey,
				command.requestFingerprint,
				command.invitationId,
				gate.invitation.role,
				command.revokedAt
			);

		let applied: boolean;
		try {
			const results: D1Result[] = await this.#database.batch([updateStmt, receiptStmt]);
			applied = results.every((result: D1Result): boolean => changeCount(result) === 1);
		} catch (error: unknown) {
			const classified: RevokeInstanceInvitationStoreResult | null =
				await this.#classifyRevokeFailure(command);
			if (classified !== null) return classified;
			throw error;
		}

		if (applied) {
			return {
				outcome: 'revoked',
				invitation: {
					id: gate.invitation.id,
					role: gate.invitation.role as InstanceMemberRole,
					status: 'revoked',
					invitedByUserId: gate.invitation.invited_by_user_id,
					createdAt: gate.invitation.created_at,
					expiresAt: gate.invitation.expires_at,
					acceptedAt: null,
					acceptedByUserId: null,
					revokedAt: command.revokedAt,
					revokedByUserId: command.actor.id
				}
			};
		}

		const classified: RevokeInstanceInvitationStoreResult | null =
			await this.#classifyRevokeFailure(command);
		return classified ?? { outcome: 'integrity_error' };
	}

	/**
	 * Keyset-paginated by `user_id` ascending: unlike invitations, a member
	 * has no separate surrogate id and no natural chronological ordering
	 * column worth exposing, and `user_id` is already the table's primary
	 * key, so it is both the sort key and the cursor value directly -- no
	 * lookup subquery is needed to translate a cursor into a sort position,
	 * so an unknown or stale cursor simply matches nothing greater than
	 * itself rather than requiring a separate malformed-cursor branch.
	 */
	async listInstanceMembers(
		actor: InstanceActor,
		query: InstanceMemberListQuery
	): Promise<ListInstanceMembersStoreResult> {
		const limit: number = boundInstanceMemberListLimit(query.limit);
		const fetchLimit: number = limit + 1;

		const memberStmt: D1PreparedStatement = this.#database
			.prepare('SELECT role, status FROM instance_member WHERE user_id = ? LIMIT 1')
			.bind(actor.id);

		const pageStmt: D1PreparedStatement =
			query.cursor === null
				? this.#database
						.prepare(
							`SELECT user_id, role, status, created_at, updated_at
							 FROM instance_member
							 ORDER BY user_id ASC
							 LIMIT ?`
						)
						.bind(fetchLimit)
				: this.#database
						.prepare(
							`SELECT user_id, role, status, created_at, updated_at
							 FROM instance_member
							 WHERE user_id > ?
							 ORDER BY user_id ASC
							 LIMIT ?`
						)
						.bind(query.cursor, fetchLimit);

		const results: D1Result<MemberRoleStatusRow | MemberRow>[] = await this.#database.batch<
			MemberRoleStatusRow | MemberRow
		>([memberStmt, pageStmt]);

		const memberRow: MemberRoleStatusRow | null = firstRow<MemberRoleStatusRow>(results[0]);
		if (memberRow === null || memberRow.role === 'member') {
			return { outcome: 'forbidden' };
		}
		if (memberRow.status === 'suspended') {
			return { outcome: 'member_suspended' };
		}

		const memberRows: MemberRow[] = (results[1]?.results ?? []) as MemberRow[];
		const hasNextPage: boolean = memberRows.length > limit;
		const rows: MemberRow[] = hasNextPage ? memberRows.slice(0, limit) : memberRows;
		const items: readonly InstanceMemberMetadata[] = rows.map(metadataFromMemberRow);
		const lastItem: InstanceMemberMetadata | undefined = items.at(-1);

		return {
			outcome: 'listed',
			page: {
				items,
				nextCursor: hasNextPage && lastItem !== undefined ? lastItem.userId : null
			}
		};
	}

	async setInstanceMemberRole(
		command: SetInstanceMemberRoleCommand
	): Promise<SetInstanceMemberRoleStoreResult> {
		const gate: SetRoleGateResult = await this.#resolveSetRoleGate(command);
		if (gate.kind === 'outcome') return gate.result;

		const cascadeKind: RoleCascadeKind = roleCascadeKind(gate.target.role, command.role);

		const memberStmt: D1PreparedStatement = this.#database
			.prepare(
				`UPDATE instance_member
				 SET role = ?, updated_at = ?
				 WHERE user_id = ? AND role = ? AND status = ?`
			)
			.bind(
				command.role,
				command.updatedAt,
				command.targetUserId,
				gate.target.role,
				gate.target.status
			);

		const cascadeStmt: D1PreparedStatement | null =
			cascadeKind === 'none'
				? null
				: this.#database
						.prepare(
							cascadeKind === 'all'
								? `UPDATE instance_invitation
								   SET status = 'revoked', revoked_at = ?, revoked_by_user_id = ?
								   WHERE invited_by_user_id = ? AND status = 'pending' AND expires_at > ?`
								: `UPDATE instance_invitation
								   SET status = 'revoked', revoked_at = ?, revoked_by_user_id = ?
								   WHERE invited_by_user_id = ? AND status = 'pending' AND expires_at > ?
								     AND role <> 'member'`
						)
						.bind(command.updatedAt, command.actor.id, command.targetUserId, command.updatedAt);

		// revoked_invitation_count is left unconditional (0 when no cascade
		// applies) rather than making the receipt itself conditional: the
		// evidence trigger, not this insert, is what rejects a receipt whose
		// claimed result_role/result_status does not match the member row the
		// batch actually produced.
		const receiptStmt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES ('user', ?, ?, 'set_role', ?, ?, ?, ?, ?, ?, ${cascadeStmt === null ? '0' : '(SELECT changes())'}, ?)`
			)
			.bind(
				command.actor.id,
				command.idempotencyKey,
				command.requestFingerprint,
				command.targetUserId,
				gate.target.role,
				gate.target.status,
				command.role,
				gate.target.status,
				command.updatedAt
			);

		const statements: D1PreparedStatement[] =
			cascadeStmt === null ? [memberStmt, receiptStmt] : [memberStmt, cascadeStmt, receiptStmt];

		let memberApplied: boolean;
		let receiptApplied: boolean;
		let revokedInvitationCount: number;
		try {
			const results: D1Result[] = await this.#database.batch(statements);
			memberApplied = changeCount(results[0]) === 1;
			receiptApplied = changeCount(results[results.length - 1]) === 1;
			revokedInvitationCount = cascadeStmt === null ? 0 : changeCount(results[1]);
		} catch (error: unknown) {
			const classified: SetInstanceMemberRoleStoreResult | null =
				await this.#classifySetRoleFailure(command);
			if (classified !== null) return classified;
			throw error;
		}

		if (memberApplied && receiptApplied) {
			return {
				outcome: 'updated',
				member: {
					userId: gate.target.user_id,
					role: command.role,
					status: gate.target.status as InstanceMemberStatus,
					createdAt: gate.target.created_at,
					updatedAt: command.updatedAt
				},
				appliedAt: command.updatedAt,
				revokedInvitationCount
			};
		}

		const classified: SetInstanceMemberRoleStoreResult | null =
			await this.#classifySetRoleFailure(command);
		return classified ?? { outcome: 'integrity_error' };
	}

	async setInstanceMemberStatus(
		command: SetInstanceMemberStatusCommand
	): Promise<SetInstanceMemberStatusStoreResult> {
		const gate: SetStatusGateResult = await this.#resolveSetStatusGate(command);
		if (gate.kind === 'outcome') return gate.result;

		const cascades: boolean = command.status === 'suspended';

		const memberStmt: D1PreparedStatement = this.#database
			.prepare(
				`UPDATE instance_member
				 SET status = ?, updated_at = ?
				 WHERE user_id = ? AND role = ? AND status = ?`
			)
			.bind(
				command.status,
				command.updatedAt,
				command.targetUserId,
				gate.target.role,
				gate.target.status
			);

		const cascadeStmt: D1PreparedStatement | null = !cascades
			? null
			: this.#database
					.prepare(
						`UPDATE instance_invitation
						 SET status = 'revoked', revoked_at = ?, revoked_by_user_id = ?
						 WHERE invited_by_user_id = ? AND status = 'pending' AND expires_at > ?`
					)
					.bind(command.updatedAt, command.actor.id, command.targetUserId, command.updatedAt);

		const receiptStmt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES ('user', ?, ?, 'set_status', ?, ?, ?, ?, ?, ?, ${cascadeStmt === null ? '0' : '(SELECT changes())'}, ?)`
			)
			.bind(
				command.actor.id,
				command.idempotencyKey,
				command.requestFingerprint,
				command.targetUserId,
				gate.target.role,
				gate.target.status,
				gate.target.role,
				command.status,
				command.updatedAt
			);

		const statements: D1PreparedStatement[] =
			cascadeStmt === null ? [memberStmt, receiptStmt] : [memberStmt, cascadeStmt, receiptStmt];

		let memberApplied: boolean;
		let receiptApplied: boolean;
		let revokedInvitationCount: number;
		try {
			const results: D1Result[] = await this.#database.batch(statements);
			memberApplied = changeCount(results[0]) === 1;
			receiptApplied = changeCount(results[results.length - 1]) === 1;
			revokedInvitationCount = cascadeStmt === null ? 0 : changeCount(results[1]);
		} catch (error: unknown) {
			const classified: SetInstanceMemberStatusStoreResult | null =
				await this.#classifySetStatusFailure(command);
			if (classified !== null) return classified;
			throw error;
		}

		if (memberApplied && receiptApplied) {
			return {
				outcome: 'updated',
				member: {
					userId: gate.target.user_id,
					role: gate.target.role as InstanceMemberRole,
					status: command.status,
					createdAt: gate.target.created_at,
					updatedAt: command.updatedAt
				},
				appliedAt: command.updatedAt,
				revokedInvitationCount
			};
		}

		const classified: SetInstanceMemberStatusStoreResult | null =
			await this.#classifySetStatusFailure(command);
		return classified ?? { outcome: 'integrity_error' };
	}

	async #resolveSetRoleGate(command: SetInstanceMemberRoleCommand): Promise<SetRoleGateResult> {
		const actorStmt: D1PreparedStatement = this.#database
			.prepare('SELECT role, status FROM instance_member WHERE user_id = ? LIMIT 1')
			.bind(command.actor.id);

		const targetStmt: D1PreparedStatement = this.#database
			.prepare(
				'SELECT user_id, role, status, created_at, updated_at FROM instance_member WHERE user_id = ? LIMIT 1'
			)
			.bind(command.targetUserId);

		const receiptStmt: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${MEMBER_COMMAND_RECEIPT_JOIN_COLUMNS}
				 FROM instance_member_command command
				 LEFT JOIN instance_member target ON target.user_id = command.target_user_id
				 WHERE command.actor_type = ? AND command.actor_id = ? AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(command.actor.type, command.actor.id, command.idempotencyKey);

		const ownerCountStmt: D1PreparedStatement = this.#database
			.prepare(
				"SELECT COUNT(*) AS count FROM instance_member WHERE role = 'owner' AND status = 'active' AND user_id <> ?"
			)
			.bind(command.targetUserId);

		const results: D1Result<
			MemberRoleStatusRow | MemberRow | MemberCommandReceiptRow | CountRow
		>[] = await this.#database.batch<
			MemberRoleStatusRow | MemberRow | MemberCommandReceiptRow | CountRow
		>([actorStmt, targetStmt, receiptStmt, ownerCountStmt]);

		const actorRow: MemberRoleStatusRow | null = firstRow<MemberRoleStatusRow>(results[0]);
		const targetRow: MemberRow | null = firstRow<MemberRow>(results[1]);
		const receiptRow: MemberCommandReceiptRow | null = firstRow<MemberCommandReceiptRow>(
			results[2]
		);
		const ownerCountRow: CountRow | null = firstRow<CountRow>(results[3]);

		// Exact receipt replay is checked first, ahead of the actor's current
		// role/status: evaluateSetRoleReceipt answers entirely from the receipt
		// and the target's row, so a replay by an actor since demoted or
		// suspended is still classified correctly without a separate branch
		// here.
		if (receiptRow !== null) {
			return { kind: 'outcome', result: evaluateSetRoleReceipt(receiptRow, command) };
		}

		if (actorRow === null || actorRow.role === 'member') {
			return { kind: 'outcome', result: { outcome: 'forbidden' } };
		}
		if (actorRow.status === 'suspended') {
			return { kind: 'outcome', result: { outcome: 'member_suspended' } };
		}

		if (targetRow === null) {
			return { kind: 'outcome', result: { outcome: 'member_not_found' } };
		}

		if (actorRow.role === 'admin') {
			// Requesting a role above member is checked before the target's
			// current role, so an admin requesting admin/owner is always
			// role_not_permitted -- including a self-targeting request, where
			// the target row is the admin's own and would otherwise fail the
			// role !== 'member' check below with the wrong outcome.
			if (command.role !== 'member') {
				return { kind: 'outcome', result: { outcome: 'role_not_permitted' } };
			}
			if (targetRow.role !== 'member') {
				return { kind: 'outcome', result: { outcome: 'forbidden' } };
			}
		}

		const otherActiveOwners: number = ownerCountRow?.count ?? 0;
		if (
			targetRow.role === 'owner' &&
			targetRow.status === 'active' &&
			command.role !== 'owner' &&
			otherActiveOwners === 0
		) {
			return { kind: 'outcome', result: { outcome: 'last_active_owner' } };
		}

		if (command.updatedAt < targetRow.updated_at) {
			return { kind: 'outcome', result: { outcome: 'integrity_error' } };
		}

		return { kind: 'proceed', target: targetRow };
	}

	async #classifySetRoleFailure(
		command: SetInstanceMemberRoleCommand
	): Promise<SetInstanceMemberRoleStoreResult | null> {
		const gate: SetRoleGateResult = await this.#resolveSetRoleGate(command);
		if (gate.kind === 'outcome') return gate.result;
		return null;
	}

	async #resolveSetStatusGate(
		command: SetInstanceMemberStatusCommand
	): Promise<SetStatusGateResult> {
		const actorStmt: D1PreparedStatement = this.#database
			.prepare('SELECT role, status FROM instance_member WHERE user_id = ? LIMIT 1')
			.bind(command.actor.id);

		const targetStmt: D1PreparedStatement = this.#database
			.prepare(
				'SELECT user_id, role, status, created_at, updated_at FROM instance_member WHERE user_id = ? LIMIT 1'
			)
			.bind(command.targetUserId);

		const receiptStmt: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${MEMBER_COMMAND_RECEIPT_JOIN_COLUMNS}
				 FROM instance_member_command command
				 LEFT JOIN instance_member target ON target.user_id = command.target_user_id
				 WHERE command.actor_type = ? AND command.actor_id = ? AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(command.actor.type, command.actor.id, command.idempotencyKey);

		const ownerCountStmt: D1PreparedStatement = this.#database
			.prepare(
				"SELECT COUNT(*) AS count FROM instance_member WHERE role = 'owner' AND status = 'active' AND user_id <> ?"
			)
			.bind(command.targetUserId);

		const results: D1Result<
			MemberRoleStatusRow | MemberRow | MemberCommandReceiptRow | CountRow
		>[] = await this.#database.batch<
			MemberRoleStatusRow | MemberRow | MemberCommandReceiptRow | CountRow
		>([actorStmt, targetStmt, receiptStmt, ownerCountStmt]);

		const actorRow: MemberRoleStatusRow | null = firstRow<MemberRoleStatusRow>(results[0]);
		const targetRow: MemberRow | null = firstRow<MemberRow>(results[1]);
		const receiptRow: MemberCommandReceiptRow | null = firstRow<MemberCommandReceiptRow>(
			results[2]
		);
		const ownerCountRow: CountRow | null = firstRow<CountRow>(results[3]);

		// Exact receipt replay is checked first, ahead of the actor's current
		// role/status: evaluateSetStatusReceipt answers entirely from the
		// receipt and the target's row, so a replay by an actor since demoted
		// or suspended is still classified correctly without a separate branch
		// here.
		if (receiptRow !== null) {
			return { kind: 'outcome', result: evaluateSetStatusReceipt(receiptRow, command) };
		}

		if (actorRow === null || actorRow.role === 'member') {
			return { kind: 'outcome', result: { outcome: 'forbidden' } };
		}
		if (actorRow.status === 'suspended') {
			return { kind: 'outcome', result: { outcome: 'member_suspended' } };
		}

		if (command.targetUserId === command.actor.id) {
			return { kind: 'outcome', result: { outcome: 'cannot_target_self' } };
		}

		if (targetRow === null) {
			return { kind: 'outcome', result: { outcome: 'member_not_found' } };
		}

		if (actorRow.role === 'admin' && targetRow.role !== 'member') {
			return { kind: 'outcome', result: { outcome: 'forbidden' } };
		}

		const otherActiveOwners: number = ownerCountRow?.count ?? 0;
		if (
			targetRow.role === 'owner' &&
			targetRow.status === 'active' &&
			command.status === 'suspended' &&
			otherActiveOwners === 0
		) {
			return { kind: 'outcome', result: { outcome: 'last_active_owner' } };
		}

		if (command.updatedAt < targetRow.updated_at) {
			return { kind: 'outcome', result: { outcome: 'integrity_error' } };
		}

		return { kind: 'proceed', target: targetRow };
	}

	async #classifySetStatusFailure(
		command: SetInstanceMemberStatusCommand
	): Promise<SetInstanceMemberStatusStoreResult | null> {
		const gate: SetStatusGateResult = await this.#resolveSetStatusGate(command);
		if (gate.kind === 'outcome') return gate.result;
		return null;
	}

	async #resolveCreateGate(
		command: CreateInstanceInvitationCommand
	): Promise<CreateInstanceInvitationStoreResult | null> {
		const memberStmt: D1PreparedStatement = this.#database
			.prepare('SELECT role, status FROM instance_member WHERE user_id = ? LIMIT 1')
			.bind(command.actor.id);

		const receiptStmt: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${CREATE_RECEIPT_JOIN_COLUMNS}
				 FROM instance_invitation_command command
				 LEFT JOIN instance_invitation invitation
				   ON invitation.id = command.invitation_id
				 WHERE command.actor_type = ? AND command.actor_id = ? AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(command.actor.type, command.actor.id, command.idempotencyKey);

		// Lexical comparison, not datetime(): both sides are canonical UTC
		// millisecond ISO-8601 strings, so string ordering matches chronological
		// ordering exactly, whereas datetime() truncates to whole seconds and
		// would misclassify invitations expiring within the same second.
		const countStmt: D1PreparedStatement = this.#database
			.prepare(
				"SELECT COUNT(*) AS count FROM instance_invitation WHERE status = 'pending' AND expires_at > ?"
			)
			.bind(command.createdAt);

		const results: D1Result<MemberRoleStatusRow | CreateInvitationReceiptRow | CountRow>[] =
			await this.#database.batch<MemberRoleStatusRow | CreateInvitationReceiptRow | CountRow>([
				memberStmt,
				receiptStmt,
				countStmt
			]);

		const memberRow: MemberRoleStatusRow | null = firstRow<MemberRoleStatusRow>(results[0]);
		if (memberRow === null || memberRow.role === 'member') {
			return { outcome: 'forbidden' };
		}
		if (memberRow.status === 'suspended') {
			return { outcome: 'member_suspended' };
		}

		const receiptRow: CreateInvitationReceiptRow | null = firstRow<CreateInvitationReceiptRow>(
			results[1]
		);
		if (receiptRow !== null) {
			return evaluateCreateReceipt(receiptRow, command);
		}

		if (memberRow.role === 'admin' && command.role !== 'member') {
			return { outcome: 'role_not_permitted' };
		}

		const countRow: CountRow | null = firstRow<CountRow>(results[2]);
		if (countRow !== null && countRow.count >= MAX_PENDING_INSTANCE_INVITATIONS) {
			return { outcome: 'limit' };
		}

		return null;
	}

	async #classifyCreateFailure(
		command: CreateInstanceInvitationCommand
	): Promise<CreateInstanceInvitationStoreResult | null> {
		const gate: CreateInstanceInvitationStoreResult | null = await this.#resolveCreateGate(command);
		if (gate !== null) return gate;

		const existingId = await this.#database
			.prepare('SELECT 1 FROM instance_invitation WHERE id = ? LIMIT 1')
			.bind(command.invitationId)
			.first();
		if (existingId !== null) return { outcome: 'credential_collision' };

		const existingHash = await this.#database
			.prepare('SELECT 1 FROM instance_invitation WHERE token_hash = ? LIMIT 1')
			.bind(command.tokenHash)
			.first();
		if (existingHash !== null) return { outcome: 'credential_collision' };

		return null;
	}

	async #resolveAcceptGate(command: AcceptInstanceInvitationCommand): Promise<AcceptGateResult> {
		const receiptStmt: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${ACCEPT_RECEIPT_JOIN_COLUMNS}
				 FROM instance_invitation_command command
				 LEFT JOIN instance_invitation invitation ON invitation.id = command.invitation_id
				 LEFT JOIN instance_member member ON member.user_id = command.actor_id
				 WHERE command.actor_type = ? AND command.actor_id = ? AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(command.actor.type, command.actor.id, command.idempotencyKey);

		const memberStmt: D1PreparedStatement = this.#database
			.prepare(
				'SELECT user_id, role, status, created_at, updated_at FROM instance_member WHERE user_id = ? LIMIT 1'
			)
			.bind(command.actor.id);

		const invitationStmt: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${INVITATION_METADATA_COLUMNS}, email_binding
				 FROM instance_invitation
				 WHERE token_hash = ?
				 LIMIT 1`
			)
			.bind(command.tokenHash);

		const results: D1Result<AcceptInvitationReceiptRow | MemberRow | InvitationCandidateRow>[] =
			await this.#database.batch<AcceptInvitationReceiptRow | MemberRow | InvitationCandidateRow>([
				receiptStmt,
				memberStmt,
				invitationStmt
			]);

		const receiptRow: AcceptInvitationReceiptRow | null = firstRow<AcceptInvitationReceiptRow>(
			results[0]
		);
		const memberRow: MemberRow | null = firstRow<MemberRow>(results[1]);
		const invitationRow: InvitationCandidateRow | null = firstRow<InvitationCandidateRow>(
			results[2]
		);

		// Exact receipt replay is checked first, ahead of the actor's current
		// status: evaluateAcceptReceipt re-derives member_suspended from the
		// joined member row itself, so a replay by a since-suspended actor is
		// still classified correctly without a separate branch here.
		if (receiptRow !== null) {
			return {
				kind: 'outcome',
				result: evaluateAcceptReceipt(receiptRow, memberRow, command)
			};
		}

		if (memberRow !== null && memberRow.status === 'suspended') {
			return { kind: 'outcome', result: { outcome: 'member_suspended' } };
		}

		// An already-active member never needs to accept: return their current
		// membership without ever locking or mutating the invitation, so a
		// stale or misdirected token cannot be replayed into a role change or
		// leave a receipt behind.
		if (memberRow !== null && memberRow.status === 'active') {
			return {
				kind: 'outcome',
				result: { outcome: 'already_member', member: metadataFromMemberRow(memberRow) }
			};
		}

		const acceptedAtMs: number = Date.parse(command.acceptedAt);
		const createdAtMs: number = invitationRow !== null ? Date.parse(invitationRow.created_at) : NaN;
		const expiresAtMs: number = invitationRow !== null ? Date.parse(invitationRow.expires_at) : NaN;
		if (
			invitationRow === null ||
			!(await secretsEqual(command.emailBinding, invitationRow.email_binding)) ||
			invitationRow.status !== 'pending' ||
			!Number.isFinite(acceptedAtMs) ||
			!Number.isFinite(createdAtMs) ||
			!Number.isFinite(expiresAtMs) ||
			acceptedAtMs < createdAtMs ||
			acceptedAtMs >= expiresAtMs
		) {
			return { kind: 'outcome', result: { outcome: 'invitation_invalid' } };
		}

		return {
			kind: 'proceed',
			invitation: invitationRow,
			existingMember: memberRow
		};
	}

	async #classifyAcceptFailure(
		command: AcceptInstanceInvitationCommand
	): Promise<AcceptInstanceInvitationStoreResult | null> {
		const gate: AcceptGateResult = await this.#resolveAcceptGate(command);
		if (gate.kind === 'outcome') return gate.result;
		return null;
	}

	async #resolveRevokeGate(command: RevokeInstanceInvitationCommand): Promise<RevokeGateResult> {
		const memberStmt: D1PreparedStatement = this.#database
			.prepare('SELECT role, status FROM instance_member WHERE user_id = ? LIMIT 1')
			.bind(command.actor.id);

		const receiptStmt: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${REVOKE_RECEIPT_JOIN_COLUMNS}
				 FROM instance_invitation_command command
				 LEFT JOIN instance_invitation invitation
				   ON invitation.id = command.invitation_id
				 WHERE command.actor_type = ? AND command.actor_id = ? AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(command.actor.type, command.actor.id, command.idempotencyKey);

		const invitationStmt: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${INVITATION_METADATA_COLUMNS}
				 FROM instance_invitation
				 WHERE id = ?
				 LIMIT 1`
			)
			.bind(command.invitationId);

		const results: D1Result<
			MemberRoleStatusRow | RevokeInvitationReceiptRow | InvitationMetadataRow
		>[] = await this.#database.batch<
			MemberRoleStatusRow | RevokeInvitationReceiptRow | InvitationMetadataRow
		>([memberStmt, receiptStmt, invitationStmt]);

		const memberRow: MemberRoleStatusRow | null = firstRow<MemberRoleStatusRow>(results[0]);
		if (memberRow === null || memberRow.role === 'member') {
			return { kind: 'outcome', result: { outcome: 'forbidden' } };
		}
		if (memberRow.status === 'suspended') {
			return { kind: 'outcome', result: { outcome: 'member_suspended' } };
		}

		const receiptRow: RevokeInvitationReceiptRow | null = firstRow<RevokeInvitationReceiptRow>(
			results[1]
		);
		if (receiptRow !== null) {
			return {
				kind: 'outcome',
				result: evaluateRevokeReceipt(receiptRow, memberRow, command)
			};
		}

		const invitationRow: InvitationMetadataRow | null = firstRow<InvitationMetadataRow>(results[2]);
		if (invitationRow === null) {
			return { kind: 'outcome', result: { outcome: 'invitation_invalid' } };
		}
		if (invitationRow.status !== 'pending') {
			return { kind: 'outcome', result: { outcome: 'invitation_invalid' } };
		}
		if (memberRow.role === 'admin' && invitationRow.role !== 'member') {
			return { kind: 'outcome', result: { outcome: 'forbidden' } };
		}

		return {
			kind: 'proceed',
			invitation: invitationRow
		};
	}

	async #classifyRevokeFailure(
		command: RevokeInstanceInvitationCommand
	): Promise<RevokeInstanceInvitationStoreResult | null> {
		const gate: RevokeGateResult = await this.#resolveRevokeGate(command);
		if (gate.kind === 'outcome') return gate.result;
		return null;
	}

	async #readMember(userId: string): Promise<MemberRow | null> {
		return await this.#database
			.prepare(
				'SELECT user_id, role, status, created_at, updated_at FROM instance_member WHERE user_id = ? LIMIT 1'
			)
			.bind(userId)
			.first<MemberRow>();
	}
}

function evaluateCreateReceipt(
	row: CreateInvitationReceiptRow,
	command: CreateInstanceInvitationCommand
): CreateInstanceInvitationStoreResult {
	if (row.request_hash !== command.requestFingerprint) {
		return { outcome: 'idempotency_conflict' };
	}
	if (
		row.command_type !== 'create' ||
		row.role !== command.role ||
		row.result_status !== 'pending'
	) {
		return { outcome: 'idempotency_conflict' };
	}
	if (
		row.inv_id === null ||
		row.inv_id !== row.invitation_id ||
		row.inv_role !== row.role ||
		row.inv_created_at !== row.occurred_at ||
		row.inv_invited_by_user_id !== command.actor.id ||
		!isValidTerminalShape(row)
	) {
		return { outcome: 'integrity_error' };
	}
	return {
		outcome: 'replayed',
		invitation: metadataFromJoinedInvitation(row)
	};
}

function evaluateAcceptReceipt(
	row: AcceptInvitationReceiptRow,
	memberRow: MemberRow | null,
	command: AcceptInstanceInvitationCommand
): AcceptInstanceInvitationStoreResult {
	if (memberRow !== null && memberRow.status === 'suspended') {
		return { outcome: 'member_suspended' };
	}
	if (row.request_hash !== command.requestFingerprint) {
		return { outcome: 'idempotency_conflict' };
	}
	if (row.command_type !== 'accept' || row.result_status !== 'accepted') {
		return { outcome: 'idempotency_conflict' };
	}
	if (
		row.inv_id === null ||
		row.inv_id !== row.invitation_id ||
		row.inv_status !== 'accepted' ||
		row.inv_accepted_by_user_id !== command.actor.id ||
		row.inv_accepted_at !== row.occurred_at ||
		row.inv_role !== row.role ||
		row.member_user_id === null ||
		row.member_user_id !== command.actor.id ||
		row.member_status !== 'active'
	) {
		return { outcome: 'integrity_error' };
	}
	return {
		outcome: 'replayed',
		invitation: metadataFromJoinedInvitation(row),
		member: metadataFromJoinedMember(row)
	};
}

function evaluateRevokeReceipt(
	row: RevokeInvitationReceiptRow,
	memberRow: MemberRoleStatusRow,
	command: RevokeInstanceInvitationCommand
): RevokeInstanceInvitationStoreResult {
	if (row.request_hash !== command.requestFingerprint) {
		return { outcome: 'idempotency_conflict' };
	}
	if (
		row.command_type !== 'revoke' ||
		row.result_status !== 'revoked' ||
		row.invitation_id !== command.invitationId
	) {
		return { outcome: 'idempotency_conflict' };
	}
	if (memberRow.role === 'admin' && row.role !== 'member') {
		return { outcome: 'forbidden' };
	}
	if (
		row.inv_id === null ||
		row.inv_id !== row.invitation_id ||
		row.inv_status !== 'revoked' ||
		row.inv_revoked_by_user_id !== command.actor.id ||
		row.inv_revoked_at !== row.occurred_at ||
		row.inv_role !== row.role
	) {
		return { outcome: 'integrity_error' };
	}
	return {
		outcome: 'replayed',
		invitation: metadataFromJoinedInvitation(row)
	};
}

function evaluateSetRoleReceipt(
	row: MemberCommandReceiptRow,
	command: SetInstanceMemberRoleCommand
): SetInstanceMemberRoleStoreResult {
	if (row.request_hash !== command.requestFingerprint) {
		return { outcome: 'idempotency_conflict' };
	}
	if (
		row.command_type !== 'set_role' ||
		row.target_user_id !== command.targetUserId ||
		row.result_role !== command.role
	) {
		return { outcome: 'idempotency_conflict' };
	}
	if (
		row.target_row_user_id === null ||
		row.target_row_created_at === null ||
		!isInstanceMemberRole(row.result_role) ||
		!isInstanceMemberStatus(row.result_status)
	) {
		return { outcome: 'integrity_error' };
	}
	return {
		outcome: 'replayed',
		member: {
			userId: row.target_row_user_id,
			role: row.result_role,
			status: row.result_status,
			createdAt: row.target_row_created_at,
			updatedAt: row.occurred_at
		},
		appliedAt: row.occurred_at,
		revokedInvitationCount: row.revoked_invitation_count
	};
}

function evaluateSetStatusReceipt(
	row: MemberCommandReceiptRow,
	command: SetInstanceMemberStatusCommand
): SetInstanceMemberStatusStoreResult {
	if (row.request_hash !== command.requestFingerprint) {
		return { outcome: 'idempotency_conflict' };
	}
	if (
		row.command_type !== 'set_status' ||
		row.target_user_id !== command.targetUserId ||
		row.result_status !== command.status
	) {
		return { outcome: 'idempotency_conflict' };
	}
	if (
		row.target_row_user_id === null ||
		row.target_row_created_at === null ||
		!isInstanceMemberRole(row.result_role) ||
		!isInstanceMemberStatus(row.result_status)
	) {
		return { outcome: 'integrity_error' };
	}
	return {
		outcome: 'replayed',
		member: {
			userId: row.target_row_user_id,
			role: row.result_role,
			status: row.result_status,
			createdAt: row.target_row_created_at,
			updatedAt: row.occurred_at
		},
		appliedAt: row.occurred_at,
		revokedInvitationCount: row.revoked_invitation_count
	};
}

function isValidTerminalShape(row: {
	inv_status: string | null;
	inv_accepted_at: string | null;
	inv_accepted_by_user_id: string | null;
	inv_revoked_at: string | null;
	inv_revoked_by_user_id: string | null;
}): boolean {
	if (row.inv_status === 'pending') {
		return (
			row.inv_accepted_at === null &&
			row.inv_accepted_by_user_id === null &&
			row.inv_revoked_at === null &&
			row.inv_revoked_by_user_id === null
		);
	}
	if (row.inv_status === 'accepted') {
		return (
			row.inv_accepted_at !== null &&
			row.inv_accepted_by_user_id !== null &&
			row.inv_revoked_at === null &&
			row.inv_revoked_by_user_id === null
		);
	}
	if (row.inv_status === 'revoked') {
		return (
			row.inv_revoked_at !== null &&
			row.inv_revoked_by_user_id !== null &&
			row.inv_accepted_at === null &&
			row.inv_accepted_by_user_id === null
		);
	}
	return false;
}

function metadataFromJoinedInvitation(row: {
	inv_id: string | null;
	inv_role: string | null;
	inv_status: string | null;
	inv_invited_by_user_id: string | null;
	inv_created_at: string | null;
	inv_expires_at: string | null;
	inv_accepted_at: string | null;
	inv_accepted_by_user_id: string | null;
	inv_revoked_at: string | null;
	inv_revoked_by_user_id: string | null;
}): InstanceInvitationMetadata {
	if (
		row.inv_id === null ||
		!isInstanceMemberRole(row.inv_role) ||
		!isInstanceInvitationStatus(row.inv_status) ||
		row.inv_invited_by_user_id === null ||
		row.inv_created_at === null ||
		row.inv_expires_at === null
	) {
		throw new Error('Stored instance invitation state is corrupted.');
	}
	return {
		id: row.inv_id,
		role: row.inv_role,
		status: row.inv_status,
		invitedByUserId: row.inv_invited_by_user_id,
		createdAt: row.inv_created_at,
		expiresAt: row.inv_expires_at,
		acceptedAt: row.inv_accepted_at,
		acceptedByUserId: row.inv_accepted_by_user_id,
		revokedAt: row.inv_revoked_at,
		revokedByUserId: row.inv_revoked_by_user_id
	};
}

function metadataFromJoinedMember(row: {
	member_user_id: string | null;
	member_role: string | null;
	member_status: string | null;
	member_created_at: string | null;
	member_updated_at: string | null;
}): InstanceMemberMetadata {
	if (
		row.member_user_id === null ||
		!isInstanceMemberRole(row.member_role) ||
		!isInstanceMemberStatus(row.member_status) ||
		row.member_created_at === null ||
		row.member_updated_at === null
	) {
		throw new Error('Stored instance member state is corrupted.');
	}
	return {
		userId: row.member_user_id,
		role: row.member_role,
		status: row.member_status,
		createdAt: row.member_created_at,
		updatedAt: row.member_updated_at
	};
}

function metadataFromInvitationRow(row: InvitationMetadataRow): InstanceInvitationMetadata {
	if (!isInstanceMemberRole(row.role) || !isInstanceInvitationStatus(row.status)) {
		throw new Error('Stored instance invitation state is corrupted.');
	}
	return {
		id: row.id,
		role: row.role,
		status: row.status,
		invitedByUserId: row.invited_by_user_id,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		acceptedAt: row.accepted_at,
		acceptedByUserId: row.accepted_by_user_id,
		revokedAt: row.revoked_at,
		revokedByUserId: row.revoked_by_user_id
	};
}

function metadataFromMemberRow(row: MemberRow): InstanceMemberMetadata {
	if (!isInstanceMemberRole(row.role) || !isInstanceMemberStatus(row.status)) {
		throw new Error('Stored instance member state is corrupted.');
	}
	return {
		userId: row.user_id,
		role: row.role,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function changeCount(result: D1Result): number {
	const changes: unknown = (result.meta as { changes?: unknown }).changes;
	return typeof changes === 'number' ? changes : 0;
}

function firstRow<T>(result: D1Result<T | unknown> | undefined): T | null {
	return (result?.results[0] as T | undefined) ?? null;
}
