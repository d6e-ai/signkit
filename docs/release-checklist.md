# Release checklist

How to prepare, verify, and publish a SignKit release. Sections 1 to 3 are
local and read-only toward the outside world: no tag is pushed, no GitHub
Release is created, no Docker registry is written to, and nothing is published
to npm. A release is then published either by
`.github/workflows/release-cloudflare-bundle.yml` (section 4) or, when GitHub
Actions cannot run, by a maintainer from one local machine (section 5). Both
paths re-verify everything listed here, publish the same assets, and make the
GitHub Release public only after npm has the matching `create-signkit`.

## 1. Version and changelog

1. Set the same product version in root `package.json` and `cli/Cargo.toml`
   (`[package] version`). The deployment CLI in
   `packages/create-signkit/package.json` is versioned independently because
   npm versions are immutable. The tag workflow validates both semver lines
   and publishes the npm package only when that exact CLI version is absent.
2. Move the `CHANGELOG.md` entry out of `[Unreleased]` into `[<version>] -
YYYY-MM-DD` with the real date. Keep entries in Keep a Changelog style;
   the `Security` section must name the current residual risks, not imply
   they are resolved.
3. Tags are plain semver with a leading `v` and no build metadata:
   `v0.1.0` (stable) or `v0.1.0-beta.1` (beta). Build metadata (`+build`) is
   rejected by `parseReleaseTag`, and the prerelease component alone selects
   both the GitHub prerelease flag and the npm dist-tag (`beta` vs `latest`).
4. Before creating the draft, a repository administrator must confirm GitHub
   immutable releases are enabled. This is an external repository setting and
   is not changed by the local checklist or by the release workflow.
5. Workflow path: create a draft GitHub Release for the new `v*` tag,
   targeting the exact verified `main` commit. Do not publish it. Run the
   `Release` workflow on that same commit with `release_tag` set to the draft
   tag. GitHub creates and locks the tag when the workflow publishes the
   verified draft. Direct tag pushes are intentionally rejected when immutable
   releases are enabled. The maintainer path (section 5) creates the draft
   itself.

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

CI also runs `scripts/test-cli-recipient-e2e.mjs` as a separate real-backend
gate. For a local repeat, build the Node server and debug Rust CLI, then point
`POSTGRES_TEST_URL` only at a disposable loopback PostgreSQL database named
`signkit_cli_e2e` and the `S3_*` variables only at a disposable loopback
S3-compatible bucket named `signkit-cli-e2e`. The script refuses other names
or non-loopback endpoints, creates records and objects, and exercises both
signer and approver CLI completion without a browser. Never aim it at a shared
instance or reuse production credentials.

Then build and verify a synthetic release bundle exactly like CI does. The
`SIGNKIT_RELEASE_TAG` override keeps the branch name out of the tag, and
`GITHUB_SHA` must be a 40-character commit:

```sh
SIGNKIT_RELEASE_TAG=v0.0.0-ci GITHUB_SHA=<40-hex-commit> node scripts/build-cloudflare-release-bundle.mjs
SIGNKIT_RELEASE_TAG=v0.0.0-ci GITHUB_SHA=<40-hex-commit> node scripts/verify-cloudflare-release-bundle.mjs
rm -rf .release
```

To rehearse the complete maintainer release build (section 5) on a branch
after the version bump, use a Docker image name that does not collide with a
real release, then remove its outputs. A rehearsal is marked in its statement,
and `sign`, `npm`, and `publish` refuse it:

```sh
node scripts/release-local.mjs build --tag v<version> --rehearsal --docker-image signkit-rehearsal:v<version>
rm -rf .release && docker image rm signkit-rehearsal:v<version>
```

Confirm `GET /api/v1/system/capabilities` still advertises every endpoint
the release changes (see `docs/api.md` § Capabilities): a new route that the
capabilities document does not list is a docs bug, and a listed route with
no implementation is a release blocker.

## 4. What running the Release workflow does (for awareness, not action)

1. The workflow first verifies that the draft release targets the exact commit
   running the workflow. The `release` job then rebuilds everything (Node bundle
   - smoke test, Cloudflare bundle + verify, Rust `--locked --release` binary,
     Docker image), regenerates a unified `.release/assets/SHA256SUMS` over all
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

## 5. Maintainer-signed release without GitHub Actions

`scripts/release-local.mjs` runs the workflow's release on one Linux x86_64
machine. Instead of a workflow attestation, a pinned maintainer signs the
release with Sigstore keyless signing after a GitHub account sign-in. GitHub's
attestations API stores only GitHub Actions-issued signatures, so the Sigstore
bundle is published as the release asset
`signkit-provenance-<tag>.sigstore.json`, where `create-signkit` reads it. The
other six assets keep the workflow's names, and the signature is not listed in
`SHA256SUMS`, which it signs. The trust model and the exact checks are in
[create-signkit](architecture/create-signkit.md#maintainer-signatures).

Before the first maintainer-signed release:

1. The release owner pins the signing identity in
   `packages/create-signkit/src/release/maintainer-signers.ts` in a reviewed
   commit on `main`: `issuer` is `https://github.com/login/oauth` and `email`
   is the address the maintainer will choose on Sigstore's consent screen,
   byte for byte. Use the account's GitHub noreply address
   (`<user id>+<login>@users.noreply.github.com`) and pick it on the consent
   screen when signing. The account must use two-factor authentication. The
   chosen email becomes public in the Sigstore transparency log and in the
   signature asset. While the list is empty, `sign` refuses to start and
   `create-signkit` rejects every maintainer signature. Each `create-signkit`
   version trusts the list it was built with, so bump `create-signkit` with
   every change to the list.
2. The machine has Node.js 22.18 or later (the workflow uses 24), the pnpm
   version from `packageManager`, a Rust toolchain (the workflow uses 1.88.0),
   Docker, `bash`, `tar`, `gzip`, `sha256sum`, `git`, and `gh`, plus a browser
   for the Sigstore sign-in. The signed statement records the tool versions.
3. `gh` is signed in to an account that can create and edit releases in the
   repository, and `npm` is signed in to an owner of the
   `create-signkit` package with two-factor authentication. The package must
   allow publishing by an interactive owner login.

For each release, after sections 1 to 3 and with the release commit merged:

1. Check out the release commit with a clean tree, `HEAD` equal to a freshly
   fetched `origin/main`, and no local `signkit:v<version>` Docker image.
2. `node scripts/release-local.mjs build --tag v<version>` refuses a dirty
   checkout, `HEAD` other than `origin/main`, a tag that differs from the root
   and Rust CLI versions, or an invalid `create-signkit` version. It deletes
   `.release`, then runs the workflow's build job with `SIGNKIT_RELEASE_TAG`
   and `GITHUB_SHA` set: `pnpm install --frozen-lockfile`, the
   `create-signkit` tests and build, the Node build and smoke check, the
   Cloudflare bundle build and verification, `cargo build --locked --release`,
   and `docker build` plus `docker save`. It writes the same six assets as the
   workflow to `.release/assets`, regenerates and checks `SHA256SUMS`, refuses
   if the build changed the checkout, and writes
   `.release/provenance-statement.json` with every asset as a subject. Review
   the printed digests.
3. `node scripts/release-local.mjs sign --tag v<version>` re-checks the
   checkout and every asset digest, then prints a Sigstore sign-in URL and
   opens it in a browser when one is available (`--no-browser` only prints
   it). Sign in with the pinned GitHub account. The browser returns to a
   one-time `127.0.0.1` address on this machine; when the browser runs on
   another machine, paste the address it was sent to into the terminal. The
   script refuses an account that is not pinned before anything is signed,
   writes `.release/provenance.sigstore.json`, and verifies it with the same
   `create-signkit` code that deployments use.
4. `node scripts/release-local.mjs npm --tag v<version>` verifies the
   signature again and publishes `packages/create-signkit` with the npm CLI
   pinned in root `package.json` and `pnpm-lock.yaml`, with the dist-tag
   derived from its version, only when that exact version is not on npm. npm
   asks for the one-time password. There is no npm provenance on this path.
5. `node scripts/release-local.mjs publish --tag v<version>` runs under the
   `gh` login. It refuses unless GitHub `main` is the signed commit, the tag
   does not exist elsewhere, and npm already has the `create-signkit` version.
   It creates a draft release targeting the commit with the channel's
   prerelease flag (or reuses a draft only when its metadata, target, and
   existing assets match byte for byte) and uploads the missing assets: the six
   built assets and `.release/provenance.sigstore.json` as
   `signkit-provenance-v<version>.sigstore.json`. It then downloads the whole
   draft, compares all seven assets with the upload and the signed statement,
   runs the online `create-signkit` provenance verifier on it (the signature
   asset comes from the authenticated draft download, because a draft has no
   public download URL yet), makes the release public, and resolves the public
   release with `create-signkit`, which now downloads the signature asset
   publicly.
6. Run `create-signkit --cloudflare plan` for the new tag and confirm that both
   human and `--json` output report `maintainer` provenance. Then remove
   `.release` and, if it is not needed, the `signkit:v<version>` image.

Every subcommand accepts `--dry-run`, which runs its checks and prints the
mutations it would perform. Reruns are safe: `build` starts over, `sign`
reuses a signature that still verifies, `npm` skips a published version, and
`publish` reuses byte-identical draft assets, including the signature asset,
while refusing a public release or any mismatch. If `publish` fails before the
release is public, the draft stays private; fix the cause and rerun it. Never
delete and re-create a public release or its tag; cut a patch release.

## Provenance checks after publishing

GitHub stores workflow provenance attestations separately from the release
assets; a maintainer-signed release carries its signature as the release asset
`signkit-provenance-<tag>.sigstore.json`. `create-signkit plan`, `deploy`, and
`upgrade` query the attestations by the downloaded Cloudflare bundle digest,
read the signature asset when the release has one, and require online
GitHub/Sigstore verification before any local recovery-file or Cloudflare
mutation. A release is not deployable if its provenance is missing, invalid,
mixed, ambiguous, unavailable, malformed, or too large. Confirm both human and `--json` plan output report verified provenance
of the expected kind (`workflow` or `maintainer`); `adopt` intentionally omits
it because it does not select a release.
