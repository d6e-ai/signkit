# Cloudflare tooling

Status: implemented, with explicit beta compatibility boundaries

Last updated: 2026-10-10

## Tool boundary

The official Cloudflare CLI `cf` is pinned to `1.0.0-beta.14` through pnpm. Typed configuration requires Node.js 22.18 or newer. This tooling change does not change SignKit's database schema, application ports, authorization, storage keys, or Node/Vercel deployment profiles.

`cloudflare.config.ts` owns the scheduled Worker's runtime metadata: bindings, compatibility settings, observability, and cron. `wrangler.config.ts` contains only the cf Wrangler build-backend options. SvelteKit remains at the repository root.

The JSONC files are compatibility profiles, not new sources of deployment policy:

- `wrangler.build.jsonc` is the SvelteKit adapter's build profile; the adapter still requires Wrangler-compatible configuration.
- `wrangler.jsonc` is retained for local D1 migrations and legacy operator commands. Its shared settings are checked against the typed configuration.
- Release archives retain their v1 `wrangler.jsonc` member for existing installers. It is generated from validated cf Build Output, not used to rebuild the application.

## Build and publication

`pnpm run build:cloudflare` first builds SvelteKit, then packages the scheduled entrypoint through `cf build`. The pinned beta misdetects applications in this pnpm workspace: it cannot select the root SvelteKit application reliably and identifies the CLI package as a separate framework. The build wrapper therefore creates a private temporary tool-only context, imports both root configs, and overrides only entrypoint/assets paths. It neither moves the application nor changes the pnpm workspace graph.

The cf process receives an explicit environment allowlist, no credential variables or application secrets. It builds only; it does not authenticate, provision resources, migrate a remote database, or upload a Worker. Complete Build Output is copied to `.cloudflare/output/v0` before the temporary context is removed. Deployment consumes it with `cf deploy --prebuilt`, avoiding framework detection and preserving the built bundle. Release packaging validates it with the official Build Output reader and retains exact bundle/assets bytes.

The beta has no typed `keep-vars` switch. Upload metadata explicitly preserves existing `plain_text`, `json`, `secret_text`, and `secret_key` bindings, so omitted dashboard variables and existing secrets are not discarded. A source deployment is a lower-level cf workflow: when a D1 binding has only a name, cf may resolve or provision that resource. Set `SIGNKIT_D1_DATABASE_ID` before building to pin an existing database. Managed release installations use the installer's stricter resource identity and adoption checks instead.

`pnpm run cf:typegen` writes `.cloudflare/types/index.d.ts`. `prepare` and `check` regenerate this ignored file before SvelteKit consumes it. Generated runtime types are not committed. An installation using `--ignore-scripts` must run `pnpm run prepare` before building, or `pnpm run check` before type checking.

## Compatibility limits and verification

Local D1 remains on `wrangler d1 migrations apply --local`. An actual cf beta.14 run on the pre-integration local baseline failed with `SQLITE_LOCKED` on the table rebuild in migration 0045; local migration listing printed its results but did not exit. Wrangler has also applied the full current migration set to a fresh local database, followed by a no-pending-migrations check. The adapter/config remains in place until a pinned cf version passes those same full-schema and clean-exit gates. No silent fallback to remote D1 is allowed.

The managed release installer has a separate Cloudflare command port; its cf-native operations and remaining fallbacks are specified in [create-signkit.md](create-signkit.md). A successful offline build or dry run is not a live deployment or provider acceptance claim.

Verification gates include type generation, application checks, Node/Cloudflare/Vercel builds, environment/config contract tests, release bundle verification, `cf deploy --prebuilt --dry-run`, and real local Wrangler D1 application. An offline protocol test runs the actual pinned cf executable against a synthetic loopback API, with only fake credentials and documented response envelopes, checking resource JSON, secret-name inspection, exact-version 100% traffic publication, and noninteractive remote-migration command behavior. Its SQLite-backed query fixture starts without a migration ledger, executes cf's emitted SQL, and checks ledger creation, applied names, and the post-apply empty pending list. It is not a Cloudflare-hosted D1 test; this and mocked provider/provenance tests do not prove real account permissions or deployment.

## Retiring compatibility paths

Remove each Wrangler path in the same change that migrates its final caller. Delete unused implementations, helpers, types, tests, operator instructions, configuration, and direct dependencies together; do not retain a second implementation for already migrated operations. Account discovery, D1 create/list/migrations, R2 inspection/creation, Worker secret-name inspection, and exact-version traffic publication now have only cf implementations in the installer.

- Retire the local D1 fallback after cf passes the full fresh-database migration set, no-op replay, and clean-exit checks described above.
- Retire managed Worker and D1 export fallbacks after their replacement passes the install/upgrade/backup/partial-failure reconciliation gates in [create-signkit.md](create-signkit.md). The active lifecycle publishes versions and reconciles routes/Cron Triggers; obsolete Worker-only rollback code is removed.
- Remove root Wrangler configuration and dependencies only when the SvelteKit adapter, cf build backend, local D1 commands, and test imports no longer require them. Keep historical ADRs and already published release archives unchanged.

For current upstream behavior, see the official [cf overview](https://developers.cloudflare.com/cf/), [Wrangler migration guide](https://developers.cloudflare.com/cf/wrangler/migrate/), and [project commands](https://developers.cloudflare.com/cf/projects/).
