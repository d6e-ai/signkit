# create-signkit Cloudflare deployment CLI — 2026-09-15

SignKit already had three build-time deployment profiles and a Rust API CLI. It did not have a publishable installer that could take a GitHub Release and reconcile Cloudflare Worker/D1/R2 state without cloning this repository.

## Decision

Ship `create-signkit` as an ESM npm package (`npx create-signkit` / `pnpm dlx create-signkit`) whose syntax requires an explicit provider flag before every command: `create-signkit --cloudflare <plan|deploy|adopt|upgrade>`. Cloudflare is not a default. `--node` and `--vercel` are reserved as mutually exclusive provider flags for later slices.

One idempotent reconciler implements all four commands. `plan` is read-only. `deploy` may create missing D1/R2. `adopt` only records existing resources. `upgrade` never creates resources. Nothing deletes.

Releases, not git refs, are the artifact source. Each tagged GitHub Release publishes a schema-validated manifest, SHA-256 checksums for transport/repository integrity (not a signature), and a prebundled Cloudflare tarball (Worker, static assets, D1 migrations). The CLI verifies origin, size, and digest before extraction.

Wrangler is a packaged dependency invoked through its Node entrypoint. Child env is an allowlist, not a copy of the parent process. `CLOUDFLARE_ACCOUNT_ID` is set only in that child environment. Dashboard vars/secrets are preserved with `--keep-vars`. Secrets never appear on argv or in XDG state.

D1 migrations for released versions must be additive and backward-compatible with the previous Worker, because Worker rollback cannot roll back D1. The reconciler exports D1 to a retained XDG-adjacent backups directory, applies pending migrations from the extracted release config (`--config` + extracted cwd), then uploads the Worker, then smoke-checks HTTPS. A failed smoke check may roll back the Worker when a previous version ID is known; it never pretends the database rolled back. Omitted resource flags inherit XDG Cloudflare state before remote inspection; identity drift requires `adopt`. `adopt` does not resolve GitHub Releases or claim the running Worker is a selected tag.

First-owner bootstrap is unchanged: no deployment secret is added in front of `POST /api/v1/instance/bootstrap`.

## Consequences

- Operators can deploy from a release without pnpm or a checkout of this repository.
- A second provider later is a new flag and a new provider module, not a default-change.
- Pre-release D1 baseline rewrites remain a development concern; released versions cannot rewrite applied migrations.
- `plan` stays read-only but describes mutating steps with `mutating: true`. The initial managed deploy (no local state) writes required non-secret vars from `--public-origin`/`--domain`, `--d6e-auth-base-url`, `--email-from`, and `--email-from-name`, even if a `secret put` stub already exists. Missing secrets refuse before creating D1/R2.
