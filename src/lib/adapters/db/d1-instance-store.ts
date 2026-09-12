import {
	isInstanceMemberRole,
	isInstanceMemberStatus,
	type BootstrapInstanceCommand,
	type BootstrapInstanceStoreResult,
	type InstanceCallerContext,
	type InstanceMemberMetadata,
	type InstanceStore
} from '$lib/ports/instance-store';

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

interface BootstrapRow {
	singleton_key: number;
	owner_user_id: string;
	created_at: string;
}

interface CountRow {
	count: number;
}

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
}

function changeCount(result: D1Result): number {
	const changes: unknown = (result.meta as { changes?: unknown }).changes;
	return typeof changes === 'number' ? changes : 0;
}

function firstRow<T>(result: D1Result<T | unknown> | undefined): T | null {
	return (result?.results[0] as T | undefined) ?? null;
}
