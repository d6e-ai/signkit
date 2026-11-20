/**
 * Maintainers whose Sigstore keyless signatures `create-signkit` accepts as
 * release provenance when a release was built outside the GitHub Actions
 * release workflow (`scripts/release-local.mjs`).
 *
 * Each entry pins one identity exactly as Fulcio writes it into the signing
 * certificate: the OIDC issuer extension and the email subject alternative
 * name. Only GitHub account sign-in through Sigstore public-good is accepted,
 * so `issuer` is always `https://github.com/login/oauth`, and `email` is the
 * verified primary address of that GitHub account, compared byte for byte.
 *
 * This is the only place maintainer identities are trusted. The list ships
 * EMPTY: the release owner adds identities in a separate, reviewed commit
 * before the first maintainer-signed release, and removes them to revoke.
 * While it is empty, every maintainer-signed attestation is rejected (fail
 * closed) and only workflow provenance verifies. A release must be built from
 * a commit that already contains the signer, because published create-signkit
 * versions carry the list they were built with.
 */
export const GITHUB_ACCOUNT_OIDC_ISSUER = 'https://github.com/login/oauth';

export interface MaintainerSigner {
	readonly issuer: typeof GITHUB_ACCOUNT_OIDC_ISSUER;
	readonly email: string;
}

export const MAINTAINER_SIGNERS: readonly MaintainerSigner[] = Object.freeze([]);
