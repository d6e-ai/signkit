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

interface WorkloadKeyRow {
	id: string;
	name: string;
	key_prefix: string;
	scopes_json: string;
	created_at: string;
	expires_at: string;
	last_used_at: string | null;
	revoked_at: string | null;
}

interface CursorRow {
	id: string;
	created_at: string;
}

interface OrganizationRow {
	d6e_organization_id: string;
}

interface CreateReceiptRow {
	request_hash: string;
	workload_key_id: string;
	name: string;
	scopes_json: string;
	key_prefix: string;
	created_at: string;
	expires_at: string;
	key_id: string | null;
	key_name: string | null;
	key_prefix_current: string | null;
	key_scopes_json: string | null;
	key_created_by_user_id: string | null;
	key_created_at: string | null;
	key_expires_at: string | null;
	key_last_used_at: string | null;
	key_revoked_at: string | null;
}

interface RevokeReceiptRow {
	request_hash: string;
	workload_key_id: string;
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

const CREATE_RECEIPT_COLUMNS: string = `command.request_hash, command.workload_key_id, command.name,
	command.scopes_json, command.key_prefix, command.created_at, command.expires_at,
	stored.id AS key_id, stored.name AS key_name, stored.key_prefix AS key_prefix_current,
	stored.scopes_json AS key_scopes_json, stored.created_by_user_id AS key_created_by_user_id,
	stored.created_at AS key_created_at, stored.expires_at AS key_expires_at,
	stored.last_used_at AS key_last_used_at, stored.revoked_at AS key_revoked_at`;

const REVOKE_RECEIPT_COLUMNS: string = `command.request_hash, command.workload_key_id,
	command.key_prefix, command.revoked_at, stored.id AS key_id, stored.name AS key_name,
	stored.key_prefix AS key_prefix_current, stored.scopes_json AS key_scopes_json,
	stored.created_at AS key_created_at, stored.expires_at AS key_expires_at,
	stored.last_used_at AS key_last_used_at, stored.revoked_at AS key_revoked_at`;

/**
 * D1 implementation of organization-scoped workload key management.
 *
 * Create and revoke each run as a single D1 batch transaction, so the key row,
 * its command receipt, and (for create) a first-seen organization projection
 * either all become visible or none of them do. A batch that fails is never
 * interpreted from the provider's error text: the store re-reads the durable
 * receipt, the organization projection, the key id, and the credential hash and
 * classifies the outcome only when one of those evidence queries proves it.
 */
export class D1WorkloadKeyStore implements WorkloadKeyStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async createWorkloadKey(
		command: CreateWorkloadKeyCommand
	): Promise<CreateWorkloadKeyStoreResult> {
		const replay: CreateWorkloadKeyStoreResult | null = await this.#resolveCreateReceipt(command);
		if (replay !== null) return replay;

		const scopesJson: string = workloadKeyScopesJson(command.scopes);
		// The guarded upsert refuses to touch an organization row whose d6e-auth
		// identifier differs, and the key insert resolves its tenant through the
		// same equality so a mismatch fails the batch instead of remapping.
		const organization: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO organization (id, d6e_organization_id, name, created_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET name = excluded.name
				 WHERE organization.d6e_organization_id = excluded.d6e_organization_id`
			)
			.bind(
				command.organizationId,
				command.organizationId,
				command.organizationName,
				command.createdAt
			);
		const key: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO workload_key (
					organization_id, id, name, token_hash, key_prefix, scopes_json,
					created_by_user_id, created_at, expires_at, revoked_at, last_used_at,
					rate_window_started_at, rate_window_count
				) VALUES (
					(SELECT id FROM organization WHERE id = ? AND d6e_organization_id = ?),
					?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0
				)`
			)
			.bind(
				command.organizationId,
				command.organizationId,
				command.workloadKeyId,
				command.name,
				command.tokenHash,
				command.keyPrefix,
				scopesJson,
				command.actor.id,
				command.createdAt,
				command.expiresAt
			);
		const receipt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO workload_key_create_command (
					organization_id, actor_type, actor_id, idempotency_key, request_hash,
					workload_key_id, name, scopes_json, key_prefix, expires_at, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				command.organizationId,
				command.actor.type,
				command.actor.id,
				command.idempotencyKey,
				command.requestFingerprint,
				command.workloadKeyId,
				command.name,
				scopesJson,
				command.keyPrefix,
				command.expiresAt,
				command.createdAt
			);

		try {
			await this.#database.batch([organization, key, receipt]);
		} catch (error: unknown) {
			const classified: CreateWorkloadKeyStoreResult | null =
				await this.#classifyCreateFailure(command);
			if (classified !== null) return classified;
			throw error;
		}

		return { outcome: 'created', key: metadataFromCreateCommand(command) };
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

		let cursor: CursorRow | null = null;
		if (query.cursor !== null) {
			cursor = await this.#database
				.prepare(
					'SELECT id, created_at FROM workload_key WHERE organization_id = ? AND id = ? LIMIT 1'
				)
				.bind(organizationId, query.cursor)
				.first<CursorRow>();
			// An unknown or cross-tenant cursor is never resolved against another
			// tenant's page; it fails closed as an empty page.
			if (cursor === null) return { items: [], nextCursor: null };
		}

		const fetchLimit: number = query.limit + 1;
		const statement: D1PreparedStatement =
			cursor === null
				? this.#database
						.prepare(
							`SELECT ${KEY_COLUMNS} FROM workload_key
							 WHERE organization_id = ?
							 ORDER BY created_at DESC, id DESC
							 LIMIT ?`
						)
						.bind(organizationId, fetchLimit)
				: this.#database
						.prepare(
							`SELECT ${KEY_COLUMNS} FROM workload_key
							 WHERE organization_id = ?
							   AND (created_at < ? OR (created_at = ? AND id < ?))
							 ORDER BY created_at DESC, id DESC
							 LIMIT ?`
						)
						.bind(organizationId, cursor.created_at, cursor.created_at, cursor.id, fetchLimit);
		const result: D1Result<WorkloadKeyRow> = await statement.all<WorkloadKeyRow>();
		const hasNextPage: boolean = result.results.length > query.limit;
		const rows: WorkloadKeyRow[] = hasNextPage
			? result.results.slice(0, query.limit)
			: result.results;
		const items: readonly WorkloadKeyMetadata[] = rows.map(
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
		const classified: RevokeWorkloadKeyStoreResult | null = await this.#classifyRevoke(command);
		if (classified !== null) return classified;

		// The receipt is derived from the key row under the same not-yet-revoked
		// predicate as the update, so both statements agree inside one batch.
		const receipt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO workload_key_revoke_command (
					organization_id, actor_type, actor_id, idempotency_key, request_hash,
					workload_key_id, key_prefix, revoked_at
				)
				SELECT organization_id, ?, ?, ?, ?, id, key_prefix, ?
				FROM workload_key
				WHERE organization_id = ? AND id = ? AND revoked_at IS NULL`
			)
			.bind(
				command.actor.type,
				command.actor.id,
				command.idempotencyKey,
				command.requestFingerprint,
				command.revokedAt,
				command.organizationId,
				command.workloadKeyId
			);
		const update: D1PreparedStatement = this.#database
			.prepare(
				`UPDATE workload_key SET revoked_at = ?
				 WHERE organization_id = ? AND id = ? AND revoked_at IS NULL`
			)
			.bind(command.revokedAt, command.organizationId, command.workloadKeyId);

		let applied: boolean;
		try {
			const results: D1Result[] = await this.#database.batch([receipt, update]);
			applied = results.every((result: D1Result): boolean => changeCount(result) === 1);
		} catch (error: unknown) {
			const raced: RevokeWorkloadKeyStoreResult | null = await this.#classifyRevoke(command);
			if (raced !== null) return raced;
			throw error;
		}

		if (applied) {
			const revoked: WorkloadKeyRow | null = await this.#readKey(
				command.organizationId,
				command.workloadKeyId
			);
			return revoked === null || revoked.revoked_at !== command.revokedAt
				? { outcome: 'integrity_error' }
				: { outcome: 'revoked', key: metadataFromRow(revoked) };
		}

		const raced: RevokeWorkloadKeyStoreResult | null = await this.#classifyRevoke(command);
		return raced ?? { outcome: 'integrity_error' };
	}

	async #classifyRevoke(
		command: RevokeWorkloadKeyCommand
	): Promise<RevokeWorkloadKeyStoreResult | null> {
		const replay: RevokeWorkloadKeyStoreResult | null = await this.#resolveRevokeReceipt(command);
		if (replay !== null) return replay;
		const key: WorkloadKeyRow | null = await this.#readKey(
			command.organizationId,
			command.workloadKeyId
		);
		if (key === null) return { outcome: 'not_found' };
		// A fresh idempotency key for an already revoked credential is reported
		// explicitly instead of writing a second receipt for the same key.
		if (key.revoked_at !== null) return { outcome: 'already_revoked', key: metadataFromRow(key) };
		return null;
	}

	async #classifyCreateFailure(
		command: CreateWorkloadKeyCommand
	): Promise<CreateWorkloadKeyStoreResult | null> {
		const replay: CreateWorkloadKeyStoreResult | null = await this.#resolveCreateReceipt(command);
		if (replay !== null) return replay;

		const organization: OrganizationRow | null = await this.#database
			.prepare('SELECT d6e_organization_id FROM organization WHERE id = ? LIMIT 1')
			.bind(command.organizationId)
			.first<OrganizationRow>();
		if (organization !== null && organization.d6e_organization_id !== command.organizationId) {
			return { outcome: 'integrity_error' };
		}

		const existingId: { value: number } | null = await this.#database
			.prepare('SELECT 1 AS value FROM workload_key WHERE organization_id = ? AND id = ? LIMIT 1')
			.bind(command.organizationId, command.workloadKeyId)
			.first<{ value: number }>();
		if (existingId !== null) return { outcome: 'key_id_conflict' };

		const existingHash: { value: number } | null = await this.#database
			.prepare('SELECT 1 AS value FROM workload_key WHERE token_hash = ? LIMIT 1')
			.bind(command.tokenHash)
			.first<{ value: number }>();
		if (existingHash !== null) return { outcome: 'token_hash_conflict' };

		return null;
	}

	async #resolveCreateReceipt(
		command: CreateWorkloadKeyCommand
	): Promise<CreateWorkloadKeyStoreResult | null> {
		const row: CreateReceiptRow | null = await this.#database
			.prepare(
				`SELECT ${CREATE_RECEIPT_COLUMNS}
				 FROM workload_key_create_command command
				 LEFT JOIN workload_key stored
					ON stored.organization_id = command.organization_id
					AND stored.id = command.workload_key_id
				 WHERE command.organization_id = ? AND command.actor_type = ?
					AND command.actor_id = ? AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(command.organizationId, command.actor.type, command.actor.id, command.idempotencyKey)
			.first<CreateReceiptRow>();
		if (row === null) return null;
		if (row.request_hash !== command.requestFingerprint) return { outcome: 'idempotency_conflict' };

		const scopes: readonly WorkloadKeyScope[] | null = parseWorkloadKeyScopesJson(row.scopes_json);
		const current: WorkloadKeyMetadata | null = createReceiptKeyMetadata(row, command.actor.id);
		// The secret is unrecoverable, so an unprovable receipt is a conflict
		// rather than a replay that could imply a usable credential.
		if (scopes === null || current === null) return { outcome: 'idempotency_conflict' };
		return { outcome: 'already_issued', key: current };
	}

	async #resolveRevokeReceipt(
		command: RevokeWorkloadKeyCommand
	): Promise<RevokeWorkloadKeyStoreResult | null> {
		const row: RevokeReceiptRow | null = await this.#database
			.prepare(
				`SELECT ${REVOKE_RECEIPT_COLUMNS}
				 FROM workload_key_revoke_command command
				 LEFT JOIN workload_key stored
					ON stored.organization_id = command.organization_id
					AND stored.id = command.workload_key_id
				 WHERE command.organization_id = ? AND command.actor_type = ?
					AND command.actor_id = ? AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(command.organizationId, command.actor.type, command.actor.id, command.idempotencyKey)
			.first<RevokeReceiptRow>();
		if (row === null) return null;
		if (
			row.workload_key_id !== command.workloadKeyId ||
			row.request_hash !== command.requestFingerprint
		) {
			return { outcome: 'idempotency_conflict' };
		}

		const scopes: readonly WorkloadKeyScope[] | null =
			row.key_scopes_json === null ? null : parseWorkloadKeyScopesJson(row.key_scopes_json);
		if (
			scopes === null ||
			row.key_id !== row.workload_key_id ||
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

	async #readKey(organizationId: string, workloadKeyId: string): Promise<WorkloadKeyRow | null> {
		return await this.#database
			.prepare(
				`SELECT ${KEY_COLUMNS} FROM workload_key
				 WHERE organization_id = ? AND id = ? LIMIT 1`
			)
			.bind(organizationId, workloadKeyId)
			.first<WorkloadKeyRow>();
	}
}

function changeCount(result: D1Result): number {
	const changes: unknown = (result.meta as { changes?: unknown }).changes;
	return typeof changes === 'number' ? changes : 0;
}

/**
 * Prove the create receipt against the key row it references. Every stored
 * field of the receipt must still match the live key, including the creating
 * user, before a replay may be reported as already issued.
 */
function createReceiptKeyMetadata(
	row: CreateReceiptRow,
	actorId: string
): WorkloadKeyMetadata | null {
	if (
		row.key_id !== row.workload_key_id ||
		row.key_name !== row.name ||
		row.key_prefix_current !== row.key_prefix ||
		row.key_scopes_json !== row.scopes_json ||
		row.key_created_by_user_id !== actorId ||
		row.key_created_at !== row.created_at ||
		row.key_expires_at !== row.expires_at
	) {
		return null;
	}
	const scopes: readonly WorkloadKeyScope[] | null = parseWorkloadKeyScopesJson(
		row.key_scopes_json
	);
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

function metadataFromCreateCommand(command: CreateWorkloadKeyCommand): WorkloadKeyMetadata {
	return {
		id: command.workloadKeyId,
		name: command.name,
		keyPrefix: command.keyPrefix,
		scopes: command.scopes,
		createdAt: command.createdAt,
		expiresAt: command.expiresAt,
		lastUsedAt: null,
		revokedAt: null
	};
}

function metadataFromRow(row: WorkloadKeyRow): WorkloadKeyMetadata {
	const scopes: readonly WorkloadKeyScope[] | null = parseWorkloadKeyScopesJson(row.scopes_json);
	if (scopes === null) {
		throw new Error('Stored workload key scopes are not canonical.');
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
