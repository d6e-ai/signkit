# create-signkit (Cloudflare deployment CLI)

Status: implemented (Cloudflare slice)

Last updated: 2026-09-15

`create-signkit` is the **deployment** CLI. It publishes a GitHub Release of SignKit onto Cloudflare Workers, D1, and R2. Manifest SHA-256 is integrity against the GitHub download, not a cryptographic signature. It is not the Rust SignKit API CLI (`signkit` under `cli/`), which talks to an already-running instance over `/api/v1`.

The two CLIs do not share configuration, credentials, or state. Mixing them is a usage error, not a fallback.

## Syntax

Every command requires an explicit boolean provider flag **before** the command token:

```text
create-signkit --cloudflare <plan|deploy|adopt|upgrade> --account-id <id> [options]
```

Cloudflare is not an implicit default. Invoking a command without `--cloudflare` fails with exit 2. `--node` and `--vercel` are reserved, mutually exclusive with `--cloudflare`, and unimplemented in this slice.

## Commands and the reconciler

All four commands share one idempotent reconciler. The reconciler never deletes Cloudflare resources.

| Command   | Mutations        | Behavior                                                                                                                                                                                                                                                                                                |
| --------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan`    | none             | Resolve a GitHub Release, inspect resources, print the plan. Planned mutation steps keep `mutating: true` but are not executed. Drift is reported in JSON and in human `Drift:` output, not thrown.                                                                                                     |
| `deploy`  | yes              | Create missing D1/R2 only when there is no local state and the remote identity is absent, then follow the deployment sequence. A Worker that already has published versions requires `adopt` first (a secret-only stub with empty versions is allowed).                                                 |
| `adopt`   | local state only | Validate intended existing Worker/D1/R2 and record them in local state. Does not resolve or claim a GitHub release.                                                                                                                                                                                     |
| `upgrade` | yes              | Require recorded local state and existing resources. A no-state upgrade refuses to take over a remote Worker and requires `adopt` first. Identity drift cannot be bypassed with resource flags. Apply pending migrations, re-list and refuse remaining pending, then `versions upload` (no `--domain`). |

Mutating commands require `--yes`.

## Deployment sequence

1. Load XDG state and refuse `state.provider !== cloudflare` before inheriting anything. `upgrade` without local state refuses immediately (adopt first). Resolve the **effective config**. `--account-id` is always required and never inherited. Omitted `--worker-name`/`--d1`/`--r2`/`--domain`/`--public-origin` and safe mail/origin flags inherit from Cloudflare state **before** any Cloudflare inspection. Parser defaults are not treated as a requested identity when state exists.
2. `wrangler whoami --json`: refuse if `--account-id` is not in the session. Errors do not print account names or other account ids.
3. Inspect Worker/D1/R2 using the effective identity (read-only for `plan`). `adopt` stops here: it does not resolve or download a GitHub release.
4. `plan`/`deploy`/`upgrade` resolve a GitHub Release. `plan` remains read-only after that.
5. Resource validation. Required Worker secrets are preflighted **before** creating D1 or R2. Create missing D1/R2 on `deploy` only when local state is absent. If state names a resource that is missing remotely, that is drift (fail closed); do not recreate it.
6. D1 backup/export (`wrangler d1 export --remote`) to `$XDG_STATE_HOME/create-signkit/backups/d1-<name>-<timestamp>.sql`. The timestamp includes milliseconds; if that name already exists, a numeric suffix is added. The backups directory is created with mode `0700` at mkdir time, then chmod `0700`, and the file is chmod `0600` after export (POSIX fail-closed; Windows is best-effort because chmod maps to ACLs). The path is returned and stored as `lastD1BackupPath`. It is never placed under the temp bundle directory and is never deleted by the CLI.
7. Pending D1 migrations only, from the **extracted release** (`wrangler d1 migrations list|apply --remote --config <generated wrangler.jsonc>` with cwd = extracted bundle root so `migrations_dir` is the release tree). Wrangler list output is treated as pending filenames after `Migrations to be applied:` (or none when it prints `No migrations to apply!`). Applied history is not inferred from that command. After a successful apply, migrations are listed again and remaining pending names fail the command. `newlyApplied` is the pre-apply pending list, unioned with existing `state.appliedMigrations`, and the same value is written on success and on smoke failure.
8. Worker upload/deploy with `--keep-vars` and `--strict`. `deploy` may pass `--domain`. `versions upload` does not. Dashboard vars and secrets are preserved; secrets are never deleted by deploy. Upload is a hard failure if Wrangler exits 0 without a labelled Worker/Version ID, aborts, or reports a remote override. A D1 UUID in that output is never treated as the Worker version. The new version id must differ from the previous one. Worker versions are sorted by `createdOn` descending (missing timestamps last, stable original order among equals) before selecting a rollback target.
9. HTTPS smoke check of `GET /api/v1/system/capabilities` on `--public-origin`, implied `https://<domain>`, or the production `{worker-name}.*.workers.dev` origin, with escalating bounded retries (default 1s then 2s) and a per-request AbortSignal timeout. Version-preview URLs are never used as production verification. If no production origin is known, smoke is reported as skipped and the command fails (and may roll back). If this deploy attached a custom domain and that origin is transiently unavailable, the production `workers.dev` origin is checked before final failure so a not-yet-propagated domain does not spuriously roll back a healthy Worker. Hosts are only the validated origins already selected for this run.

Migrations run **before** the new Worker is uploaded so the still-serving previous Worker must keep working on the new schema.

## Migration policy

Released D1 migrations are **additive** and **forward- and backward-compatible within released versions**:

- Forward: a new Worker may assume the schema produced by applying its pending migrations.
- Backward: the previous released Worker must keep running after those migrations are applied, because Worker rollback cannot roll back D1.

A failed HTTPS smoke check rolls the Worker back only when a previous Worker version ID is recorded and `wrangler rollback` succeeds. The CLI never claims that D1 was rolled back. Operators who need SQL restore use D1 Time Travel ([operations/d1-time-travel-restore.md](../operations/d1-time-travel-restore.md)).

## Version resolution

Versions come from GitHub Releases of `d6e-ai/signkit`, never from arbitrary git refs. Tags with semver build metadata (`+build`) are rejected. Manifest `channel` is classified from the tag's semver prerelease component (`v1.2.3-beta.1` is beta; `v1.2.3` is stable), not from a substring match. The tag workflow marks the GitHub Release `prerelease` from that same classification and normalizes the flag both directions on reruns. npm publish uses dist-tag `beta` for prereleases and `latest` for stable, also from that classification. `SIGNKIT_RELEASE_TAG` overrides `GITHUB_REF_NAME` when both are set so CI branch names cannot become the synthetic bundle tag.

- `--version latest --channel stable` uses `/releases/latest` (non-draft, non-prerelease, stable semver tag). A beta/prerelease is refused.
- `--version latest --channel beta` selects the highest valid semver prerelease tag among non-draft releases, independent of GitHub API order. Drafts, stable tags, and invalid/build-metadata tags are ignored. If none exists, the CLI fails rather than selecting a stable release.
- `--version v1.2.3` is an exact tag fetched from `/releases/tags/v1.2.3`. `--channel` is still enforced against the tag, GitHub prerelease metadata, and the manifest channel, so stable never resolves a beta.

Each release must publish `signkit-cloudflare-manifest.json` and a `signkit-cloudflare-<tag>.tar.gz` bundle. The CLI validates schema, repository, tag, commit, size, and SHA-256, and will only download from GitHub release/API hosts with bounded response sizes. SHA-256 in the manifest is transport/repository integrity, not a signature. The npx package does not require this repository or pnpm; it depends on Wrangler and a tar extractor.

## State and secrets

Non-secret deployment metadata is stored in `$XDG_STATE_HOME/create-signkit/state.json` (or `--state`). Safe vars stored there: worker/D1/R2 identity, optional domain, `publicOrigin`, `d6eAuthBaseUrl`, `emailFrom`, `emailFromName`, `lastD1BackupPath`. The file must never contain tokens, passwords, or secret names as keys.

Secrets are never accepted on argv and are never printed. Wrangler runs as `node <packaged wrangler/bin/wrangler.js ...>` with a **minimal env allowlist** (PATH, HOME/platform, locale/TLS/proxy, XDG, Wrangler/Cloudflare auth) plus `CLOUDFLARE_ACCOUNT_ID` and `CI=1`. Parent env is not forwarded. Worker secrets are preflighted by name via `wrangler secret list`. This slice stops with the missing names rather than prompting for values; set them with `wrangler secret put <NAME>` (interactive stdin) or documented environment/stdin channels.

The **initial managed deploy** is `deploy` with no local Cloudflare state, even if `wrangler secret put` already created a Worker stub. That deploy requires `--email-from` and `--public-origin` or `--domain`, and writes every manifest `requiredVars` into the generated config: `SIGNKIT_MAIL_PROVIDER=cloudflare` (fixed), `SIGNKIT_PUBLIC_ORIGIN`, `D6E_AUTH_BASE_URL` (default `https://www.d6e.ai`), `SIGNKIT_EMAIL_FROM`, `SIGNKIT_EMAIL_FROM_NAME` (default `SignKit`). Later deploys/upgrades may inherit those values from state; `--keep-vars` leaves remote vars that are omitted from the generated config. Secrets are preflighted before any D1/R2 create. Secrets are never stored.

Release tarballs accept only regular files and directories. Extraction fails closed if uncompressed regular-file bytes or member count exceed the cap, and rejects link, device, FIFO, and tar extension/PAX members. Bundle paths stay short relative POSIX names so PAX long-link headers are not required.

This CLI does **not** add a bootstrap secret. First-owner claim remains first-authenticated-identity-wins; operators must call `POST /api/v1/instance/bootstrap` before advertising the URL. See [authorization-and-instance-administration.md](authorization-and-instance-administration.md#instance-bootstrap).

## Drift

If local state, an explicit target, and remote identity disagree, mutating `deploy`/`upgrade` refuse. Supplying `--worker-name`/`--d1`/`--r2` that differ from state is still drift. `adopt` is the only command that records the intended existing resources into local state. `plan` reports `drift[]` without mutating, and human non-JSON plan output prints a `Drift:` list.

## Wrangler

create-signkit invokes the Wrangler v4 packaged Node entrypoint as a subprocess. It does not shell out to a globally installed `wrangler` binary. Non-bundle commands (whoami, D1 list/create/export, R2, secret list, versions list/deploy, rollback) run from a fresh empty temp cwd that is deleted after the command, so neither the caller's directory nor `node_modules/wrangler` parent trees can auto-discover a user `wrangler.jsonc`/`.env`. Bundle migration/deploy commands explicitly use the extracted cwd and `--config`. Current flags used: `whoami --json`, `d1 create|list|export`, `d1 migrations list|apply --remote --config <extracted wrangler.jsonc>` (cwd = extracted bundle), `r2 bucket info|create`, `secret list --format json`, `versions list|upload|deploy`, `deploy --keep-vars --strict [--domain]`, `rollback --yes`. `versions upload` is built without `--domain`. Missing-Worker classification for secret/version listing is keyed on `script_not_found` and API codes `10007`/`10006`/`10090` only when those codes appear as `code:`/`[code]`/`(code)` forms, not as bare numbers. Human non-JSON plan/output goes to stdout, including drift; stderr is for errors and warnings. `--json=true` is treated as JSON, including on errors. `upgrade` refuses an explicit `--domain`/`--public-origin` that differs from stored state.
