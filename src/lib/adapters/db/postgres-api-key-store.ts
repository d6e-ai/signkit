import postgres from 'postgres';
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

interface GrantRow {
	id: string;
	apiKeyId: string;
	organizationId: string;
	grantedByUserId: string;
	grantedOrganizationRole: string;
	grantedAt: Date | string;
	revokedAt: Date | string | null;
	revokedByUserId: string | null;
	revokedByAuthority: string | null;
}

interface GrantWithOwnerRow extends GrantRow {
	keyOwnerUserId: string;
}

interface GrantCursorRow {
	id: string;
	grantedAt: Date | string;
}

interface KeyLivenessRow {
	ownerUserId: string;
	revokedAt: Date | string | null;
	expiresAt: Date | string;
}

interface GrantReceiptRow {
	requestHash: string;
	grantId: string;
	apiKeyId: string;
	organizationId: string;
	grantedOrganizationRole: string;
	grantedAt: Date | string;
	storedId: string | null;
	storedApiKeyId: string | null;
	storedOrganizationId: string | null;
	storedGrantedByUserId: string | null;
	storedGrantedOrganizationRole: string | null;
	storedGrantedAt: Date | string | null;
	storedRevokedAt: Date | string | null;
	storedRevokedByUserId: string | null;
	storedRevokedByAuthority: string | null;
}

interface GrantRevokeReceiptRow {
	requestHash: string;
	grantId: string;
	apiKeyId: string;
	organizationId: string;
	actorAuthority: string;
	revokedAt: Date | string;
	storedId: string | null;
	storedApiKeyId: string | null;
	storedOrganizationId: string | null;
	storedGrantedByUserId: string | null;
	storedGrantedOrganizationRole: string | null;
	storedGrantedAt: Date | string | null;
	storedRevokedAt: Date | string | null;
	storedRevokedByUserId: string | null;
	storedRevokedByAuthority: string | null;
}

/**
 * Either a terminal outcome or the authority under which the write may proceed.
 * Keeping these in one value means the caller cannot accidentally continue after
 * a refusal, and the resolved authority is always the one recorded in the
 * receipt.
 */
type RevokeGrantResolution =
	| { kind: 'result'; result: RevokeApiKeyOrganizationGrantStoreResult }
	| { kind: 'authority'; authority: ApiKeyOrganizationGrantRevokeAuthority };

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

	async grantApiKeyOrganization(
		command: GrantApiKeyOrganizationCommand
	): Promise<GrantApiKeyOrganizationStoreResult> {
		try {
			return await this.#sql.begin(
				async (transaction): Promise<GrantApiKeyOrganizationStoreResult> => {
					// Lock order is instance_member -> api_key -> grant -> organization,
					// the same member-then-key prefix revokeApiKey uses, so two API key
					// commands can never deadlock against each other. Envelope creation
					// locks organization but never takes a member or key lock, so there
					// is no cycle with it either.
					await this.#requireActiveOwner(transaction, command.actor.id);
					const replay: GrantApiKeyOrganizationStoreResult | null = await this.#resolveGrantReceipt(
						transaction,
						command
					);
					if (replay !== null) throw new ApiKeyRollback(replay);

					const keyRows = await transaction<KeyLivenessRow[]>`
						SELECT owner_user_id AS "ownerUserId", revoked_at AS "revokedAt",
							expires_at AS "expiresAt"
						FROM api_key
						WHERE id = ${command.apiKeyId} AND owner_user_id = ${command.actor.id}
						FOR UPDATE
					`;
					const key: KeyLivenessRow | undefined = keyRows[0];
					// An unknown or cross-owner key is opaque, so granting cannot be used
					// to discover another member's key ids.
					if (key === undefined) {
						throw new ApiKeyRollback<GrantApiKeyOrganizationStoreResult>({
							outcome: 'not_found'
						});
					}
					// A revoked or already expired key describes a credential the caller
					// owns and can already see in their own key list, so it is explicit.
					if (key.revokedAt !== null || (isoTimestamp(key.expiresAt) ?? '') <= command.grantedAt) {
						throw new ApiKeyRollback<GrantApiKeyOrganizationStoreResult>({
							outcome: 'key_not_active'
						});
					}

					const liveRows = await transaction<GrantRow[]>`
						SELECT ${transaction.unsafe(GRANT_COLUMNS)}
						FROM api_key_organization_grant
						WHERE api_key_id = ${command.apiKeyId}
							AND organization_id = ${command.organizationId}
							AND revoked_at IS NULL
						FOR UPDATE
					`;
					// A fresh idempotency key naming an organization this key already
					// reaches returns the existing grant and writes no second receipt.
					if (liveRows.length === 1) {
						throw new ApiKeyRollback<GrantApiKeyOrganizationStoreResult>({
							outcome: 'already_granted',
							grant: grantMetadataFromRow(liveRows[0])
						});
					}

					// The organization projection is upserted from the caller's own
					// verified current d6e-auth membership, inside the same transaction,
					// so the grant's foreign key resolves even for an organization that
					// has never created an envelope here.
					const organizations = await transaction<{ id: string }[]>`
						INSERT INTO organization (id, d6e_organization_id, name, created_at)
						VALUES (
							${command.organizationId},
							${command.organizationId},
							${command.organizationName},
							${command.grantedAt}::timestamptz
						)
						ON CONFLICT (id) DO UPDATE
						SET name = EXCLUDED.name
						WHERE organization.d6e_organization_id = EXCLUDED.d6e_organization_id
						RETURNING id
					`;
					if (organizations.length !== 1) {
						throw new ApiKeyRollback<GrantApiKeyOrganizationStoreResult>({
							outcome: 'integrity_error'
						});
					}

					const grantRows = await transaction<GrantRow[]>`
						INSERT INTO api_key_organization_grant (
							id, api_key_id, organization_id, granted_by_user_id,
							granted_organization_role, granted_at, revoked_at,
							revoked_by_user_id, revoked_by_authority
						)
						VALUES (
							${command.grantId},
							${command.apiKeyId},
							${command.organizationId},
							${command.actor.id},
							${command.grantingOrganizationRole},
							${command.grantedAt}::timestamptz,
							NULL, NULL, NULL
						)
						ON CONFLICT DO NOTHING
						RETURNING ${transaction.unsafe(GRANT_COLUMNS)}
					`;
					if (grantRows.length !== 1) {
						throw new ApiKeyRollback(await this.#classifyGrantInsertConflict(transaction, command));
					}

					const receiptRows = await transaction<{ grantId: string }[]>`
						INSERT INTO api_key_organization_grant_command (
							actor_type, actor_id, idempotency_key, request_hash,
							grant_id, api_key_id, organization_id, granted_organization_role,
							granted_at
						)
						SELECT
							${command.actor.type},
							${command.actor.id},
							${command.idempotencyKey},
							${command.requestFingerprint},
							id, api_key_id, organization_id, granted_organization_role, granted_at
						FROM api_key_organization_grant
						WHERE id = ${command.grantId}
						ON CONFLICT DO NOTHING
						RETURNING grant_id AS "grantId"
					`;
					if (receiptRows.length !== 1) {
						const raced: GrantApiKeyOrganizationStoreResult | null =
							await this.#resolveGrantReceipt(transaction, command);
						throw new ApiKeyRollback(raced ?? { outcome: 'integrity_error' });
					}

					return { outcome: 'granted', grant: grantMetadataFromRow(grantRows[0]) };
				}
			);
		} catch (error: unknown) {
			if (error instanceof ApiKeyRollback) {
				return error.result as GrantApiKeyOrganizationStoreResult;
			}
			throw error;
		}
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

		try {
			return await this.#sql.begin(
				async (transaction): Promise<ListApiKeyOrganizationGrantsStoreResult> => {
					// The membership row is locked FOR SHARE for the rest of the
					// transaction, so a concurrent suspension cannot commit between this
					// check and the reads below.
					await this.#requireActiveOwner(transaction, query.actor.id);

					const keyRows = await transaction<{ id: string }[]>`
						SELECT id FROM api_key
						WHERE id = ${query.apiKeyId} AND owner_user_id = ${query.actor.id}
						LIMIT 1
					`;
					// An unknown or cross-owner key is reported identically, so grant
					// listing cannot be used to discover which key ids exist.
					if (keyRows.length !== 1) return { outcome: 'not_found' };

					let cursor: GrantCursorRow | undefined;
					if (query.cursor !== null) {
						const cursorRows = await transaction<GrantCursorRow[]>`
							SELECT id, granted_at AS "grantedAt"
							FROM api_key_organization_grant
							WHERE api_key_id = ${query.apiKeyId} AND id = ${query.cursor}
							LIMIT 1
						`;
						cursor = cursorRows[0];
						// An unknown or cross-key cursor never resolves against another
						// key's page; it fails closed as an empty page.
						if (cursor === undefined) {
							return { outcome: 'listed', page: { items: [], nextCursor: null } };
						}
					}

					const fetchLimit: number = query.limit + 1;
					const rows =
						cursor === undefined
							? await transaction<GrantRow[]>`
								SELECT ${transaction.unsafe(GRANT_COLUMNS)}
								FROM api_key_organization_grant
								WHERE api_key_id = ${query.apiKeyId}
									AND EXISTS (
										SELECT 1 FROM api_key
										JOIN instance_member
											ON instance_member.user_id = api_key.owner_user_id
										WHERE api_key.id = ${query.apiKeyId}
											AND api_key.owner_user_id = ${query.actor.id}
											AND instance_member.status = 'active'
									)
								ORDER BY granted_at DESC, id DESC
								LIMIT ${fetchLimit}
							`
							: await transaction<GrantRow[]>`
								SELECT ${transaction.unsafe(GRANT_COLUMNS)}
								FROM api_key_organization_grant
								WHERE api_key_id = ${query.apiKeyId}
									AND EXISTS (
										SELECT 1 FROM api_key
										JOIN instance_member
											ON instance_member.user_id = api_key.owner_user_id
										WHERE api_key.id = ${query.apiKeyId}
											AND api_key.owner_user_id = ${query.actor.id}
											AND instance_member.status = 'active'
									)
									AND (
										granted_at < ${cursor.grantedAt}
										OR (granted_at = ${cursor.grantedAt} AND id < ${cursor.id})
									)
								ORDER BY granted_at DESC, id DESC
								LIMIT ${fetchLimit}
							`;
					const hasNextPage: boolean = rows.length > query.limit;
					const page: GrantRow[] = hasNextPage ? rows.slice(0, query.limit) : [...rows];
					const items: readonly ApiKeyOrganizationGrantMetadata[] = page.map(
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
			);
		} catch (error: unknown) {
			if (error instanceof ApiKeyRollback) {
				return error.result as ListApiKeyOrganizationGrantsStoreResult;
			}
			throw error;
		}
	}

	async revokeApiKeyOrganizationGrant(
		command: RevokeApiKeyOrganizationGrantCommand
	): Promise<RevokeApiKeyOrganizationGrantStoreResult> {
		try {
			return await this.#sql.begin(
				async (transaction): Promise<RevokeApiKeyOrganizationGrantStoreResult> => {
					// Deliberately not `#requireActiveOwner`: the organization
					// administrator path is authorized entirely by the verified d6e-auth
					// session and may hold no local instance membership at all, so
					// demanding one here would break exactly the de-escalation control an
					// organization needs most.
					const memberActive: boolean = await this.#actorIsActive(transaction, command.actor.id);

					// Receipt before authority, matching instance member administration: an
					// actor whose authority has since changed must still see their own
					// earlier command replay identically rather than be re-authorized
					// under today's state.
					const replay: RevokeApiKeyOrganizationGrantStoreResult | null =
						await this.#resolveGrantRevokeReceipt(transaction, command);
					if (replay !== null) throw new ApiKeyRollback(replay);

					const grantRows = await transaction<GrantWithOwnerRow[]>`
						SELECT
							grant_row.id,
							grant_row.api_key_id AS "apiKeyId",
							grant_row.organization_id AS "organizationId",
							grant_row.granted_by_user_id AS "grantedByUserId",
							grant_row.granted_organization_role AS "grantedOrganizationRole",
							grant_row.granted_at AS "grantedAt",
							grant_row.revoked_at AS "revokedAt",
							grant_row.revoked_by_user_id AS "revokedByUserId",
							grant_row.revoked_by_authority AS "revokedByAuthority",
							api_key.owner_user_id AS "keyOwnerUserId"
						FROM api_key_organization_grant grant_row
						JOIN api_key ON api_key.id = grant_row.api_key_id
						WHERE grant_row.id = ${command.grantId}
							AND grant_row.api_key_id = ${command.apiKeyId}
						FOR UPDATE OF grant_row
					`;
					const grant: GrantWithOwnerRow | undefined = grantRows[0];
					if (grant === undefined) {
						throw new ApiKeyRollback<RevokeApiKeyOrganizationGrantStoreResult>({
							outcome: 'not_found'
						});
					}

					const resolved: RevokeGrantResolution = resolveRevokeAuthority(
						command,
						grant,
						memberActive
					);
					if (resolved.kind === 'result') throw new ApiKeyRollback(resolved.result);
					const authority: ApiKeyOrganizationGrantRevokeAuthority = resolved.authority;

					// Already revoked is explicit rather than a second receipt, matching
					// api key revocation -- but only after authority is proven, so a
					// caller with no authority still sees the opaque not_found.
					if (grant.revokedAt !== null) {
						throw new ApiKeyRollback<RevokeApiKeyOrganizationGrantStoreResult>({
							outcome: 'already_revoked',
							grant: grantMetadataFromRow(grant)
						});
					}

					const receiptRows = await transaction<{ grantId: string }[]>`
						INSERT INTO api_key_organization_grant_revoke_command (
							actor_type, actor_id, idempotency_key, request_hash,
							grant_id, api_key_id, organization_id, actor_authority, revoked_at
						)
						VALUES (
							${command.actor.type},
							${command.actor.id},
							${command.idempotencyKey},
							${command.requestFingerprint},
							${command.grantId},
							${command.apiKeyId},
							${grant.organizationId},
							${authority},
							${command.revokedAt}::timestamptz
						)
						ON CONFLICT DO NOTHING
						RETURNING grant_id AS "grantId"
					`;
					if (receiptRows.length !== 1) {
						const raced: RevokeApiKeyOrganizationGrantStoreResult | null =
							await this.#resolveGrantRevokeReceipt(transaction, command);
						throw new ApiKeyRollback(raced ?? { outcome: 'integrity_error' });
					}

					const updated = await transaction<GrantRow[]>`
						UPDATE api_key_organization_grant
						SET revoked_at = ${command.revokedAt}::timestamptz,
							revoked_by_user_id = ${command.actor.id},
							revoked_by_authority = ${authority}
						WHERE id = ${command.grantId}
							AND api_key_id = ${command.apiKeyId}
							AND revoked_at IS NULL
						RETURNING ${transaction.unsafe(GRANT_COLUMNS)}
					`;
					if (updated.length !== 1) {
						throw new ApiKeyRollback<RevokeApiKeyOrganizationGrantStoreResult>({
							outcome: 'integrity_error'
						});
					}
					return { outcome: 'revoked', grant: grantMetadataFromRow(updated[0]) };
				}
			);
		} catch (error: unknown) {
			if (error instanceof ApiKeyRollback) {
				return error.result as RevokeApiKeyOrganizationGrantStoreResult;
			}
			throw error;
		}
	}

	async #classifyGrantInsertConflict(
		sql: Sql,
		command: GrantApiKeyOrganizationCommand
	): Promise<GrantApiKeyOrganizationStoreResult> {
		const sameId = await sql<{ id: string }[]>`
			SELECT id FROM api_key_organization_grant WHERE id = ${command.grantId} LIMIT 1
		`;
		if (sameId.length === 1) return { outcome: 'grant_id_conflict' };
		const live = await sql<GrantRow[]>`
			SELECT ${sql.unsafe(GRANT_COLUMNS)}
			FROM api_key_organization_grant
			WHERE api_key_id = ${command.apiKeyId}
				AND organization_id = ${command.organizationId}
				AND revoked_at IS NULL
			LIMIT 1
		`;
		if (live.length === 1)
			return { outcome: 'already_granted', grant: grantMetadataFromRow(live[0]) };
		return { outcome: 'integrity_error' };
	}

	async #resolveGrantReceipt(
		sql: Sql,
		command: GrantApiKeyOrganizationCommand
	): Promise<GrantApiKeyOrganizationStoreResult | null> {
		const rows = await sql<GrantReceiptRow[]>`
			SELECT
				command.request_hash AS "requestHash",
				command.grant_id AS "grantId",
				command.api_key_id AS "apiKeyId",
				command.organization_id AS "organizationId",
				command.granted_organization_role AS "grantedOrganizationRole",
				command.granted_at AS "grantedAt",
				stored.id AS "storedId",
				stored.api_key_id AS "storedApiKeyId",
				stored.organization_id AS "storedOrganizationId",
				stored.granted_by_user_id AS "storedGrantedByUserId",
				stored.granted_organization_role AS "storedGrantedOrganizationRole",
				stored.granted_at AS "storedGrantedAt",
				stored.revoked_at AS "storedRevokedAt",
				stored.revoked_by_user_id AS "storedRevokedByUserId",
				stored.revoked_by_authority AS "storedRevokedByAuthority"
			FROM api_key_organization_grant_command command
			LEFT JOIN api_key_organization_grant stored
				ON stored.id = command.grant_id
			WHERE command.actor_type = ${command.actor.type}
				AND command.actor_id = ${command.actor.id}
				AND command.idempotency_key = ${command.idempotencyKey}
			LIMIT 1
		`;
		const row: GrantReceiptRow | undefined = rows[0];
		if (row === undefined) return null;
		if (
			row.requestHash !== command.requestFingerprint ||
			row.apiKeyId !== command.apiKeyId ||
			row.organizationId !== command.organizationId
		) {
			return { outcome: 'idempotency_conflict' };
		}
		const current: ApiKeyOrganizationGrantMetadata | null = grantReceiptMetadata(row);
		// An unprovable receipt is a conflict rather than a replay that could imply
		// an authority nobody can verify.
		if (current === null) return { outcome: 'idempotency_conflict' };
		return { outcome: 'replayed', grant: current };
	}

	async #resolveGrantRevokeReceipt(
		sql: Sql,
		command: RevokeApiKeyOrganizationGrantCommand
	): Promise<RevokeApiKeyOrganizationGrantStoreResult | null> {
		const rows = await sql<GrantRevokeReceiptRow[]>`
			SELECT
				command.request_hash AS "requestHash",
				command.grant_id AS "grantId",
				command.api_key_id AS "apiKeyId",
				command.organization_id AS "organizationId",
				command.actor_authority AS "actorAuthority",
				command.revoked_at AS "revokedAt",
				stored.id AS "storedId",
				stored.api_key_id AS "storedApiKeyId",
				stored.organization_id AS "storedOrganizationId",
				stored.granted_by_user_id AS "storedGrantedByUserId",
				stored.granted_organization_role AS "storedGrantedOrganizationRole",
				stored.granted_at AS "storedGrantedAt",
				stored.revoked_at AS "storedRevokedAt",
				stored.revoked_by_user_id AS "storedRevokedByUserId",
				stored.revoked_by_authority AS "storedRevokedByAuthority"
			FROM api_key_organization_grant_revoke_command command
			LEFT JOIN api_key_organization_grant stored
				ON stored.id = command.grant_id
			WHERE command.actor_type = ${command.actor.type}
				AND command.actor_id = ${command.actor.id}
				AND command.idempotency_key = ${command.idempotencyKey}
			LIMIT 1
		`;
		const row: GrantRevokeReceiptRow | undefined = rows[0];
		if (row === undefined) return null;
		if (
			row.grantId !== command.grantId ||
			row.apiKeyId !== command.apiKeyId ||
			row.requestHash !== command.requestFingerprint
		) {
			return { outcome: 'idempotency_conflict' };
		}
		const revokedAt: string | null = isoTimestamp(row.revokedAt);
		const storedRevokedAt: string | null = isoTimestamp(row.storedRevokedAt);
		if (
			revokedAt === null ||
			storedRevokedAt !== revokedAt ||
			row.storedId !== row.grantId ||
			row.storedApiKeyId !== row.apiKeyId ||
			row.storedOrganizationId !== row.organizationId ||
			row.storedRevokedByAuthority !== row.actorAuthority ||
			row.storedRevokedByUserId !== command.actor.id
		) {
			return { outcome: 'integrity_error' };
		}
		const grant: ApiKeyOrganizationGrantMetadata | null = grantMetadataFromStored(row);
		if (grant === null) return { outcome: 'integrity_error' };
		return { outcome: 'replayed', grant };
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

const GRANT_COLUMNS: string = `id, api_key_id AS "apiKeyId",
	organization_id AS "organizationId", granted_by_user_id AS "grantedByUserId",
	granted_organization_role AS "grantedOrganizationRole", granted_at AS "grantedAt",
	revoked_at AS "revokedAt", revoked_by_user_id AS "revokedByUserId",
	revoked_by_authority AS "revokedByAuthority"`;

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
): RevokeGrantResolution {
	const ownsKey: boolean = grant.keyOwnerUserId === command.actor.id;
	const organizationAdmits: boolean =
		command.organizationScope !== null && grant.organizationId === command.organizationScope;

	if (command.ownerScope && ownsKey && memberActive) {
		return { kind: 'authority', authority: 'key_owner' };
	}
	if (organizationAdmits) return { kind: 'authority', authority: 'organization_admin' };
	if (command.ownerScope && ownsKey) {
		return { kind: 'result', result: { outcome: 'owner_not_active' } };
	}
	return { kind: 'result', result: { outcome: 'not_found' } };
}

/**
 * Prove the grant receipt against the row it references. Every stored field must
 * still match before a replay may be reported as already granted.
 */
function grantReceiptMetadata(row: GrantReceiptRow): ApiKeyOrganizationGrantMetadata | null {
	const grantedAt: string | null = isoTimestamp(row.grantedAt);
	const storedGrantedAt: string | null = isoTimestamp(row.storedGrantedAt);
	if (
		row.storedId !== row.grantId ||
		row.storedApiKeyId !== row.apiKeyId ||
		row.storedOrganizationId !== row.organizationId ||
		row.storedGrantedOrganizationRole !== row.grantedOrganizationRole ||
		grantedAt === null ||
		storedGrantedAt !== grantedAt
	) {
		return null;
	}
	return grantMetadataFromStored(row);
}

function grantMetadataFromStored(
	row: GrantReceiptRow | GrantRevokeReceiptRow
): ApiKeyOrganizationGrantMetadata | null {
	const grantedAt: string | null = isoTimestamp(row.storedGrantedAt);
	if (
		row.storedId === null ||
		row.storedApiKeyId === null ||
		row.storedOrganizationId === null ||
		row.storedGrantedByUserId === null ||
		grantedAt === null ||
		!isApiKeyGrantingOrganizationRole(row.storedGrantedOrganizationRole)
	) {
		return null;
	}
	if (
		row.storedRevokedByAuthority !== null &&
		!isApiKeyOrganizationGrantRevokeAuthority(row.storedRevokedByAuthority)
	) {
		return null;
	}
	return {
		id: row.storedId,
		apiKeyId: row.storedApiKeyId,
		organizationId: row.storedOrganizationId,
		grantedByUserId: row.storedGrantedByUserId,
		grantedOrganizationRole: row.storedGrantedOrganizationRole,
		grantedAt,
		revokedAt: isoTimestamp(row.storedRevokedAt),
		revokedByUserId: row.storedRevokedByUserId,
		revokedByAuthority: row.storedRevokedByAuthority
	};
}

function grantMetadataFromRow(row: GrantRow): ApiKeyOrganizationGrantMetadata {
	const grantedAt: string | null = isoTimestamp(row.grantedAt);
	if (grantedAt === null || !isApiKeyGrantingOrganizationRole(row.grantedOrganizationRole)) {
		throw new Error('Stored API key grant row is not canonical.');
	}
	if (
		row.revokedByAuthority !== null &&
		!isApiKeyOrganizationGrantRevokeAuthority(row.revokedByAuthority)
	) {
		throw new Error('Stored API key grant revoke authority is not canonical.');
	}
	return {
		id: row.id,
		apiKeyId: row.apiKeyId,
		organizationId: row.organizationId,
		grantedByUserId: row.grantedByUserId,
		grantedOrganizationRole: row.grantedOrganizationRole,
		grantedAt,
		revokedAt: isoTimestamp(row.revokedAt),
		revokedByUserId: row.revokedByUserId,
		revokedByAuthority: row.revokedByAuthority
	};
}
