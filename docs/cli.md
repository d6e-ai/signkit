# SignKit Rust CLI (`signkit`)

Production-quality, agent-first Rust CLI for SignKit located under `cli/` (requires Rust 1.88.0+ / MSRV 1.88.0).

## Architecture & Current Truth

The SignKit CLI is designed for non-interactive and machine-automated workflows. It adheres strictly to the current authorization reality documented in [api.md](api.md) and [architecture/](architecture/README.md):

- **Enabled surface:** API-key Bearer authentication with `envelopes:read`, `drafts:write`, and `envelopes:send` on the HTTP commands listed by `GET /api/v1/system/capabilities`, plus public system capabilities.
- **Unavailable operations (by design):**
  - **API-key and instance management** (`/api/v1/api-keys/**`, `/api/v1/instance/**`) reject API keys outright with HTTP 403 `api-key-not-permitted` to prevent self-escalation.
  - Recipient sign/approve/decline remain capability-cookie commands and are not in the CLI.

## Credentials & Security Boundaries

1. **No compiled fallback base URL & strict URL validation:**
   - There is no hardcoded default base URL. Base URL is mandatory and must be supplied via `--base-url <URL>`, `SIGNKIT_BASE_URL`, or a non-secret configuration file.
   - Base URLs are parsed strictly with `url::Url`.
   - **HTTPS is required** for all remote hosts. Plain HTTP is strictly prohibited except for exact loopback hosts (`localhost`, `127.0.0.1`, `::1`).
   - Base URLs containing user credentials (`user:pass@`), query parameters (`?query`), fragments (`#frag`), or non-root paths (`/api`) are rejected immediately before any network request is issued.
   - All endpoint URLs are constructed safely via `Url::join`.
2. **API key validation & redaction:**
   - API keys must match the exact regex `^signkit_[A-Za-z0-9_-]{43}$` (total length 51 bytes). Validation occurs locally before any network dispatch.
   - The CLI does not accept or strip a `Bearer ` prefix.
   - API keys cannot be provided as command-line flags. They are accepted solely via the `SIGNKIT_API_KEY` environment variable or bounded standard input (`--api-key-stdin`, capped at 1024 bytes).
   - In-memory keys are wrapped in a redaction newtype whose `Debug` formatting strictly renders `[REDACTED]`.
3. **Identifier validation:**
   - Envelope IDs and list pagination cursors are validated as canonical lowercase RFC 9562 UUIDv7 strings before network dispatch (`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`). Uppercase hex or non-v7 UUIDs fail fast with exit code 2 (`UsageError`).
4. **Mandatory explicit organization selection:**
   - Every envelope operation requires an explicit organization (`SignKit-Organization-Id` header).
   - The organization is never inferred from defaults or cookies. It must be specified via `--org <ORG_ID>`, the `SIGNKIT_ORG` / `SIGNKIT_ORGANIZATION_ID` environment variables, or a non-secret configuration file. Empty string aliases fall through cleanly to secondary configuration sources.
   - Public commands like `signkit capabilities` do not send `Authorization` or `SignKit-Organization-Id` headers even if configured.
5. **Strict redirect policy (`none`):**
   - HTTP redirects (3xx) are refused outright (`reqwest::redirect::Policy::none()`). This eliminates the risk of `Authorization` credentials leaking to external or unencrypted endpoints.
6. **Bounded responses & timeouts:**
   - Response bodies are streamed with an enforced ceiling (10 MiB) to prevent denial-of-service or memory exhaustion.
   - Configurable timeout (default 30 seconds via `--timeout` or `SIGNKIT_TIMEOUT_SECS`; timeout of 0 is rejected).
   - Fixed `User-Agent` (`signkit-cli/<version>`).
7. **Non-secret configuration storage:**
   - Configuration files (`~/.config/signkit/config.toml` or `--config <PATH>`) hold non-sensitive settings only (`base_url`, `organization_id`, `timeout_secs`).
   - Storing credentials (`api_key`, `token`, `secret`, `password`) anywhere in configuration files (including nested tables or arrays) is strictly prohibited and causes immediate parse rejection.

## Exit Codes

The CLI implements an exact exit-code contract:

| Exit Code | Name                    | Description                                                                                                                           |
| :-------: | :---------------------- | :------------------------------------------------------------------------------------------------------------------------------------ |
|    `0`    | **Success**             | The command completed successfully.                                                                                                   |
|    `1`    | **GenericError**        | Unspecified internal or runtime failure.                                                                                              |
|    `2`    | **UsageError**          | CLI argument parsing failure, missing mandatory organization, missing API key, invalid key format, invalid UUIDv7, or invalid config. |
|    `3`    | **AuthenticationError** | HTTP 401: Invalid, expired, or revoked API key, or suspended account.                                                                 |
|    `4`    | **ForbiddenError**      | HTTP 403: Missing organization grant, insufficient scope, API key presented on forbidden management surface, or refused redirect.     |
|    `5`    | **NotFoundError**       | HTTP 404: Requested envelope or resource was not found in the authorized organization.                                                |
|    `6`    | **ConflictError**       | HTTP 409: State or concurrency conflict.                                                                                              |
|    `7`    | **ValidationError**     | HTTP 400, 422, or any unhandled 4xx: Server-side validation error, malformed input, or response body exceeded size limit.             |
|    `8`    | **UnavailableError**    | HTTP 500, 502, 503, 504, connection refused, network failure, or request timeout.                                                     |

## Output Formats & RFC 9457

- **Default:** Emits a stable versioned JSON envelope to `stdout`:
  ```json
  {
    "version": "1",
    "data": { ... }
  }
  ```
- **Raw Mode (`--raw`):** Emits the unadorned API response payload directly to `stdout`.
- **Pretty Mode (`--pretty`):** Formats JSON output with indentation.
- **Extensibility & Error Preservation:**
  - Unknown future JSON fields and future enum variants are preserved across all payloads.
  - Partial RFC 9457 `ProblemDetail` documents preserve original server problem types and extension attributes rather than synthesizing or replacing them.
  - Errors emit RFC 9457 JSON to `stderr`:
    ```json
    {
    	"type": "urn:signkit:problem:envelope-not-found",
    	"title": "Envelope not found",
    	"status": 404,
    	"detail": "No envelope was found in the authorized organization.",
    	"instance": "/api/v1/envelopes/0191b26f-4000-7000-8000-000000000001"
    }
    ```

## Command Reference

### `signkit capabilities`

Reads system capabilities and supported runtime profiles. Completely unauthenticated (sends no credentials or organization headers).

```sh
signkit --base-url https://signkit.example.com capabilities
```

### `signkit envelopes list`

Lists a single page of envelopes in the authorized organization with keyset cursor pagination.

```sh
export SIGNKIT_API_KEY="signkit_abcdef1234567890abcdef1234567890abcdef12345"
signkit --base-url https://signkit.example.com --org org_12345 envelopes list --limit 25 --cursor 0191b26f-4000-7000-8000-000000000001
```

Flags:

- `--limit <LIMIT>`: Number of envelopes per page (1..=100, default 50).
- `--cursor <CURSOR>`: Pagination cursor from previous page's `nextCursor` (must be canonical lowercase UUIDv7).

### `signkit envelopes get <ENVELOPE_ID>`

Reads metadata for a specific envelope. `<ENVELOPE_ID>` must be a canonical lowercase UUIDv7.

```sh
signkit --base-url https://signkit.example.com --org org_12345 envelopes get 0191b26f-4000-7000-8000-000000000001
```

### `signkit envelopes draft <ENVELOPE_ID>`

Reads the current draft workspace snapshot, Git generation, and tracked Markdown documents under `documents/*.md`.

```sh
signkit --base-url https://signkit.example.com --org org_12345 envelopes draft 0191b26f-4000-7000-8000-000000000001
```

### `signkit envelopes deliveries <ENVELOPE_ID>`

Reads the delivery outbox status of invitations for an envelope.

```sh
signkit --base-url https://signkit.example.com --org org_12345 envelopes deliveries 0191b26f-4000-7000-8000-000000000001
```

### `signkit envelopes completion-artifact <ENVELOPE_ID>`

Reads completion artifact publication status: `published`, `pending`, `processing`, `failed`, or `not_completed` (when the envelope has not reached terminal completion).

```sh
signkit --base-url https://signkit.example.com --org org_12345 envelopes completion-artifact 0191b26f-4000-7000-8000-000000000001
```

### `signkit envelopes create`

Creates a draft envelope (`drafts:write`). Supply `--title` or `--file PATH` (`-` for stdin JSON `{ "title": "..." }`). An `Idempotency-Key` is generated when `--idempotency-key` is omitted.

### `signkit envelopes commit <ENVELOPE_ID>`

Commits Markdown edits (`drafts:write`). JSON body from `--file` (default stdin) must include `expectedGeneration`, `message`, and `edits`.

### `signkit envelopes ready <ENVELOPE_ID>` / `fields` / `send` / `void`

Authoring and send/void mutations. JSON from `--file` (default stdin). Flags overlay concurrency fields. Envelope IDs and `expectedReadyAuditEventId` must be canonical lowercase UUIDv7. Each command sends `Idempotency-Key`.

### `signkit envelopes import-docx <ENVELOPE_ID>`

Converts a bounded DOCX file into one Markdown draft commit (`drafts:write`). Reads a regular file or stdin (`--file`, default `-`), refuses symbolic links, and caps input at 20 MiB. Requires `--target-path documents/....md`, `--expected-generation`, and `Idempotency-Key`.

```sh
signkit --base-url https://signkit.example.com --org org_12345 \
  envelopes import-docx 0191b26f-4000-7000-8000-000000000001 \
  --file ./agreement.docx --target-path documents/agreement.md --expected-generation 0
```

### `signkit envelopes export-docx <ENVELOPE_ID>`

Downloads the pinned revision as WordprocessingML (`envelopes:read`). `--output PATH` writes a regular file (refusing symlinks) and prints a JSON receipt; `--output -` writes bytes to stdout.

```sh
signkit --base-url https://signkit.example.com --org org_12345 \
  envelopes export-docx 0191b26f-4000-7000-8000-000000000001 --output ./agreement.docx
```
