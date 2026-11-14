import postgres from 'postgres';
import {
	INSTANCE_DISPLAY_CLEANUP_BATCH_LIMIT,
	INSTANCE_DISPLAY_RESEAL_BATCH_LIMIT,
	boundInstanceDisplayCleanupLimit,
	boundInstanceDisplayResealLimit
} from '$lib/domain/instance-display';
import {
	uniqueBoundedDisplayIds,
	type CasResealDisplayResult,
	type CasResealInvitationDisplayCommand,
	type CasResealMemberDisplayCommand,
	type DeferDisplayResealResult,
	type DeferInvitationDisplayResealCommand,
	type DeferMemberDisplayResealCommand,
	type InstanceDisplayCleanupResult,
	type InstanceDisplayStore,
	type InstanceInvitationDisplayRow,
	type InstanceMemberDisplayRow,
	type ListInstanceDisplayRowsResult,
	type RecordMemberDisplaySnapshotCommand,
	type RecordMemberDisplaySnapshotResult
} from '$lib/ports/instance-display-store';
import { MAX_INSTANCE_MEMBER_LIST_LIMIT, type InstanceActor } from '$lib/ports/instance-store';

type Sql = ReturnType<typeof postgres>;

interface MemberRoleStatusRow {
	role: string;
	status: string;
}

interface MemberDisplaySqlRow {
	userId: string;
	sealedPayload: string;
	sealingKeyId: string;
	observedAt: Date | string;
	expiresAt: Date | string;
	storedAt: Date | string;
}

interface InvitationDisplaySqlRow {
	invitationId: string;
	sealedPayload: string;
	sealingKeyId: string;
	createdAt: Date | string;
	expiresAt: Date | string;
}

export class PostgresInstanceDisplayStore implements InstanceDisplayStore {
	readonly #sql: Sql;

	constructor(sql: Sql) {
		this.#sql = sql;
	}

	async recordMemberSnapshot(
		command: RecordMemberDisplaySnapshotCommand
	): Promise<RecordMemberDisplaySnapshotResult> {
		const inserted = await this.#sql<{ userId: string }[]>`
			INSERT INTO instance_member_display (
				user_id, sealed_payload, sealing_key_id, observed_at, expires_at, stored_at
			)
			SELECT user_id, ${command.sealedPayload}, ${command.sealingKeyId},
				${command.observedAt}::timestamptz, ${command.expiresAt}::timestamptz,
				${command.storedAt}::timestamptz
			FROM instance_member
			WHERE user_id = ${command.userId} AND status = 'active'
			ON CONFLICT (user_id) DO UPDATE SET
				sealed_payload = EXCLUDED.sealed_payload,
				sealing_key_id = EXCLUDED.sealing_key_id,
				observed_at = EXCLUDED.observed_at,
				expires_at = EXCLUDED.expires_at,
				stored_at = EXCLUDED.stored_at
			WHERE instance_member_display.observed_at < EXCLUDED.observed_at
			RETURNING user_id AS "userId"
		`;
		if (inserted.length === 1) return { outcome: 'recorded' };
		const members = await this.#sql<MemberRoleStatusRow[]>`
			SELECT role, status FROM instance_member WHERE user_id = ${command.userId} LIMIT 1
		`;
		const member: MemberRoleStatusRow | undefined = members[0];
		if (member === undefined || member.status !== 'active') return { outcome: 'skipped' };
		return { outcome: 'unchanged' };
	}

	async listMemberDisplayRows(
		actor: InstanceActor,
		userIds: readonly string[]
	): Promise<ListInstanceDisplayRowsResult<InstanceMemberDisplayRow>> {
		return await this.#sql.begin(
			async (transaction): Promise<ListInstanceDisplayRowsResult<InstanceMemberDisplayRow>> => {
				const authorized = await authorizeActor(transaction, actor.id);
				if (authorized.outcome !== 'listed') return authorized;
				const ids: string[] = uniqueBoundedDisplayIds(userIds, MAX_INSTANCE_MEMBER_LIST_LIMIT);
				if (ids.length === 0) return { outcome: 'listed', rows: [] };
				const rows: MemberDisplaySqlRow[] = await transaction<MemberDisplaySqlRow[]>`
					SELECT
						user_id AS "userId",
						sealed_payload AS "sealedPayload",
						sealing_key_id AS "sealingKeyId",
						observed_at AS "observedAt",
						expires_at AS "expiresAt",
						stored_at AS "storedAt"
					FROM instance_member_display
					WHERE user_id = ANY(${ids})
				`;
				return { outcome: 'listed', rows: rows.map(memberRowFromSql) };
			}
		);
	}

	async listInvitationDisplayRows(
		actor: InstanceActor,
		invitationIds: readonly string[]
	): Promise<ListInstanceDisplayRowsResult<InstanceInvitationDisplayRow>> {
		return await this.#sql.begin(
			async (transaction): Promise<ListInstanceDisplayRowsResult<InstanceInvitationDisplayRow>> => {
				const authorized = await authorizeActor(transaction, actor.id);
				if (authorized.outcome !== 'listed') return authorized;
				const ids: string[] = uniqueBoundedDisplayIds(
					invitationIds,
					MAX_INSTANCE_MEMBER_LIST_LIMIT
				);
				if (ids.length === 0) return { outcome: 'listed', rows: [] };
				const rows: InvitationDisplaySqlRow[] = await transaction<InvitationDisplaySqlRow[]>`
					SELECT
						invitation_id AS "invitationId",
						sealed_payload AS "sealedPayload",
						sealing_key_id AS "sealingKeyId",
						created_at AS "createdAt",
						expires_at AS "expiresAt"
					FROM instance_invitation_display
					WHERE invitation_id = ANY(${ids})
				`;
				return { outcome: 'listed', rows: rows.map(invitationRowFromSql) };
			}
		);
	}

	async cleanupExpired(now: string, limit: number): Promise<InstanceDisplayCleanupResult> {
		const bounded: number = boundInstanceDisplayCleanupLimit(limit);
		if (bounded === 0) return { expired: 0, deleted: 0 };
		const members = await this.#sql<{ userId: string }[]>`
			WITH doomed AS (
				SELECT user_id
				FROM instance_member_display
				WHERE expires_at <= ${now}::timestamptz
				ORDER BY expires_at, user_id
				LIMIT ${bounded}
			)
			DELETE FROM instance_member_display AS display
			USING doomed
			WHERE display.user_id = doomed.user_id
				AND display.expires_at <= ${now}::timestamptz
			RETURNING display.user_id AS "userId"
		`;
		const expired: number = Math.min(members.length, INSTANCE_DISPLAY_CLEANUP_BATCH_LIMIT);
		const remaining: number = bounded - expired;
		if (remaining < 1) return { expired, deleted: 0 };
		const invitations = await this.#sql<{ invitationId: string }[]>`
			WITH doomed AS (
				SELECT display.invitation_id
				FROM instance_invitation_display AS display
				INNER JOIN instance_invitation AS invitation
					ON invitation.id = display.invitation_id
				WHERE display.expires_at <= ${now}::timestamptz
					OR invitation.status <> 'pending'
					OR invitation.expires_at <= ${now}::timestamptz
				ORDER BY display.expires_at, display.invitation_id
				LIMIT ${remaining}
			)
			DELETE FROM instance_invitation_display AS display
			USING doomed, instance_invitation AS invitation
			WHERE display.invitation_id = doomed.invitation_id
				AND invitation.id = display.invitation_id
				AND (
					display.expires_at <= ${now}::timestamptz
					OR invitation.status <> 'pending'
					OR invitation.expires_at <= ${now}::timestamptz
				)
			RETURNING display.invitation_id AS "invitationId"
		`;
		return {
			expired,
			deleted: Math.min(invitations.length, INSTANCE_DISPLAY_CLEANUP_BATCH_LIMIT)
		};
	}

	async findMemberRowsForReseal(
		previousSealingKeyId: string,
		now: string,
		limit: number
	): Promise<readonly InstanceMemberDisplayRow[]> {
		const bounded: number = boundInstanceDisplayResealLimit(limit);
		if (bounded === 0) return [];
		const rows: MemberDisplaySqlRow[] = await this.#sql<MemberDisplaySqlRow[]>`
			SELECT
				user_id AS "userId",
				sealed_payload AS "sealedPayload",
				sealing_key_id AS "sealingKeyId",
				observed_at AS "observedAt",
				expires_at AS "expiresAt",
				stored_at AS "storedAt"
			FROM instance_member_display
			WHERE sealing_key_id = ${previousSealingKeyId}
				AND expires_at > ${now}::timestamptz
				AND reseal_after <= ${now}::timestamptz
			ORDER BY expires_at, user_id
			LIMIT ${bounded}
		`;
		return rows.slice(0, INSTANCE_DISPLAY_RESEAL_BATCH_LIMIT).map(memberRowFromSql);
	}

	async findInvitationRowsForReseal(
		previousSealingKeyId: string,
		now: string,
		limit: number
	): Promise<readonly InstanceInvitationDisplayRow[]> {
		const bounded: number = boundInstanceDisplayResealLimit(limit);
		if (bounded === 0) return [];
		const rows: InvitationDisplaySqlRow[] = await this.#sql<InvitationDisplaySqlRow[]>`
			SELECT
				display.invitation_id AS "invitationId",
				display.sealed_payload AS "sealedPayload",
				display.sealing_key_id AS "sealingKeyId",
				display.created_at AS "createdAt",
				display.expires_at AS "expiresAt"
			FROM instance_invitation_display AS display
			INNER JOIN instance_invitation AS invitation
				ON invitation.id = display.invitation_id
			WHERE display.sealing_key_id = ${previousSealingKeyId}
				AND display.expires_at > ${now}::timestamptz
				AND display.reseal_after <= ${now}::timestamptz
				AND invitation.status = 'pending'
				AND invitation.expires_at > ${now}::timestamptz
			ORDER BY display.expires_at, display.invitation_id
			LIMIT ${bounded}
		`;
		return rows.slice(0, INSTANCE_DISPLAY_RESEAL_BATCH_LIMIT).map(invitationRowFromSql);
	}

	async casResealMemberSnapshot(
		command: CasResealMemberDisplayCommand
	): Promise<CasResealDisplayResult> {
		const updated = await this.#sql<{ userId: string }[]>`
			UPDATE instance_member_display
			SET sealed_payload = ${command.sealedPayload},
				sealing_key_id = ${command.sealingKeyId},
				stored_at = ${command.storedAt}::timestamptz
			WHERE user_id = ${command.userId}
				AND sealing_key_id = ${command.previousSealingKeyId}
				AND observed_at = ${command.previousObservedAt}::timestamptz
				AND expires_at = ${command.previousExpiresAt}::timestamptz
				AND sealed_payload = ${command.previousSealedPayload}
				AND expires_at > ${command.storedAt}::timestamptz
			RETURNING user_id AS "userId"
		`;
		return updated.length === 1 ? 'resealed' : 'stale';
	}

	async casResealInvitationTarget(
		command: CasResealInvitationDisplayCommand
	): Promise<CasResealDisplayResult> {
		const updated = await this.#sql<{ invitationId: string }[]>`
			UPDATE instance_invitation_display AS display
			SET sealed_payload = ${command.sealedPayload},
				sealing_key_id = ${command.sealingKeyId}
			WHERE display.invitation_id = ${command.invitationId}
				AND display.sealing_key_id = ${command.previousSealingKeyId}
				AND display.sealed_payload = ${command.previousSealedPayload}
				AND display.expires_at > ${command.now}::timestamptz
				AND EXISTS (
					SELECT 1 FROM instance_invitation
					WHERE id = display.invitation_id
						AND status = 'pending'
						AND expires_at > ${command.now}::timestamptz
				)
			RETURNING display.invitation_id AS "invitationId"
		`;
		return updated.length === 1 ? 'resealed' : 'stale';
	}

	async deferMemberReseal(
		command: DeferMemberDisplayResealCommand
	): Promise<DeferDisplayResealResult> {
		const updated = await this.#sql<{ userId: string }[]>`
			UPDATE instance_member_display
			SET reseal_after = expires_at
			WHERE user_id = ${command.userId}
				AND sealing_key_id = ${command.previousSealingKeyId}
				AND observed_at = ${command.previousObservedAt}::timestamptz
				AND expires_at = ${command.previousExpiresAt}::timestamptz
				AND sealed_payload = ${command.previousSealedPayload}
				AND expires_at > ${command.now}::timestamptz
			RETURNING user_id AS "userId"
		`;
		return updated.length === 1 ? 'deferred' : 'stale';
	}

	async deferInvitationReseal(
		command: DeferInvitationDisplayResealCommand
	): Promise<DeferDisplayResealResult> {
		const updated = await this.#sql<{ invitationId: string }[]>`
			UPDATE instance_invitation_display AS display
			SET reseal_after = expires_at
			WHERE display.invitation_id = ${command.invitationId}
				AND display.sealing_key_id = ${command.previousSealingKeyId}
				AND display.sealed_payload = ${command.previousSealedPayload}
				AND display.expires_at > ${command.now}::timestamptz
				AND EXISTS (
					SELECT 1 FROM instance_invitation
					WHERE id = display.invitation_id
						AND status = 'pending'
						AND expires_at > ${command.now}::timestamptz
				)
			RETURNING display.invitation_id AS "invitationId"
		`;
		return updated.length === 1 ? 'deferred' : 'stale';
	}
}

async function authorizeActor(
	sql: postgres.TransactionSql,
	actorId: string
): Promise<ListInstanceDisplayRowsResult<never>> {
	const members: MemberRoleStatusRow[] = await sql<MemberRoleStatusRow[]>`
		SELECT role, status FROM instance_member WHERE user_id = ${actorId} LIMIT 1 FOR SHARE
	`;
	const member: MemberRoleStatusRow | undefined = members[0];
	if (member === undefined || member.role === 'member') {
		return { outcome: 'forbidden' };
	}
	if (member.status === 'suspended') {
		return { outcome: 'member_suspended' };
	}
	return { outcome: 'listed', rows: [] };
}

function memberRowFromSql(row: MemberDisplaySqlRow): InstanceMemberDisplayRow {
	return {
		userId: row.userId,
		sealedPayload: row.sealedPayload,
		sealingKeyId: row.sealingKeyId,
		observedAt: toIso(row.observedAt),
		expiresAt: toIso(row.expiresAt),
		storedAt: toIso(row.storedAt)
	};
}

function invitationRowFromSql(row: InvitationDisplaySqlRow): InstanceInvitationDisplayRow {
	return {
		invitationId: row.invitationId,
		sealedPayload: row.sealedPayload,
		sealingKeyId: row.sealingKeyId,
		createdAt: toIso(row.createdAt),
		expiresAt: toIso(row.expiresAt)
	};
}

function toIso(val: Date | string): string {
	return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
}
