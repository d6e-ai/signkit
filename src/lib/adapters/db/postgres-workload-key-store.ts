import postgres from 'postgres';
import {
	MAX_WORKLOAD_KEY_LIST_LIMIT,
	parseWorkloadKeyScopesJson,
	workloadKeyScopesJson,
	type CreateWorkloadKeyCommand,
	type CreateWorkloadKeyStoreResult,
	type RevokeWorkloadKeyCommand,
	type RevokeWorkloadKeyStoreResult,
	type WorkloadKeyListPage,
	type WorkloadKeyListQuery,
	type WorkloadKeyMetadata,
	type WorkloadKeyStore
} from '$lib/ports/workload-key-store';
import type { WorkloadKeyScope } from '$lib/security/workload-key';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

/**
 * Carries a non-success outcome out of a transaction so PostgreSQL rolls the
 * partial work back. Returning the outcome normally would commit it.
 */
class WorkloadKeyRollback<T> extends Error {
	constructor(readonly result: T) {
		super('Workload key transaction rolled back with an explicit outcome');
		this.name = 'WorkloadKeyRollback';
	}
}

interface WorkloadKeyRow {
	id: string;
	name: string;
	keyPrefix: string;
	scopesJson: string;
	createdAt: Date | string;
	expiresAt: Date | string;
	lastUsedAt: Date | string | null;
	revokedAt: Date | string | null;
}

interface CursorRow {
	id: string;
	createdAt: Date | string;
}

interface CreateReceiptRow {
	requestHash: string;
	workloadKeyId: string;
	name: string;
	scopesJson: string;
	keyPrefix: string;
	createdAt: Date | string;
	expiresAt: Date | string;
	keyId: string | null;
	keyName: string | null;
	keyPrefixCurrent: string | null;
	keyScopesJson: string | null;
	keyCreatedByUserId: string | null;
	keyCreatedAt: Date | string | null;
	keyExpiresAt: Date | string | null;
	keyLastUsedAt: Date | string | null;
	keyRevokedAt: Date | string | null;
}

interface RevokeReceiptRow {
	requestHash: string;
	workloadKeyId: string;
	keyPrefix: string;
	revokedAt: Date | string;
	keyId: string | null;
	keyName: string | null;
	keyPrefixCurrent: string | null;
	keyScopesJson: string | null;
	keyCreatedAt: Date | string | null;
	keyExpiresAt: Date | string | null;
	keyLastUsedAt: Date | string | null;
	keyRevokedAt: Date | string | null;
}

/**
 * PostgreSQL implementation of organization-scoped workload key management.
 *
 * Create and revoke run inside one transaction each. Conflicts are absorbed
 * with `ON CONFLICT DO NOTHING` so the transaction stays usable, and the
 * outcome is then decided by explicit evidence queries against the receipt, the
 * organization projection, the key id, and the credential hash — never by
 * inspecting a driver error code or message. Revoke takes a `FOR UPDATE` lock
 * on the key row so concurrent revocations serialize on it.
 */
export class PostgresWorkloadKeyStore implements WorkloadKeyStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async createWorkloadKey(
		command: CreateWorkloadKeyCommand
	): Promise<CreateWorkloadKeyStoreResult> {
		const scopesJson: string = workloadKeyScopesJson(command.scopes);
		try {
			return await this.#sql.begin(async (transaction): Promise<CreateWorkloadKeyStoreResult> => {
				const replay: CreateWorkloadKeyStoreResult | null = await this.#resolveCreateReceipt(
					transaction,
					command
				);
				if (replay !== null) throw new WorkloadKeyRollback(replay);

				// The guarded upsert locks an existing organization row and refuses to
				// update it when its d6e-auth identifier differs, so a create can never
				// silently remap the projection.
				const organizations = await transaction<{ id: string }[]>`
						INSERT INTO organization (id, d6e_organization_id, name, created_at)
						VALUES (
							${command.organizationId},
							${command.organizationId},
							${command.organizationName},
							${command.createdAt}::timestamptz
						)
						ON CONFLICT (id) DO UPDATE
						SET name = EXCLUDED.name
						WHERE organization.d6e_organization_id = EXCLUDED.d6e_organization_id
						RETURNING id
					`;
				if (organizations.length !== 1) {
					throw new WorkloadKeyRollback<CreateWorkloadKeyStoreResult>({
						outcome: 'integrity_error'
					});
				}

				const keyRows = await transaction<WorkloadKeyRow[]>`
						INSERT INTO workload_key (
							organization_id, id, name, token_hash, key_prefix, scopes_json,
							created_by_user_id, created_at, expires_at, revoked_at, last_used_at,
							rate_window_started_at, rate_window_count
						)
						VALUES (
							${command.organizationId},
							${command.workloadKeyId},
							${command.name},
							${command.tokenHash},
							${command.keyPrefix},
							${scopesJson},
							${command.actor.id},
							${command.createdAt}::timestamptz,
							${command.expiresAt}::timestamptz,
							NULL, NULL, NULL, 0
						)
						ON CONFLICT DO NOTHING
						RETURNING ${transaction.unsafe(KEY_COLUMNS)}
					`;
				if (keyRows.length !== 1) {
					throw new WorkloadKeyRollback(
						await this.#classifyKeyInsertConflict(transaction, command)
					);
				}

				const receiptRows = await transaction<{ workloadKeyId: string }[]>`
						INSERT INTO workload_key_create_command (
							organization_id, actor_type, actor_id, idempotency_key, request_hash,
							workload_key_id, name, scopes_json, key_prefix, expires_at, created_at
						)
						VALUES (
							${command.organizationId},
							${command.actor.type},
							${command.actor.id},
							${command.idempotencyKey},
							${command.requestFingerprint},
							${command.workloadKeyId},
							${command.name},
							${scopesJson},
							${command.keyPrefix},
							${command.expiresAt}::timestamptz,
							${command.createdAt}::timestamptz
						)
						ON CONFLICT DO NOTHING
						RETURNING workload_key_id AS "workloadKeyId"
					`;
				if (receiptRows.length !== 1) {
					const raced: CreateWorkloadKeyStoreResult | null = await this.#resolveCreateReceipt(
						transaction,
						command
					);
					throw new WorkloadKeyRollback(raced ?? { outcome: 'integrity_error' });
				}

				return { outcome: 'created', key: metadataFromRow(keyRows[0]) };
			});
		} catch (error: unknown) {
			if (error instanceof WorkloadKeyRollback) {
				return error.result as CreateWorkloadKeyStoreResult;
			}
			throw error;
		}
	}

	async listWorkloadKeys(
		organizationId: string,
		query: WorkloadKeyListQuery
	): Promise<WorkloadKeyListPage> {
		if (
			!Number.isSafeInteger(query.limit) ||
			query.limit < 1 ||
			query.limit > MAX_WORKLOAD_KEY_LIST_LIMIT
		) {
			throw new RangeError(
				`Workload key list limit must be between 1 and ${MAX_WORKLOAD_KEY_LIST_LIMIT}.`
			);
		}

		let cursor: CursorRow | undefined;
		if (query.cursor !== null) {
			const cursorRows = await this.#sql<CursorRow[]>`
				SELECT id, created_at AS "createdAt"
				FROM workload_key
				WHERE organization_id = ${organizationId} AND id = ${query.cursor}
				LIMIT 1
			`;
			cursor = cursorRows[0];
			// An unknown or cross-tenant cursor never resolves against another
			// tenant's page; it fails closed as an empty page.
			if (cursor === undefined) return { items: [], nextCursor: null };
		}

		const fetchLimit: number = query.limit + 1;
		const rows =
			cursor === undefined
				? await this.#sql<WorkloadKeyRow[]>`
					SELECT ${this.#sql.unsafe(KEY_COLUMNS)}
					FROM workload_key
					WHERE organization_id = ${organizationId}
					ORDER BY created_at DESC, id DESC
					LIMIT ${fetchLimit}
				`
				: await this.#sql<WorkloadKeyRow[]>`
					SELECT ${this.#sql.unsafe(KEY_COLUMNS)}
					FROM workload_key
					WHERE organization_id = ${organizationId}
						AND (
							created_at < ${cursor.createdAt}
							OR (created_at = ${cursor.createdAt} AND id < ${cursor.id})
						)
					ORDER BY created_at DESC, id DESC
					LIMIT ${fetchLimit}
				`;
		const hasNextPage: boolean = rows.length > query.limit;
		const page: WorkloadKeyRow[] = hasNextPage ? rows.slice(0, query.limit) : [...rows];
		const items: readonly WorkloadKeyMetadata[] = page.map(
			(row: WorkloadKeyRow): WorkloadKeyMetadata => metadataFromRow(row)
		);
		const lastItem: WorkloadKeyMetadata | undefined = items.at(-1);

		return {
			items,
			nextCursor: hasNextPage && lastItem !== undefined ? lastItem.id : null
		};
	}

	async revokeWorkloadKey(
		command: RevokeWorkloadKeyCommand
	): Promise<RevokeWorkloadKeyStoreResult> {
		try {
			return await this.#sql.begin(async (transaction): Promise<RevokeWorkloadKeyStoreResult> => {
				const replay: RevokeWorkloadKeyStoreResult | null = await this.#resolveRevokeReceipt(
					transaction,
					command
				);
				if (replay !== null) throw new WorkloadKeyRollback(replay);

				const keyRows = await transaction<WorkloadKeyRow[]>`
						SELECT ${transaction.unsafe(KEY_COLUMNS)}
						FROM workload_key
						WHERE organization_id = ${command.organizationId} AND id = ${command.workloadKeyId}
						FOR UPDATE
					`;
				const key: WorkloadKeyRow | undefined = keyRows[0];
				if (key === undefined) {
					throw new WorkloadKeyRollback<RevokeWorkloadKeyStoreResult>({ outcome: 'not_found' });
				}
				// A fresh idempotency key for an already revoked credential is
				// reported explicitly rather than writing a second receipt.
				if (key.revokedAt !== null) {
					throw new WorkloadKeyRollback<RevokeWorkloadKeyStoreResult>({
						outcome: 'already_revoked',
						key: metadataFromRow(key)
					});
				}

				const receiptRows = await transaction<{ workloadKeyId: string }[]>`
						INSERT INTO workload_key_revoke_command (
							organization_id, actor_type, actor_id, idempotency_key, request_hash,
							workload_key_id, key_prefix, revoked_at
						)
						VALUES (
							${command.organizationId},
							${command.actor.type},
							${command.actor.id},
							${command.idempotencyKey},
							${command.requestFingerprint},
							${command.workloadKeyId},
							${key.keyPrefix},
							${command.revokedAt}::timestamptz
						)
						ON CONFLICT DO NOTHING
						RETURNING workload_key_id AS "workloadKeyId"
					`;
				if (receiptRows.length !== 1) {
					const raced: RevokeWorkloadKeyStoreResult | null = await this.#resolveRevokeReceipt(
						transaction,
						command
					);
					throw new WorkloadKeyRollback(raced ?? { outcome: 'integrity_error' });
				}

				const updated = await transaction<WorkloadKeyRow[]>`
						UPDATE workload_key
						SET revoked_at = ${command.revokedAt}::timestamptz
						WHERE organization_id = ${command.organizationId}
							AND id = ${command.workloadKeyId}
							AND revoked_at IS NULL
						RETURNING ${transaction.unsafe(KEY_COLUMNS)}
					`;
				if (updated.length !== 1) {
					throw new WorkloadKeyRollback<RevokeWorkloadKeyStoreResult>({
						outcome: 'integrity_error'
					});
				}
				return { outcome: 'revoked', key: metadataFromRow(updated[0]) };
			});
		} catch (error: unknown) {
			if (error instanceof WorkloadKeyRollback) {
				return error.result as RevokeWorkloadKeyStoreResult;
			}
			throw error;
		}
	}

	async #classifyKeyInsertConflict(
		sql: Sql,
		command: CreateWorkloadKeyCommand
	): Promise<CreateWorkloadKeyStoreResult> {
		const sameId = await sql<{ id: string }[]>`
			SELECT id FROM workload_key
			WHERE organization_id = ${command.organizationId} AND id = ${command.workloadKeyId}
			LIMIT 1
		`;
		if (sameId.length === 1) return { outcome: 'key_id_conflict' };
		const sameHash = await sql<{ id: string }[]>`
			SELECT id FROM workload_key WHERE token_hash = ${command.tokenHash} LIMIT 1
		`;
		if (sameHash.length === 1) return { outcome: 'token_hash_conflict' };
		return { outcome: 'integrity_error' };
	}

	async #resolveCreateReceipt(
		sql: Sql,
		command: CreateWorkloadKeyCommand
	): Promise<CreateWorkloadKeyStoreResult | null> {
		const rows = await sql<CreateReceiptRow[]>`
			SELECT
				command.request_hash AS "requestHash",
				command.workload_key_id AS "workloadKeyId",
				command.name,
				command.scopes_json AS "scopesJson",
				command.key_prefix AS "keyPrefix",
				command.created_at AS "createdAt",
				command.expires_at AS "expiresAt",
				stored.id AS "keyId",
				stored.name AS "keyName",
				stored.key_prefix AS "keyPrefixCurrent",
				stored.scopes_json AS "keyScopesJson",
				stored.created_by_user_id AS "keyCreatedByUserId",
				stored.created_at AS "keyCreatedAt",
				stored.expires_at AS "keyExpiresAt",
				stored.last_used_at AS "keyLastUsedAt",
				stored.revoked_at AS "keyRevokedAt"
			FROM workload_key_create_command command
			LEFT JOIN workload_key stored
				ON stored.organization_id = command.organization_id
				AND stored.id = command.workload_key_id
			WHERE command.organization_id = ${command.organizationId}
				AND command.actor_type = ${command.actor.type}
				AND command.actor_id = ${command.actor.id}
				AND command.idempotency_key = ${command.idempotencyKey}
			LIMIT 1
		`;
		const row: CreateReceiptRow | undefined = rows[0];
		if (row === undefined) return null;
		if (row.requestHash !== command.requestFingerprint) return { outcome: 'idempotency_conflict' };

		const scopes: readonly WorkloadKeyScope[] | null = parseWorkloadKeyScopesJson(row.scopesJson);
		const current: WorkloadKeyMetadata | null = createReceiptKeyMetadata(row, command.actor.id);
		// The secret is unrecoverable, so an unprovable receipt is a conflict
		// rather than a replay that could imply a usable credential.
		if (scopes === null || current === null) return { outcome: 'idempotency_conflict' };
		return { outcome: 'already_issued', key: current };
	}

	async #resolveRevokeReceipt(
		sql: Sql,
		command: RevokeWorkloadKeyCommand
	): Promise<RevokeWorkloadKeyStoreResult | null> {
		const rows = await sql<RevokeReceiptRow[]>`
			SELECT
				command.request_hash AS "requestHash",
				command.workload_key_id AS "workloadKeyId",
				command.key_prefix AS "keyPrefix",
				command.revoked_at AS "revokedAt",
				stored.id AS "keyId",
				stored.name AS "keyName",
				stored.key_prefix AS "keyPrefixCurrent",
				stored.scopes_json AS "keyScopesJson",
				stored.created_at AS "keyCreatedAt",
				stored.expires_at AS "keyExpiresAt",
				stored.last_used_at AS "keyLastUsedAt",
				stored.revoked_at AS "keyRevokedAt"
			FROM workload_key_revoke_command command
			LEFT JOIN workload_key stored
				ON stored.organization_id = command.organization_id
				AND stored.id = command.workload_key_id
			WHERE command.organization_id = ${command.organizationId}
				AND command.actor_type = ${command.actor.type}
				AND command.actor_id = ${command.actor.id}
				AND command.idempotency_key = ${command.idempotencyKey}
			LIMIT 1
		`;
		const row: RevokeReceiptRow | undefined = rows[0];
		if (row === undefined) return null;
		if (
			row.workloadKeyId !== command.workloadKeyId ||
			row.requestHash !== command.requestFingerprint
		) {
			return { outcome: 'idempotency_conflict' };
		}

		const scopes: readonly WorkloadKeyScope[] | null =
			row.keyScopesJson === null ? null : parseWorkloadKeyScopesJson(row.keyScopesJson);
		const revokedAt: string | null = isoTimestamp(row.revokedAt);
		const keyRevokedAt: string | null = isoTimestamp(row.keyRevokedAt);
		const createdAt: string | null = isoTimestamp(row.keyCreatedAt);
		const expiresAt: string | null = isoTimestamp(row.keyExpiresAt);
		if (
			scopes === null ||
			revokedAt === null ||
			keyRevokedAt === null ||
			createdAt === null ||
			expiresAt === null ||
			row.keyId !== row.workloadKeyId ||
			row.keyName === null ||
			row.keyPrefixCurrent !== row.keyPrefix ||
			keyRevokedAt !== revokedAt
		) {
			return { outcome: 'integrity_error' };
		}
		return {
			outcome: 'replayed',
			key: {
				id: row.keyId,
				name: row.keyName,
				keyPrefix: row.keyPrefixCurrent,
				scopes,
				createdAt,
				expiresAt,
				lastUsedAt: isoTimestamp(row.keyLastUsedAt),
				revokedAt: keyRevokedAt
			}
		};
	}
}

const KEY_COLUMNS: string = `id, name, key_prefix AS "keyPrefix", scopes_json AS "scopesJson",
	created_at AS "createdAt", expires_at AS "expiresAt", last_used_at AS "lastUsedAt",
	revoked_at AS "revokedAt"`;

/**
 * Prove the create receipt against the key row it references. Every stored
 * field of the receipt must still match the live key, including the creating
 * user, before a replay may be reported as already issued.
 */
function createReceiptKeyMetadata(
	row: CreateReceiptRow,
	actorId: string
): WorkloadKeyMetadata | null {
	const createdAt: string | null = isoTimestamp(row.keyCreatedAt);
	const expiresAt: string | null = isoTimestamp(row.keyExpiresAt);
	if (
		row.keyId !== row.workloadKeyId ||
		row.keyName !== row.name ||
		row.keyPrefixCurrent !== row.keyPrefix ||
		row.keyScopesJson !== row.scopesJson ||
		row.keyCreatedByUserId !== actorId ||
		createdAt === null ||
		expiresAt === null ||
		createdAt !== isoTimestamp(row.createdAt) ||
		expiresAt !== isoTimestamp(row.expiresAt)
	) {
		return null;
	}
	const scopes: readonly WorkloadKeyScope[] | null = parseWorkloadKeyScopesJson(row.keyScopesJson);
	if (scopes === null) return null;
	return {
		id: row.keyId,
		name: row.keyName,
		keyPrefix: row.keyPrefixCurrent,
		scopes,
		createdAt,
		expiresAt,
		lastUsedAt: isoTimestamp(row.keyLastUsedAt),
		revokedAt: isoTimestamp(row.keyRevokedAt)
	};
}

function metadataFromRow(row: WorkloadKeyRow): WorkloadKeyMetadata {
	const scopes: readonly WorkloadKeyScope[] | null = parseWorkloadKeyScopesJson(row.scopesJson);
	const createdAt: string | null = isoTimestamp(row.createdAt);
	const expiresAt: string | null = isoTimestamp(row.expiresAt);
	if (scopes === null || createdAt === null || expiresAt === null) {
		throw new Error('Stored workload key row is not canonical.');
	}
	return {
		id: row.id,
		name: row.name,
		keyPrefix: row.keyPrefix,
		scopes,
		createdAt,
		expiresAt,
		lastUsedAt: isoTimestamp(row.lastUsedAt),
		revokedAt: isoTimestamp(row.revokedAt)
	};
}

function isoTimestamp(value: Date | string | null): string | null {
	if (value === null) return null;
	const milliseconds: number = value instanceof Date ? value.valueOf() : Date.parse(value);
	return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}
