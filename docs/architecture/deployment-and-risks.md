# Deployment and risks

Status: mixed — deployment profiles are implemented (scaffolded); the risk list is a living register, not a status claim

## Deployment

`DEPLOY_TARGET` selects `node`, `cloudflare`, or `vercel` at build time. Each target produces a separate artifact; there is no universal runtime build.

Node runs as a non-root user in the supplied multi-stage Docker image. A reverse proxy must preserve the public HTTPS origin used to construct the registered `/auth/callback` URI. Cloudflare uses D1/R2 bindings, `nodejs_compat`, generated binding types, and observability. Production Cloudflare installs are created with `create-signkit --cloudflare` from a GitHub Release ([create-signkit.md](create-signkit.md)); that CLI is distinct from the Rust `signkit` API CLI. Vercel compiles in CI but is not supported for production until its issue is complete.

## Primary risks

- first-user-wins instance bootstrap: `POST /api/v1/instance/bootstrap` authorizes on the verified d6e-auth cookie session alone, with no deployment secret gate, so whichever authenticated identity reaches an empty instance first claims the sole `owner` slot. The atomic empty-instance check and idempotency receipt prevent a second claim once one succeeds, but they do not prevent the _first_ claim from being made by the wrong person — that is an operational race, not a defect the store can close. The mitigation is procedural: claim the initial owner immediately after deploy, before the instance URL is shared or otherwise discoverable (see [deployment.md § Claim the initial owner immediately after deploy](../deployment.md#claim-the-initial-owner-immediately-after-deploy)).
- AGPL contamination from copying upstream implementation or distinctive assets.
- cross-tenant reads or writes caused by missing organization predicates.
- inconsistent SQL/object pointers during concurrent draft commits.
- Worker exhaustion from large Git archives, DOCX ZIP bombs, PDFs, or fonts.
- leaked recipient links or over-broad agent scopes.
- a durable API key organization grant outliving the d6e organization membership that authorized it: grants are created under a live membership proof but are not automatically retired when the grantor loses their role or the organization changes status, so organization-side revoke is the immediate control and d6e-auth synchronization is a follow-up.
- audit claims stronger than the actual threat model.
- PDF rendering and CJK font differences across runtimes.
- webhook SSRF, DNS rebinding, secret leakage, or uncontrolled retries. Drain resolves each unique hostname once per batch of 25 (fail-closed public-address checks, including IPv4 `224/4`). Residual limitation: this is not a double-resolve detector, so DNS can still change between that lookup and `fetch`. The DoH fallback always checks both A and AAAA records so a blocked IPv6 answer cannot hide behind a public A record. Signing secrets are sealed at rest (`skwhs1_`, D1 0039 / Postgres 0037).
- jurisdiction-dependent electronic-signature requirements.
