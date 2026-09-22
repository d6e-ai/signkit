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
create-signkit --cloudflare deploy --account-id <id> --email-from ops@example.com --domain sign.example.com --bootstrap-owner-email owner@example.com --yes
create-signkit --cloudflare adopt --account-id <id> --yes
create-signkit --cloudflare upgrade --account-id <id> --yes
```

Omitting `--cloudflare` exits 2. There is no implicit Cloudflare default.

## Flags

| Flag                      | Meaning                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `--account-id`            | Cloudflare account ID (required; never inherited)                                                                                        |
| `--worker-name`           | Worker name (default `signkit` when there is no state)                                                                                   |
| `--d1`                    | D1 name or UUID (default `signkit` when there is no state)                                                                               |
| `--r2`                    | R2 bucket name (default `signkit-objects` when there is no state)                                                                        |
| `--domain`                | Optional custom hostname; implies `https://<hostname>`                                                                                   |
| `--public-origin`         | Public https origin; must agree with `--domain` when both are set                                                                        |
| `--d6e-auth-base-url`     | `D6E_AUTH_BASE_URL` (default `https://www.d6e.ai`)                                                                                       |
| `--email-from`            | `SIGNKIT_EMAIL_FROM` (required for the initial managed deploy)                                                                           |
| `--email-from-name`       | `SIGNKIT_EMAIL_FROM_NAME` (default `SignKit`)                                                                                            |
| `--mail-provider`         | `cloudflare` (default, native Email binding) or `smtp`                                                                                   |
| `--smtp-host`             | SMTP hostname; required with `--mail-provider smtp`                                                                                      |
| `--smtp-port`             | SMTP submission port; required with SMTP, and port 25 is refused                                                                         |
| `--smtp-secure`           | `true` for implicit TLS or `false` for mandatory STARTTLS; required with SMTP                                                            |
| `--smtp-username`         | Optional SMTP username; when present, `SIGNKIT_SMTP_PASSWORD` is read only from secret stdin                                             |
| `--bootstrap-owner-email` | `SIGNKIT_BOOTSTRAP_OWNER_EMAIL` as a non-secret Worker var (required for deploy/upgrade; uninitialized instances fail closed without it) |
| `--version`               | `latest` or an exact tag such as `v1.2.3`                                                                                                |
| `--channel`               | `stable` (default) or `beta`; enforced against the selected release                                                                      |
| `--state`                 | Override the XDG state file                                                                                                              |
| `--yes`                   | Required for deploy/adopt/upgrade                                                                                                        |
| `--json`                  | Machine-readable result on stdout                                                                                                        |

Omitted worker/D1/R2/domain/origin/mail flags inherit existing XDG state **before** Cloudflare inspection. Cloudflare Email is the default, while `--mail-provider smtp` generates SMTP vars and omits the native `EMAIL` binding. Secrets are never accepted on argv.

## First deploy

1. `create-signkit --cloudflare plan --account-id <id>` (resolves and downloads the selected release, verifies its GitHub/Sigstore provenance, and inspects Cloudflare; it never reads stdin, creates deployment/state/recovery files, or mutates Cloudflare. Sigstore may create or refresh its standard per-user TUF trust-metadata cache.)
2. Write the two OAuth credentials to a secure JSON file (mode `0600`, never committed), then redirect it on stdin for the initial deploy. The CLI reads at most 16 KiB, requires exactly `D6E_AUTH_CLIENT_ID` and `D6E_AUTH_CLIENT_SECRET`, and never accepts secret values on argv, prints them, or stores them in state/logs:

   ```sh
   cat > /run/secrets/signkit-oauth.json <<'EOF'
   {"D6E_AUTH_CLIENT_ID":"<id>","D6E_AUTH_CLIENT_SECRET":"<secret>"}
   EOF
   chmod 0600 /run/secrets/signkit-oauth.json
   create-signkit --cloudflare deploy --account-id <id> --email-from ops@example.com --domain sign.example.com --bootstrap-owner-email owner@example.com --yes < /run/secrets/signkit-oauth.json
   ```

   For authenticated SMTP, select it explicitly and include `SIGNKIT_SMTP_PASSWORD` as the third key in the same stdin JSON. The username and non-secret connection settings remain flags; the password never appears on argv:

   ```sh
   create-signkit --cloudflare deploy --account-id <id> --email-from ops@example.com --domain sign.example.com --bootstrap-owner-email owner@example.com --mail-provider smtp --smtp-host smtp.example.com --smtp-port 587 --smtp-secure false --smtp-username signkit --yes < /run/secrets/signkit-smtp.json
   ```

   On a genuinely pristine initial deploy (no local state and no remote Worker versions/secrets), the CLI creates three independent 32-byte base64 values for `DELIVERY_ENCRYPTION_KEY`, `SESSION_ENCRYPTION_KEY`, and `DELIVERY_WORKER_SECRET`, combines them with the stdin OAuth pair and, when configured, the SMTP password into a flat recovery file at `<state-dir>/recovery.json`, and creates an adjacent non-secret binding file for the selected Cloudflare account and Worker (parent `0700`, files `0600` from creation, exclusive no-overwrite, fsynced, retained on success and failure). It rechecks the retained fingerprint while copying the validated values into a private `0600` temporary file for `wrangler deploy --secrets-file`; Wrangler never reopens the retained path after validation. Only the retained path and SHA-256 fingerprint are returned/logged. Windows is refused because the required POSIX ownership and mode guarantees cannot be enforced; use Linux, macOS, or WSL. A retry after a failed initial deploy (D1/R2 exist but no Worker/state) validates the binding and reuses the same file without reading stdin again; a different target is refused. Remote Worker versions/secrets with no local state are not pristine: deploy refuses and tells the operator to `adopt` first. Unknown manifest secret names fail closed before any Cloudflare mutation.

   `--email-from` and `--public-origin` or `--domain` are required whenever local state is absent. `--bootstrap-owner-email` is required for every deploy and upgrade (an explicit flag, or the address recorded in state from a previous run): the CLI validates and canonicalizes it to trimmed lowercase and applies it as a non-secret Worker var, never printing the address. Without it the deployment fails closed before creating anything — an uninitialized instance whose bootstrap endpoint anyone could claim is never produced. `--public-origin` may be used instead of `--domain`. Both must agree when set together. Subsequent deploys inherit these non-secret vars from state; `--keep-vars` leaves extra remote vars in place.

3. Claim the owner immediately: sign in as the configured address and `POST /api/v1/instance/bootstrap` before anyone else can. Only that verified email can claim the empty instance; any other verified caller is refused without consuming the claim. Once claimed, the bootstrap address is inert — later upgrades keep applying it as configuration, but it authorizes nothing further.

Keep the recovery file and its adjacent binding file together in a secure offline backup. If either is lost or corrupted, the CLI fails pre-mutation and names the recovery path so the pair can be restored; the CLI never overwrites either retained file. If an existing deployment is missing required Worker secrets, restore the pair and rerun `deploy` or `upgrade`; create-signkit validates it and stages only the missing names for Wrangler, so present remote values are not reset. Errors and results never contain secret values.

## Adopt and upgrade

If the Worker/D1/R2 already exist, record them without changing Cloudflare and without selecting a GitHub release:

```sh
create-signkit --cloudflare adopt --account-id <id> --worker-name signkit --d1 signkit --r2 signkit-objects --yes
```

Adopt does not store a release tag/commit. Retargeting an identity clears previous Worker version metadata.

Cloudflare requires the [first Worker upload](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/deployment-management/#first-upload) to use complete `wrangler deploy`; `wrangler versions upload` cannot create a Worker. Any Worker with zero published versions uses that path, including resources previously recorded with `adopt`; adoption does not turn a zero-version Worker into a later version upload. If that first command fails, create-signkit re-lists remote versions. It preserves the original failure without new deployment state when no new version exists. If a new version appeared, it stores the release, migrations, backup, observed version, and a non-secret `triggerReconciliationRequired` marker because activation, routes, and Cron Triggers may be partially applied; a retry then uses the explicit sequence below. For every Worker that already has a version, both deploy and upgrade apply pending D1 migrations, upload and activate the selected release's Worker version, and then apply the release's routes and Cron Triggers before the HTTPS smoke check. The generated configuration preserves routing explicitly: no custom domain means `workers_dev: true`; a configured domain means `workers_dev: false` and a `custom_domain` route for that hostname. A trigger update failure fails the command after recording the actually active new Worker version, previous version, release metadata, migrations, backup, and marker. It does not attempt HTTPS smoke or an automatic Worker rollback: that rollback cannot prove or restore route/Cron state when the trigger operation may have been partially applied, so inspect the active routes and Cron Triggers and rerun the command. A successful deploy or upgrade clears the marker. `adopt` preserves it for the same target because adoption does not reconcile triggers; retargeting to a different Worker/D1/R2 identity clears the old target-specific marker. State files written by older versions without this optional marker remain compatible. Omitted resource flags keep the identity recorded in state. Upgrade without local state refuses to take over a remote Worker and requires `adopt` first. Upgrade (like deploy) requires an effective `--bootstrap-owner-email`: pass the flag, or inherit the address recorded in state from a previous run. State files written before this requirement stay loadable, but the first upgrade with one must pass the flag once; after that it is inherited. Adopting an existing deployment accepts an optional `--bootstrap-owner-email` to record alongside the resources. Existing deployments, adopted resources, and upgrades never create or overwrite the recovery file; only a pristine initial deploy does:

```sh
create-signkit --cloudflare upgrade --account-id <id> --version latest --yes
```

To change an existing Cloudflare Email deployment to authenticated SMTP, first provision `SIGNKIT_SMTP_PASSWORD` in that Worker's secret storage, then run `upgrade` with the explicit SMTP flags. The retained recovery file is immutable and is not silently rewritten to add a new operator-supplied credential. Switching provider with a missing password therefore fails before migration or deployment.

If remote identity drifted from local state, or if you pass resource flags that disagree with state, the CLI refuses. Run `adopt` with the intended flags, then retry. Ordinary `deploy`/`upgrade` cannot retarget around drift.

## Backups

Each mutating deploy/upgrade writes a D1 export under `$XDG_STATE_HOME/create-signkit/backups/` (or beside `--state`) and prints the path. Filenames include millisecond timestamps and a numeric suffix if the same timestamp already exists. On POSIX the directory is created `0700` at mkdir time, then chmod `0700`, and the file is `0600`; chmod failure fails the command. On Windows, chmod is best-effort because the OS uses ACLs rather than Unix modes. The CLI never deletes that file. Worker rollback cannot roll back D1.

If `upgrade` is given an explicit `--domain` or `--public-origin` that differs from stored state, it refuses and tells the operator to use `deploy` or `adopt`. An inherited domain from state is unchanged.

Human non-JSON plan and result text goes to stdout, including a `Drift:` list when plan reports identity drift. stderr is for errors and warnings. `--json` and `--json=true` both emit JSON, including errors.

`--channel` is enforced against the selected GitHub release and its manifest. Channel is classified from the tag's semver prerelease component (`v1.2.3-beta.1` is beta; `v1.2.3` is stable), not from a substring. Tags with build metadata (`+build`) are rejected. `--channel beta` with `--version latest` selects the highest valid semver prerelease among non-draft GitHub releases, not GitHub API order. Drafts, stable tags, and invalid or build-metadata tags are ignored. `--channel stable` never resolves a beta/prerelease. If GitHub has only stable releases, beta latest fails instead of treating a stable release as beta.

The HTTPS smoke check uses escalating backoff (1s, 2s by default) and a bounded per-request timeout. It verifies `--public-origin`, implied `https://<domain>`, or the production `workers.dev` hostname for the Worker name. Version-preview URLs are not production verification; if no production origin is known, smoke is reported as skipped and the command fails. A custom domain explicitly disables `workers.dev`, so it is never used as fallback. After either the complete first deploy or the explicit version/trigger sequence succeeds, a failed or skipped smoke check leaves the new Worker version and release routes/Cron Triggers active, records that new version/release in state, and requires operator reconciliation. Neither path performs a Worker-only rollback that would knowingly mismatch code and triggers. Because the deployment sequence successfully reconciled triggers before smoke, it clears an inherited `triggerReconciliationRequired` marker even when smoke then fails or is skipped.

## npm package

The CLI version and HTTP User-Agent come from `packages/create-signkit/package.json`. The published tarball includes `LICENSE` (AGPL). SHA-256 in the release manifest is an integrity check, while GitHub/Sigstore provenance is the independent publisher identity check. `plan`, `deploy`, and `upgrade` all download the exact bundle once and require online verification of its official repository, workflow, release tag/ref, source commit, subject name/digest, and SLSA workflow provenance before any recovery-file or Cloudflare mutation. Stable and beta use the same policy. Missing, invalid, ambiguous, unavailable, malformed, or oversized provenance fails closed. JSON output includes a `provenance` object; human output prints one verified provenance line. `adopt` does not resolve a release and omits it.

The first publication of the unscoped `create-signkit` package must use a short-lived npm token or a manual `npm publish` because Trusted Publishing cannot be configured until the package exists. After that one-time initial manual publish, the workflow publishes via OIDC Trusted Publishing only, with no token fallback. The workflow keeps pnpm for workspace installation, installs the exact npm CLI version committed in root `package.json` and `pnpm-lock.yaml`, verifies the selected binary reports that exact version, and publishes through it (`npm publish`, not `pnpm publish`). The frozen pnpm lock supplies registry integrity; the privileged job never dynamically resolves an npm range. The product tag must equal the root package and Rust CLI versions. `create-signkit` has an independent npm version; the release workflow validates it as semver and publishes it only when that exact version is not already present. Do not publish from a working tree without those checks. The package version's prerelease component selects the npm dist-tag (`beta` or `latest`) independently of the product release tag.

## Rollback

If smoke fails or is skipped after complete `deploy`, or after `upgrade` has successfully applied routes and Cron Triggers, create-signkit does not attempt a Worker-only rollback. State and output retain the actually active new version; upgrade also reports the applied trigger mutation. Inspect and reconcile both surfaces before retrying. Use [D1 Time Travel](operations/d1-time-travel-restore.md) for SQL restore. A Worker-only rollback could not restore the matching route, trigger, or database state.

## State

Default path: `$XDG_STATE_HOME/create-signkit/state.json` (typically `~/.local/state/create-signkit/state.json`). It stores account id, Worker name, D1 name/id, R2 name, optional domain/origin/mail vars, the canonicalized bootstrap owner email, last D1 backup path, release tag/commit, D1 schema epoch, version ids, and the optional non-secret `triggerReconciliationRequired` partial-state marker. It must never contain secrets. A release with a different schema epoch cannot upgrade a populated D1 in place; recreate and adopt a fresh D1 first.

## Distinguishing the CLIs

| CLI              | Package / path       | Talks to                     | Auth                                                |
| ---------------- | -------------------- | ---------------------------- | --------------------------------------------------- |
| `create-signkit` | npm `create-signkit` | Cloudflare + GitHub Releases | Wrangler / `CLOUDFLARE_API_TOKEN` (env, never argv) |
| `signkit`        | `cli/` Rust binary   | SignKit `/api/v1`            | `SIGNKIT_API_KEY` (env or stdin)                    |
