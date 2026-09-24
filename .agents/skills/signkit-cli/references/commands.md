# SignKit CLI commands

## Configuration precedence

1. `--base-url`, `--timeout`, `--config`
2. `SIGNKIT_BASE_URL`, `SIGNKIT_TIMEOUT_SECS`, `SIGNKIT_CONFIG`
3. `base_url` and `timeout_secs` in `config.toml`
4. built-in defaults

Credentials are accepted only through `SIGNKIT_API_KEY` or `--api-key-stdin`.

## Read commands

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

## Mutation commands

```sh
signkit envelopes create --title "Agreement" --idempotency-key <opaque-key>
signkit envelopes commit <envelope-id> --file commit.json
signkit envelopes import-docx <envelope-id> --file agreement.docx --target-path documents/agreement.md
signkit envelopes upload-pdf <envelope-id> --file exhibit.pdf --expected-generation 1
signkit envelopes document-order <envelope-id> --file document-order.json
signkit envelopes ready <envelope-id> --file ready.json
signkit envelopes fields <envelope-id> --file fields.json
signkit envelopes send <envelope-id> --file send.json
signkit envelopes void <envelope-id> --file void.json
signkit envelopes pdf-seal-request <envelope-id> --profile pades-b-b --idempotency-key <opaque-key>
```

An omitted idempotency key is generated as UUIDv4. Reuse the same key only when retrying the same logical mutation.

`upload-pdf` sends a raw `application/pdf` body from a regular file or stdin, bounded to 20 MiB. It requires `--expected-generation`; `--title` is optional (1-200 characters, without control characters), and `--position` is optional (0-19). `document-order` accepts JSON with `expectedGeneration` and 1-20 unique UUIDv7 `documentIds`; the IDs are the complete retained set, so omitting an existing ID removes it from the draft.

`pdf-seal-request` asks the instance to produce a PAdES seal for the published executed agreement PDF (requires `envelopes:send`). `--profile` must be `pades-b-b` or `pades-b-t` and must match the profile the instance is configured for, or the request fails with a 409 conflict. `pdf-seal-status` reads job status (`disabled`, `not_requested`, `pending`, `processing`, `failed`, or `published`, with profile, attempt, and validation detail once available). `pdf-seal-download` downloads the published, validated sealed PDF once status is `published`; it requires a regular output path and never writes agreement bytes to stdout. It 404s with a distinct problem type before publication.

## Exit codes

`0` success; `1` internal or JSON error; `2` usage; `3` authentication; `4` authorization; `5` not found; `6` conflict; `7` other client error; `8` rate limited (HTTP 429); `9` server unavailable (HTTP 5xx); `10` network failure; `11` timeout; `12` redirect refused.

Scripts written against v0.1.x must not treat `8` as generic server failure: `8` is rate limited, `9` is server unavailable, `10` is transport failure, `11` is timeout, and `12` is redirect refused. Stderr always carries the original RFC 9457 HTTP `status` independently of the process code.
