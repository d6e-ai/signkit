# Release checklist (non-publishing)

How to prepare and verify a SignKit release without publishing anything. Every
step below is local and read-only toward the outside world: no tag is pushed,
no GitHub Release is created, no Docker registry is written to, and nothing is
published to npm. Publishing happens only in
`.github/workflows/release-cloudflare-bundle.yml` after a `v*` tag is pushed,
and that workflow re-verifies everything listed here before it attaches any
asset.

## 1. Version and changelog

1. Set the same version in all three versioned packages: root `package.json`,
   `packages/create-signkit/package.json`, and `cli/Cargo.toml` (`[package]
version`). The tag workflow refuses to release when `v<tag>` differs from
   any of them, and `publish-npm` re-checks all three before publishing.
2. Move the `CHANGELOG.md` entry out of `[Unreleased]` into `[<version>] -
YYYY-MM-DD` with the real date. Keep entries in Keep a Changelog style;
   the `Security` section must name the current residual risks, not imply
   they are resolved.
3. Tags are plain semver with a leading `v` and no build metadata:
   `v0.1.0` (stable) or `v0.1.0-beta.1` (beta). Build metadata (`+build`) is
   rejected by `parseReleaseTag`, and the prerelease component alone selects
   both the GitHub prerelease flag and the npm dist-tag (`beta` vs `latest`).
4. Before pushing the tag, a repository administrator must confirm GitHub
   immutable releases are enabled. This is an external repository setting and
   is not changed by the local checklist or by the release workflow.

## 2. Migrations and operations docs

1. `migrations/postgres` applies cleanly to a fresh PostgreSQL 18 database
   and is idempotent on rerun:
   ```sh
   node scripts/postgres-migrate.mjs
   node scripts/postgres-migrate.mjs --check
   ```
   `--check` must report no pending migrations and no checksum drift. It
   writes nothing and is safe with a read-only role.
2. Every schema change has both dialects (`migrations/postgres` and
   `migrations/d1`) plus the matching parity specs, or a written reason why
   it is single-dialect.
3. `docs/operations/` runbooks stay generic: no account, database, bucket,
   Worker, domain, or other instance-specific value. Placeholders only.

## 3. Local verification (no publishing)

Run the same gates CI runs, in this order:

```sh
pnpm install --frozen-lockfile
pnpm run lint
pnpm run check
pnpm run build:create-signkit
pnpm run build:node && pnpm run test:node-build
pnpm run build:cloudflare
pnpm run build:vercel
pnpm run test
pnpm --filter create-signkit test
cd cli && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked && cd ..
```

Then build and verify a synthetic release bundle exactly like CI does. The
`SIGNKIT_RELEASE_TAG` override keeps the branch name out of the tag, and
`GITHUB_SHA` must be a 40-character commit:

```sh
SIGNKIT_RELEASE_TAG=v0.0.0-ci GITHUB_SHA=<40-hex-commit> node scripts/build-cloudflare-release-bundle.mjs
SIGNKIT_RELEASE_TAG=v0.0.0-ci GITHUB_SHA=<40-hex-commit> node scripts/verify-cloudflare-release-bundle.mjs
rm -rf .release
```

Confirm `GET /api/v1/system/capabilities` still advertises every endpoint
the release changes (see `docs/api.md` § Capabilities): a new route that the
capabilities document does not list is a docs bug, and a listed route with
no implementation is a release blocker.

## 4. What pushing the tag does (for awareness, not action)

1. The `release` job rebuilds everything (Node bundle + smoke test,
   Cloudflare bundle + verify, Rust `--locked --release` binary, Docker
   image), regenerates a unified `.release/assets/SHA256SUMS` over all
   assets and verifies it with `sha256sum -c`. A first run uploads missing
   assets to a draft. A rerun refuses a public release, mismatched prerelease
   metadata, unexpected assets, or different bytes under an expected name;
   byte-identical assets are downloaded, verified, and reused without
   replacement. Only after that succeeds does the job generate GitHub build-
   provenance attestations for the verified local files.
2. The `publish-npm` job runs only after `release` succeeds. It uses the exact
   npm CLI version pinned in root `package.json` and `pnpm-lock.yaml` (including
   registry integrity), re-checks tag-equals-version across all
   three packages, derives the dist-tag from the same semver channel
   (`beta` for prereleases, `latest` for stable), and publishes with that
   explicit `--tag` via OIDC Trusted Publishing only, with no token fallback.
   It never runs `pnpm publish`. The package has completed its one-time
   manual first publish, so normal releases use OIDC Trusted Publishing only.
3. The `publish-release` job receives the exact six-name SHA-256 inventory from
   the build job. After npm succeeds and immediately before making the release
   public, it re-reads the draft's asset list, downloads every asset, and refuses
   any missing name, extra name, or byte mismatch.
4. Rollback is per artifact, not atomic: Worker rollback cannot roll back
   D1 (see `docs/create-signkit.md` § Rollback), a Docker image is replaced
   by deploying the previous tag, and npm dist-tags are moved rather than
   unpublishing. Do not delete and re-push a tag to "fix" a release; cut a
   new prerelease or patch version instead.

GitHub stores the provenance attestations separately from the release assets.
They can be verified with a compatible GitHub CLI, but the local release
checks and `create-signkit` do not currently verify them. A policy that makes
attestation verification mandatory at deploy time needs a follow-up issue and
a fail-closed verifier in `create-signkit`; do not describe generation alone as
end-to-end enforcement.
