/**
 * Maintainers whose Sigstore keyless signatures `create-signkit` accepts as
 * release provenance when a release was built outside the GitHub Actions
 * release workflow (`scripts/release-local.mjs`).
 *
 * Each entry pins one identity exactly as Fulcio writes it into the signing
 * certificate: the OIDC issuer extension and the email subject alternative
 * name. Only GitHub account sign-in through Sigstore public-good is accepted,
 * so `issuer` is always `https://github.com/login/oauth`, and `email` is the
 * address the maintainer chooses on Sigstore's consent screen (one the GitHub
 * account has verified), compared byte for byte. Maintainers use their GitHub
 * noreply address (`<user id>+<login>@users.noreply.github.com`), which names
 * the account and keeps personal addresses out of the public transparency log.
 *
 * This is the only place maintainer identities are trusted. Identities are
 * added in a separate, reviewed commit and removed to revoke. With an empty
 * list, every maintainer-signed attestation is rejected (fail closed) and only
 * workflow provenance verifies. A release must be built from
 * a commit that already contains the signer, because published create-signkit
 * versions carry the list they were built with.
 */
export const GITHUB_ACCOUNT_OIDC_ISSUER = 'https://github.com/login/oauth';

export interface MaintainerSigner {
	readonly issuer: typeof GITHUB_ACCOUNT_OIDC_ISSUER;
	readonly email: string;
}

export const MAINTAINER_SIGNERS: readonly MaintainerSigner[] = Object.freeze([
	// GitHub account Senna46 (user id 29295263).
	{ issuer: GITHUB_ACCOUNT_OIDC_ISSUER, email: '29295263+Senna46@users.noreply.github.com' },
	// GitHub account kimurayu45z (user id 33382781).
	{ issuer: GITHUB_ACCOUNT_OIDC_ISSUER, email: '33382781+kimurayu45z@users.noreply.github.com' }
]);
