# 2026-09-16 — create-signkit secret bootstrap via stdin and recovery file

## Context

The Cloudflare deployment CLI needed first-deploy secrets without ever accepting
them on argv, printing them, or storing them in state/logs. The prior flow —
manual `wrangler secret put` per name, possibly leaving a secret-only Worker
stub — split secret creation across tools, could not be retried deterministically,
and let a stubbed Worker exist before the managed deploy validated anything.

## Decision

- **Pristine initial deploy only**: `deploy` with no local state and no remote
  Worker versions/secrets reads the OAuth pair once from stdin (bounded 16 KiB
  exact-key JSON: exactly `D6E_AUTH_CLIENT_ID` and `D6E_AUTH_CLIENT_SECRET`) and
  creates or reuses a deterministic recovery file at `<state-dir>/recovery.json`
  **before** any Cloudflare mutation.
- **Target binding**: an adjacent non-secret `recovery-binding.json` is created
  exclusively before the recovery file and binds that retained map to the
  selected Cloudflare account and Worker. Retries must match it; an unbound
  existing recovery file is refused rather than silently adopted for another
  target. Both files and their direct parent must be owned by the invoking user
  on POSIX.
- **Recovery file**: flat Wrangler-compatible JSON with exactly the manifest
  taxonomy (`DELIVERY_ENCRYPTION_KEY`, `SESSION_ENCRYPTION_KEY`,
  `DELIVERY_WORKER_SECRET` generated as three independent 32-byte standard
  padded base64 values; OAuth values never generated). Parent `0700`, file
  `0600` from creation, exclusive no-overwrite, symlinks/non-regular files
  refused via lstat, file plus directory fsynced, retained on success and
  failure. Unknown manifest types fail closed pre-mutation with restore
  guidance. Only path and SHA-256 fingerprint are returned or logged.
- **Supported host security model**: recovery bootstrap refuses Windows because
  the CLI cannot enforce the required POSIX owner/mode guarantees there. Linux,
  macOS, and WSL are supported.
- **Upload**: the CLI copies validated values into a `0600` file inside a
  private temporary directory, re-verifies that the retained map still matches
  the reported fingerprint, and passes that staging path as
  `wrangler deploy|versions upload --secrets-file <temporary.json>` alongside
  `--keep-vars --strict --no-bundle`. The child-argv guard allows
  `--config`/`--secrets-file` paths but still rejects secret-bearing flags and
  secret-like values. The generated `wrangler.jsonc` carries top-level
  `secrets.required` derived from the manifest.
- **No stub**: remote Worker versions **or** secrets with no local state are not
  pristine; deploy refuses and directs the operator to `adopt`. Existing,
  adopted, and upgrade flows never create or overwrite retained recovery files.
  `plan` never reads stdin and never creates files.
- **Retry**: a failed initial deploy (D1/R2 exist, no Worker/state) reuses the
  same recovery file on retry without reading OAuth stdin again. If an existing
  deployment is missing a required secret, deploy/upgrade requires the retained
  file and binding. Its temporary upload contains only the missing names, so
  present remote secrets are not reset to older recovery values; the CLI never
  generates or overwrites replacement values.

## Consequences

- Canonical operator flow:
  `create-signkit --cloudflare deploy … --yes < oauth.json`
  where `oauth.json` is a secure two-key file (`0600`, never committed).
- Operators must back up the recovery file together with its binding sidecar;
  loss/corruption fails pre-mutation with the path for restore, never
  overwriting either retained file.
- `wrangler secret list` preflight remains for non-pristine commands.

## Alternatives considered

- Keep manual `wrangler secret put`: rejected — non-atomic, non-retryable, and
  leaves pre-managed Worker state.
- Environment variables for OAuth input: rejected — parent env is not forwarded
  to Wrangler by design, and argv/env channels risk leakage into logs.
