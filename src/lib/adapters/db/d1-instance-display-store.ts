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

interface MemberRoleStatusRow {
	role: string;
	status: string;
}

interface MemberDisplaySqlRow {
	user_id: string;
	sealed_payload: string;
	sealing_key_id: string;
	observed_at: string;
	expires_at: string;
	stored_at: string;
}

interface InvitationDisplaySqlRow {
	invitation_id: string;
	sealed_payload: string;
	sealing_key_id: string;
	created_at: string;
	expires_at: string;
}

const MEMBER_DISPLAY_COLUMNS: string =
	'user_id, sealed_payload, sealing_key_id, observed_at, expires_at, stored_at';
const INVITATION_DISPLAY_COLUMNS: string =
	'invitation_id, sealed_payload, sealing_key_id, created_at, expires_at';
const INVITATION_DISPLAY_JOIN_COLUMNS: string =
	'display.invitation_id AS invitation_id, display.sealed_payload AS sealed_payload, display.sealing_key_id AS sealing_key_id, display.created_at AS created_at, display.expires_at AS expires_at';

export class D1InstanceDisplayStore implements InstanceDisplayStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async recordMemberSnapshot(
		command: RecordMemberDisplaySnapshotCommand
	): Promise<RecordMemberDisplaySnapshotResult> {
		const upsert: D1Result = await this.#database
			.prepare(
				`INSERT INTO instance_member_display (
					user_id, sealed_payload, sealing_key_id, observed_at, expires_at, stored_at
				)
				SELECT user_id, ?, ?, ?, ?, ?
				FROM instance_member
				WHERE user_id = ? AND status = 'active'
				ON CONFLICT(user_id) DO UPDATE SET
					sealed_payload = excluded.sealed_payload,
					sealing_key_id = excluded.sealing_key_id,
					observed_at = excluded.observed_at,
					expires_at = excluded.expires_at,
					stored_at = excluded.stored_at,
					reseal_after = excluded.reseal_after
				WHERE instance_member_display.observed_at < excluded.observed_at`
			)
			.bind(
				command.sealedPayload,
				command.sealingKeyId,
				command.observedAt,
				command.expiresAt,
				command.storedAt,
				command.userId
			)
			.run();
		if (changeCount(upsert) === 1) return { outcome: 'recorded' };

		const member: MemberRoleStatusRow | null = await this.#database
			.prepare('SELECT role, status FROM instance_member WHERE user_id = ? LIMIT 1')
			.bind(command.userId)
			.first<MemberRoleStatusRow>();
		if (member === null || member.status !== 'active') return { outcome: 'skipped' };
		return { outcome: 'unchanged' };
	}

	async listMemberDisplayRows(
		actor: InstanceActor,
		userIds: readonly string[]
	): Promise<ListInstanceDisplayRowsResult<InstanceMemberDisplayRow>> {
		const ids: string[] = uniqueBoundedDisplayIds(userIds, MAX_INSTANCE_MEMBER_LIST_LIMIT);
		const memberStmt: D1PreparedStatement = this.#database
			.prepare('SELECT role, status FROM instance_member WHERE user_id = ? LIMIT 1')
			.bind(actor.id);
		if (ids.length === 0) {
			const memberRow: MemberRoleStatusRow | null = await memberStmt.first<MemberRoleStatusRow>();
			return authorizeList(memberRow, []);
		}
		const placeholders: string = ids.map((): string => '?').join(', ');
		const pageStmt: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${MEMBER_DISPLAY_COLUMNS}
				 FROM instance_member_display
				 WHERE user_id IN (${placeholders})`
			)
			.bind(...ids);
		const results: D1Result<MemberRoleStatusRow | MemberDisplaySqlRow>[] =
			await this.#database.batch<MemberRoleStatusRow | MemberDisplaySqlRow>([memberStmt, pageStmt]);
		const authorized: ListInstanceDisplayRowsResult<InstanceMemberDisplayRow> = authorizeList(
			firstRow<MemberRoleStatusRow>(results[0]),
			[]
		);
		if (authorized.outcome !== 'listed') return authorized;
		const rows: MemberDisplaySqlRow[] = (results[1]?.results ?? []) as MemberDisplaySqlRow[];
		return { outcome: 'listed', rows: rows.map(memberRowFromSql) };
	}

	async listInvitationDisplayRows(
		actor: InstanceActor,
		invitationIds: readonly string[]
	): Promise<ListInstanceDisplayRowsResult<InstanceInvitationDisplayRow>> {
		const ids: string[] = uniqueBoundedDisplayIds(invitationIds, MAX_INSTANCE_MEMBER_LIST_LIMIT);
		const memberStmt: D1PreparedStatement = this.#database
			.prepare('SELECT role, status FROM instance_member WHERE user_id = ? LIMIT 1')
			.bind(actor.id);
		if (ids.length === 0) {
			const memberRow: MemberRoleStatusRow | null = await memberStmt.first<MemberRoleStatusRow>();
			return authorizeList(memberRow, []);
		}
		const placeholders: string = ids.map((): string => '?').join(', ');
		const pageStmt: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${INVITATION_DISPLAY_COLUMNS}
				 FROM instance_invitation_display
				 WHERE invitation_id IN (${placeholders})`
			)
			.bind(...ids);
		const results: D1Result<MemberRoleStatusRow | InvitationDisplaySqlRow>[] =
			await this.#database.batch<MemberRoleStatusRow | InvitationDisplaySqlRow>([
				memberStmt,
				pageStmt
			]);
		const authorized: ListInstanceDisplayRowsResult<InstanceInvitationDisplayRow> = authorizeList(
			firstRow<MemberRoleStatusRow>(results[0]),
			[]
		);
		if (authorized.outcome !== 'listed') return authorized;
		const rows: InvitationDisplaySqlRow[] = (results[1]?.results ??
			[]) as InvitationDisplaySqlRow[];
		return { outcome: 'listed', rows: rows.map(invitationRowFromSql) };
	}

	async cleanupExpired(now: string, limit: number): Promise<InstanceDisplayCleanupResult> {
		const bounded: number = boundInstanceDisplayCleanupLimit(limit);
		if (bounded === 0) return { expired: 0, deleted: 0 };
		const memberDelete: D1Result = await this.#database
			.prepare(
				`DELETE FROM instance_member_display
				 WHERE user_id IN (
					 SELECT user_id FROM instance_member_display
					 WHERE expires_at <= ?
					 ORDER BY expires_at, user_id
					 LIMIT ?
				 )
				 AND expires_at <= ?`
			)
			.bind(now, bounded, now)
			.run();
		const expired: number = Math.min(
			changeCount(memberDelete),
			INSTANCE_DISPLAY_CLEANUP_BATCH_LIMIT
		);
		const remaining: number = bounded - expired;
		if (remaining < 1) {
			return { expired, deleted: 0 };
		}
		const invitationDelete: D1Result = await this.#database
			.prepare(
				`DELETE FROM instance_invitation_display
				 WHERE invitation_id IN (
					 SELECT display.invitation_id
					 FROM instance_invitation_display AS display
					 INNER JOIN instance_invitation AS invitation
					   ON invitation.id = display.invitation_id
					 WHERE display.expires_at <= ?
					    OR invitation.status <> 'pending'
					    OR invitation.expires_at <= ?
					 ORDER BY display.expires_at, display.invitation_id
					 LIMIT ?
				 )
				 AND invitation_id IN (
					 SELECT display.invitation_id
					 FROM instance_invitation_display AS display
					 INNER JOIN instance_invitation AS invitation
					   ON invitation.id = display.invitation_id
					 WHERE display.expires_at <= ?
					    OR invitation.status <> 'pending'
					    OR invitation.expires_at <= ?
				 )`
			)
			.bind(now, now, remaining, now, now)
			.run();
		return {
			expired,
			deleted: Math.min(changeCount(invitationDelete), INSTANCE_DISPLAY_CLEANUP_BATCH_LIMIT)
		};
	}

	async findMemberRowsForReseal(
		previousSealingKeyId: string,
		now: string,
		limit: number
	): Promise<readonly InstanceMemberDisplayRow[]> {
		const bounded: number = boundInstanceDisplayResealLimit(limit);
		if (bounded === 0) return [];
		const result: D1Result<MemberDisplaySqlRow> = await this.#database
			.prepare(
				`SELECT ${MEMBER_DISPLAY_COLUMNS}
				 FROM instance_member_display
				 WHERE sealing_key_id = ? AND expires_at > ? AND reseal_after <= ?
				 ORDER BY expires_at, user_id
				 LIMIT ?`
			)
			.bind(previousSealingKeyId, now, now, bounded)
			.all<MemberDisplaySqlRow>();
		return (result.results ?? [])
			.slice(0, INSTANCE_DISPLAY_RESEAL_BATCH_LIMIT)
			.map(memberRowFromSql);
	}

	async findInvitationRowsForReseal(
		previousSealingKeyId: string,
		now: string,
		limit: number
	): Promise<readonly InstanceInvitationDisplayRow[]> {
		const bounded: number = boundInstanceDisplayResealLimit(limit);
		if (bounded === 0) return [];
		const result: D1Result<InvitationDisplaySqlRow> = await this.#database
			.prepare(
				`SELECT ${INVITATION_DISPLAY_JOIN_COLUMNS}
				 FROM instance_invitation_display AS display
				 INNER JOIN instance_invitation AS invitation
				   ON invitation.id = display.invitation_id
				 WHERE display.sealing_key_id = ?
				   AND display.expires_at > ?
				   AND display.reseal_after <= ?
				   AND invitation.status = 'pending'
				   AND invitation.expires_at > ?
				 ORDER BY display.expires_at, display.invitation_id
				 LIMIT ?`
			)
			.bind(previousSealingKeyId, now, now, now, bounded)
			.all<InvitationDisplaySqlRow>();
		return (result.results ?? [])
			.slice(0, INSTANCE_DISPLAY_RESEAL_BATCH_LIMIT)
			.map(invitationRowFromSql);
	}

	async casResealMemberSnapshot(
		command: CasResealMemberDisplayCommand
	): Promise<CasResealDisplayResult> {
		const result: D1Result = await this.#database
			.prepare(
				`UPDATE instance_member_display
				 SET sealed_payload = ?, sealing_key_id = ?, stored_at = ?
				 WHERE user_id = ?
				   AND sealing_key_id = ?
				   AND observed_at = ?
				   AND expires_at = ?
				   AND sealed_payload = ?
				   AND expires_at > ?`
			)
			.bind(
				command.sealedPayload,
				command.sealingKeyId,
				command.storedAt,
				command.userId,
				command.previousSealingKeyId,
				command.previousObservedAt,
				command.previousExpiresAt,
				command.previousSealedPayload,
				command.storedAt
			)
			.run();
		return changeCount(result) === 1 ? 'resealed' : 'stale';
	}

	async casResealInvitationTarget(
		command: CasResealInvitationDisplayCommand
	): Promise<CasResealDisplayResult> {
		const result: D1Result = await this.#database
			.prepare(
				`UPDATE instance_invitation_display
				 SET sealed_payload = ?, sealing_key_id = ?
				 WHERE invitation_id = ?
				   AND sealing_key_id = ?
				   AND sealed_payload = ?
				   AND expires_at > ?
				   AND EXISTS (
					 SELECT 1 FROM instance_invitation
					 WHERE id = instance_invitation_display.invitation_id
					   AND status = 'pending'
					   AND expires_at > ?
				   )`
			)
			.bind(
				command.sealedPayload,
				command.sealingKeyId,
				command.invitationId,
				command.previousSealingKeyId,
				command.previousSealedPayload,
				command.now,
				command.now
			)
			.run();
		return changeCount(result) === 1 ? 'resealed' : 'stale';
	}

	async deferMemberReseal(
		command: DeferMemberDisplayResealCommand
	): Promise<DeferDisplayResealResult> {
		const result: D1Result = await this.#database
			.prepare(
				`UPDATE instance_member_display
				 SET reseal_after = expires_at
				 WHERE user_id = ?
				   AND sealing_key_id = ?
				   AND observed_at = ?
				   AND expires_at = ?
				   AND sealed_payload = ?
				   AND expires_at > ?`
			)
			.bind(
				command.userId,
				command.previousSealingKeyId,
				command.previousObservedAt,
				command.previousExpiresAt,
				command.previousSealedPayload,
				command.now
			)
			.run();
		return changeCount(result) === 1 ? 'deferred' : 'stale';
	}

	async deferInvitationReseal(
		command: DeferInvitationDisplayResealCommand
	): Promise<DeferDisplayResealResult> {
		const result: D1Result = await this.#database
			.prepare(
				`UPDATE instance_invitation_display
				 SET reseal_after = expires_at
				 WHERE invitation_id = ?
				   AND sealing_key_id = ?
				   AND sealed_payload = ?
				   AND expires_at > ?
				   AND EXISTS (
					 SELECT 1 FROM instance_invitation
					 WHERE id = instance_invitation_display.invitation_id
					   AND status = 'pending'
					   AND expires_at > ?
				   )`
			)
			.bind(
				command.invitationId,
				command.previousSealingKeyId,
				command.previousSealedPayload,
				command.now,
				command.now
			)
			.run();
		return changeCount(result) === 1 ? 'deferred' : 'stale';
	}
}

function authorizeList<T>(
	memberRow: MemberRoleStatusRow | null,
	rows: readonly T[]
): ListInstanceDisplayRowsResult<T> {
	if (memberRow === null || memberRow.role === 'member') {
		return { outcome: 'forbidden' };
	}
	if (memberRow.status === 'suspended') {
		return { outcome: 'member_suspended' };
	}
	return { outcome: 'listed', rows };
}

function memberRowFromSql(row: MemberDisplaySqlRow): InstanceMemberDisplayRow {
	return {
		userId: row.user_id,
		sealedPayload: row.sealed_payload,
		sealingKeyId: row.sealing_key_id,
		observedAt: row.observed_at,
		expiresAt: row.expires_at,
		storedAt: row.stored_at
	};
}

function invitationRowFromSql(row: InvitationDisplaySqlRow): InstanceInvitationDisplayRow {
	return {
		invitationId: row.invitation_id,
		sealedPayload: row.sealed_payload,
		sealingKeyId: row.sealing_key_id,
		createdAt: row.created_at,
		expiresAt: row.expires_at
	};
}

function changeCount(result: D1Result): number {
	const changes: unknown = (result.meta as { changes?: unknown }).changes;
	return typeof changes === 'number' ? changes : 0;
}

function firstRow<T>(result: D1Result<T | unknown> | undefined): T | null {
	const row: T | unknown | undefined = result?.results?.[0];
	return row === undefined ? null : (row as T);
}
