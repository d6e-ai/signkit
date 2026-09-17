# create-signkit

Deployment CLI for publishing a SignKit GitHub Release onto Cloudflare Workers (D1 + R2). `plan`, `deploy`, and `upgrade` require online GitHub/Sigstore provenance verification of the exact downloaded bundle before any Cloudflare mutation. This package is **not** the Rust SignKit API CLI (`signkit` under `cli/`).

```sh
npx create-signkit --cloudflare plan --account-id <id>
npx create-signkit --cloudflare deploy --account-id <id> --email-from ops@example.com --domain sign.example.com --bootstrap-owner-email owner@example.com --yes < oauth.json
```

The `--cloudflare` provider flag is required and must appear before the command. There is no implicit Cloudflare default.

Normative architecture: https://github.com/d6e-ai/signkit/blob/main/docs/architecture/create-signkit.md

Operator guide: https://github.com/d6e-ai/signkit/blob/main/docs/create-signkit.md
