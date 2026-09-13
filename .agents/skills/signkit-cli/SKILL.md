---
name: signkit-cli
description: Guide for building, configuring, scripting, and operating the agent-first SignKit Rust CLI (signkit), including secure secret handling, JSON output, exit codes, loopback networking, mutations, DOCX import/export, and explicit organization selection.
---

# SignKit CLI

Guide for building, configuring, scripting, and operating the agent-first SignKit Rust CLI (`signkit`). Emphasizes compilation from source, credential hygiene, flexible organization configuration, loopback HTTP rules, and exit code handling.

## Build and Installation

The SignKit CLI is implemented in Rust under `cli/` (requires Rust 1.88.0+ / MSRV 1.88.0).

> [!IMPORTANT]
> There are **no released prebuilt binaries**, **no npm packages** (`npm install signkit` does not exist), and **no `signkit login` commands**. The CLI must be compiled from source using Cargo.

### Compiling from Source

From the repository root:

```sh
cargo build --release --manifest-path cli/Cargo.toml
# Executable located at: cli/target/release/signkit
```

Or from within the `cli/` directory:

```sh
cd cli
cargo build --release
# Executable located at: target/release/signkit
```

Verify build and run mock HTTP integration tests:

```sh
cargo test --manifest-path cli/Cargo.toml
```

## Current Scope & Non-Goals

The CLI strictly respects the current API authorization model:

- **Enabled Operations:** Public capabilities (`signkit capabilities`), API-key `envelopes:read` inspection (`list`, `get`, `draft`, `deliveries`, `completion-artifact`, `audit`, `evidence`, `pdf`, `export-docx`), `drafts:write` authoring (`create`, `commit`, `ready`, `fields`, `import-docx`), and `envelopes:send` (`send`, `void`).
- **Explicit Non-Goals (Do Not Attempt or Invent):**
  - **No Authentication Commands:** There is no `login`, `logout`, or browser exchange command.
  - **No Management Commands:** Key issuance, grant creation, and instance member administration reject API keys and are not in the CLI.
  - **No Recipient Decisions:** `sign`, `approve`, and `decline` remain capability-cookie commands.

## Secret Handling & Credential Hygiene

SignKit API keys must match `^signkit_[A-Za-z0-9_-]{43}$` (51 characters).

- **Accepted Ingestion Channels Only:**
  1. `SIGNKIT_API_KEY` environment variable.
  2. Standard input via `--api-key-stdin` (bounded to 1024 bytes).
- **Caller-Provided Secrets:** Always require caller-provided environment variables or secure standard input. Never hardcode API keys in documentation, scripts, or examples.
- **Strict Prohibitions:**
  - **Never pass keys via CLI flags:** There is no `--api-key` flag. Flags expose secrets in process listings (`ps`).
  - **Never store secrets in configuration files:** Storing keys, tokens, or passwords in `config.toml` causes immediate parse rejection (Exit Code 2).
  - **Do not prefix keys with `Bearer `:** Pass the raw `signkit_...` string. The CLI adds the `Bearer ` header automatically; passing `Bearer signkit_...` fails regex validation.
- **Redaction:** In-memory keys are wrapped in a redaction type; debug formatters output `[REDACTED]`.

## Configuration & Precedence

Non-secret configuration is loaded from:
- `--config <PATH>`
- `SIGNKIT_CONFIG` environment variable
- Default XDG path: `~/.config/signkit/config.toml` (or `$XDG_CONFIG_HOME/signkit/config.toml`)

### Non-Secret `config.toml` Example

```toml
base_url = "https://signkit.example.com"
organization_id = "org_0191b26f-4000-7000-8000-000000000000"
timeout_secs = 30
```

### Forbidden Config Key-Name Matching

The CLI inspects configuration files using the recursive check in `cli/src/config.rs`:
- It inspects TOML table **key names** (`k.to_lowercase()`), never string values or comments.
- A key name triggers immediate hard rejection (Exit Code 2) if:
  - It exactly matches any forbidden key: `api_key`, `apikey`, `api-key`, `token`, `secret`, `password`, `key`, `bearer`, `auth_token`, `signkit_api_key`.
  - Or it contains the substring `secret` or `api_key`.

### Precedence Order

1. CLI flags (`--base-url`, `--org`, `--timeout`)
2. Environment variables (`SIGNKIT_BASE_URL`, `SIGNKIT_ORG` / `SIGNKIT_ORGANIZATION_ID`, `SIGNKIT_TIMEOUT_SECS`)
3. Non-secret config file (`config.toml`)

## Network & Loopback HTTP Rules

- **Mandatory Base URL:** No compiled default exists. Must be supplied via `--base-url`, `SIGNKIT_BASE_URL`, or `config.toml`.
- **Strict HTTPS / Loopback Exception:** Remote endpoints MUST use `https://`. Insecure `http://` is permitted ONLY for loopback hosts:
  - Any address in the IPv4 loopback range (`127.0.0.0/8`, e.g. `127.0.0.1`)
  - IPv6 loopback / localhost (`::1`)
  - The domain name `localhost`
- **Root Path Only:** Base URLs cannot contain path components (e.g. `https://example.com/api` is rejected), user credentials, queries, or fragments.
- **Redirects Refused:** HTTP redirects (3xx) are refused outright (`reqwest::redirect::Policy::none()`) to prevent credential leakage. Refused redirects exit with code 4 (`ForbiddenError`).
- **Bounded Responses:** Responses are capped at 10 MiB to prevent denial-of-service.

## Mandatory Organization Selection

All `signkit envelopes` subcommands require an explicit target organization ID:

- **Source Flexibility:** The organization ID may be supplied via:
  - `--org <ORG_ID>` flag
  - `SIGNKIT_ORG` or `SIGNKIT_ORGANIZATION_ID` environment variables
  - `organization_id` or `org` setting in `config.toml`
- **Format:** 1–200 visible ASCII characters without whitespace (`^[\x21-\x7E]+$`).
- **Never Inferred:** The server never infers an organization from grants or cookies.
- **Capabilities Exception:** `signkit capabilities` sends neither authentication nor organization headers.

## Identifiers & Keyset Pagination

- **Envelope IDs:** Positional `<ENVELOPE_ID>` arguments must be canonical lowercase RFC 9562 UUIDv7 (`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).
- **Pagination Cursor:** `--cursor <CURSOR>` on `signkit envelopes list` must also be a canonical lowercase UUIDv7.
- **Limits:** `--limit <LIMIT>` must be an integer between 1 and 100 (default: 50).

Invalid UUIDv7 values fail locally before network dispatch with Exit Code 2 (`UsageError`).

## Output & Exit Codes

### Output Modes

- **Default:** Versioned JSON envelope to `stdout`:
  ```json
  {
    "version": "1",
    "data": { ... }
  }
  ```
- **Raw Mode (`--raw`):** Emits unadorned API JSON payload directly to `stdout`.
- **Pretty Mode (`--pretty`):** Formats JSON output with indentation.
- **Errors:** Emits RFC 9457 `ProblemDetail` JSON to `stderr`.

### Exit Codes Contract

| Exit Code | Name | Meaning |
| :---: | :--- | :--- |
| `0` | **Success** | Command completed successfully |
| `1` | **GenericError** | Unspecified internal/runtime failure, I/O error, or JSON serialization error |
| `2` | **UsageError** | Invalid arguments, missing org, missing/invalid API key, non-UUIDv7 ID, or forbidden config key name |
| `3` | **AuthenticationError** | HTTP 401: Invalid, expired, or revoked API key, or suspended owner |
| `4` | **ForbiddenError** | HTTP 403: Missing org grant, insufficient scope, forbidden management path; OR refused HTTP redirect (3xx) |
| `5` | **NotFoundError** | HTTP 404: Envelope not found in the authorized organization |
| `6` | **ConflictError** | HTTP 409: State or concurrency conflict |
| `7` | **ValidationError** | HTTP 400, 422, any other unhandled 4xx status, or response body exceeded 10 MiB |
| `8` | **UnavailableError** | HTTP 500, 502, 503, 504, connection refused, network error, or request timeout |

For command syntax examples and shell scripting patterns, see [references/commands.md](references/commands.md). For canonical CLI architecture, see `docs/cli.md`.
