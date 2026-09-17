import postgres from 'postgres';
import { parseApiKeyScopesJson } from '$lib/ports/api-key-store';
import type { ApiKeyScope } from '$lib/security/api-key';
import { API_KEY_RATE_WINDOW_MAX_REQUESTS, API_KEY_RATE_WINDOW_MS } from '$lib/security/api-key';
import type {
	ApiKeyAuthenticationStore,
	AuthenticateApiKeyQuery,
	AuthenticateApiKeyResult
} from '$lib/ports/api-key-authentication-store';

interface AuthenticationRow {
	apiKeyId: string;
	keyPrefix: string;
	ownerUserId: string;
	scopesJson: string;
	expiresAt: Date | string;
}

/**
 * PostgreSQL request-path resolution of a `signkit_` bearer token into an
 * instance authority.
 *
 * One statement, therefore one snapshot, therefore no transaction needed: a
 * single `SELECT` already sees a consistent view, so a key revocation or an
 * owner suspension committing concurrently is either wholly visible or wholly
 * absent. Nothing is cached, so revocation on either side takes effect on the
 * very next request.
 *
 * The key is found by `token_hash` alone; `key_prefix` is shared display
 * material and never a lookup term. The plaintext token never reaches this
 * class, and neither it nor its hash is ever logged.
 *
 * Liveness lives in the join and predicate rather than in branches over
 * separately fetched rows, so an unknown hash, a revoked key, an expired key,
 * and a suspended or missing owner all collapse to zero rows and cannot be
 * told apart.
 */
export class PostgresApiKeyAuthenticationStore implements ApiKeyAuthenticationStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async authenticateApiKey(query: AuthenticateApiKeyQuery): Promise<AuthenticateApiKeyResult> {
		// No LIMIT: the unique token_hash index admits at most one row, so a
		// second row can only mean that invariant was bypassed. Reading every
		// row lets that fail closed instead of silently picking one.
		const rows = await this.#sql<AuthenticationRow[]>`
			SELECT
				api_key.id AS "apiKeyId",
				api_key.key_prefix AS "keyPrefix",
				api_key.owner_user_id AS "ownerUserId",
				api_key.scopes_json AS "scopesJson",
				api_key.expires_at AS "expiresAt"
			FROM api_key
			JOIN instance_member owner
				ON owner.user_id = api_key.owner_user_id
				AND owner.status = 'active'
			WHERE api_key.token_hash = ${query.tokenHash}
				AND api_key.revoked_at IS NULL
				AND api_key.expires_at > ${query.at}::timestamptz
		`;

		// Zero rows is the whole opaque set: unknown hash, revoked key, expired
		// key, suspended owner, missing owner.
		if (rows.length === 0) return { outcome: 'invalid_token' };
		if (rows.length > 1) return { outcome: 'integrity_error' };

		const row: AuthenticationRow = rows[0];
		const scopes: readonly ApiKeyScope[] | null = parseApiKeyScopesJson(row.scopesJson);
		// Stored scopes that are not the canonical serialization are drifted
		// authority, never a reason to proceed with a narrower guess.
		if (scopes === null) return { outcome: 'integrity_error' };

		const expiresAt: string | null = isoTimestamp(row.expiresAt);
		if (expiresAt === null) {
			return { outcome: 'integrity_error' };
		}

		const recorded: boolean = await this.#recordUse(row.apiKeyId, query.at);
		if (!recorded) return { outcome: 'rate_limited' };

		return {
			outcome: 'authenticated',
			principal: {
				apiKeyId: row.apiKeyId,
				keyPrefix: row.keyPrefix,
				ownerUserId: row.ownerUserId,
				scopes,
				expiresAt
			}
		};
	}

	async #recordUse(apiKeyId: string, at: string): Promise<boolean> {
		const windowStartCutoff: string = new Date(
			Date.parse(at) - API_KEY_RATE_WINDOW_MS
		).toISOString();
		const updated = await this.#sql<{ id: string }[]>`
			UPDATE api_key
			SET last_used_at = ${at}::timestamptz,
				rate_window_started_at = CASE
					WHEN rate_window_started_at IS NULL
						OR rate_window_started_at <= ${windowStartCutoff}::timestamptz
					THEN ${at}::timestamptz
					ELSE rate_window_started_at
				END,
				rate_window_count = CASE
					WHEN rate_window_started_at IS NULL
						OR rate_window_started_at <= ${windowStartCutoff}::timestamptz
					THEN 1
					ELSE rate_window_count + 1
				END
			WHERE id = ${apiKeyId}
				AND revoked_at IS NULL
				AND (
					rate_window_started_at IS NULL
					OR rate_window_started_at <= ${windowStartCutoff}::timestamptz
					OR rate_window_count < ${API_KEY_RATE_WINDOW_MAX_REQUESTS}
				)
			RETURNING id
		`;
		return updated.length === 1;
	}
}

function isoTimestamp(value: Date | string): string | null {
	const milliseconds: number = value instanceof Date ? value.valueOf() : Date.parse(value);
	return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}
