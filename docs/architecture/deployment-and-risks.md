# Deployment and risks

Status: mixed — deployment profiles are supported on Node/Docker and Cloudflare Workers (Vercel is CI-only); the risk list is a living register, not a status claim

## Deployment

`DEPLOY_TARGET` selects `node`, `cloudflare`, or `vercel` at build time. Each target produces a separate artifact; there is no universal runtime build.

Node runs as a non-root user in the supplied multi-stage Docker image. A reverse proxy must preserve the public HTTPS origin used to construct the registered `/auth/callback` URI. Cloudflare uses D1/R2 bindings, `nodejs_compat`, generated binding types, and observability. Production Cloudflare installs are created with `create-signkit --cloudflare` from a GitHub Release ([create-signkit.md](create-signkit.md)); that CLI is distinct from the Rust `signkit` API CLI. Vercel compiles in CI but is not supported for production until its issue is complete.

## Primary risks

- first-user-wins instance bootstrap, closed by default: `POST /api/v1/instance/bootstrap` authorizes on the verified d6e-auth cookie session alone, with no deployment secret gate, so an uninitialized instance would let whichever authenticated identity reaches it first claim the sole `owner` slot. Uninitialized instances therefore fail closed instead: the claim succeeds only when `SIGNKIT_BOOTSTRAP_OWNER_EMAIL` is configured and exactly matches the caller's verified email, or when the local-development-only `SIGNKIT_ALLOW_UNSAFE_FIRST_USER_BOOTSTRAP=true` opt-in applies (Node with `NODE_ENV=development` and a loopback public origin; ignored on Cloudflare Workers, Vercel, production/test/unset runtime modes, and non-loopback origins). Runtime mode and configured origin are independent checks, so a production proxy misconfigured with a loopback origin cannot enable the unsafe path. Anything else is refused with 403 and the empty-instance window stays open. The atomic empty-instance check and idempotency receipt prevent a second claim once one succeeds, and the deploy-time gate decides who may make the _first_ claim at all: with a configured owner email, only that verified d6e-auth identity can claim, so the remaining risk is compromise or misconfiguration of that configured identity (or explicitly enabling every local unsafe signal), not an unauthenticated race. The primary mitigation remains procedural: configure the owner email before the first deploy and claim the initial owner immediately after deploy, before the instance URL is shared or otherwise discoverable (see [deployment.md § Claim the initial owner immediately after deploy](../deployment.md#claim-the-initial-owner-immediately-after-deploy)). The owner email is ordinary configuration, becomes irrelevant once the instance is claimed, and already-claimed instances are unaffected by its value.
- AGPL contamination from copying upstream implementation or distinctive assets.
- authorization bypass between instance members, API-key owners, envelopes, or recipients.
- inconsistent SQL/object pointers during concurrent draft commits.
- Worker exhaustion from large Git archives, DOCX ZIP bombs, PDFs, or fonts.
- leaked recipient links or over-broad agent scopes.
- an API key remaining usable after its owner loses local access; every API-key request therefore rechecks that the owner is still an active instance member.
- audit claims stronger than the actual threat model.
- PDF rendering and CJK font differences across runtimes.
- webhook SSRF, DNS rebinding, secret leakage, or uncontrolled retries. Webhook destinations are additionally deployer-allowlisted (`SIGNKIT_WEBHOOK_ALLOWED_HOSTS`, default deny; exact hosts and explicit wildcard suffixes only), re-evaluated on every creation and every delivery attempt with redirects disabled. Drain resolves each unique hostname once per batch of 25 (fail-closed public-address checks, including IPv4 `224/4`). Residual limitation: this is not a double-resolve detector, so DNS can still change between that lookup and `fetch`. The DoH fallback always checks both A and AAAA records so a blocked IPv6 answer cannot hide behind a public A record. Signing secrets are sealed at rest (`skwhs1_`, D1 0039 / Postgres 0037).
- jurisdiction-dependent electronic-signature requirements.
