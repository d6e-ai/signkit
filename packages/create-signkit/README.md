# create-signkit

Deployment CLI for publishing a SignKit GitHub Release onto Cloudflare Workers (D1 + R2). `plan`, `deploy`, and `upgrade` require online GitHub/Sigstore provenance verification of the exact downloaded bundle before any Cloudflare mutation. This package is **not** the Rust SignKit API CLI (`signkit` under `cli/`).

Cloudflare requires the first Worker upload to use complete `wrangler deploy`; later deploys and upgrades explicitly upload and activate the verified Worker version, then reconcile `workers.dev`/custom-domain routing and Cron Triggers before smoke. If the first deploy fails after creating a version, or later trigger reconciliation fails, the CLI records an honest partial-state retry marker without smoke or a Worker-only rollback. A successful retry clears that marker. If smoke later fails or is skipped, the CLI records the coherent active Worker/routes/triggers instead of creating a mismatch with a Worker-only rollback.

```sh
npx create-signkit --cloudflare plan --account-id <id>
npx create-signkit --cloudflare deploy --account-id <id> --email-from ops@example.com --domain sign.example.com --bootstrap-owner-email owner@example.com --yes < oauth.json
```

The `--cloudflare` provider flag is required and must appear before the command. There is no implicit Cloudflare default.

Normative architecture: https://github.com/d6e-ai/signkit/blob/main/docs/architecture/create-signkit.md

Operator guide: https://github.com/d6e-ai/signkit/blob/main/docs/create-signkit.md
