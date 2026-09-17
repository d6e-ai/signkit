---
name: signkit-cli
description: Build, configure, script, and operate the agent-first SignKit Rust CLI with secure credentials, JSON output, mutations, and document import or export.
---

# SignKit CLI

Use the Rust `signkit` CLI for non-interactive envelope workflows. It is distinct from the npm `create-signkit` deployment tool.

## Essential rules

- Pass the service with `--base-url` or `SIGNKIT_BASE_URL`.
- Pass API keys through `SIGNKIT_API_KEY` or `--api-key-stdin`; never as a command argument or config entry.
- Do not supply a tenant selector. Authority comes from the key's active local owner and scopes.
- Parse the default `{ "version": "1", "data": ... }` JSON envelope, or request `--raw`.
- Treat stderr as RFC 9457-style error JSON and use the process exit code.
- Give binary downloads an output path; never emit agreement bytes to a terminal.

Build with `cargo build --manifest-path cli/Cargo.toml --release`.

Read [references/commands.md](references/commands.md) for command examples and configuration precedence.
