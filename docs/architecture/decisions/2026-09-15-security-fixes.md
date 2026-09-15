# Transport, upload, session, and delivery hardening — 2026-09-15

A set of fail-closed hardening changes across the login redirect, the
document upload surface, the operator session cookie, the d6e-auth runtime
configuration, the Rust CLI file I/O, and webhook delivery. Each change
prefers rejecting hostile input over sanitizing it, and none changes the
durable schema: no migration ships with this set, so D1/Postgres parity is
preserved by construction.

## Decision

- Post-login return paths are validated same-origin (`src/lib/server/oauth.ts`).
  Only `path[?query][#hash]` values starting with a single `/` are accepted;
  raw backslashes, ASCII controls, and their percent-encoded forms are
  rejected before URL canonicalization, so no parser quirk can smuggle a
  cross-origin redirect past the check.
- PDF and DOCX uploads accept only raw bodies (`application/pdf` /
  WordprocessingML, plus `application/octet-stream`) with metadata in the
  query string. `multipart/form-data` is rejected with 415 before any
  buffering, because a multipart wrapper cannot preserve the
  stream-then-buffer size bound. Clients, OpenAPI, and handler tests cover
  the raw-body contract, including mid-stream cancellation of chunked bodies
  that exceed the bound.
- The upload PDF parser treats every PDF as hostile and passive-only:
  catalog `/AcroForm` (covering nested `/XFA`), page and annotation `/AA`,
  inherently active annotation subtypes, and any action outside the
  URI/GoTo allowlist are rejected, with `/Next` chains bounded so cyclic
  graphs fail closed. Resolution runs through compressed object streams the
  same way as classic indirect objects.
- The operator session cookie is an explicit-key-ID envelope
  (`base64url(keyId | iv | ciphertext+tag)`) sealed under an HKDF-derived
  subkey with a fixed operator-session AAD tag, so ciphertext from another
  purpose can never be reinterpreted as an operator session. Opening accepts
  only the active or `_PREVIOUS` key, legacy pre-keyring cookies are migrated
  transparently and resealed onto the active format, and oversized or
  malformed cookies fail closed before any AEAD work.
- `D6E_AUTH_BASE_URL` must be a canonical origin: HTTPS for any real host,
  HTTP only for exact loopback hosts in development, with no userinfo, path,
  query, or fragment. Validation errors never echo the configured value.
- Rust CLI file I/O opens paths with `O_NOFOLLOW` in the single `open(2)`
  call and derives every property from the open descriptor, closing the
  check-then-open symlink race; writes keep the overwrite-regular-file UX
  while refusing symlinks, FIFOs, and other non-regular types.
- Webhook endpoints keep default-deny delivery: HTTPS with no credentials or
  fragment, no IP literals or loopback/private hostnames, DNS resolved and
  checked against blocked ranges at create time and rechecked on every
  dispatch through the per-batch DNS cache, with SSRF rejections marked
  non-retryable.
- Organization grants stay durable and explicit: key ownership alone
  authorizes nothing, the organization selector is never inferred, revocation
  of the key or the grant takes effect on the next request (nothing cached),
  and API keys remain refused on management surfaces. See
  `docs/api.md` and
  `architecture/authorization-and-instance-administration.md`.

## Consequences

- Clients must send raw upload bodies; multipart uploads fail with 415.
- PDFs with forms, scripts, embedded files, media annotations, or chained
  actions are rejected at upload even when the viewer would render them.
- Rotating `SESSION_ENCRYPTION_KEY` without setting `_PREVIOUS` first signs
  every operator out; legacy cookies self-migrate on next use.
- `D6E_AUTH_BASE_URL` values with paths, queries, or non-loopback HTTP
  schemes fail fast at startup of the auth path instead of reaching fetch.
