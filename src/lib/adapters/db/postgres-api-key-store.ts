import postgres from 'postgres';
import {
	MAX_API_KEY_LIST_LIMIT,
	parseApiKeyScopesJson,
	apiKeyScopesJson,
	type CreateApiKeyCommand,
	type CreateApiKeyStoreResult,
	type ListApiKeyStoreResult,
	type RevokeApiKeyCommand,
	type RevokeApiKeyStoreResult,
	type ApiKeyActor,
	type ApiKeyListQuery,
	type ApiKeyMetadata,
	type ApiKeyStore
} from '$lib/ports/api-key-store';
import type { ApiKeyScope } from '$lib/security/api-key';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

/**
 * Carries a non-success outcome out of a transaction so PostgreSQL rolls the
 * partial work back. Returning the outcome normally would commit it.
 */
class ApiKeyRollback<T> extends Error {
	constructor(readonly result: T) {
		super('API key transaction rolled back with an explicit outcome');
		this.name = 'ApiKeyRollback';
	}
}
interface ApiKeyRow {
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

interface MemberRow {
	status: string;
}

interface CreateReceiptRow {
	requestHash: string;
	apiKeyId: string;
	name: string;
	scopesJson: string;
	keyPrefix: string;
	createdAt: Date | string;
	expiresAt: Date | string;
	keyId: string | null;
	keyName: string | null;
	keyPrefixCurrent: string | null;
	keyScopesJson: string | null;
	keyOwnerUserId: string | null;
	keyCreatedAt: Date | string | null;
	keyExpiresAt: Date | string | null;
	keyLastUsedAt: Date | string | null;
	keyRevokedAt: Date | string | null;
}

interface RevokeReceiptRow {
	requestHash: string;
	apiKeyId: string;
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
 * PostgreSQL implementation of owner-scoped API key management.
 *
 * Create, list, and revoke run inside one transaction each. The actor's
 * `instance_member` row is locked `FOR SHARE` and must be `active` before any
 * key mutation or list disclosure. Conflicts are absorbed with
 * `ON CONFLICT DO NOTHING` so the transaction stays usable, and the outcome is
 * then decided by explicit evidence queries against the receipt, the member
 * status, the key id, and the credential hash — never by inspecting a driver
 * error code or message. Revoke takes a `FOR UPDATE` lock on the owned key row
 * so concurrent revocations serialize on it.
 */
export class PostgresApiKeyStore implements ApiKeyStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async createApiKey(command: CreateApiKeyCommand): Promise<CreateApiKeyStoreResult> {
		const scopesJson: string = apiKeyScopesJson(command.scopes);
		try {
			return await this.#sql.begin(async (transaction): Promise<CreateApiKeyStoreResult> => {
				await this.#requireActiveOwner(transaction, command.actor.id);
				const replay: CreateApiKeyStoreResult | null = await this.#resolveCreateReceipt(
					transaction,
					command
				);
				if (replay !== null) throw new ApiKeyRollback(replay);

				const keyRows = await transaction<ApiKeyRow[]>`
						INSERT INTO api_key (
							id, name, token_hash, key_prefix, scopes_json,
							owner_user_id, created_at, expires_at, revoked_at, last_used_at,
							rate_window_started_at, rate_window_count
						)
						SELECT
							${command.apiKeyId},
							${command.name},
							${command.tokenHash},
							${command.keyPrefix},
							${scopesJson},
							user_id,
							${command.createdAt}::timestamptz,
							${command.expiresAt}::timestamptz,
							NULL, NULL, NULL, 0
						FROM instance_member
						WHERE user_id = ${command.actor.id} AND status = 'active'
						ON CONFLICT DO NOTHING
						RETURNING ${transaction.unsafe(KEY_COLUMNS)}
					`;
				if (keyRows.length !== 1) {
					throw new ApiKeyRollback(await this.#classifyKeyInsertConflict(transaction, command));
				}

				const receiptRows = await transaction<{ apiKeyId: string }[]>`
						INSERT INTO api_key_create_command (
							actor_type, actor_id, idempotency_key, request_hash,
							api_key_id, name, scopes_json, key_prefix, expires_at, created_at
						)
						SELECT
							${command.actor.type},
							${command.actor.id},
							${command.idempotencyKey},
							${command.requestFingerprint},
							id, name, scopes_json, key_prefix, expires_at, created_at
						FROM api_key
						WHERE id = ${command.apiKeyId} AND owner_user_id = ${command.actor.id}
						ON CONFLICT DO NOTHING
						RETURNING api_key_id AS "apiKeyId"
					`;
				if (receiptRows.length !== 1) {
					const raced: CreateApiKeyStoreResult | null = await this.#resolveCreateReceipt(
						transaction,
						command
					);
					throw new ApiKeyRollback(raced ?? { outcome: 'integrity_error' });
				}

				return { outcome: 'created', key: metadataFromRow(keyRows[0]) };
			});
		} catch (error: unknown) {
			if (error instanceof ApiKeyRollback) {
				return error.result as CreateApiKeyStoreResult;
			}
			throw error;
		}
	}

	async listApiKeys(actor: ApiKeyActor, query: ApiKeyListQuery): Promise<ListApiKeyStoreResult> {
		if (
			!Number.isSafeInteger(query.limit) ||
			query.limit < 1 ||
			query.limit > MAX_API_KEY_LIST_LIMIT
		) {
			throw new RangeError(`API key list limit must be between 1 and ${MAX_API_KEY_LIST_LIMIT}.`);
		}

		try {
			return await this.#sql.begin(async (transaction): Promise<ListApiKeyStoreResult> => {
				// The owner's membership row is locked FOR SHARE and the lock is held for
				// the rest of this transaction, so a concurrent suspension cannot commit
				// between the check and the owner-key reads below.
				await this.#requireActiveOwner(transaction, actor.id);

				let cursor: CursorRow | undefined;
				if (query.cursor !== null) {
					const cursorRows = await transaction<CursorRow[]>`
						SELECT id, created_at AS "createdAt"
						FROM api_key
						WHERE owner_user_id = ${actor.id} AND id = ${query.cursor}
						LIMIT 1
					`;
					cursor = cursorRows[0];
					// An unknown or cross-owner cursor never resolves against another
					// owner's page; it fails closed as an empty page.
					if (cursor === undefined) {
						return { outcome: 'listed', page: { items: [], nextCursor: null } };
					}
				}

				const fetchLimit: number = query.limit + 1;
				// The active-member predicate is also carried inside the page read, so
				// disclosure is coupled to authorization in the statement itself and not
				// only to the preceding check.
				const rows =
					cursor === undefined
						? await transaction<ApiKeyRow[]>`
							SELECT ${transaction.unsafe(KEY_COLUMNS)}
							FROM api_key
							WHERE owner_user_id = ${actor.id}
								AND EXISTS (
									SELECT 1 FROM instance_member
									WHERE user_id = ${actor.id} AND status = 'active'
								)
							ORDER BY created_at DESC, id DESC
							LIMIT ${fetchLimit}
						`
						: await transaction<ApiKeyRow[]>`
							SELECT ${transaction.unsafe(KEY_COLUMNS)}
							FROM api_key
							WHERE owner_user_id = ${actor.id}
								AND EXISTS (
									SELECT 1 FROM instance_member
									WHERE user_id = ${actor.id} AND status = 'active'
								)
								AND (
									created_at < ${cursor.createdAt}
									OR (created_at = ${cursor.createdAt} AND id < ${cursor.id})
								)
							ORDER BY created_at DESC, id DESC
							LIMIT ${fetchLimit}
						`;
				const hasNextPage: boolean = rows.length > query.limit;
				const page: ApiKeyRow[] = hasNextPage ? rows.slice(0, query.limit) : [...rows];
				const items: readonly ApiKeyMetadata[] = page.map((row: ApiKeyRow): ApiKeyMetadata =>
					metadataFromRow(row)
				);
				const lastItem: ApiKeyMetadata | undefined = items.at(-1);

				return {
					outcome: 'listed',
					page: {
						items,
						nextCursor: hasNextPage && lastItem !== undefined ? lastItem.id : null
					}
				};
			});
		} catch (error: unknown) {
			if (error instanceof ApiKeyRollback) {
				return error.result as ListApiKeyStoreResult;
			}
			throw error;
		}
	}

	async revokeApiKey(command: RevokeApiKeyCommand): Promise<RevokeApiKeyStoreResult> {
		try {
			return await this.#sql.begin(async (transaction): Promise<RevokeApiKeyStoreResult> => {
				await this.#requireActiveOwner(transaction, command.actor.id);
				const replay: RevokeApiKeyStoreResult | null = await this.#resolveRevokeReceipt(
					transaction,
					command
				);
				if (replay !== null) throw new ApiKeyRollback(replay);

				const keyRows = await transaction<ApiKeyRow[]>`
						SELECT ${transaction.unsafe(KEY_COLUMNS)}
						FROM api_key
						WHERE owner_user_id = ${command.actor.id} AND id = ${command.apiKeyId}
						FOR UPDATE
					`;
				const key: ApiKeyRow | undefined = keyRows[0];
				if (key === undefined) {
					throw new ApiKeyRollback<RevokeApiKeyStoreResult>({ outcome: 'not_found' });
				}
				// A fresh idempotency key for an already revoked credential is
				// reported explicitly rather than writing a second receipt.
				if (key.revokedAt !== null) {
					throw new ApiKeyRollback<RevokeApiKeyStoreResult>({
						outcome: 'already_revoked',
						key: metadataFromRow(key)
					});
				}

				const receiptRows = await transaction<{ apiKeyId: string }[]>`
						INSERT INTO api_key_revoke_command (
							actor_type, actor_id, idempotency_key, request_hash,
							api_key_id, key_prefix, revoked_at
						)
						VALUES (
							${command.actor.type},
							${command.actor.id},
							${command.idempotencyKey},
							${command.requestFingerprint},
							${command.apiKeyId},
							${key.keyPrefix},
							${command.revokedAt}::timestamptz
						)
						ON CONFLICT DO NOTHING
						RETURNING api_key_id AS "apiKeyId"
					`;
				if (receiptRows.length !== 1) {
					const raced: RevokeApiKeyStoreResult | null = await this.#resolveRevokeReceipt(
						transaction,
						command
					);
					throw new ApiKeyRollback(raced ?? { outcome: 'integrity_error' });
				}

				const updated = await transaction<ApiKeyRow[]>`
						UPDATE api_key
						SET revoked_at = ${command.revokedAt}::timestamptz
						WHERE owner_user_id = ${command.actor.id}
							AND id = ${command.apiKeyId}
							AND revoked_at IS NULL
						RETURNING ${transaction.unsafe(KEY_COLUMNS)}
					`;
				if (updated.length !== 1) {
					throw new ApiKeyRollback<RevokeApiKeyStoreResult>({
						outcome: 'integrity_error'
					});
				}
				return { outcome: 'revoked', key: metadataFromRow(updated[0]) };
			});
		} catch (error: unknown) {
			if (error instanceof ApiKeyRollback) {
				return error.result as RevokeApiKeyStoreResult;
			}
			throw error;
		}
	}

	async #requireActiveOwner(sql: Sql, userId: string): Promise<void> {
		const members = await sql<MemberRow[]>`
			SELECT status FROM instance_member WHERE user_id = ${userId} LIMIT 1 FOR SHARE
		`;
		const member: MemberRow | undefined = members[0];
		if (member === undefined || member.status !== 'active') {
			throw new ApiKeyRollback<
				CreateApiKeyStoreResult | ListApiKeyStoreResult | RevokeApiKeyStoreResult
			>({
				outcome: 'owner_not_active'
			});
		}
	}

	async #actorIsActive(sql: Sql, userId: string): Promise<boolean> {
		const members = await sql<MemberRow[]>`
			SELECT status FROM instance_member WHERE user_id = ${userId} LIMIT 1
		`;
		const member: MemberRow | undefined = members[0];
		return member !== undefined && member.status === 'active';
	}

	async #classifyKeyInsertConflict(
		sql: Sql,
		command: CreateApiKeyCommand
	): Promise<CreateApiKeyStoreResult> {
		if (!(await this.#actorIsActive(sql, command.actor.id))) {
			return { outcome: 'owner_not_active' };
		}
		const sameId = await sql<{ id: string }[]>`
			SELECT id FROM api_key WHERE id = ${command.apiKeyId} LIMIT 1
		`;
		if (sameId.length === 1) return { outcome: 'key_id_conflict' };
		const sameHash = await sql<{ id: string }[]>`
			SELECT id FROM api_key WHERE token_hash = ${command.tokenHash} LIMIT 1
		`;
		if (sameHash.length === 1) return { outcome: 'token_hash_conflict' };
		return { outcome: 'integrity_error' };
	}

	async #resolveCreateReceipt(
		sql: Sql,
		command: CreateApiKeyCommand
	): Promise<CreateApiKeyStoreResult | null> {
		const rows = await sql<CreateReceiptRow[]>`
			SELECT
				command.request_hash AS "requestHash",
				command.api_key_id AS "apiKeyId",
				command.name,
				command.scopes_json AS "scopesJson",
				command.key_prefix AS "keyPrefix",
				command.created_at AS "createdAt",
				command.expires_at AS "expiresAt",
				stored.id AS "keyId",
				stored.name AS "keyName",
				stored.key_prefix AS "keyPrefixCurrent",
				stored.scopes_json AS "keyScopesJson",
				stored.owner_user_id AS "keyOwnerUserId",
				stored.created_at AS "keyCreatedAt",
				stored.expires_at AS "keyExpiresAt",
				stored.last_used_at AS "keyLastUsedAt",
				stored.revoked_at AS "keyRevokedAt"
			FROM api_key_create_command command
			LEFT JOIN api_key stored
				ON stored.id = command.api_key_id
			WHERE command.actor_type = ${command.actor.type}
				AND command.actor_id = ${command.actor.id}
				AND command.idempotency_key = ${command.idempotencyKey}
			LIMIT 1
		`;
		const row: CreateReceiptRow | undefined = rows[0];
		if (row === undefined) return null;
		if (row.requestHash !== command.requestFingerprint) return { outcome: 'idempotency_conflict' };

		const scopes: readonly ApiKeyScope[] | null = parseApiKeyScopesJson(row.scopesJson);
		const current: ApiKeyMetadata | null = createReceiptKeyMetadata(row, command.actor.id);
		// The secret is unrecoverable, so an unprovable receipt is a conflict
		// rather than a replay that could imply a usable credential.
		if (scopes === null || current === null) return { outcome: 'idempotency_conflict' };
		return { outcome: 'already_issued', key: current };
	}

	async #resolveRevokeReceipt(
		sql: Sql,
		command: RevokeApiKeyCommand
	): Promise<RevokeApiKeyStoreResult | null> {
		const rows = await sql<RevokeReceiptRow[]>`
			SELECT
				command.request_hash AS "requestHash",
				command.api_key_id AS "apiKeyId",
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
			FROM api_key_revoke_command command
			LEFT JOIN api_key stored
				ON stored.id = command.api_key_id
			WHERE command.actor_type = ${command.actor.type}
				AND command.actor_id = ${command.actor.id}
				AND command.idempotency_key = ${command.idempotencyKey}
			LIMIT 1
		`;
		const row: RevokeReceiptRow | undefined = rows[0];
		if (row === undefined) return null;
		if (row.apiKeyId !== command.apiKeyId || row.requestHash !== command.requestFingerprint) {
			return { outcome: 'idempotency_conflict' };
		}

		const scopes: readonly ApiKeyScope[] | null =
			row.keyScopesJson === null ? null : parseApiKeyScopesJson(row.keyScopesJson);
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
			row.keyId !== row.apiKeyId ||
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
 * field of the receipt must still match the live key, including the owning
 * user, before a replay may be reported as already issued.
 */
function createReceiptKeyMetadata(row: CreateReceiptRow, actorId: string): ApiKeyMetadata | null {
	const createdAt: string | null = isoTimestamp(row.keyCreatedAt);
	const expiresAt: string | null = isoTimestamp(row.keyExpiresAt);
	if (
		row.keyId !== row.apiKeyId ||
		row.keyName !== row.name ||
		row.keyPrefixCurrent !== row.keyPrefix ||
		row.keyScopesJson !== row.scopesJson ||
		row.keyOwnerUserId !== actorId ||
		createdAt === null ||
		expiresAt === null ||
		createdAt !== isoTimestamp(row.createdAt) ||
		expiresAt !== isoTimestamp(row.expiresAt)
	) {
		return null;
	}
	const scopes: readonly ApiKeyScope[] | null = parseApiKeyScopesJson(row.keyScopesJson);
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

function metadataFromRow(row: ApiKeyRow): ApiKeyMetadata {
	const scopes: readonly ApiKeyScope[] | null = parseApiKeyScopesJson(row.scopesJson);
	const createdAt: string | null = isoTimestamp(row.createdAt);
	const expiresAt: string | null = isoTimestamp(row.expiresAt);
	if (scopes === null || createdAt === null || expiresAt === null) {
		throw new Error('Stored API key row is not canonical.');
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
