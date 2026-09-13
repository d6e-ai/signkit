import postgres from 'postgres';
import { parseApiKeyScopesJson } from '$lib/ports/api-key-store';
import type { ApiKeyScope } from '$lib/security/api-key';
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
	grantId: string | null;
	grantOrganizationId: string | null;
	organizationId: string | null;
	organizationName: string | null;
}

/**
 * PostgreSQL request-path resolution of a `signkit_` bearer token into an
 * organization-scoped authority.
 *
 * One statement, therefore one snapshot, therefore no transaction needed: a
 * single `SELECT` already sees a consistent view, so a key revocation, an owner
 * suspension, or a grant revocation committing concurrently is either wholly
 * visible or wholly absent. Nothing is cached, so revocation on either side
 * takes effect on the very next request.
 *
 * The key is found by `token_hash` alone; `key_prefix` is shared display
 * material and never a lookup term. The plaintext token never reaches this
 * class, and neither it nor its hash is ever logged.
 *
 * Liveness lives in the join and predicate rather than in branches over
 * separately fetched rows, so an unknown hash, a revoked key, an expired key,
 * and a suspended or missing owner all collapse to zero rows and cannot be told
 * apart. The grant is a LEFT JOIN so a live key missing only the requested grant
 * still yields one row and earns the distinct grant-required outcome.
 */
export class PostgresApiKeyAuthenticationStore implements ApiKeyAuthenticationStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async authenticateApiKey(query: AuthenticateApiKeyQuery): Promise<AuthenticateApiKeyResult> {
		// No LIMIT: the partial unique index admits at most one live grant per
		// (key, organization), so a second row can only mean that invariant was
		// bypassed. Reading every row lets that fail closed instead of silently
		// picking one.
		const rows = await this.#sql<AuthenticationRow[]>`
			SELECT
				api_key.id AS "apiKeyId",
				api_key.key_prefix AS "keyPrefix",
				api_key.owner_user_id AS "ownerUserId",
				api_key.scopes_json AS "scopesJson",
				api_key.expires_at AS "expiresAt",
				grant_row.id AS "grantId",
				grant_row.organization_id AS "grantOrganizationId",
				organization.id AS "organizationId",
				organization.name AS "organizationName"
			FROM api_key
			JOIN instance_member owner
				ON owner.user_id = api_key.owner_user_id
				AND owner.status = 'active'
			LEFT JOIN api_key_organization_grant grant_row
				ON grant_row.api_key_id = api_key.id
				AND grant_row.organization_id = ${query.organizationId}
				AND grant_row.revoked_at IS NULL
			LEFT JOIN organization
				ON organization.id = grant_row.organization_id
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

		if (row.grantId === null) return { outcome: 'organization_grant_required' };

		const expiresAt: string | null = isoTimestamp(row.expiresAt);
		if (
			expiresAt === null ||
			row.grantOrganizationId !== query.organizationId ||
			row.organizationId !== query.organizationId ||
			row.organizationName === null
		) {
			return { outcome: 'integrity_error' };
		}

		return {
			outcome: 'authenticated',
			principal: {
				apiKeyId: row.apiKeyId,
				keyPrefix: row.keyPrefix,
				ownerUserId: row.ownerUserId,
				organizationId: query.organizationId,
				organizationName: row.organizationName,
				scopes,
				expiresAt
			}
		};
	}
}

function isoTimestamp(value: Date | string): string | null {
	const milliseconds: number = value instanceof Date ? value.valueOf() : Date.parse(value);
	return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}
