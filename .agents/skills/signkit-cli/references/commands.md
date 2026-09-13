# SignKit CLI Command Reference

This document provides detailed usage syntax, configuration details, and script integration patterns for the SignKit Rust CLI (`signkit`).

## Global Options

Every command accepts the following global options:

- `--base-url <URL>`: Service base URL. Required if not configured via `SIGNKIT_BASE_URL` or configuration file. Remote endpoints must use HTTPS; insecure HTTP is permitted for loopback hosts (the `127.0.0.0/8` IPv4 range, `localhost`, and `::1`).
- `--org <ORG_ID>`: Target organization ID (required for all `envelopes` subcommands; 1–200 visible ASCII characters). Alternatively supplied via `SIGNKIT_ORG`, `SIGNKIT_ORGANIZATION_ID`, or `organization_id` / `org` in `config.toml`.
- `--api-key-stdin`: Read the raw API key from standard input rather than `SIGNKIT_API_KEY` (bounded to 1024 bytes).
- `--config <PATH>`: Path to non-secret configuration file.
- `--timeout <SECONDS>`: Request timeout in seconds (default: 30, must be > 0).
- `--raw`: Emit unadorned API response JSON directly to stdout without the `{"version": "1", "data": ...}` envelope.
- `--pretty`: Format JSON output with indentation.

---

## Command Reference

### 1. `signkit capabilities`

Reads runtime profile, feature flags, and dynamic authorization settings. Completely unauthenticated (sends no credentials or organization headers).

```sh
signkit --base-url "$SIGNKIT_BASE_URL" capabilities
```

Output is emitted inside the CLI version envelope (`{"version": "1", "data": ...}`). For the complete capabilities schema, query the command directly or consult `docs/api.md`.

---

### 2. `signkit envelopes list`

Lists envelopes in the authorized organization using keyset cursor pagination.

**Options:**
- `--limit <LIMIT>`: Number of envelopes per page (1..=100, default: 50).
- `--cursor <CURSOR>`: Pagination cursor from previous page's `nextCursor` (canonical lowercase RFC 9562 UUIDv7).

**Invocation with Environment Variables:**
```sh
# Requires caller-provided SIGNKIT_API_KEY in the environment:
signkit --base-url "$SIGNKIT_BASE_URL" --org "$SIGNKIT_ORG" envelopes list --limit 25
```

**Invocation with Secure Stdin:**
```sh
printf "%s" "$CALLER_API_KEY" | signkit \
  --base-url "$SIGNKIT_BASE_URL" \
  --org "$SIGNKIT_ORG" \
  --api-key-stdin \
  envelopes list --limit 25
```

---

### 3. `signkit envelopes get <ENVELOPE_ID>`

Reads metadata for a specific envelope. `<ENVELOPE_ID>` must be a canonical lowercase RFC 9562 UUIDv7.

```sh
signkit --base-url "$SIGNKIT_BASE_URL" --org "$SIGNKIT_ORG" \
  envelopes get 0191b26f-4000-7000-8000-000000000001
```

---

### 4. `signkit envelopes draft <ENVELOPE_ID>`

Reads the draft workspace snapshot, Git generation, and tracked documents (`documents/*.md`).

```sh
signkit --base-url "$SIGNKIT_BASE_URL" --org "$SIGNKIT_ORG" \
  envelopes draft 0191b26f-4000-7000-8000-000000000001
```

---

### 5. `signkit envelopes deliveries <ENVELOPE_ID>`

Reads invitation outbox delivery statuses for an envelope.

```sh
signkit --base-url "$SIGNKIT_BASE_URL" --org "$SIGNKIT_ORG" \
  envelopes deliveries 0191b26f-4000-7000-8000-000000000001
```

---

### 6. `signkit envelopes completion-artifact <ENVELOPE_ID>`

Reads completion artifact publication status: `published`, `pending`, `processing`, `failed`, or `not_completed`. `signkit envelopes audit` is an alias of this status read.

```sh
signkit --base-url "$SIGNKIT_BASE_URL" --org "$SIGNKIT_ORG" \
  envelopes completion-artifact 0191b26f-4000-7000-8000-000000000001
```

---

### 7. `signkit envelopes evidence <ENVELOPE_ID>`

Downloads published immutable completion evidence (`GET .../evidence`). `--format json` (default) or `--format markdown`. `--output PATH` writes a regular file (refusing symlinks) and prints a JSON receipt; `--output -` writes bytes to stdout.

```sh
signkit --base-url "$SIGNKIT_BASE_URL" --org "$SIGNKIT_ORG" \
  envelopes evidence 0191b26f-4000-7000-8000-000000000001 \
  --format markdown --output ./evidence.md
```

---

### 8. `signkit envelopes pdf <ENVELOPE_ID>`

Downloads the published visual completion PDF (`GET .../pdf`). `--output PATH` writes a regular file (refusing symlinks) and prints a JSON receipt; `--output -` writes bytes to stdout.

```sh
signkit --base-url "$SIGNKIT_BASE_URL" --org "$SIGNKIT_ORG" \
  envelopes pdf 0191b26f-4000-7000-8000-000000000001 \
  --output ./completion.pdf
```

---

### 9. `signkit envelopes import-docx <ENVELOPE_ID>`

Converts a bounded DOCX file into one Markdown draft commit (`drafts:write`). Reads a regular file or stdin (`--file`, default `-`), refuses symbolic links, and caps input at 20 MiB. Requires `--target-path documents/....md`, `--expected-generation`, and `Idempotency-Key` (generated when omitted). Secrets are never accepted as flags.

```sh
signkit --base-url "$SIGNKIT_BASE_URL" --org "$SIGNKIT_ORG" \
  envelopes import-docx 0191b26f-4000-7000-8000-000000000001 \
  --file ./agreement.docx --target-path documents/agreement.md --expected-generation 0
```

---

### 10. `signkit envelopes export-docx <ENVELOPE_ID>`

Downloads the pinned revision as WordprocessingML (`envelopes:read`). `--output PATH` writes a regular file (refusing symlinks) and prints a JSON receipt; `--output -` writes DOCX bytes to stdout.

```sh
signkit --base-url "$SIGNKIT_BASE_URL" --org "$SIGNKIT_ORG" \
  envelopes export-docx 0191b26f-4000-7000-8000-000000000001 \
  --output ./agreement.docx
```

---

## Non-Secret Configuration File

Default location: `~/.config/signkit/config.toml` (or specified via `--config <PATH>` or `SIGNKIT_CONFIG`).

```toml
# Non-secret configuration only
base_url = "https://signkit.example.com"
organization_id = "org_12345"
timeout_secs = 30
```

The alias `org` is also accepted:
```toml
org = "org_12345"
```

### Forbidden Key-Name Matching

The CLI parses TOML and inspects table **key names** recursively (`k.to_lowercase()`) in `cli/src/config.rs`. Storing credentials triggers immediate exit with code 2 (`UsageError`):

- **Forbidden Key Names:** `api_key`, `apikey`, `api-key`, `token`, `secret`, `password`, `key`, `bearer`, `auth_token`, `signkit_api_key`.
- **Substring Matches:** Any key name containing `secret` or `api_key`.
- **Scope:** Key names only. String values and comments are not searched for forbidden keywords.

---

## Scripting Integration & Exit Codes

When scripting `signkit`, inspect process exit codes to branch on specific error categories:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Assumes SIGNKIT_BASE_URL, SIGNKIT_ORG, and SIGNKIT_API_KEY
# are provided by the caller's environment.

output=$(signkit envelopes list --raw 2>/tmp/signkit_err.json) || exit_code=$?

case "${exit_code:-0}" in
  0)
    echo "Success:"
    echo "$output" | jq .
    ;;
  2)
    echo "Usage / validation error (e.g. invalid UUIDv7, missing org, forbidden config key):" >&2
    cat /tmp/signkit_err.json >&2
    exit 2
    ;;
  3)
    echo "Authentication failure (HTTP 401: invalid or expired API key):" >&2
    cat /tmp/signkit_err.json >&2
    exit 3
    ;;
  4)
    echo "Forbidden / redirect refused (HTTP 403 or refused HTTP redirect):" >&2
    cat /tmp/signkit_err.json >&2
    exit 4
    ;;
  5)
    echo "Resource not found (HTTP 404: envelope not found in authorized org):" >&2
    cat /tmp/signkit_err.json >&2
    exit 5
    ;;
  6)
    echo "Conflict (HTTP 409: state or concurrency conflict):" >&2
    cat /tmp/signkit_err.json >&2
    exit 6
    ;;
  7)
    echo "Validation error (HTTP 400, 422, unhandled 4xx, or response > 10 MiB):" >&2
    cat /tmp/signkit_err.json >&2
    exit 7
    ;;
  8)
    echo "Service unavailable or network timeout (HTTP 5xx, timeout, connection refused):" >&2
    cat /tmp/signkit_err.json >&2
    exit 8
    ;;
  *)
    echo "Unexpected error (exit code $exit_code):" >&2
    cat /tmp/signkit_err.json >&2
    exit "$exit_code"
    ;;
esac
```
