---
name: signkit-cli
description: Build, configure, script, and operate the agent-first SignKit Rust CLI with secure credentials, JSON output, mutations, and document import or export.
---

# SignKit CLI

Use the Rust `signkit` CLI for non-interactive envelope workflows. It is distinct from the npm `create-signkit` deployment tool.

## Essential rules

- Pass the service with `--base-url` or `SIGNKIT_BASE_URL`.
- Pass API keys through `SIGNKIT_API_KEY` or `--api-key-stdin`; never as a command argument or config entry.
- Recipient commands require the recipient's own invitation capability via `SIGNKIT_RECIPIENT_CAPABILITY` or `--recipient-capability-stdin`; a sender API key cannot authorize them. Never put the capability in argv, a URL, a payload, or config.
- Require the recipient's actual, contemporaneous authorization before passing `--consent` for viewed, sign, approve, or decline. Token possession is not consent.
- Do not supply a tenant selector. Authority comes from the key's active local owner and scopes.
- Parse the default `{ "version": "1", "data": ... }` JSON envelope, or request `--raw`.
- Treat stderr as RFC 9457-style error JSON and use the process exit code.
- Give binary downloads an output path; never emit agreement bytes to a terminal.

Build with `cargo build --manifest-path cli/Cargo.toml --release`.

Read [references/commands.md](references/commands.md) for command examples and configuration precedence.
