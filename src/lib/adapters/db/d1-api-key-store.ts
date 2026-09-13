import {
	MAX_API_KEY_GRANT_LIST_LIMIT,
	MAX_API_KEY_LIST_LIMIT,
	isApiKeyGrantingOrganizationRole,
	isApiKeyOrganizationGrantRevokeAuthority,
	parseApiKeyScopesJson,
	apiKeyScopesJson,
	type ApiKeyOrganizationGrantListQuery,
	type ApiKeyOrganizationGrantMetadata,
	type ApiKeyOrganizationGrantRevokeAuthority,
	type CreateApiKeyCommand,
	type CreateApiKeyStoreResult,
	type GrantApiKeyOrganizationCommand,
	type GrantApiKeyOrganizationStoreResult,
	type ListApiKeyOrganizationGrantsStoreResult,
	type ListApiKeyStoreResult,
	type RevokeApiKeyCommand,
	type RevokeApiKeyOrganizationGrantCommand,
	type RevokeApiKeyOrganizationGrantStoreResult,
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

interface GrantRow {
	id: string;
	api_key_id: string;
	organization_id: string;
	granted_by_user_id: string;
	granted_organization_role: string;
	granted_at: string;
	revoked_at: string | null;
	revoked_by_user_id: string | null;
	revoked_by_authority: string | null;
}

interface GrantWithOwnerRow extends GrantRow {
	key_owner_user_id: string;
}

interface GrantReceiptRow {
	request_hash: string;
	grant_id: string;
	api_key_id: string;
	organization_id: string;
	granted_organization_role: string;
	granted_at: string;
	stored_id: string | null;
	stored_api_key_id: string | null;
	stored_organization_id: string | null;
	stored_granted_by_user_id: string | null;
	stored_granted_organization_role: string | null;
	stored_granted_at: string | null;
	stored_revoked_at: string | null;
	stored_revoked_by_user_id: string | null;
	stored_revoked_by_authority: string | null;
}

interface GrantRevokeReceiptRow {
	request_hash: string;
	grant_id: string;
	api_key_id: string;
	organization_id: string;
	actor_authority: string;
	revoked_at: string;
	stored_id: string | null;
	stored_api_key_id: string | null;
	stored_organization_id: string | null;
	stored_granted_by_user_id: string | null;
	stored_granted_organization_role: string | null;
	stored_granted_at: string | null;
	stored_revoked_at: string | null;
	stored_revoked_by_user_id: string | null;
	stored_revoked_by_authority: string | null;
}

interface KeyLivenessRow {
	owner_user_id: string;
	revoked_at: string | null;
	expires_at: string;
}

const KEY_COLUMNS: string = `id, name, key_prefix, scopes_json, created_at, expires_at,
	last_used_at, revoked_at`;

const GRANT_COLUMNS: string = `id, api_key_id, organization_id, granted_by_user_id,
	granted_organization_role, granted_at, revoked_at, revoked_by_user_id, revoked_by_authority`;

const GRANT_STORED_COLUMNS: string = `stored.id AS stored_id,
	stored.api_key_id AS stored_api_key_id, stored.organization_id AS stored_organization_id,
	stored.granted_by_user_id AS stored_granted_by_user_id,
	stored.granted_organization_role AS stored_granted_organization_role,
	stored.granted_at AS stored_granted_at, stored.revoked_at AS stored_revoked_at,
	stored.revoked_by_user_id AS stored_revoked_by_user_id,
	stored.revoked_by_authority AS stored_revoked_by_authority`;

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
 * `instance_member.status = 'active'`, so suspended members fail closed at
 * the durable boundary. List, and the create/revoke idempotency
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
			await this.#database.batch<MemberRow | RevokeReceiptRow | ApiKeyRow>([member, receipt, key]);
		const memberRow: MemberRow | undefined = results[0]?.results[0] as MemberRow | undefined;
		if (memberRow === undefined || memberRow.status !== 'active') {
			return { outcome: 'owner_not_active' };
		}

		const receiptRow: RevokeReceiptRow | undefined = results[1]?.results[0] as
			RevokeReceiptRow | undefined;
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
	 * longer active. The receipt read repeats the actor id for its own
	 * active-member predicate, so the disclosure is owner-gated by the statement
	 * that produces it as well. Returns null when the actor is active and there
	 * is no receipt yet, meaning the caller should proceed with the insert.
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
			.bind(command.actor.type, command.actor.id, command.idempotencyKey, command.actor.id);

		const results: D1Result<MemberRow | CreateReceiptRow>[] = await this.#database.batch<
			MemberRow | CreateReceiptRow
		>([member, receipt]);
		const memberRow: MemberRow | undefined = results[0]?.results[0] as MemberRow | undefined;
		if (memberRow === undefined || memberRow.status !== 'active') {
			return { outcome: 'owner_not_active' };
		}

		const row: CreateReceiptRow | undefined = results[1]?.results[0] as
			CreateReceiptRow | undefined;
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

	async grantApiKeyOrganization(
		command: GrantApiKeyOrganizationCommand
	): Promise<GrantApiKeyOrganizationStoreResult> {
		const gate: GrantApiKeyOrganizationStoreResult | null = await this.#resolveGrantGate(command);
		if (gate !== null) return gate;

		// The organization projection is upserted from the caller's own verified
		// current d6e-auth membership, in the same batch as the grant, so the
		// grant's foreign key always resolves even for an organization that has
		// never created an envelope here. `organization.id` is the d6e identifier
		// itself, matching how envelope creation projects it.
		const organization: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO organization (id, d6e_organization_id, name, created_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET name = excluded.name`
			)
			.bind(
				command.organizationId,
				command.organizationId,
				command.organizationName,
				command.grantedAt
			);
		// Every authorization predicate the grant depends on is carried by the
		// insert itself: the actor must be an active member, must own the key, and
		// the key must be unrevoked and unexpired at this instant. A suspension, a
		// revocation, or an expiry committing between the gate read and this write
		// makes the insert affect zero rows instead of granting on stale evidence.
		const grant: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO api_key_organization_grant (
					id, api_key_id, organization_id, granted_by_user_id,
					granted_organization_role, granted_at, revoked_at, revoked_by_user_id,
					revoked_by_authority
				)
				SELECT ?, api_key.id, ?, ?, ?, ?, NULL, NULL, NULL
				FROM api_key
				WHERE api_key.id = ?
					AND api_key.owner_user_id = ?
					AND api_key.revoked_at IS NULL
					AND datetime(api_key.expires_at) > datetime(?)
					AND EXISTS (
						SELECT 1 FROM instance_member
						WHERE user_id = ? AND status = 'active'
					)`
			)
			.bind(
				command.grantId,
				command.organizationId,
				command.actor.id,
				command.grantingOrganizationRole,
				command.grantedAt,
				command.apiKeyId,
				command.actor.id,
				command.grantedAt,
				command.actor.id
			);
		// The receipt is derived from the row just inserted rather than from the
		// command, so a receipt can never describe a grant that did not land.
		const receipt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO api_key_organization_grant_command (
					actor_type, actor_id, idempotency_key, request_hash,
					grant_id, api_key_id, organization_id, granted_organization_role, granted_at
				)
				SELECT ?, ?, ?, ?, id, api_key_id, organization_id,
					granted_organization_role, granted_at
				FROM api_key_organization_grant
				WHERE id = ?`
			)
			.bind(
				command.actor.type,
				command.actor.id,
				command.idempotencyKey,
				command.requestFingerprint,
				command.grantId
			);

		let applied: boolean;
		try {
			const results: D1Result[] = await this.#database.batch([organization, grant, receipt]);
			applied = results.every((result: D1Result): boolean => changeCount(result) === 1);
		} catch (error: unknown) {
			const classified: GrantApiKeyOrganizationStoreResult | null =
				await this.#classifyGrantFailure(command);
			if (classified !== null) return classified;
			throw error;
		}

		if (applied) {
			return {
				outcome: 'granted',
				grant: {
					id: command.grantId,
					apiKeyId: command.apiKeyId,
					organizationId: command.organizationId,
					grantedByUserId: command.actor.id,
					grantedOrganizationRole: command.grantingOrganizationRole,
					grantedAt: command.grantedAt,
					revokedAt: null,
					revokedByUserId: null,
					revokedByAuthority: null
				}
			};
		}

		const classified: GrantApiKeyOrganizationStoreResult | null =
			await this.#classifyGrantFailure(command);
		return classified ?? { outcome: 'integrity_error' };
	}

	async listApiKeyOrganizationGrants(
		query: ApiKeyOrganizationGrantListQuery
	): Promise<ListApiKeyOrganizationGrantsStoreResult> {
		if (
			!Number.isSafeInteger(query.limit) ||
			query.limit < 1 ||
			query.limit > MAX_API_KEY_GRANT_LIST_LIMIT
		) {
			throw new RangeError(
				`API key grant list limit must be between 1 and ${MAX_API_KEY_GRANT_LIST_LIMIT}.`
			);
		}
		const fetchLimit: number = query.limit + 1;
		const member: D1PreparedStatement = this.#database
			.prepare('SELECT status FROM instance_member WHERE user_id = ? LIMIT 1')
			.bind(query.actor.id);
		const key: D1PreparedStatement = this.#database
			.prepare('SELECT 1 AS value FROM api_key WHERE id = ? AND owner_user_id = ? LIMIT 1')
			.bind(query.apiKeyId, query.actor.id);
		// The page read carries its own active-member and key-ownership predicates,
		// so no grant row can be projected on the strength of a separate earlier
		// check. An unknown or cross-key cursor leaves the row-value comparison
		// NULL, which fails closed as an empty page.
		const page: D1PreparedStatement =
			query.cursor === null
				? this.#database
						.prepare(
							`SELECT ${GRANT_COLUMNS} FROM api_key_organization_grant
							 WHERE api_key_id = ?
								 AND EXISTS (
									 SELECT 1 FROM api_key
									 JOIN instance_member ON instance_member.user_id = api_key.owner_user_id
									 WHERE api_key.id = ? AND api_key.owner_user_id = ?
										 AND instance_member.status = 'active'
								 )
							 ORDER BY granted_at DESC, id DESC
							 LIMIT ?`
						)
						.bind(query.apiKeyId, query.apiKeyId, query.actor.id, fetchLimit)
				: this.#database
						.prepare(
							`SELECT ${GRANT_COLUMNS} FROM api_key_organization_grant
							 WHERE api_key_id = ?
								 AND EXISTS (
									 SELECT 1 FROM api_key
									 JOIN instance_member ON instance_member.user_id = api_key.owner_user_id
									 WHERE api_key.id = ? AND api_key.owner_user_id = ?
										 AND instance_member.status = 'active'
								 )
								 AND (granted_at, id) < (
									 SELECT granted_at, id FROM api_key_organization_grant
									 WHERE api_key_id = ? AND id = ? LIMIT 1
								 )
							 ORDER BY granted_at DESC, id DESC
							 LIMIT ?`
						)
						.bind(
							query.apiKeyId,
							query.apiKeyId,
							query.actor.id,
							query.apiKeyId,
							query.cursor,
							fetchLimit
						);

		// One batch is one transaction, so member status, key ownership, and the
		// page come from the same durable snapshot.
		const results: D1Result<MemberRow | { value: number } | GrantRow>[] =
			await this.#database.batch<MemberRow | { value: number } | GrantRow>([member, key, page]);
		const memberRow: MemberRow | undefined = results[0]?.results[0] as MemberRow | undefined;
		if (memberRow === undefined || memberRow.status !== 'active') {
			return { outcome: 'owner_not_active' };
		}
		// An unknown or cross-owner key is reported identically, so grant listing
		// cannot be used to discover which key ids exist.
		if (results[1]?.results[0] === undefined) return { outcome: 'not_found' };

		const grantRows: GrantRow[] = (results[2]?.results ?? []) as GrantRow[];
		const hasNextPage: boolean = grantRows.length > query.limit;
		const rows: GrantRow[] = hasNextPage ? grantRows.slice(0, query.limit) : grantRows;
		const items: readonly ApiKeyOrganizationGrantMetadata[] = rows.map(
			(row: GrantRow): ApiKeyOrganizationGrantMetadata => grantMetadataFromRow(row)
		);
		const lastItem: ApiKeyOrganizationGrantMetadata | undefined = items.at(-1);

		return {
			outcome: 'listed',
			page: {
				items,
				nextCursor: hasNextPage && lastItem !== undefined ? lastItem.id : null
			}
		};
	}

	async revokeApiKeyOrganizationGrant(
		command: RevokeApiKeyOrganizationGrantCommand
	): Promise<RevokeApiKeyOrganizationGrantStoreResult> {
		const gate: RevokeApiKeyOrganizationGrantResolution =
			await this.#resolveGrantRevokeGate(command);
		if (gate.kind === 'result') return gate.result;
		const authority: ApiKeyOrganizationGrantRevokeAuthority = gate.authority;

		// Both admissible authorities are re-expressed as predicates on the write
		// itself. The owner path repeats the active-member and ownership checks; the
		// organization path repeats the exact organization the session proved. A
		// suspension or an ownership change committing after the gate read makes
		// this affect zero rows rather than revoking on stale evidence.
		const authorityPredicate: string =
			authority === 'key_owner'
				? `EXISTS (
						SELECT 1 FROM api_key
						JOIN instance_member ON instance_member.user_id = api_key.owner_user_id
						WHERE api_key.id = api_key_organization_grant.api_key_id
							AND api_key.owner_user_id = ?
							AND instance_member.status = 'active'
					)`
				: `api_key_organization_grant.organization_id = ?`;
		const authorityBinding: string =
			authority === 'key_owner' ? command.actor.id : (command.organizationScope ?? '');

		const receipt: D1PreparedStatement = this.#database
			.prepare(
				`INSERT INTO api_key_organization_grant_revoke_command (
					actor_type, actor_id, idempotency_key, request_hash,
					grant_id, api_key_id, organization_id, actor_authority, revoked_at
				)
				SELECT ?, ?, ?, ?, id, api_key_id, organization_id, ?, ?
				FROM api_key_organization_grant
				WHERE id = ? AND api_key_id = ? AND revoked_at IS NULL
					AND ${authorityPredicate}`
			)
			.bind(
				command.actor.type,
				command.actor.id,
				command.idempotencyKey,
				command.requestFingerprint,
				authority,
				command.revokedAt,
				command.grantId,
				command.apiKeyId,
				authorityBinding
			);
		const update: D1PreparedStatement = this.#database
			.prepare(
				`UPDATE api_key_organization_grant
				 SET revoked_at = ?, revoked_by_user_id = ?, revoked_by_authority = ?
				 WHERE id = ? AND api_key_id = ? AND revoked_at IS NULL
					AND ${authorityPredicate}`
			)
			.bind(
				command.revokedAt,
				command.actor.id,
				authority,
				command.grantId,
				command.apiKeyId,
				authorityBinding
			);

		let applied: boolean;
		try {
			const results: D1Result[] = await this.#database.batch([receipt, update]);
			applied = results.every((result: D1Result): boolean => changeCount(result) === 1);
		} catch (error: unknown) {
			const raced: RevokeApiKeyOrganizationGrantResolution =
				await this.#resolveGrantRevokeGate(command);
			if (raced.kind === 'result') return raced.result;
			throw error;
		}

		if (applied) {
			const revoked: GrantRow | null = await this.#readGrant(command.grantId, command.apiKeyId);
			return revoked === null ||
				revoked.revoked_at !== command.revokedAt ||
				revoked.revoked_by_user_id !== command.actor.id ||
				revoked.revoked_by_authority !== authority
				? { outcome: 'integrity_error' }
				: { outcome: 'revoked', grant: grantMetadataFromRow(revoked) };
		}

		const raced: RevokeApiKeyOrganizationGrantResolution =
			await this.#resolveGrantRevokeGate(command);
		return raced.kind === 'result' ? raced.result : { outcome: 'integrity_error' };
	}

	/**
	 * Reads the active-membership check, the grant receipt, the key's liveness,
	 * and any existing live grant for the requested pair in one D1 batch (one
	 * transaction), so a suspension or a key revocation committing between
	 * separate reads can never surface a stale disclosure. Returns null when the
	 * command should proceed to the insert.
	 */
	async #resolveGrantGate(
		command: GrantApiKeyOrganizationCommand
	): Promise<GrantApiKeyOrganizationStoreResult | null> {
		const member: D1PreparedStatement = this.#database
			.prepare('SELECT status FROM instance_member WHERE user_id = ? LIMIT 1')
			.bind(command.actor.id);
		const receipt: D1PreparedStatement = this.#database
			.prepare(
				`SELECT command.request_hash, command.grant_id, command.api_key_id,
					command.organization_id, command.granted_organization_role, command.granted_at,
					${GRANT_STORED_COLUMNS}
				 FROM api_key_organization_grant_command command
				 LEFT JOIN api_key_organization_grant stored
					ON stored.id = command.grant_id
				 WHERE command.actor_type = ? AND command.actor_id = ?
					AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(command.actor.type, command.actor.id, command.idempotencyKey);
		const key: D1PreparedStatement = this.#database
			.prepare(
				`SELECT owner_user_id, revoked_at, expires_at FROM api_key
				 WHERE id = ? AND owner_user_id = ? LIMIT 1`
			)
			.bind(command.apiKeyId, command.actor.id);
		const live: D1PreparedStatement = this.#database
			.prepare(
				`SELECT ${GRANT_COLUMNS} FROM api_key_organization_grant
				 WHERE api_key_id = ? AND organization_id = ? AND revoked_at IS NULL LIMIT 1`
			)
			.bind(command.apiKeyId, command.organizationId);

		const results: D1Result<MemberRow | GrantReceiptRow | KeyLivenessRow | GrantRow>[] =
			await this.#database.batch<MemberRow | GrantReceiptRow | KeyLivenessRow | GrantRow>([
				member,
				receipt,
				key,
				live
			]);
		const memberRow: MemberRow | undefined = results[0]?.results[0] as MemberRow | undefined;
		if (memberRow === undefined || memberRow.status !== 'active') {
			return { outcome: 'owner_not_active' };
		}

		const receiptRow: GrantReceiptRow | undefined = results[1]?.results[0] as
			GrantReceiptRow | undefined;
		if (receiptRow !== undefined) return evaluateGrantReceiptRow(receiptRow, command);

		// An unknown or cross-owner key is reported opaquely, so granting cannot be
		// used to discover another member's key ids.
		const keyRow: KeyLivenessRow | undefined = results[2]?.results[0] as KeyLivenessRow | undefined;
		if (keyRow === undefined) return { outcome: 'not_found' };
		// A revoked or already expired key describes a credential the caller owns
		// and can already see in their own key list, so it is reported explicitly
		// rather than opaquely.
		if (keyRow.revoked_at !== null || keyRow.expires_at <= command.grantedAt) {
			return { outcome: 'key_not_active' };
		}

		// A fresh idempotency key naming an organization this key already reaches
		// returns the existing grant and writes no second receipt, keeping the
		// one-receipt-per-grant invariant.
		const liveRow: GrantRow | undefined = results[3]?.results[0] as GrantRow | undefined;
		if (liveRow !== undefined) {
			return { outcome: 'already_granted', grant: grantMetadataFromRow(liveRow) };
		}
		return null;
	}

	async #classifyGrantFailure(
		command: GrantApiKeyOrganizationCommand
	): Promise<GrantApiKeyOrganizationStoreResult | null> {
		const gate: GrantApiKeyOrganizationStoreResult | null = await this.#resolveGrantGate(command);
		if (gate !== null) return gate;

		const existingId: { value: number } | null = await this.#database
			.prepare('SELECT 1 AS value FROM api_key_organization_grant WHERE id = ? LIMIT 1')
			.bind(command.grantId)
			.first<{ value: number }>();
		if (existingId !== null) return { outcome: 'grant_id_conflict' };

		return null;
	}

	/**
	 * Reads the grant, its owning key, the actor's membership, and any existing
	 * revoke receipt in one D1 batch, then resolves which of the two admissible
	 * de-escalation authorities applies.
	 *
	 * The receipt is evaluated before authority on purpose: an actor whose
	 * authority has since changed -- an owner since suspended, an organization
	 * administrator since removed -- must still see their own earlier command
	 * replay identically rather than having it re-authorized under today's state.
	 * This mirrors the instance member command's receipt-first ordering.
	 */
	async #resolveGrantRevokeGate(
		command: RevokeApiKeyOrganizationGrantCommand
	): Promise<RevokeApiKeyOrganizationGrantResolution> {
		const member: D1PreparedStatement = this.#database
			.prepare('SELECT status FROM instance_member WHERE user_id = ? LIMIT 1')
			.bind(command.actor.id);
		const receipt: D1PreparedStatement = this.#database
			.prepare(
				`SELECT command.request_hash, command.grant_id, command.api_key_id,
					command.organization_id, command.actor_authority, command.revoked_at,
					${GRANT_STORED_COLUMNS}
				 FROM api_key_organization_grant_revoke_command command
				 LEFT JOIN api_key_organization_grant stored
					ON stored.id = command.grant_id
				 WHERE command.actor_type = ? AND command.actor_id = ?
					AND command.idempotency_key = ?
				 LIMIT 1`
			)
			.bind(command.actor.type, command.actor.id, command.idempotencyKey);
		const grant: D1PreparedStatement = this.#database
			.prepare(
				`SELECT grant_row.id, grant_row.api_key_id, grant_row.organization_id,
					grant_row.granted_by_user_id, grant_row.granted_organization_role,
					grant_row.granted_at, grant_row.revoked_at, grant_row.revoked_by_user_id,
					grant_row.revoked_by_authority, api_key.owner_user_id AS key_owner_user_id
				 FROM api_key_organization_grant grant_row
				 JOIN api_key ON api_key.id = grant_row.api_key_id
				 WHERE grant_row.id = ? AND grant_row.api_key_id = ? LIMIT 1`
			)
			.bind(command.grantId, command.apiKeyId);

		const results: D1Result<MemberRow | GrantRevokeReceiptRow | GrantWithOwnerRow>[] =
			await this.#database.batch<MemberRow | GrantRevokeReceiptRow | GrantWithOwnerRow>([
				member,
				receipt,
				grant
			]);
		const memberRow: MemberRow | undefined = results[0]?.results[0] as MemberRow | undefined;
		const memberActive: boolean = memberRow !== undefined && memberRow.status === 'active';

		const receiptRow: GrantRevokeReceiptRow | undefined = results[1]?.results[0] as
			GrantRevokeReceiptRow | undefined;
		if (receiptRow !== undefined) {
			return { kind: 'result', result: evaluateGrantRevokeReceiptRow(receiptRow, command) };
		}

		const grantRow: GrantWithOwnerRow | undefined = results[2]?.results[0] as
			GrantWithOwnerRow | undefined;
		if (grantRow === undefined) {
			return { kind: 'result', result: { outcome: 'not_found' } };
		}

		const resolved: RevokeApiKeyOrganizationGrantResolution = resolveRevokeAuthority(
			command,
			grantRow,
			memberActive
		);
		if (resolved.kind === 'result') return resolved;

		// Already revoked is reported explicitly rather than as a second receipt,
		// matching api key revocation.
		if (grantRow.revoked_at !== null) {
			return {
				kind: 'result',
				result: { outcome: 'already_revoked', grant: grantMetadataFromRow(grantRow) }
			};
		}
		return resolved;
	}

	async #readGrant(grantId: string, apiKeyId: string): Promise<GrantRow | null> {
		return await this.#database
			.prepare(
				`SELECT ${GRANT_COLUMNS} FROM api_key_organization_grant
				 WHERE id = ? AND api_key_id = ? LIMIT 1`
			)
			.bind(grantId, apiKeyId)
			.first<GrantRow>();
	}
}

/**
 * Either a terminal outcome or the authority under which the write may proceed.
 * Keeping these in one value means the caller cannot accidentally continue after
 * a refusal, and the resolved authority is always the one recorded in the
 * receipt.
 */
type RevokeApiKeyOrganizationGrantResolution =
	| { kind: 'result'; result: RevokeApiKeyOrganizationGrantStoreResult }
	| { kind: 'authority'; authority: ApiKeyOrganizationGrantRevokeAuthority };

/**
 * Resolves which de-escalation authority applies, `key_owner` first so the
 * recorded authority is deterministic when a caller happens to hold both.
 *
 * A caller who owns the key but is no longer an active instance member, and who
 * has no organization authority either, gets `owner_not_active` -- their own
 * status, which they already know. Everyone else gets the opaque `not_found`, so
 * neither path can enumerate grants the other one reaches.
 */
function resolveRevokeAuthority(
	command: RevokeApiKeyOrganizationGrantCommand,
	grant: GrantWithOwnerRow,
	memberActive: boolean
): RevokeApiKeyOrganizationGrantResolution {
	const ownsKey: boolean = grant.key_owner_user_id === command.actor.id;
	const organizationAdmits: boolean =
		command.organizationScope !== null && grant.organization_id === command.organizationScope;

	if (command.ownerScope && ownsKey && memberActive) {
		return { kind: 'authority', authority: 'key_owner' };
	}
	if (organizationAdmits) return { kind: 'authority', authority: 'organization_admin' };
	if (command.ownerScope && ownsKey) {
		return { kind: 'result', result: { outcome: 'owner_not_active' } };
	}
	return { kind: 'result', result: { outcome: 'not_found' } };
}

function evaluateGrantReceiptRow(
	row: GrantReceiptRow,
	command: GrantApiKeyOrganizationCommand
): GrantApiKeyOrganizationStoreResult {
	if (row.request_hash !== command.requestFingerprint) return { outcome: 'idempotency_conflict' };
	if (row.api_key_id !== command.apiKeyId || row.organization_id !== command.organizationId) {
		return { outcome: 'idempotency_conflict' };
	}
	const current: ApiKeyOrganizationGrantMetadata | null = grantReceiptMetadata(row);
	// An unprovable receipt is a conflict rather than a replay that could imply
	// an authority nobody can verify.
	if (current === null) return { outcome: 'idempotency_conflict' };
	return { outcome: 'replayed', grant: current };
}

function evaluateGrantRevokeReceiptRow(
	row: GrantRevokeReceiptRow,
	command: RevokeApiKeyOrganizationGrantCommand
): RevokeApiKeyOrganizationGrantStoreResult {
	if (
		row.grant_id !== command.grantId ||
		row.api_key_id !== command.apiKeyId ||
		row.request_hash !== command.requestFingerprint
	) {
		return { outcome: 'idempotency_conflict' };
	}
	if (
		row.stored_id !== row.grant_id ||
		row.stored_api_key_id !== row.api_key_id ||
		row.stored_organization_id !== row.organization_id ||
		row.stored_revoked_at !== row.revoked_at ||
		row.stored_revoked_by_authority !== row.actor_authority ||
		row.stored_revoked_by_user_id !== command.actor.id
	) {
		return { outcome: 'integrity_error' };
	}
	const grant: ApiKeyOrganizationGrantMetadata | null = grantMetadataFromStored(row);
	if (grant === null) return { outcome: 'integrity_error' };
	return { outcome: 'replayed', grant };
}

/**
 * Prove the grant receipt against the row it references. Every stored field must
 * still match before a replay may be reported as already granted.
 */
function grantReceiptMetadata(row: GrantReceiptRow): ApiKeyOrganizationGrantMetadata | null {
	if (
		row.stored_id !== row.grant_id ||
		row.stored_api_key_id !== row.api_key_id ||
		row.stored_organization_id !== row.organization_id ||
		row.stored_granted_organization_role !== row.granted_organization_role ||
		row.stored_granted_at !== row.granted_at
	) {
		return null;
	}
	return grantMetadataFromStored(row);
}

function grantMetadataFromStored(
	row: GrantReceiptRow | GrantRevokeReceiptRow
): ApiKeyOrganizationGrantMetadata | null {
	if (
		row.stored_id === null ||
		row.stored_api_key_id === null ||
		row.stored_organization_id === null ||
		row.stored_granted_by_user_id === null ||
		row.stored_granted_at === null ||
		!isApiKeyGrantingOrganizationRole(row.stored_granted_organization_role)
	) {
		return null;
	}
	if (
		row.stored_revoked_by_authority !== null &&
		!isApiKeyOrganizationGrantRevokeAuthority(row.stored_revoked_by_authority)
	) {
		return null;
	}
	return {
		id: row.stored_id,
		apiKeyId: row.stored_api_key_id,
		organizationId: row.stored_organization_id,
		grantedByUserId: row.stored_granted_by_user_id,
		grantedOrganizationRole: row.stored_granted_organization_role,
		grantedAt: row.stored_granted_at,
		revokedAt: row.stored_revoked_at,
		revokedByUserId: row.stored_revoked_by_user_id,
		revokedByAuthority: row.stored_revoked_by_authority
	};
}

function grantMetadataFromRow(row: GrantRow): ApiKeyOrganizationGrantMetadata {
	if (!isApiKeyGrantingOrganizationRole(row.granted_organization_role)) {
		throw new Error('Stored API key grant role is not canonical.');
	}
	if (
		row.revoked_by_authority !== null &&
		!isApiKeyOrganizationGrantRevokeAuthority(row.revoked_by_authority)
	) {
		throw new Error('Stored API key grant revoke authority is not canonical.');
	}
	return {
		id: row.id,
		apiKeyId: row.api_key_id,
		organizationId: row.organization_id,
		grantedByUserId: row.granted_by_user_id,
		grantedOrganizationRole: row.granted_organization_role,
		grantedAt: row.granted_at,
		revokedAt: row.revoked_at,
		revokedByUserId: row.revoked_by_user_id,
		revokedByAuthority: row.revoked_by_authority
	};
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
