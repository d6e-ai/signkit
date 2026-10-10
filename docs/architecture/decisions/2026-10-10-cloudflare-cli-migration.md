# 2026-10-10: adopt the Cloudflare CLI with narrow compatibility fallbacks

Status: accepted

## Context

SignKit used Wrangler for local builds, bindings, CI, and its managed release installer. Cloudflare now provides the broader official `cf` CLI, but its pinned beta has framework-detection and local D1 limitations observed against this repository. A tool migration must not weaken secret handling, resource identity checks, release provenance, backups, or partial-failure recovery.

## Decision

Adopt `cf@1.0.0-beta.14` with pnpm and typed root configuration. Build with cf's supported Wrangler backend into Cloudflare Build Output, then deploy prebuilt bytes. Keep SvelteKit at the repository root and isolate only the beta's framework detection in a temporary build context. Generate binding/runtime types during setup and checks instead of committing generated declarations.

The v1 release archive remains compatible with existing installers. Its legacy config is derived from validated cf output, while its Worker and asset bytes are copied without rebundling. The installer exposes a tool-neutral Cloudflare port; commands without proven parity retain explicit, tested Wrangler fallbacks. Account/D1/R2 discovery, remote migrations, secret-name inspection, and exact-version traffic publication use cf; their old implementations are removed with the final caller.

Retain Wrangler for local D1 until a pinned cf version can apply every SignKit migration and exit cleanly. On the pre-integration local baseline, cf failed with `SQLITE_LOCKED` at migration 0045 while Wrangler succeeded. After integrating current main, Wrangler also passed the full current migration set and a no-pending-migrations check. This is a CLI compatibility boundary, not permission to rewrite previously released SQL or to substitute a remote migration.

## Consequences

- Operators use cf-facing build, type, and deployment commands, but Wrangler remains a backend/compatibility dependency.
- Node.js 22.18 is the minimum for typed config loading.
- CI validates prebuilt deployment without credentials and keeps real local D1 coverage.
- Current normative details live in [cloudflare-tooling.md](../cloudflare-tooling.md) and [create-signkit.md](../create-signkit.md).
- The beta pin and compatibility fallbacks require deliberate revalidation before upgrading; this decision does not claim that cf replaces every Wrangler feature today.
