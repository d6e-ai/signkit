# create-signkit operator guide

How to publish a SignKit GitHub Release onto Cloudflare Workers with the `create-signkit` deployment CLI. The normative contract is [architecture/create-signkit.md](architecture/create-signkit.md). This file is the operational companion.

This is **not** the Rust SignKit API CLI. `signkit` (under `cli/`) talks to a running instance. `create-signkit` creates and upgrades the instance.

## Install

```sh
npx create-signkit --help
pnpm dlx create-signkit --help
```

The package depends on Wrangler. You do not need this repository or pnpm. Authenticate Wrangler the usual way (`wrangler login`, or `CLOUDFLARE_API_TOKEN` in the environment). Never pass tokens on the command line.

## Syntax

The provider flag is required and must appear before the command:

```sh
create-signkit --cloudflare plan --account-id <32-hex-account-id>
create-signkit --cloudflare deploy --account-id <id> --email-from ops@example.com --domain sign.example.com --yes
create-signkit --cloudflare adopt --account-id <id> --yes
create-signkit --cloudflare upgrade --account-id <id> --yes
```

Omitting `--cloudflare` exits 2. There is no implicit Cloudflare default.

## Flags

| Flag                  | Meaning                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `--account-id`        | Cloudflare account ID (required; never inherited)                   |
| `--worker-name`       | Worker name (default `signkit` when there is no state)              |
| `--d1`                | D1 name or UUID (default `signkit` when there is no state)          |
| `--r2`                | R2 bucket name (default `signkit-objects` when there is no state)   |
| `--domain`            | Optional custom hostname; implies `https://<hostname>`              |
| `--public-origin`     | Public https origin; must agree with `--domain` when both are set   |
| `--d6e-auth-base-url` | `D6E_AUTH_BASE_URL` (default `https://www.d6e.ai`)                  |
| `--email-from`        | `SIGNKIT_EMAIL_FROM` (required for the initial managed deploy)      |
| `--email-from-name`   | `SIGNKIT_EMAIL_FROM_NAME` (default `SignKit`)                       |
| `--version`           | `latest` or an exact tag such as `v1.2.3`                           |
| `--channel`           | `stable` (default) or `beta`; enforced against the selected release |
| `--state`             | Override the XDG state file                                         |
| `--yes`               | Required for deploy/adopt/upgrade                                   |
| `--json`              | Machine-readable result on stdout                                   |

Omitted worker/D1/R2/domain/origin/mail flags inherit existing XDG state **before** Cloudflare inspection. `SIGNKIT_MAIL_PROVIDER` is always `cloudflare`. Secrets are never accepted on argv.

## First deploy

1. `create-signkit --cloudflare plan --account-id <id>` (resolves a release; read-only)
2. Put required Worker secrets first (interactive stdin; never argv). This may create a Worker stub; it is **not** an initial managed deploy:

   ```sh
   wrangler secret put DELIVERY_ENCRYPTION_KEY --name signkit
   wrangler secret put SESSION_ENCRYPTION_KEY --name signkit
   wrangler secret put DELIVERY_WORKER_SECRET --name signkit
   wrangler secret put D6E_AUTH_CLIENT_ID --name signkit
   wrangler secret put D6E_AUTH_CLIENT_SECRET --name signkit
   ```

   Missing secret names are listed and the command stops **before creating D1 or R2**, rather than prompting for values.

3. `create-signkit --cloudflare deploy --account-id <id> --email-from ops@example.com --domain sign.example.com --yes`

   `--email-from` and `--public-origin` or `--domain` are required whenever local state is absent, including after a secret-put stub. `--public-origin` may be used instead of `--domain`. Both must agree when set together. Subsequent deploys inherit these non-secret vars from state; `--keep-vars` leaves extra remote vars in place.

4. Claim the owner immediately: sign in and `POST /api/v1/instance/bootstrap` before anyone else can. create-signkit does not add a bootstrap secret.

## Adopt and upgrade

If the Worker/D1/R2 already exist, record them without changing Cloudflare and without selecting a GitHub release:

```sh
create-signkit --cloudflare adopt --account-id <id> --worker-name signkit --d1 signkit --r2 signkit-objects --yes
```

Adopt does not store a release tag/commit. Retargeting an identity clears previous Worker version metadata.

Upgrade applies pending D1 migrations, then uploads a new Worker version from the selected release. Omitted resource flags keep the identity recorded in state. Upgrade without local state refuses to take over a remote Worker and requires `adopt` first:

```sh
create-signkit --cloudflare upgrade --account-id <id> --version latest --yes
```

If remote identity drifted from local state, or if you pass resource flags that disagree with state, the CLI refuses. Run `adopt` with the intended flags, then retry. Ordinary `deploy`/`upgrade` cannot retarget around drift.

## Backups

Each mutating deploy/upgrade writes a D1 export under `$XDG_STATE_HOME/create-signkit/backups/` (or beside `--state`) and prints the path. Filenames include millisecond timestamps and a numeric suffix if the same timestamp already exists. On POSIX the directory is created `0700` at mkdir time, then chmod `0700`, and the file is `0600`; chmod failure fails the command. On Windows, chmod is best-effort because the OS uses ACLs rather than Unix modes. The CLI never deletes that file. Worker rollback cannot roll back D1.

If `upgrade` is given an explicit `--domain` or `--public-origin` that differs from stored state, it refuses and tells the operator to use `deploy` or `adopt`. An inherited domain from state is unchanged.

Human non-JSON plan and result text goes to stdout, including a `Drift:` list when plan reports identity drift. stderr is for errors and warnings. `--json` and `--json=true` both emit JSON, including errors.

`--channel` is enforced against the selected GitHub release and its manifest. Channel is classified from the tag's semver prerelease component (`v1.2.3-beta.1` is beta; `v1.2.3` is stable), not from a substring. Tags with build metadata (`+build`) are rejected. `--channel beta` with `--version latest` selects the highest valid semver prerelease among non-draft GitHub releases, not GitHub API order. Drafts, stable tags, and invalid or build-metadata tags are ignored. `--channel stable` never resolves a beta/prerelease. If GitHub has only stable releases, beta latest fails instead of treating a stable release as beta.

The HTTPS smoke check uses escalating backoff (1s, 2s by default) and a bounded per-request timeout. It verifies `--public-origin`, implied `https://<domain>`, or the production `workers.dev` hostname for the Worker name. Version-preview URLs are not production verification; if no production origin is known, smoke is reported as skipped and the command fails. If this deploy attached a custom domain and that origin is transiently unavailable, the production `workers.dev` origin is checked before rollback.

## npm package

The CLI version and HTTP User-Agent come from `packages/create-signkit/package.json`. The published tarball includes `LICENSE` (AGPL). SHA-256 in the release manifest is integrity against GitHub, not a signature.

The first publication of the unscoped `create-signkit` package must use a short-lived npm token or a manual `npm publish` because Trusted Publishing cannot be configured until the package exists. After that, configure npm Trusted Publisher for workflow `.github/workflows/release-cloudflare-bundle.yml` job `publish-npm` and remove the token. The workflow keeps pnpm for workspace installation, installs an isolated npm CLI `>= 11.5.1` via `pnpm exec`, publishes with that same binary via `pnpm exec` (`npm publish`, not `pnpm publish`), still accepts `NODE_AUTH_TOKEN` as a fallback, and never prints it. The git tag `v*` must equal the root `package.json`, `packages/create-signkit/package.json`, and `cli/Cargo.toml` versions alike (the release job checks all three before building any asset; `publish-npm` re-checks them before publishing). Do not publish from a working tree without that tag match. The same semver prerelease classification that marks the GitHub Release also selects the npm dist-tag: prerelease versions publish with `beta`, and stable versions with `latest`, so a beta package cannot replace npm `latest`.

## Rollback

If a smoke check fails, create-signkit rolls the Worker back only when a previous version ID is recorded and Wrangler rollback succeeds. Use [D1 Time Travel](operations/d1-time-travel-restore.md) for SQL restore. Do not treat a Worker rollback as a database rollback.

## State

Default path: `$XDG_STATE_HOME/create-signkit/state.json` (typically `~/.local/state/create-signkit/state.json`). It stores account id, Worker name, D1 name/id, R2 name, optional domain/origin/mail vars, last D1 backup path, release tag/commit, and version ids. It must never contain secrets.

## Distinguishing the CLIs

| CLI              | Package / path       | Talks to                     | Auth                                                |
| ---------------- | -------------------- | ---------------------------- | --------------------------------------------------- |
| `create-signkit` | npm `create-signkit` | Cloudflare + GitHub Releases | Wrangler / `CLOUDFLARE_API_TOKEN` (env, never argv) |
| `signkit`        | `cli/` Rust binary   | SignKit `/api/v1`            | `SIGNKIT_API_KEY` (env or stdin)                    |
