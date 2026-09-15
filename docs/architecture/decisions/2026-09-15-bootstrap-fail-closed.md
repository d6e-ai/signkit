# Fail-closed instance bootstrap — 2026-09-15

Uninitialized instances no longer fall back to first-user-wins. `POST
/api/v1/instance/bootstrap` still authorizes on the verified d6e-auth cookie
session alone (with `email_verified: true`), but the claim now succeeds only
when either `SIGNKIT_BOOTSTRAP_OWNER_EMAIL` is configured and exactly matches
the caller's verified email (case-insensitive, trimmed), or the explicit
local-development-only `SIGNKIT_ALLOW_UNSAFE_FIRST_USER_BOOTSTRAP=true`
opt-in applies. Anything else is refused with 403 (`bootstrap-owner-mismatch`
for a configured-but-unmatched address, `bootstrap-owner-required` for an
unconfigured non-local instance) before the store is ever consulted, so the
refused attempt never consumes the single empty-instance window.

## Decision

- The unsafe flag is honored only when explicit and independent development
  signals all agree: `NODE_ENV=development`, no Cloudflare Workers
  `platform.env` (which also covers `wrangler dev`), no Vercel indicator in
  process env, and a `SIGNKIT_PUBLIC_ORIGIN` naming a
  loopback host (`localhost`, `127.0.0.1`, `::1`) — the same loopback
  exception the d6e-auth base-URL validation and the recipient-link
  Secure-cookie handling already use. Runtime mode is not inferred from the
  origin, so a production proxy misconfigured with a loopback origin remains
  closed. A `true` flag anywhere else is ignored.
- The expected email is never echoed: both refusals carry generic problem
  details, and the comparison lives in one gate
  (`src/lib/security/bootstrap-owner-gate.ts`) shared by the D1 (Cloudflare
  `platform.env`) and PostgreSQL (Node/Vercel process env) paths.
- `create-signkit --cloudflare` requires `--bootstrap-owner-email` for
  `deploy` and `upgrade` (explicit flag or recorded state), validates and
  canonicalizes it to trimmed lowercase, and applies it as a non-secret
  Worker var without printing the address. State files written before this
  requirement stay loadable; the first upgrade with one passes the flag once
  and inherits it afterwards. `plan` stays read-only and `adopt` accepts the
  flag optionally.
- The upload PDF policy rejects external `/URI` actions recursively: only
  internal `/GoTo` may remain. A `/URI` entry names an outside URL for the
  viewer to open, so a document carrying one is not passive input.
- Webhook wildcard suffixes must carry at least three labels
  (`*.hooks.example.com` allowed; `*.example.com` and `*.com` rejected), so
  one compromised subdomain cannot stand in for a whole registrable domain.

## Consequences

- Fresh deployments must configure the owner email before the first deploy;
  unconfigured non-local instances stay unclaimed (403) instead of going to
  whoever arrives first. Already-claimed instances are unaffected: bootstrap
  never runs again, so the value is inert for them.
- Local development sets `NODE_ENV=development`,
  `SIGNKIT_ALLOW_UNSAFE_FIRST_USER_BOOTSTRAP=true`, and a loopback origin, or
  configures an owner email like production.
- PDFs with external links are rejected at upload even when the viewer would
  open them in a separate browser.
- Webhook allowlists using two-label wildcards must add a label or switch to
  exact hosts.
