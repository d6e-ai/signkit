import { parseApiKeyScopesJson } from '$lib/ports/api-key-store';
import type { ApiKeyScope } from '$lib/security/api-key';
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
	grant_id: string | null;
	grant_organization_id: string | null;
	organization_id: string | null;
	organization_name: string | null;
}

/**
 * D1 request-path resolution of a `signkit_` bearer token into an
 * organization-scoped authority.
 *
 * The whole decision is one statement, so it is one snapshot: a key revocation,
 * an owner suspension, or a grant revocation committing while this runs either
 * is entirely visible or entirely absent, and a principal can never be assembled
 * from two points in time. Nothing is cached, so revoking either the key or the
 * grant takes effect on the very next request.
 *
 * The key is found by `token_hash` alone. `key_prefix` is display material that
 * many keys share and is never a lookup term. The plaintext token never reaches
 * this class, and neither the token nor its hash is ever logged.
 *
 * Liveness is expressed as join and predicate conditions rather than as branches
 * over separately fetched rows, which is what makes the opaque outcomes
 * genuinely indistinguishable: an unknown hash, a revoked key, an expired key,
 * and a suspended or missing owner all produce zero rows through the inner join
 * and the WHERE clause, so the store cannot accidentally tell them apart. The
 * grant is a LEFT JOIN precisely so that a live key whose requested grant is
 * missing still returns exactly one row and can be answered with the
 * grant-required outcome instead of being folded into that opaque set.
 */
export class D1ApiKeyAuthenticationStore implements ApiKeyAuthenticationStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async authenticateApiKey(query: AuthenticateApiKeyQuery): Promise<AuthenticateApiKeyResult> {
		// No LIMIT: the partial unique index admits at most one live grant per
		// (key, organization), so a second row can only mean that invariant has
		// been violated. Reading every row lets that fail closed as an integrity
		// error rather than silently picking an arbitrary one.
		const result: D1Result<AuthenticationRow> = await this.#database
			.prepare(
				`SELECT
					api_key.id AS api_key_id,
					api_key.key_prefix AS key_prefix,
					api_key.owner_user_id AS owner_user_id,
					api_key.scopes_json AS scopes_json,
					api_key.expires_at AS expires_at,
					grant_row.id AS grant_id,
					grant_row.organization_id AS grant_organization_id,
					organization.id AS organization_id,
					organization.name AS organization_name
				 FROM api_key
				 JOIN instance_member owner
					ON owner.user_id = api_key.owner_user_id
					AND owner.status = 'active'
				 LEFT JOIN api_key_organization_grant grant_row
					ON grant_row.api_key_id = api_key.id
					AND grant_row.organization_id = ?
					AND grant_row.revoked_at IS NULL
				 LEFT JOIN organization
					ON organization.id = grant_row.organization_id
				 WHERE api_key.token_hash = ?
					AND api_key.revoked_at IS NULL
					AND datetime(api_key.expires_at) > datetime(?)`
			)
			.bind(query.organizationId, query.tokenHash, query.at)
			.all<AuthenticationRow>();

		const rows: AuthenticationRow[] = result.results ?? [];
		// Zero rows is the whole opaque set: unknown hash, revoked key, expired
		// key, suspended owner, missing owner.
		if (rows.length === 0) return { outcome: 'invalid_token' };
		// More than one row means the live-grant uniqueness index was bypassed.
		if (rows.length > 1) return { outcome: 'integrity_error' };

		const row: AuthenticationRow = rows[0];
		const scopes: readonly ApiKeyScope[] | null = parseApiKeyScopesJson(row.scopes_json);
		// Stored scopes that are not the canonical serialization are drifted
		// authority, never a reason to proceed with a narrower guess.
		if (scopes === null) return { outcome: 'integrity_error' };

		if (row.grant_id === null) return { outcome: 'organization_grant_required' };

		// A granted organization with no projection row, or one whose projection
		// disagrees with the grant, contradicts the grant table's own foreign key.
		if (
			row.grant_organization_id !== query.organizationId ||
			row.organization_id !== query.organizationId ||
			row.organization_name === null
		) {
			return { outcome: 'integrity_error' };
		}

		return {
			outcome: 'authenticated',
			principal: {
				apiKeyId: row.api_key_id,
				keyPrefix: row.key_prefix,
				ownerUserId: row.owner_user_id,
				organizationId: query.organizationId,
				organizationName: row.organization_name,
				scopes,
				expiresAt: row.expires_at
			}
		};
	}
}
