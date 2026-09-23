# SignKit Rust CLI

The first-party `signkit` CLI is a non-interactive client for agent and automation workflows. It calls the same `/api/v1` endpoints as the web application.

`create-signkit` is a separate npm package for provisioning and updating Cloudflare deployments; see [create-signkit.md](create-signkit.md).

## Build

```sh
cargo build --manifest-path cli/Cargo.toml --release
./cli/target/release/signkit --help
```

## Configuration

Supply the base URL by flag, environment, or the non-secret config file:

```toml
base_url = "https://signkit.example.com"
timeout_secs = 30
```

Precedence is flags, environment, config, then defaults. Relevant values are:

- `--base-url` or `SIGNKIT_BASE_URL`
- `--timeout` or `SIGNKIT_TIMEOUT_SECS`
- `--config` or `SIGNKIT_CONFIG`
- `SIGNKIT_API_KEY`, or `--api-key-stdin` for secret input

API keys are never accepted as command-line values or config-file fields. The CLI rejects secret-looking config keys recursively. It never follows HTTP redirects, so credentials cannot be forwarded to another origin.

There is no tenant flag or selector. The key's active local owner and scopes determine its authority.

## Output

Successful JSON commands write a stable envelope to stdout:

```json
{ "version": "1", "data": {} }
```

Use `--raw` for the API body and `--pretty` for formatted JSON. Errors are RFC 9457-style JSON on stderr. Binary downloads never write document bytes to a terminal; provide an output file.

## Commands

```sh
signkit capabilities
signkit envelopes list --limit 25
signkit envelopes get <envelope-id>
signkit envelopes draft <envelope-id>
signkit envelopes deliveries <envelope-id>
signkit envelopes completion-artifact <envelope-id>
signkit envelopes evidence <envelope-id> --format json --output evidence.json
signkit envelopes pdf <envelope-id> --output agreement.pdf
signkit envelopes pdf-seal-status <envelope-id>
signkit envelopes pdf-seal-download <envelope-id> --output sealed-agreement.pdf
```

Authoring and lifecycle commands:

```sh
signkit envelopes create --title "Agreement" --idempotency-key <opaque-key>
signkit envelopes commit <envelope-id> --file commit.json
signkit envelopes import-docx <envelope-id> --file agreement.docx --target-path documents/agreement.md
signkit envelopes upload-pdf <envelope-id> --file exhibit.pdf --expected-generation 1
signkit envelopes document-order <envelope-id> --file document-order.json
signkit envelopes export-docx <envelope-id> --output agreement.docx
signkit envelopes ready <envelope-id> --file ready.json
signkit envelopes fields <envelope-id> --file fields.json
signkit envelopes send <envelope-id> --file send.json
signkit envelopes void <envelope-id> --file void.json
signkit envelopes pdf-seal-request <envelope-id> --profile pades-b-t --idempotency-key <opaque-key>
```

When omitted, mutation idempotency keys are generated as UUIDv4 values. Envelope ids and cursors are validated as UUIDv7 before any network request.

`upload-pdf` sends a raw `application/pdf` body from a regular file or stdin, bounded to 20 MiB. `--expected-generation` is required; `--title` is optional (1-200 characters, without control characters), and `--position` is optional (0-19). The JSON supplied to `document-order` must contain `expectedGeneration` and 1-20 unique UUIDv7 `documentIds` in the desired order. The list is the complete retained set: omit an existing document ID to remove it from the draft.

`pdf-seal-request` explicitly requests the instance's configured `pades-b-b` or `pades-b-t` profile for an already-published completion PDF. `pdf-seal-status` reports the durable job and validation state. `pdf-seal-download` is available only after independent validation and atomic publication; it requires a regular output file and never writes agreement bytes to stdout.

## Exit codes

| Code | Meaning                         |
| ---- | ------------------------------- |
| `0`  | success                         |
| `1`  | internal or JSON error          |
| `2`  | usage or local validation error |
| `3`  | authentication failure          |
| `4`  | authorization failure           |
| `5`  | not found                       |
| `6`  | conflict                        |
| `7`  | other client error              |
| `8`  | rate limited                    |
| `9`  | server unavailable              |
| `10` | network failure                 |
| `11` | timeout                         |
| `12` | redirect refused                |

The CLI preserves unknown API fields so newer servers remain inspectable by older clients.
