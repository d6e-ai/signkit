import postgres from 'postgres';
import {
	isInstanceMemberRole,
	isInstanceMemberStatus,
	type BootstrapInstanceCommand,
	type BootstrapInstanceStoreResult,
	type InstanceCallerContext,
	type InstanceMemberMetadata,
	type InstanceStore
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

function toIso(val: Date | string): string {
	return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
}
