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

interface ApiKeyRow {
	id: string;
	name: string;
	key_prefix: string;
	scopes_json: string;
	created_at: string;
	expires_at: string;
	last_used_at: string | null;
	revoked_at: string | null;
}

interface MemberRow {
	status: string;
}

interface CreateReceiptRow {
	request_hash: string;
	api_key_id: string;
	name: string;
	scopes_json: string;
	key_prefix: string;
	created_at: string;
	expires_at: string;
	key_id: string | null;
	key_name: string | null;
	key_prefix_current: string | null;
	key_scopes_json: string | null;
	key_owner_user_id: string | null;
	key_created_at: string | null;
	key_expires_at: string | null;
	key_last_used_at: string | null;
	key_revoked_at: string | null;
}

interface RevokeReceiptRow {
	request_hash: string;
	api_key_id: string;
	key_prefix: string;
	revoked_at: string;
	key_id: string | null;
	key_name: string | null;
	key_prefix_current: string | null;
	key_scopes_json: string | null;
	key_created_at: string | null;
	key_expires_at: string | null;
	key_last_used_at: string | null;
	key_revoked_at: string | null;
}

const KEY_COLUMNS: string = `id, name, key_prefix, scopes_json, created_at, expires_at,
	last_used_at, revoked_at`;

const CREATE_RECEIPT_COLUMNS: string = `command.request_hash, command.api_key_id, command.name,
	command.scopes_json, command.key_prefix, command.created_at, command.expires_at,
	stored.id AS key_id, stored.name AS key_name, stored.key_prefix AS key_prefix_current,
	stored.scopes_json AS key_scopes_json, stored.owner_user_id AS key_owner_user_id,
	stored.created_at AS key_created_at, stored.expires_at AS key_expires_at,
	stored.last_used_at AS key_last_used_at, stored.revoked_at AS key_revoked_at`;

const REVOKE_RECEIPT_COLUMNS: string = `command.request_hash, command.api_key_id,
	command.key_prefix, command.revoked_at, stored.id AS key_id, stored.name AS key_name,
	stored.key_prefix AS key_prefix_current, stored.scopes_json AS key_scopes_json,
	stored.created_at AS key_created_at, stored.expires_at AS key_expires_at,
	stored.last_used_at AS key_last_used_at, stored.revoked_at AS key_revoked_at`;

/**
 * D1 implementation of owner-scoped API key management.
 *
 * Create and revoke each run as a single D1 batch transaction, so the key row
 * and its command receipt either all become visible or none of them do. A batch
 * that fails is never interpreted from the provider's error text: the store
 * re-reads the durable receipt, the member status, the key id, and the
 * credential hash and classifies the outcome only when one of those evidence
 * queries proves it. Every write selects the owner through
 * `instance_member.status = 'active'`, so invited and suspended members fail
 * closed at the durable boundary. List, and the create/revoke idempotency
 * gates, read the member status together with the disclosed evidence — the
 * owner page, or the create/revoke receipt and key row — in one batch, so a
 * suspension can never land between the check and the disclosure.
 */
export class D1ApiKeyStore implements ApiKeyStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async createApiKey(command: CreateApiKeyCommand): Promise<CreateApiKeyStoreResult> {
		const gate: CreateApiKeyStoreResult | null = await this.#resolveCreateGate(command);
		if (gate !== null) return gate;

		const scopesJson: string = apiKeyScopesJson(command.scopes);
		const key: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO api_key (
					id, name, token_hash, key_prefix, scopes_json,
					owner_user_id, created_at, expires_at, revoked_at, last_used_at,
					rate_window_started_at, rate_window_count
				)
				SELECT ?, ?, ?, ?, ?, user_id, ?, ?, NULL, NULL, NULL, 0
				FROM instance_member
				WHERE user_id = ? AND status = 'active'`
			)
			.bind(
				command.apiKeyId,
				command.name,
				command.tokenHash,
				command.keyPrefix,
				scopesJson,
				command.createdAt,
				command.expiresAt,
				command.actor.id
			);
		const receipt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO api_key_create_command (
					actor_type, actor_id, idempotency_key, request_hash,
					api_key_id, name, scopes_json, key_prefix, expires_at, created_at
				)
				SELECT ?, ?, ?, ?, id, name, scopes_json, key_prefix, expires_at, created_at
				FROM api_key
				WHERE id = ? AND owner_user_id = ?`
			)
			.bind(
				command.actor.type,
				command.actor.id,
				command.idempotencyKey,
				command.requestFingerprint,
				command.apiKeyId,
				command.actor.id
			);

		let applied: boolean;
		try {
			const results: D1Result[] = await this.#database.batch([key, receipt]);
			applied = results.every((result: D1Result): boolean => changeCount(result) === 1);
		} catch (error: unknown) {
			const classified: CreateApiKeyStoreResult | null = await this.#classifyCreateFailure(command);
			if (classified !== null) return classified;
			throw error;
		}

		if (applied) return { outcome: 'created', key: metadataFromCreateCommand(command) };
		const classified: CreateApiKeyStoreResult | null = await this.#classifyCreateFailure(command);
		return classified ?? { outcome: 'integrity_error' };
	}

	async listApiKeys(actor: ApiKeyActor, query: ApiKeyListQuery): Promise<ListApiKeyStoreResult> {
		if (
			!Number.isSafeInteger(query.limit) ||
			query.limit < 1 ||
			query.limit > MAX_API_KEY_LIST_LIMIT
		) {
			throw new RangeError(`API key list limit must be between 1 and ${MAX_API_KEY_LIST_LIMIT}.`);
		}
		const fetchLimit: number = query.limit + 1;
		const member: D1PreparedStatement = this.#database
			.prepare('SELECT status FROM instance_member WHERE user_id = ? LIMIT 1')
			.bind(actor.id);
		// The page read carries the active-member predicate itself and resolves the
		// cursor owner-scoped in the same statement, so no key row can be projected
		// on the strength of a separate earlier check. An unknown or cross-owner
		// cursor leaves the row-value comparison NULL, which fails closed as an
		// empty page rather than resolving against another owner's page.
		const page: D1PreparedStatement =
			query.cursor === null
				? this.#database
						.prepare(
							`SELECT ${KEY_COLUMNS} FROM api_key
							 WHERE owner_user_id = ?
							   AND EXISTS (
								   SELECT 1 FROM instance_member
								   WHERE user_id = ? AND status = 'active'
							   )
							 ORDER BY created_at DESC, id DESC
							 LIMIT ?`
						)
						.bind(actor.id, actor.id, fetchLimit)
				: this.#database
						.prepare(
							`SELECT ${KEY_COLUMNS} FROM api_key
							 WHERE owner_user_id = ?
							   AND EXISTS (
								   SELECT 1 FROM instance_member
								   WHERE user_id = ? AND status = 'active'
							   )
							   AND (created_at, id) < (
								   SELECT created_at, id FROM api_key
								   WHERE owner_user_id = ? AND id = ? LIMIT 1
							   )
							 ORDER BY created_at DESC, id DESC
							 LIMIT ?`
						)
						.bind(actor.id, actor.id, actor.id, query.cursor, fetchLimit);

		// One batch is one transaction, so the member status and the page are read
		// from the same durable snapshot: a suspension committed between them is
		// impossible.
		const results: D1Result<MemberRow | ApiKeyRow>[] = await this.#database.batch<
			MemberRow | ApiKeyRow
		>([member, page]);
		const memberRow: MemberRow | undefined = results[0]?.results[0] as MemberRow | undefined;
		if (memberRow === undefined || memberRow.status !== 'active') {
			return { outcome: 'owner_not_active' };
		}

		const keyRows: ApiKeyRow[] = (results[1]?.results ?? []) as ApiKeyRow[];
		const hasNextPage: boolean = keyRows.length > query.limit;
		const rows: ApiKeyRow[] = hasNextPage ? keyRows.slice(0, query.limit) : keyRows;
		const items: readonly ApiKeyMetadata[] = rows.map((row: ApiKeyRow): ApiKeyMetadata =>
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
	}

	async revokeApiKey(command: RevokeApiKeyCommand): Promise<RevokeApiKeyStoreResult> {
		const gate: RevokeApiKeyStoreResult | null = await this.#resolveRevokeGate(command);
		if (gate !== null) return gate;

		// The receipt is derived from the key row under the same not-yet-revoked
		// owner-scoped predicate as the update, so both statements agree inside
		// one batch.
		const receipt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO api_key_revoke_command (
					actor_type, actor_id, idempotency_key, request_hash,
					api_key_id, key_prefix, revoked_at
				)
				SELECT ?, ?, ?, ?, id, key_prefix, ?
				FROM api_key
				WHERE owner_user_id = ? AND id = ? AND revoked_at IS NULL
					AND EXISTS (
						SELECT 1 FROM instance_member
						WHERE user_id = ? AND status = 'active'
					)`
			)
			.bind(
				command.actor.type,
				command.actor.id,
				command.idempotencyKey,
				command.requestFingerprint,
				command.revokedAt,
				command.actor.id,
				command.apiKeyId,
				command.actor.id
			);
		const update: D1PreparedStatement = this.#database
			.prepare(
				`UPDATE api_key SET revoked_at = ?
				 WHERE owner_user_id = ? AND id = ? AND revoked_at IS NULL
					AND EXISTS (
						SELECT 1 FROM instance_member
						WHERE user_id = api_key.owner_user_id AND status = 'active'
					)`
			)
			.bind(command.revokedAt, command.actor.id, command.apiKeyId);

		let applied: boolean;
		try {
			const results: D1Result[] = await this.#database.batch([receipt, update]);
			applied = results.every((result: D1Result): boolean => changeCount(result) === 1);
		} catch (error: unknown) {
			const raced: RevokeApiKeyStoreResult | null = await this.#resolveRevokeGate(command);
			if (raced !== null) return raced;
			throw error;
		}

		if (applied) {
			const revoked: ApiKeyRow | null = await this.#readOwnedKey(
				command.actor.id,
				command.apiKeyId
			);
			return revoked === null || revoked.revoked_at !== command.revokedAt
				? { outcome: 'integrity_error' }
				: { outcome: 'revoked', key: metadataFromRow(revoked) };
		}

		const raced: RevokeApiKeyStoreResult | null = await this.#resolveRevokeGate(command);
		return raced ?? { outcome: 'integrity_error' };
	}

	/**
	 * Reads the active-membership check, the idempotency receipt, and the
	 * current key row in one D1 batch (one transaction), so a suspension
	 * committed between separate reads can never surface a stale
	 * replayed/already_revoked disclosure for an owner who is no longer active.
	 * Returns null when the actor is active and the command should proceed.
	 */
	async #resolveRevokeGate(command: RevokeApiKeyCommand): Promise<RevokeApiKeyStoreResult | null> {
		const member: D1PreparedStatement = this.#database
			.prepare('SELECT status FROM instance_member WHERE user_id = ? LIMIT 1')
			.bind(command.actor.id);
		const receipt: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${REVOKE_RECEIPT_COLUMNS}
				 FROM api_key_revoke_command command
				 LEFT JOIN api_key stored
					ON stored.id = command.api_key_id
				 WHERE command.actor_type = ? AND command.actor_id = ?
					AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(command.actor.type, command.actor.id, command.idempotencyKey);
		const key: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${KEY_COLUMNS} FROM api_key
				 WHERE owner_user_id = ? AND id = ? LIMIT 1`
			)
			.bind(command.actor.id, command.apiKeyId);

		const results: D1Result<MemberRow | RevokeReceiptRow | ApiKeyRow>[] =
			await this.#database.batch<MemberRow | RevokeReceiptRow | ApiKeyRow>([
				member,
				receipt,
				key
			]);
		const memberRow: MemberRow | undefined = results[0]?.results[0] as MemberRow | undefined;
		if (memberRow === undefined || memberRow.status !== 'active') {
			return { outcome: 'owner_not_active' };
		}

		const receiptRow: RevokeReceiptRow | undefined = results[1]?.results[0] as
			| RevokeReceiptRow
			| undefined;
		if (receiptRow !== undefined) return evaluateRevokeReceiptRow(receiptRow, command);

		const keyRow: ApiKeyRow | undefined = results[2]?.results[0] as ApiKeyRow | undefined;
		if (keyRow === undefined) return { outcome: 'not_found' };
		// A fresh idempotency key for an already revoked credential is reported
		// explicitly instead of writing a second receipt for the same key.
		if (keyRow.revoked_at !== null) {
			return { outcome: 'already_revoked', key: metadataFromRow(keyRow) };
		}
		return null;
	}

	async #classifyCreateFailure(
		command: CreateApiKeyCommand
	): Promise<CreateApiKeyStoreResult | null> {
		const gate: CreateApiKeyStoreResult | null = await this.#resolveCreateGate(command);
		if (gate !== null) return gate;

		const existingId: { value: number } | null = await this.#database
			.prepare('SELECT 1 AS value FROM api_key WHERE id = ? LIMIT 1')
			.bind(command.apiKeyId)
			.first<{ value: number }>();
		if (existingId !== null) return { outcome: 'key_id_conflict' };

		const existingHash: { value: number } | null = await this.#database
			.prepare('SELECT 1 AS value FROM api_key WHERE token_hash = ? LIMIT 1')
			.bind(command.tokenHash)
			.first<{ value: number }>();
		if (existingHash !== null) return { outcome: 'token_hash_conflict' };

		return null;
	}

	/**
	 * Reads the active-membership check and the idempotency receipt in one D1
	 * batch (one transaction), so a suspension committed between separate reads
	 * can never surface a stale already_issued disclosure for an owner who is no
	 * longer active. Returns null when the actor is active and there is no
	 * receipt yet, meaning the caller should proceed with the insert.
	 */
	async #resolveCreateGate(command: CreateApiKeyCommand): Promise<CreateApiKeyStoreResult | null> {
		const member: D1PreparedStatement = this.#database
			.prepare('SELECT status FROM instance_member WHERE user_id = ? LIMIT 1')
			.bind(command.actor.id);
		const receipt: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${CREATE_RECEIPT_COLUMNS}
				 FROM api_key_create_command command
				 LEFT JOIN api_key stored
					ON stored.id = command.api_key_id
				 WHERE command.actor_type = ? AND command.actor_id = ?
					AND command.idempotency_key = ?
					AND EXISTS (
						SELECT 1 FROM instance_member
						WHERE user_id = ? AND status = 'active'
					)
				 LIMIT 1`
			)
			.bind(command.actor.type, command.actor.id, command.idempotencyKey);

		const results: D1Result<MemberRow | CreateReceiptRow>[] = await this.#database.batch<
			MemberRow | CreateReceiptRow
		>([member, receipt]);
		const memberRow: MemberRow | undefined = results[0]?.results[0] as MemberRow | undefined;
		if (memberRow === undefined || memberRow.status !== 'active') {
			return { outcome: 'owner_not_active' };
		}

		const row: CreateReceiptRow | undefined = results[1]?.results[0] as
			| CreateReceiptRow
			| undefined;
		if (row === undefined) return null;
		return evaluateCreateReceiptRow(row, command);
	}

	/** Reads back what this call just wrote, after the batch already proved the owner active. */
	async #readOwnedKey(ownerUserId: string, apiKeyId: string): Promise<ApiKeyRow | null> {
		return await this.#database
			.prepare(
				`SELECT ${KEY_COLUMNS} FROM api_key
				 WHERE owner_user_id = ? AND id = ? LIMIT 1`
			)
			.bind(ownerUserId, apiKeyId)
			.first<ApiKeyRow>();
	}

	/**
	 * The classification read. `already_revoked` discloses the same key metadata a
	 * replay does, so the active-member predicate rides inside this statement too.
	 */
	async #readActiveOwnedKey(ownerUserId: string, apiKeyId: string): Promise<ApiKeyRow | null> {
		return await this.#database
			.prepare(
				`SELECT ${KEY_COLUMNS} FROM api_key
				 WHERE owner_user_id = ? AND id = ?
					AND EXISTS (
						SELECT 1 FROM instance_member
						WHERE user_id = ? AND status = 'active'
					)
				 LIMIT 1`
			)
			.bind(ownerUserId, apiKeyId, ownerUserId)
			.first<ApiKeyRow>();
	}
}

function changeCount(result: D1Result): number {
	const changes: unknown = (result.meta as { changes?: unknown }).changes;
	return typeof changes === 'number' ? changes : 0;
}

function evaluateCreateReceiptRow(
	row: CreateReceiptRow,
	command: CreateApiKeyCommand
): CreateApiKeyStoreResult {
	if (row.request_hash !== command.requestFingerprint) return { outcome: 'idempotency_conflict' };

	const scopes: readonly ApiKeyScope[] | null = parseApiKeyScopesJson(row.scopes_json);
	const current: ApiKeyMetadata | null = createReceiptKeyMetadata(row, command.actor.id);
	// The secret is unrecoverable, so an unprovable receipt is a conflict
	// rather than a replay that could imply a usable credential.
	if (scopes === null || current === null) return { outcome: 'idempotency_conflict' };
	return { outcome: 'already_issued', key: current };
}

function evaluateRevokeReceiptRow(
	row: RevokeReceiptRow,
	command: RevokeApiKeyCommand
): RevokeApiKeyStoreResult {
	if (row.api_key_id !== command.apiKeyId || row.request_hash !== command.requestFingerprint) {
		return { outcome: 'idempotency_conflict' };
	}

	const scopes: readonly ApiKeyScope[] | null =
		row.key_scopes_json === null ? null : parseApiKeyScopesJson(row.key_scopes_json);
	if (
		scopes === null ||
		row.key_id !== row.api_key_id ||
		row.key_prefix_current !== row.key_prefix ||
		row.key_revoked_at !== row.revoked_at ||
		row.key_name === null ||
		row.key_created_at === null ||
		row.key_expires_at === null
	) {
		return { outcome: 'integrity_error' };
	}
	return {
		outcome: 'replayed',
		key: {
			id: row.key_id,
			name: row.key_name,
			keyPrefix: row.key_prefix_current,
			scopes,
			createdAt: row.key_created_at,
			expiresAt: row.key_expires_at,
			lastUsedAt: row.key_last_used_at,
			revokedAt: row.key_revoked_at
		}
	};
}

/**
 * Prove the create receipt against the key row it references. Every stored
 * field of the receipt must still match the live key, including the owning
 * user, before a replay may be reported as already issued.
 */
function createReceiptKeyMetadata(row: CreateReceiptRow, actorId: string): ApiKeyMetadata | null {
	if (
		row.key_id !== row.api_key_id ||
		row.key_name !== row.name ||
		row.key_prefix_current !== row.key_prefix ||
		row.key_scopes_json !== row.scopes_json ||
		row.key_owner_user_id !== actorId ||
		row.key_created_at !== row.created_at ||
		row.key_expires_at !== row.expires_at
	) {
		return null;
	}
	const scopes: readonly ApiKeyScope[] | null = parseApiKeyScopesJson(row.key_scopes_json);
	if (scopes === null) return null;
	return {
		id: row.key_id,
		name: row.key_name,
		keyPrefix: row.key_prefix_current,
		scopes,
		createdAt: row.key_created_at,
		expiresAt: row.key_expires_at,
		lastUsedAt: row.key_last_used_at,
		revokedAt: row.key_revoked_at
	};
}

function metadataFromCreateCommand(command: CreateApiKeyCommand): ApiKeyMetadata {
	return {
		id: command.apiKeyId,
		name: command.name,
		keyPrefix: command.keyPrefix,
		scopes: command.scopes,
		createdAt: command.createdAt,
		expiresAt: command.expiresAt,
		lastUsedAt: null,
		revokedAt: null
	};
}

function metadataFromRow(row: ApiKeyRow): ApiKeyMetadata {
	const scopes: readonly ApiKeyScope[] | null = parseApiKeyScopesJson(row.scopes_json);
	if (scopes === null) {
		throw new Error('Stored API key scopes are not canonical.');
	}
	return {
		id: row.id,
		name: row.name,
		keyPrefix: row.key_prefix,
		scopes,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		lastUsedAt: row.last_used_at,
		revokedAt: row.revoked_at
	};
}
