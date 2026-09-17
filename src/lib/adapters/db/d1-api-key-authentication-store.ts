import { parseApiKeyScopesJson } from '$lib/ports/api-key-store';
import type { ApiKeyScope } from '$lib/security/api-key';
import { API_KEY_RATE_WINDOW_MAX_REQUESTS, API_KEY_RATE_WINDOW_MS } from '$lib/security/api-key';
import type {
	ApiKeyAuthenticationStore,
	AuthenticateApiKeyQuery,
	AuthenticateApiKeyResult
} from '$lib/ports/api-key-authentication-store';

interface AuthenticationRow {
	api_key_id: string;
	key_prefix: string;
	owner_user_id: string;
	scopes_json: string;
	expires_at: string;
}

/**
 * D1 request-path resolution of a `signkit_` bearer token into an instance
 * authority.
 *
 * The whole decision is one statement, so it is one snapshot: a key revocation
 * or an owner suspension committing while this runs is either entirely visible
 * or entirely absent, and a principal can never be assembled from two points
 * in time. Nothing is cached, so revoking the key takes effect on the very
 * next request.
 *
 * The key is found by `token_hash` alone. `key_prefix` is display material that
 * many keys share and is never a lookup term. The plaintext token never reaches
 * this class, and neither the token nor its hash is ever logged.
 *
 * Liveness is expressed as join and predicate conditions rather than as
 * branches over separately fetched rows, which is what makes the opaque
 * outcomes genuinely indistinguishable: an unknown hash, a revoked key, an
 * expired key, and a suspended or missing owner all produce zero rows through
 * the inner join and the WHERE clause, so the store cannot accidentally tell
 * them apart.
 */
export class D1ApiKeyAuthenticationStore implements ApiKeyAuthenticationStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async authenticateApiKey(query: AuthenticateApiKeyQuery): Promise<AuthenticateApiKeyResult> {
		// No LIMIT: the unique token_hash index admits at most one row, so a
		// second row can only mean that invariant has been violated. Reading
		// every row lets that fail closed as an integrity error rather than
		// silently picking an arbitrary one.
		const result: D1Result<AuthenticationRow> = await this.#database
			.prepare(
				`SELECT
					api_key.id AS api_key_id,
					api_key.key_prefix AS key_prefix,
					api_key.owner_user_id AS owner_user_id,
					api_key.scopes_json AS scopes_json,
					api_key.expires_at AS expires_at
				 FROM api_key
				 JOIN instance_member owner
					ON owner.user_id = api_key.owner_user_id
					AND owner.status = 'active'
				 WHERE api_key.token_hash = ?
					AND api_key.revoked_at IS NULL
					AND datetime(api_key.expires_at) > datetime(?)`
			)
			.bind(query.tokenHash, query.at)
			.all<AuthenticationRow>();

		const rows: AuthenticationRow[] = result.results ?? [];
		// Zero rows is the whole opaque set: unknown hash, revoked key, expired
		// key, suspended owner, missing owner.
		if (rows.length === 0) return { outcome: 'invalid_token' };
		// More than one row means the token_hash uniqueness index was bypassed.
		if (rows.length > 1) return { outcome: 'integrity_error' };

		const row: AuthenticationRow = rows[0];
		const scopes: readonly ApiKeyScope[] | null = parseApiKeyScopesJson(row.scopes_json);
		// Stored scopes that are not the canonical serialization are drifted
		// authority, never a reason to proceed with a narrower guess.
		if (scopes === null) return { outcome: 'integrity_error' };

		const recorded: boolean = await this.#recordUse(row.api_key_id, query.at);
		if (!recorded) return { outcome: 'rate_limited' };

		return {
			outcome: 'authenticated',
			principal: {
				apiKeyId: row.api_key_id,
				keyPrefix: row.key_prefix,
				ownerUserId: row.owner_user_id,
				scopes,
				expiresAt: row.expires_at
			}
		};
	}

	async #recordUse(apiKeyId: string, at: string): Promise<boolean> {
		const windowStartCutoff: string = new Date(
			Date.parse(at) - API_KEY_RATE_WINDOW_MS
		).toISOString();
		const result: D1Result = await this.#database
			.prepare(
				`UPDATE api_key
				 SET last_used_at = ?,
					 rate_window_started_at = CASE
						WHEN rate_window_started_at IS NULL OR rate_window_started_at <= ?
						THEN ?
						ELSE rate_window_started_at
					 END,
					 rate_window_count = CASE
						WHEN rate_window_started_at IS NULL OR rate_window_started_at <= ?
						THEN 1
						ELSE rate_window_count + 1
					 END
				 WHERE id = ?
					 AND revoked_at IS NULL
					 AND (
						rate_window_started_at IS NULL
						OR rate_window_started_at <= ?
						OR rate_window_count < ?
					 )`
			)
			.bind(
				at,
				windowStartCutoff,
				at,
				windowStartCutoff,
				apiKeyId,
				windowStartCutoff,
				API_KEY_RATE_WINDOW_MAX_REQUESTS
			)
			.run();
		return (result.meta?.changes ?? 0) === 1;
	}
}
