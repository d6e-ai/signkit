import postgres from 'postgres';
import {
	boundInstanceInvitationListLimit,
	isInstanceInvitationId,
	isInstanceInvitationStatus,
	isInstanceMemberRole,
	isInstanceMemberStatus,
	type AcceptInstanceInvitationCommand,
	type AcceptInstanceInvitationStoreResult,
	type BootstrapInstanceCommand,
	type BootstrapInstanceStoreResult,
	type CreateInstanceInvitationCommand,
	type CreateInstanceInvitationStoreResult,
	type InstanceActor,
	type InstanceCallerContext,
	type InstanceInvitationListQuery,
	type InstanceInvitationMetadata,
	type InstanceMemberMetadata,
	type InstanceMemberRole,
	type InstanceStore,
	type ListInstanceInvitationsStoreResult,
	type RevokeInstanceInvitationCommand,
	type RevokeInstanceInvitationStoreResult
} from '$lib/ports/instance-store';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

class InstanceRollback<T> extends Error {
	constructor(readonly result: T) {
		super('Instance transaction rolled back with an explicit outcome');
		this.name = 'InstanceRollback';
	}
}

interface MemberRow {
	userId: string;
	role: string;
	status: string;
	createdAt: Date | string;
	updatedAt: Date | string;
}

interface MemberRoleStatusRow {
	role: string;
	status: string;
}

interface BootstrapRow {
	singletonKey: number;
	ownerUserId: string;
	createdAt: Date | string;
}

interface BootstrapReceiptRow {
	requestHash: string;
	ownerUserId: string;
	createdAt: Date | string;
}

interface CountRow {
	count: string | number;
}

interface InvitationMetadataRow {
	id: string;
	role: string;
	status: string;
	invitedByUserId: string;
	createdAt: Date | string;
	expiresAt: Date | string;
	acceptedAt: Date | string | null;
	acceptedByUserId: string | null;
	revokedAt: Date | string | null;
	revokedByUserId: string | null;
}

interface InvitationCandidateRow {
	id: string;
	role: string;
	status: string;
	emailBinding: string;
	invitedByUserId: string;
	createdAt: Date | string;
	expiresAt: Date | string;
	acceptedAt: Date | string | null;
	acceptedByUserId: string | null;
	revokedAt: Date | string | null;
	revokedByUserId: string | null;
}

interface CreateInvitationReceiptRow {
	requestHash: string;
	commandType: string;
	invitationId: string;
	role: string;
	resultStatus: string;
	occurredAt: Date | string;
	invId: string | null;
	invRole: string | null;
	invStatus: string | null;
	invInvitedByUserId: string | null;
	invCreatedAt: Date | string | null;
	invExpiresAt: Date | string | null;
	invAcceptedAt: Date | string | null;
	invAcceptedByUserId: string | null;
	invRevokedAt: Date | string | null;
	invRevokedByUserId: string | null;
}

interface AcceptInvitationReceiptRow {
	requestHash: string;
	commandType: string;
	invitationId: string;
	role: string;
	resultStatus: string;
	occurredAt: Date | string;
	invId: string | null;
	invRole: string | null;
	invStatus: string | null;
	invInvitedByUserId: string | null;
	invCreatedAt: Date | string | null;
	invExpiresAt: Date | string | null;
	invAcceptedAt: Date | string | null;
	invAcceptedByUserId: string | null;
	invRevokedAt: Date | string | null;
	invRevokedByUserId: string | null;
	memberUserId: string | null;
	memberRole: string | null;
	memberStatus: string | null;
	memberCreatedAt: Date | string | null;
	memberUpdatedAt: Date | string | null;
}

interface RevokeInvitationReceiptRow {
	requestHash: string;
	commandType: string;
	invitationId: string;
	role: string;
	resultStatus: string;
	occurredAt: Date | string;
	invId: string | null;
	invRole: string | null;
	invStatus: string | null;
	invInvitedByUserId: string | null;
	invCreatedAt: Date | string | null;
	invExpiresAt: Date | string | null;
	invAcceptedAt: Date | string | null;
	invAcceptedByUserId: string | null;
	invRevokedAt: Date | string | null;
	invRevokedByUserId: string | null;
}

export class PostgresInstanceStore implements InstanceStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async bootstrapInstance(
		command: BootstrapInstanceCommand
	): Promise<BootstrapInstanceStoreResult> {
		try {
			return await this.#sql.begin(async (transaction): Promise<BootstrapInstanceStoreResult> => {
				// 1. Check receipt
				const receipts = await transaction<BootstrapReceiptRow[]>`
						SELECT request_hash AS "requestHash", owner_user_id AS "ownerUserId", created_at AS "createdAt"
						FROM instance_bootstrap_command
						WHERE actor_type = ${command.actor.type}
						  AND actor_id = ${command.actor.id}
						  AND idempotency_key = ${command.idempotencyKey}
					`;
				if (receipts.length > 0) {
					throw new InstanceRollback(
						await this.#evaluateReceipt(transaction, receipts[0], command)
					);
				}

				// 2. Check if instance is already bootstrapped or not empty
				const bootstrapRows = await transaction<BootstrapRow[]>`
						SELECT singleton_key AS "singletonKey", owner_user_id AS "ownerUserId", created_at AS "createdAt"
						FROM instance_bootstrap
						WHERE singleton_key = 1
					`;
				const memberCountRows = await transaction<{ count: string | number }[]>`
						SELECT count(*) AS count FROM instance_member
					`;

				if (bootstrapRows.length > 0 || Number(memberCountRows[0]?.count ?? 0) > 0) {
					throw new InstanceRollback({ outcome: 'already_bootstrapped', replayed: false });
				}

				// 3. Atomically insert member, singleton bootstrap, and receipt. The
				// member insert re-checks emptiness in its own SELECT (matching D1's
				// INSERT ... SELECT ... WHERE NOT EXISTS gate) so a membership writer
				// that lands between step 2 and here can never race the step 2 precheck.
				const memberRows = await transaction<MemberRow[]>`
						INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
						SELECT
							${command.actor.id},
							'owner',
							'active',
							${command.createdAt}::timestamptz,
							${command.createdAt}::timestamptz
						WHERE NOT EXISTS (SELECT 1 FROM instance_bootstrap)
						  AND NOT EXISTS (SELECT 1 FROM instance_member)
						ON CONFLICT (user_id) DO NOTHING
						RETURNING user_id AS "userId", role, status, created_at AS "createdAt", updated_at AS "updatedAt"
					`;
				if (memberRows.length !== 1) {
					throw new InstanceRollback(await this.#classifyFailure(transaction, command));
				}

				const bootstrapInserted = await transaction<{ ownerUserId: string }[]>`
						INSERT INTO instance_bootstrap (singleton_key, owner_user_id, created_at)
						VALUES (
							1,
							${command.actor.id},
							${command.createdAt}::timestamptz
						)
						ON CONFLICT DO NOTHING
						RETURNING owner_user_id AS "ownerUserId"
					`;
				if (bootstrapInserted.length !== 1) {
					throw new InstanceRollback(await this.#classifyFailure(transaction, command));
				}

				const receiptInserted = await transaction<{ actorId: string }[]>`
						INSERT INTO instance_bootstrap_command (
							actor_type, actor_id, idempotency_key, request_hash, owner_user_id, created_at
						)
						VALUES (
							${command.actor.type},
							${command.actor.id},
							${command.idempotencyKey},
							${command.requestFingerprint},
							${command.actor.id},
							${command.createdAt}::timestamptz
						)
						ON CONFLICT DO NOTHING
						RETURNING actor_id AS "actorId"
					`;
				if (receiptInserted.length !== 1) {
					throw new InstanceRollback(await this.#classifyFailure(transaction, command));
				}

				return {
					outcome: 'bootstrapped',
					member: {
						userId: memberRows[0].userId,
						role: 'owner',
						status: 'active',
						createdAt: toIso(memberRows[0].createdAt),
						updatedAt: toIso(memberRows[0].updatedAt)
					}
				};
			});
		} catch (error: unknown) {
			if (error instanceof InstanceRollback) {
				return error.result as BootstrapInstanceStoreResult;
			}
			throw error;
		}
	}

	async getInstanceCallerContext(userId: string): Promise<InstanceCallerContext> {
		const [bootstrapRows, memberRows] = await Promise.all([
			this.#sql<BootstrapRow[]>`
				SELECT singleton_key AS "singletonKey", owner_user_id AS "ownerUserId", created_at AS "createdAt"
				FROM instance_bootstrap
				WHERE singleton_key = 1
			`,
			this.#sql<MemberRow[]>`
				SELECT user_id AS "userId", role, status, created_at AS "createdAt", updated_at AS "updatedAt"
				FROM instance_member
				WHERE user_id = ${userId}
			`
		]);

		const bootstrapped: boolean = bootstrapRows.length > 0;
		let member: InstanceMemberMetadata | null = null;
		if (memberRows.length > 0) {
			const row = memberRows[0];
			if (!isInstanceMemberRole(row.role) || !isInstanceMemberStatus(row.status)) {
				throw new Error('Stored instance member state is corrupted.');
			}
			member = {
				userId: row.userId,
				role: row.role,
				status: row.status,
				createdAt: toIso(row.createdAt),
				updatedAt: toIso(row.updatedAt)
			};
		}

		return { member, bootstrapped };
	}

	async createInstanceInvitation(
		command: CreateInstanceInvitationCommand
	): Promise<CreateInstanceInvitationStoreResult> {
		try {
			return await this.#sql.begin(
				async (transaction): Promise<CreateInstanceInvitationStoreResult> => {
					// 1. Authorize actor durably in transaction
					const memberRow: MemberRoleStatusRow | null = await this.#findMemberRoleStatus(
						transaction,
						command.actor.id,
						true
					);
					if (memberRow === null || memberRow.role === 'member') {
						throw new InstanceRollback({ outcome: 'forbidden' });
					}
					if (memberRow.status === 'suspended') {
						throw new InstanceRollback({ outcome: 'member_suspended' });
					}

					// Fix (1): Acquire stable invitation-create-specific advisory lock before receipt/cap/insert
					await transaction`SELECT pg_advisory_xact_lock(hashtext('instance_invitation_create'))`;

					// 2. Check receipt for replay / idempotency conflict
					const receiptRow: CreateInvitationReceiptRow | null = await this.#findCreateReceipt(
						transaction,
						command.actor.type,
						command.actor.id,
						command.idempotencyKey
					);
					if (receiptRow !== null) {
						throw new InstanceRollback(evaluateCreateReceipt(receiptRow, command));
					}

					// 3. Enforce role permission: active admin can invite member only
					if (memberRow.role === 'admin' && command.role !== 'member') {
						throw new InstanceRollback({ outcome: 'role_not_permitted' });
					}

					// 4. Enforce pending cap 200 durably in transaction
					const pendingCount: number = await this.#countPendingInvitations(transaction);
					if (pendingCount >= 200) {
						throw new InstanceRollback({ outcome: 'limit' });
					}

					// 5. Insert invitation
					const insertedInvitation = await transaction<{ id: string }[]>`
						INSERT INTO instance_invitation (
							id, role, status, token_hash, email_binding, invited_by_user_id,
							created_at, expires_at, accepted_at, accepted_by_user_id, revoked_at, revoked_by_user_id
						) VALUES (
							${command.invitationId},
							${command.role},
							'pending',
							${command.tokenHash},
							${command.emailBinding},
							${command.actor.id},
							${command.createdAt}::timestamptz,
							${command.expiresAt}::timestamptz,
							NULL, NULL, NULL, NULL
						)
						ON CONFLICT DO NOTHING
						RETURNING id
					`;
					if (insertedInvitation.length !== 1) {
						throw new InstanceRollback(await this.#classifyCreateFailure(transaction, command));
					}

					// 6. Insert receipt
					const insertedReceipt = await transaction<{ actorId: string }[]>`
						INSERT INTO instance_invitation_command (
							actor_type, actor_id, idempotency_key, command_type, request_hash,
							invitation_id, role, result_status, occurred_at
						) VALUES (
							${command.actor.type},
							${command.actor.id},
							${command.idempotencyKey},
							'create',
							${command.requestFingerprint},
							${command.invitationId},
							${command.role},
							'pending',
							${command.createdAt}::timestamptz
						)
						ON CONFLICT DO NOTHING
						RETURNING actor_id AS "actorId"
					`;
					if (insertedReceipt.length !== 1) {
						throw new InstanceRollback(await this.#classifyCreateFailure(transaction, command));
					}

					return {
						outcome: 'created',
						invitation: {
							id: command.invitationId,
							role: command.role,
							status: 'pending',
							invitedByUserId: command.actor.id,
							createdAt: toIso(command.createdAt),
							expiresAt: toIso(command.expiresAt),
							acceptedAt: null,
							acceptedByUserId: null,
							revokedAt: null,
							revokedByUserId: null
						}
					};
				}
			);
		} catch (error: unknown) {
			if (error instanceof InstanceRollback) {
				return error.result as CreateInstanceInvitationStoreResult;
			}
			const classified: CreateInstanceInvitationStoreResult | null =
				await this.#classifyCreateFailure(this.#sql, command);
			if (classified !== null && classified.outcome !== 'integrity_error') {
				return classified;
			}
			throw error;
		}
	}

	async listInstanceInvitations(
		actor: InstanceActor,
		query: InstanceInvitationListQuery
	): Promise<ListInstanceInvitationsStoreResult> {
		return await this.#sql.begin(
			async (transaction): Promise<ListInstanceInvitationsStoreResult> => {
				const memberRow: MemberRoleStatusRow | null = await this.#findMemberRoleStatus(
					transaction,
					actor.id,
					true
				);
				if (memberRow === null || memberRow.role === 'member') {
					return { outcome: 'forbidden' };
				}
				if (memberRow.status === 'suspended') {
					return { outcome: 'member_suspended' };
				}

				if (query.cursor !== null && !isInstanceInvitationId(query.cursor)) {
					return { outcome: 'listed', page: { items: [], nextCursor: null } };
				}

				const limit: number = boundInstanceInvitationListLimit(query.limit);
				const fetchLimit: number = limit + 1;

				const rows: InvitationMetadataRow[] =
					query.cursor === null
						? await transaction<InvitationMetadataRow[]>`
								SELECT
									id, role, status,
									invited_by_user_id AS "invitedByUserId",
									created_at AS "createdAt",
									expires_at AS "expiresAt",
									accepted_at AS "acceptedAt",
									accepted_by_user_id AS "acceptedByUserId",
									revoked_at AS "revokedAt",
									revoked_by_user_id AS "revokedByUserId"
								FROM instance_invitation
								ORDER BY created_at DESC, id DESC
								LIMIT ${fetchLimit}
							`
						: await transaction<InvitationMetadataRow[]>`
								SELECT
									id, role, status,
									invited_by_user_id AS "invitedByUserId",
									created_at AS "createdAt",
									expires_at AS "expiresAt",
									accepted_at AS "acceptedAt",
									accepted_by_user_id AS "acceptedByUserId",
									revoked_at AS "revokedAt",
									revoked_by_user_id AS "revokedByUserId"
								FROM instance_invitation
								WHERE (created_at, id) < (
									SELECT created_at, id FROM instance_invitation WHERE id = ${query.cursor} LIMIT 1
								)
								ORDER BY created_at DESC, id DESC
								LIMIT ${fetchLimit}
							`;

				const hasNextPage: boolean = rows.length > limit;
				const pageRows: InvitationMetadataRow[] = hasNextPage ? rows.slice(0, limit) : rows;
				const items: readonly InstanceInvitationMetadata[] =
					pageRows.map(metadataFromInvitationRow);
				const lastItem: InstanceInvitationMetadata | undefined = items.at(-1);

				return {
					outcome: 'listed',
					page: {
						items,
						nextCursor: hasNextPage && lastItem !== undefined ? lastItem.id : null
					}
				};
			}
		);
	}

	async acceptInstanceInvitation(
		command: AcceptInstanceInvitationCommand
	): Promise<AcceptInstanceInvitationStoreResult> {
		try {
			return await this.#sql.begin(
				async (transaction): Promise<AcceptInstanceInvitationStoreResult> => {
					// 1. Refuse suspended subject
					const memberRows = await transaction<MemberRow[]>`
						SELECT user_id AS "userId", role, status, created_at AS "createdAt", updated_at AS "updatedAt"
						FROM instance_member
						WHERE user_id = ${command.actor.id}
						FOR UPDATE
					`;
					const existingMember: MemberRow | null = memberRows[0] ?? null;
					if (existingMember !== null && existingMember.status === 'suspended') {
						throw new InstanceRollback({ outcome: 'member_suspended' });
					}

					// 2. Check receipt for replay
					const receiptRow: AcceptInvitationReceiptRow | null = await this.#findAcceptReceipt(
						transaction,
						command.actor.type,
						command.actor.id,
						command.idempotencyKey
					);
					if (receiptRow !== null) {
						throw new InstanceRollback(evaluateAcceptReceipt(receiptRow, existingMember, command));
					}

					// 3. Lock invitation FOR UPDATE
					const invRows = await transaction<InvitationCandidateRow[]>`
						SELECT
							id, role, status,
							email_binding AS "emailBinding",
							invited_by_user_id AS "invitedByUserId",
							created_at AS "createdAt",
							expires_at AS "expiresAt",
							accepted_at AS "acceptedAt",
							accepted_by_user_id AS "acceptedByUserId",
							revoked_at AS "revokedAt",
							revoked_by_user_id AS "revokedByUserId"
						FROM instance_invitation
						WHERE token_hash = ${command.tokenHash}
						FOR UPDATE
					`;
					if (invRows.length === 0) {
						throw new InstanceRollback({ outcome: 'invitation_invalid' });
					}

					const inv: InvitationCandidateRow = invRows[0];
					if (inv.status !== 'pending') {
						const racedReceipt: AcceptInvitationReceiptRow | null = await this.#findAcceptReceipt(
							transaction,
							command.actor.type,
							command.actor.id,
							command.idempotencyKey
						);
						if (racedReceipt !== null) {
							throw new InstanceRollback(
								evaluateAcceptReceipt(racedReceipt, existingMember, command)
							);
						}
						throw new InstanceRollback({ outcome: 'invitation_invalid' });
					}

					if (inv.emailBinding !== command.emailBinding) {
						throw new InstanceRollback({ outcome: 'invitation_invalid' });
					}

					const acceptedAtMs: number = Date.parse(command.acceptedAt);
					const createdAtMs: number = Date.parse(toIso(inv.createdAt));
					const expiresAtMs: number = Date.parse(toIso(inv.expiresAt));
					if (
						!Number.isFinite(acceptedAtMs) ||
						!Number.isFinite(createdAtMs) ||
						!Number.isFinite(expiresAtMs) ||
						acceptedAtMs < createdAtMs ||
						acceptedAtMs >= expiresAtMs
					) {
						throw new InstanceRollback({ outcome: 'invitation_invalid' });
					}

					// 4. Enroll active member with invited role or preserve existing role
					await transaction`
						INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
						VALUES (
							${command.actor.id},
							${inv.role},
							'active',
							${command.acceptedAt}::timestamptz,
							${command.acceptedAt}::timestamptz
						)
						ON CONFLICT (user_id) DO NOTHING
					`;

					const enrolledMemberRows = await transaction<MemberRow[]>`
						SELECT user_id AS "userId", role, status, created_at AS "createdAt", updated_at AS "updatedAt"
						FROM instance_member
						WHERE user_id = ${command.actor.id}
						FOR UPDATE
					`;
					const enrolledMember: MemberRow | null = enrolledMemberRows[0] ?? null;
					if (
						enrolledMember === null ||
						!isInstanceMemberRole(enrolledMember.role) ||
						!isInstanceMemberStatus(enrolledMember.status) ||
						enrolledMember.status !== 'active'
					) {
						throw new InstanceRollback({ outcome: 'integrity_error' });
					}

					// 5. Update invitation
					const updated = await transaction<{ id: string }[]>`
						UPDATE instance_invitation
						SET status = 'accepted',
							accepted_at = ${command.acceptedAt}::timestamptz,
							accepted_by_user_id = ${command.actor.id}
						WHERE id = ${inv.id}
						  AND status = 'pending'
						  AND token_hash = ${command.tokenHash}
						  AND email_binding = ${command.emailBinding}
						  AND expires_at > ${command.acceptedAt}::timestamptz
						RETURNING id
					`;
					if (updated.length !== 1) {
						throw new InstanceRollback(await this.#classifyAcceptFailure(transaction, command));
					}

					// 6. Record accept receipt
					const insertedReceipt = await transaction<{ actorId: string }[]>`
						INSERT INTO instance_invitation_command (
							actor_type, actor_id, idempotency_key, command_type, request_hash,
							invitation_id, role, result_status, occurred_at
						) VALUES (
							'user',
							${command.actor.id},
							${command.idempotencyKey},
							'accept',
							${command.requestFingerprint},
							${inv.id},
							${inv.role},
							'accepted',
							${command.acceptedAt}::timestamptz
						)
						ON CONFLICT DO NOTHING
						RETURNING actor_id AS "actorId"
					`;
					if (insertedReceipt.length !== 1) {
						throw new InstanceRollback(await this.#classifyAcceptFailure(transaction, command));
					}

					return {
						outcome: 'accepted',
						invitation: {
							id: inv.id,
							role: inv.role as InstanceMemberRole,
							status: 'accepted',
							invitedByUserId: inv.invitedByUserId,
							createdAt: toIso(inv.createdAt),
							expiresAt: toIso(inv.expiresAt),
							acceptedAt: toIso(command.acceptedAt),
							acceptedByUserId: command.actor.id,
							revokedAt: null,
							revokedByUserId: null
						},
						member: {
							userId: enrolledMember.userId,
							role: enrolledMember.role as InstanceMemberRole,
							status: enrolledMember.status,
							createdAt: toIso(enrolledMember.createdAt),
							updatedAt: toIso(enrolledMember.updatedAt)
						}
					};
				}
			);
		} catch (error: unknown) {
			if (error instanceof InstanceRollback) {
				return error.result as AcceptInstanceInvitationStoreResult;
			}
			const classified: AcceptInstanceInvitationStoreResult | null =
				await this.#classifyAcceptFailure(this.#sql, command);
			if (classified !== null && classified.outcome !== 'integrity_error') {
				return classified;
			}
			throw error;
		}
	}

	async revokeInstanceInvitation(
		command: RevokeInstanceInvitationCommand
	): Promise<RevokeInstanceInvitationStoreResult> {
		try {
			return await this.#sql.begin(
				async (transaction): Promise<RevokeInstanceInvitationStoreResult> => {
					// 1. Enforce active actor role durably in transaction
					const memberRow: MemberRoleStatusRow | null = await this.#findMemberRoleStatus(
						transaction,
						command.actor.id,
						true
					);
					if (memberRow === null || memberRow.role === 'member') {
						throw new InstanceRollback({ outcome: 'forbidden' });
					}
					if (memberRow.status === 'suspended') {
						throw new InstanceRollback({ outcome: 'member_suspended' });
					}

					// 2. Check receipt for replay
					const receiptRow: RevokeInvitationReceiptRow | null = await this.#findRevokeReceipt(
						transaction,
						command.actor.type,
						command.actor.id,
						command.idempotencyKey
					);
					if (receiptRow !== null) {
						throw new InstanceRollback(evaluateRevokeReceipt(receiptRow, memberRow, command));
					}

					// 3. Lock invitation FOR UPDATE (pending only)
					const invRows = await transaction<InvitationMetadataRow[]>`
						SELECT
							id, role, status,
							invited_by_user_id AS "invitedByUserId",
							created_at AS "createdAt",
							expires_at AS "expiresAt",
							accepted_at AS "acceptedAt",
							accepted_by_user_id AS "acceptedByUserId",
							revoked_at AS "revokedAt",
							revoked_by_user_id AS "revokedByUserId"
						FROM instance_invitation
						WHERE id = ${command.invitationId}
						FOR UPDATE
					`;
					if (invRows.length === 0) {
						throw new InstanceRollback({ outcome: 'invitation_invalid' });
					}

					const inv: InvitationMetadataRow = invRows[0];
					if (inv.status !== 'pending') {
						const racedReceipt: RevokeInvitationReceiptRow | null = await this.#findRevokeReceipt(
							transaction,
							command.actor.type,
							command.actor.id,
							command.idempotencyKey
						);
						if (racedReceipt !== null) {
							throw new InstanceRollback(evaluateRevokeReceipt(racedReceipt, memberRow, command));
						}
						throw new InstanceRollback({ outcome: 'invitation_invalid' });
					}

					// 4. Owner can revoke any role; admin can revoke member only
					if (memberRow.role === 'admin' && inv.role !== 'member') {
						throw new InstanceRollback({ outcome: 'forbidden' });
					}

					// 5. Update invitation to revoked
					const updated = await transaction<{ id: string }[]>`
						UPDATE instance_invitation
						SET status = 'revoked',
							revoked_at = ${command.revokedAt}::timestamptz,
							revoked_by_user_id = ${command.actor.id}
						WHERE id = ${command.invitationId}
						  AND status = 'pending'
						RETURNING id
					`;
					if (updated.length !== 1) {
						throw new InstanceRollback(await this.#classifyRevokeFailure(transaction, command));
					}

					// 6. Record revoke receipt
					const insertedReceipt = await transaction<{ actorId: string }[]>`
						INSERT INTO instance_invitation_command (
							actor_type, actor_id, idempotency_key, command_type, request_hash,
							invitation_id, role, result_status, occurred_at
						) VALUES (
							'user',
							${command.actor.id},
							${command.idempotencyKey},
							'revoke',
							${command.requestFingerprint},
							${command.invitationId},
							${inv.role},
							'revoked',
							${command.revokedAt}::timestamptz
						)
						ON CONFLICT DO NOTHING
						RETURNING actor_id AS "actorId"
					`;
					if (insertedReceipt.length !== 1) {
						throw new InstanceRollback(await this.#classifyRevokeFailure(transaction, command));
					}

					return {
						outcome: 'revoked',
						invitation: {
							id: inv.id,
							role: inv.role as InstanceMemberRole,
							status: 'revoked',
							invitedByUserId: inv.invitedByUserId,
							createdAt: toIso(inv.createdAt),
							expiresAt: toIso(inv.expiresAt),
							acceptedAt: null,
							acceptedByUserId: null,
							revokedAt: toIso(command.revokedAt),
							revokedByUserId: command.actor.id
						}
					};
				}
			);
		} catch (error: unknown) {
			if (error instanceof InstanceRollback) {
				return error.result as RevokeInstanceInvitationStoreResult;
			}
			const classified: RevokeInstanceInvitationStoreResult | null =
				await this.#classifyRevokeFailure(this.#sql, command);
			if (classified !== null && classified.outcome !== 'integrity_error') {
				return classified;
			}
			throw error;
		}
	}

	async #findMemberRoleStatus(
		sql: Sql,
		userId: string,
		forShare: boolean
	): Promise<MemberRoleStatusRow | null> {
		const rows = forShare
			? await sql<MemberRoleStatusRow[]>`
					SELECT role, status
					FROM instance_member
					WHERE user_id = ${userId}
					FOR SHARE
				`
			: await sql<MemberRoleStatusRow[]>`
					SELECT role, status
					FROM instance_member
					WHERE user_id = ${userId}
					LIMIT 1
				`;
		return rows[0] ?? null;
	}

	async #countPendingInvitations(sql: Sql): Promise<number> {
		const rows = await sql<CountRow[]>`
			SELECT count(*)::int AS count
			FROM instance_invitation
			WHERE status = 'pending'
		`;
		return Number(rows[0]?.count ?? 0);
	}

	async #findCreateReceipt(
		sql: Sql,
		actorType: string,
		actorId: string,
		idempotencyKey: string
	): Promise<CreateInvitationReceiptRow | null> {
		const rows = await sql<CreateInvitationReceiptRow[]>`
			SELECT
				command.request_hash AS "requestHash",
				command.command_type AS "commandType",
				command.invitation_id AS "invitationId",
				command.role AS "role",
				command.result_status AS "resultStatus",
				command.occurred_at AS "occurredAt",
				invitation.id AS "invId",
				invitation.role AS "invRole",
				invitation.status AS "invStatus",
				invitation.invited_by_user_id AS "invInvitedByUserId",
				invitation.created_at AS "invCreatedAt",
				invitation.expires_at AS "invExpiresAt",
				invitation.accepted_at AS "invAcceptedAt",
				invitation.accepted_by_user_id AS "invAcceptedByUserId",
				invitation.revoked_at AS "invRevokedAt",
				invitation.revoked_by_user_id AS "invRevokedByUserId"
			FROM instance_invitation_command command
			LEFT JOIN instance_invitation invitation ON invitation.id = command.invitation_id
			WHERE command.actor_type = ${actorType}
			  AND command.actor_id = ${actorId}
			  AND command.idempotency_key = ${idempotencyKey}
			LIMIT 1
		`;
		return rows[0] ?? null;
	}

	async #findAcceptReceipt(
		sql: Sql,
		actorType: string,
		actorId: string,
		idempotencyKey: string
	): Promise<AcceptInvitationReceiptRow | null> {
		const rows = await sql<AcceptInvitationReceiptRow[]>`
			SELECT
				command.request_hash AS "requestHash",
				command.command_type AS "commandType",
				command.invitation_id AS "invitationId",
				command.role AS "role",
				command.result_status AS "resultStatus",
				command.occurred_at AS "occurredAt",
				invitation.id AS "invId",
				invitation.role AS "invRole",
				invitation.status AS "invStatus",
				invitation.invited_by_user_id AS "invInvitedByUserId",
				invitation.created_at AS "invCreatedAt",
				invitation.expires_at AS "invExpiresAt",
				invitation.accepted_at AS "invAcceptedAt",
				invitation.accepted_by_user_id AS "invAcceptedByUserId",
				invitation.revoked_at AS "invRevokedAt",
				invitation.revoked_by_user_id AS "invRevokedByUserId",
				member.user_id AS "memberUserId",
				member.role AS "memberRole",
				member.status AS "memberStatus",
				member.created_at AS "memberCreatedAt",
				member.updated_at AS "memberUpdatedAt"
			FROM instance_invitation_command command
			LEFT JOIN instance_invitation invitation ON invitation.id = command.invitation_id
			LEFT JOIN instance_member member ON member.user_id = command.actor_id
			WHERE command.actor_type = ${actorType}
			  AND command.actor_id = ${actorId}
			  AND command.idempotency_key = ${idempotencyKey}
			LIMIT 1
		`;
		return rows[0] ?? null;
	}

	async #findRevokeReceipt(
		sql: Sql,
		actorType: string,
		actorId: string,
		idempotencyKey: string
	): Promise<RevokeInvitationReceiptRow | null> {
		const rows = await sql<RevokeInvitationReceiptRow[]>`
			SELECT
				command.request_hash AS "requestHash",
				command.command_type AS "commandType",
				command.invitation_id AS "invitationId",
				command.role AS "role",
				command.result_status AS "resultStatus",
				command.occurred_at AS "occurredAt",
				invitation.id AS "invId",
				invitation.role AS "invRole",
				invitation.status AS "invStatus",
				invitation.invited_by_user_id AS "invInvitedByUserId",
				invitation.created_at AS "invCreatedAt",
				invitation.expires_at AS "invExpiresAt",
				invitation.accepted_at AS "invAcceptedAt",
				invitation.accepted_by_user_id AS "invAcceptedByUserId",
				invitation.revoked_at AS "invRevokedAt",
				invitation.revoked_by_user_id AS "invRevokedByUserId"
			FROM instance_invitation_command command
			LEFT JOIN instance_invitation invitation ON invitation.id = command.invitation_id
			WHERE command.actor_type = ${actorType}
			  AND command.actor_id = ${actorId}
			  AND command.idempotency_key = ${idempotencyKey}
			LIMIT 1
		`;
		return rows[0] ?? null;
	}

	async #classifyCreateFailure(
		sql: Sql,
		command: CreateInstanceInvitationCommand
	): Promise<CreateInstanceInvitationStoreResult> {
		const receipt = await this.#findCreateReceipt(
			sql,
			command.actor.type,
			command.actor.id,
			command.idempotencyKey
		);
		if (receipt !== null) {
			return evaluateCreateReceipt(receipt, command);
		}

		const member = await this.#findMemberRoleStatus(sql, command.actor.id, false);
		if (member === null || member.role === 'member') {
			return { outcome: 'forbidden' };
		}
		if (member.status === 'suspended') {
			return { outcome: 'member_suspended' };
		}
		if (member.role === 'admin' && command.role !== 'member') {
			return { outcome: 'role_not_permitted' };
		}

		const pendingCount = await this.#countPendingInvitations(sql);
		if (pendingCount >= 200) {
			return { outcome: 'limit' };
		}

		const existingId = await sql<{ id: string }[]>`
			SELECT id FROM instance_invitation WHERE id = ${command.invitationId} LIMIT 1
		`;
		if (existingId.length > 0) {
			return { outcome: 'integrity_error' };
		}

		const existingHash = await sql<{ id: string }[]>`
			SELECT id FROM instance_invitation WHERE token_hash = ${command.tokenHash} LIMIT 1
		`;
		if (existingHash.length > 0) {
			return { outcome: 'integrity_error' };
		}

		return { outcome: 'integrity_error' };
	}

	async #classifyAcceptFailure(
		sql: Sql,
		command: AcceptInstanceInvitationCommand
	): Promise<AcceptInstanceInvitationStoreResult> {
		const memberRows = await sql<MemberRow[]>`
			SELECT user_id AS "userId", role, status, created_at AS "createdAt", updated_at AS "updatedAt"
			FROM instance_member
			WHERE user_id = ${command.actor.id}
			LIMIT 1
		`;
		const existingMember: MemberRow | null = memberRows[0] ?? null;
		if (existingMember !== null && existingMember.status === 'suspended') {
			return { outcome: 'member_suspended' };
		}

		const receipt = await this.#findAcceptReceipt(
			sql,
			command.actor.type,
			command.actor.id,
			command.idempotencyKey
		);
		if (receipt !== null) {
			return evaluateAcceptReceipt(receipt, existingMember, command);
		}

		const invRows = await sql<InvitationCandidateRow[]>`
			SELECT
				id, role, status,
				email_binding AS "emailBinding",
				invited_by_user_id AS "invitedByUserId",
				created_at AS "createdAt",
				expires_at AS "expiresAt",
				accepted_at AS "acceptedAt",
				accepted_by_user_id AS "acceptedByUserId",
				revoked_at AS "revokedAt",
				revoked_by_user_id AS "revokedByUserId"
			FROM instance_invitation
			WHERE token_hash = ${command.tokenHash}
			LIMIT 1
		`;
		if (invRows.length === 0) {
			return { outcome: 'invitation_invalid' };
		}

		const inv = invRows[0];
		if (inv.status !== 'pending' || inv.emailBinding !== command.emailBinding) {
			return { outcome: 'invitation_invalid' };
		}

		const acceptedAtMs = Date.parse(command.acceptedAt);
		const createdAtMs = Date.parse(toIso(inv.createdAt));
		const expiresAtMs = Date.parse(toIso(inv.expiresAt));
		if (
			!Number.isFinite(acceptedAtMs) ||
			!Number.isFinite(createdAtMs) ||
			!Number.isFinite(expiresAtMs) ||
			acceptedAtMs < createdAtMs ||
			acceptedAtMs >= expiresAtMs
		) {
			return { outcome: 'invitation_invalid' };
		}

		return { outcome: 'integrity_error' };
	}

	async #classifyRevokeFailure(
		sql: Sql,
		command: RevokeInstanceInvitationCommand
	): Promise<RevokeInstanceInvitationStoreResult> {
		const member = await this.#findMemberRoleStatus(sql, command.actor.id, false);
		if (member === null || member.role === 'member') {
			return { outcome: 'forbidden' };
		}
		if (member.status === 'suspended') {
			return { outcome: 'member_suspended' };
		}

		const receipt = await this.#findRevokeReceipt(
			sql,
			command.actor.type,
			command.actor.id,
			command.idempotencyKey
		);
		if (receipt !== null) {
			return evaluateRevokeReceipt(receipt, member, command);
		}

		const invRows = await sql<InvitationMetadataRow[]>`
			SELECT
				id, role, status,
				invited_by_user_id AS "invitedByUserId",
				created_at AS "createdAt",
				expires_at AS "expiresAt",
				accepted_at AS "acceptedAt",
				accepted_by_user_id AS "acceptedByUserId",
				revoked_at AS "revokedAt",
				revoked_by_user_id AS "revokedByUserId"
			FROM instance_invitation
			WHERE id = ${command.invitationId}
			LIMIT 1
		`;
		if (invRows.length === 0 || invRows[0].status !== 'pending') {
			return { outcome: 'invitation_invalid' };
		}

		if (member.role === 'admin' && invRows[0].role !== 'member') {
			return { outcome: 'forbidden' };
		}

		return { outcome: 'integrity_error' };
	}

	async #evaluateReceipt(
		sql: Sql,
		receipt: BootstrapReceiptRow,
		command: BootstrapInstanceCommand
	): Promise<BootstrapInstanceStoreResult> {
		if (receipt.requestHash !== command.requestFingerprint) {
			return { outcome: 'idempotency_conflict' };
		}
		// Self-bootstrap only: the receipt owner must be the replaying actor, or
		// another member's metadata could otherwise be disclosed on replay.
		if (receipt.ownerUserId !== command.actor.id) {
			return { outcome: 'integrity_error' };
		}

		const memberRows = await sql<MemberRow[]>`
				SELECT user_id AS "userId", role, status, created_at AS "createdAt", updated_at AS "updatedAt"
				FROM instance_member
				WHERE user_id = ${receipt.ownerUserId}
			`;
		const bootstrapRows = await sql<BootstrapRow[]>`
				SELECT singleton_key AS "singletonKey", owner_user_id AS "ownerUserId", created_at AS "createdAt"
				FROM instance_bootstrap
				WHERE singleton_key = 1
			`;

		if (
			memberRows.length === 0 ||
			bootstrapRows.length === 0 ||
			bootstrapRows[0].ownerUserId !== receipt.ownerUserId ||
			!isInstanceMemberRole(memberRows[0].role) ||
			!isInstanceMemberStatus(memberRows[0].status) ||
			memberRows[0].role !== 'owner' ||
			memberRows[0].status !== 'active'
		) {
			return { outcome: 'integrity_error' };
		}

		return {
			outcome: 'already_bootstrapped',
			member: {
				userId: memberRows[0].userId,
				role: memberRows[0].role,
				status: memberRows[0].status,
				createdAt: toIso(memberRows[0].createdAt),
				updatedAt: toIso(memberRows[0].updatedAt)
			},
			replayed: true
		};
	}

	async #classifyFailure(
		sql: Sql,
		command: BootstrapInstanceCommand
	): Promise<BootstrapInstanceStoreResult> {
		const receipts = await sql<BootstrapReceiptRow[]>`
			SELECT request_hash AS "requestHash", owner_user_id AS "ownerUserId", created_at AS "createdAt"
			FROM instance_bootstrap_command
			WHERE actor_type = ${command.actor.type}
			  AND actor_id = ${command.actor.id}
			  AND idempotency_key = ${command.idempotencyKey}
		`;
		if (receipts.length > 0) {
			return this.#evaluateReceipt(sql, receipts[0], command);
		}

		const bootstrapRows = await sql<BootstrapRow[]>`
			SELECT singleton_key AS "singletonKey", owner_user_id AS "ownerUserId", created_at AS "createdAt"
			FROM instance_bootstrap
			WHERE singleton_key = 1
		`;
		const memberCountRows = await sql<{ count: string | number }[]>`
			SELECT count(*) AS count FROM instance_member
		`;

		if (bootstrapRows.length > 0 || Number(memberCountRows[0]?.count ?? 0) > 0) {
			return { outcome: 'already_bootstrapped', replayed: false };
		}

		return { outcome: 'integrity_error' };
	}
}

function evaluateCreateReceipt(
	row: CreateInvitationReceiptRow,
	command: CreateInstanceInvitationCommand
): CreateInstanceInvitationStoreResult {
	if (row.requestHash !== command.requestFingerprint) {
		return { outcome: 'idempotency_conflict' };
	}
	if (row.commandType !== 'create' || row.role !== command.role || row.resultStatus !== 'pending') {
		return { outcome: 'idempotency_conflict' };
	}
	if (
		row.invId === null ||
		row.invId !== row.invitationId ||
		row.invRole !== row.role ||
		row.invCreatedAt === null ||
		toIso(row.invCreatedAt) !== toIso(row.occurredAt) ||
		row.invInvitedByUserId !== command.actor.id ||
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
	memberRow: MemberRow | MemberRoleStatusRow | null,
	command: AcceptInstanceInvitationCommand
): AcceptInstanceInvitationStoreResult {
	if (memberRow !== null && memberRow.status === 'suspended') {
		return { outcome: 'member_suspended' };
	}
	if (row.requestHash !== command.requestFingerprint) {
		return { outcome: 'idempotency_conflict' };
	}
	if (row.commandType !== 'accept' || row.resultStatus !== 'accepted') {
		return { outcome: 'idempotency_conflict' };
	}
	if (
		row.invId === null ||
		row.invId !== row.invitationId ||
		row.invStatus !== 'accepted' ||
		row.invAcceptedByUserId !== command.actor.id ||
		row.invAcceptedAt === null ||
		toIso(row.invAcceptedAt) !== toIso(row.occurredAt) ||
		row.invRole !== row.role ||
		row.memberUserId === null ||
		row.memberUserId !== command.actor.id ||
		row.memberStatus !== 'active'
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
	if (row.requestHash !== command.requestFingerprint) {
		return { outcome: 'idempotency_conflict' };
	}
	if (
		row.commandType !== 'revoke' ||
		row.resultStatus !== 'revoked' ||
		row.invitationId !== command.invitationId
	) {
		return { outcome: 'idempotency_conflict' };
	}
	if (memberRow.role === 'admin' && row.role !== 'member') {
		return { outcome: 'forbidden' };
	}
	if (
		row.invId === null ||
		row.invId !== row.invitationId ||
		row.invStatus !== 'revoked' ||
		row.invRevokedByUserId !== command.actor.id ||
		row.invRevokedAt === null ||
		toIso(row.invRevokedAt) !== toIso(row.occurredAt) ||
		row.invRole !== row.role
	) {
		return { outcome: 'integrity_error' };
	}
	return {
		outcome: 'replayed',
		invitation: metadataFromJoinedInvitation(row)
	};
}

function isValidTerminalShape(row: {
	invStatus: string | null;
	invAcceptedAt: Date | string | null;
	invAcceptedByUserId: string | null;
	invRevokedAt: Date | string | null;
	invRevokedByUserId: string | null;
}): boolean {
	if (row.invStatus === 'pending') {
		return (
			row.invAcceptedAt === null &&
			row.invAcceptedByUserId === null &&
			row.invRevokedAt === null &&
			row.invRevokedByUserId === null
		);
	}
	if (row.invStatus === 'accepted') {
		return (
			row.invAcceptedAt !== null &&
			row.invAcceptedByUserId !== null &&
			row.invRevokedAt === null &&
			row.invRevokedByUserId === null
		);
	}
	if (row.invStatus === 'revoked') {
		return (
			row.invRevokedAt !== null &&
			row.invRevokedByUserId !== null &&
			row.invAcceptedAt === null &&
			row.invAcceptedByUserId === null
		);
	}
	return false;
}

function metadataFromJoinedInvitation(row: {
	invId: string | null;
	invRole: string | null;
	invStatus: string | null;
	invInvitedByUserId: string | null;
	invCreatedAt: Date | string | null;
	invExpiresAt: Date | string | null;
	invAcceptedAt: Date | string | null;
	invAcceptedByUserId: string | null;
	invRevokedAt: Date | string | null;
	invRevokedByUserId: string | null;
}): InstanceInvitationMetadata {
	if (
		row.invId === null ||
		!isInstanceMemberRole(row.invRole) ||
		!isInstanceInvitationStatus(row.invStatus) ||
		row.invInvitedByUserId === null ||
		row.invCreatedAt === null ||
		row.invExpiresAt === null
	) {
		throw new Error('Stored instance invitation state is corrupted.');
	}
	return {
		id: row.invId,
		role: row.invRole,
		status: row.invStatus,
		invitedByUserId: row.invInvitedByUserId,
		createdAt: toIso(row.invCreatedAt),
		expiresAt: toIso(row.invExpiresAt),
		acceptedAt: toIsoOrNull(row.invAcceptedAt),
		acceptedByUserId: row.invAcceptedByUserId,
		revokedAt: toIsoOrNull(row.invRevokedAt),
		revokedByUserId: row.invRevokedByUserId
	};
}

function metadataFromJoinedMember(row: {
	memberUserId: string | null;
	memberRole: string | null;
	memberStatus: string | null;
	memberCreatedAt: Date | string | null;
	memberUpdatedAt: Date | string | null;
}): InstanceMemberMetadata {
	if (
		row.memberUserId === null ||
		!isInstanceMemberRole(row.memberRole) ||
		!isInstanceMemberStatus(row.memberStatus) ||
		row.memberCreatedAt === null ||
		row.memberUpdatedAt === null
	) {
		throw new Error('Stored instance member state is corrupted.');
	}
	return {
		userId: row.memberUserId,
		role: row.memberRole,
		status: row.memberStatus,
		createdAt: toIso(row.memberCreatedAt),
		updatedAt: toIso(row.memberUpdatedAt)
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
		invitedByUserId: row.invitedByUserId,
		createdAt: toIso(row.createdAt),
		expiresAt: toIso(row.expiresAt),
		acceptedAt: toIsoOrNull(row.acceptedAt),
		acceptedByUserId: row.acceptedByUserId,
		revokedAt: toIsoOrNull(row.revokedAt),
		revokedByUserId: row.revokedByUserId
	};
}

function toIso(val: Date | string): string {
	return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
}

function toIsoOrNull(val: Date | string | null | undefined): string | null {
	if (val === null || val === undefined) return null;
	return toIso(val);
}
