# SignKit

Self-hosted contract drafting and electronic signatures, built for people and AI agents. Prepare
Markdown or PDF documents, send them for review and signature, and retain the executed PDF with its
audit evidence.

- Draft revisions backed by Git, with multiple ordered documents per envelope.
- A browser interface, versioned HTTP API, and first-party Rust CLI.
- Node/Docker with PostgreSQL and S3-compatible storage, or Cloudflare Workers with D1 and R2.
  Vercel is build-tested but not supported for production.

Optional PAdES instance seals require external signing and validation services. They are not
recipients' certificate-backed or qualified electronic signatures.

## Get started

To self-host, follow the [deployment guide](docs/deployment.md) or the
[Cloudflare installation and upgrade guide](docs/create-signkit.md).

For local development:

```sh
pnpm install
cp .env.example .env
pnpm run dev
```

Configure authentication, encryption keys, database, and storage before using the application. See
[development setup](docs/development.md) for requirements and tests.

## Use with an agent

Install the `signkit-api` and `signkit-cli` skills:

```sh
npx skills add https://github.com/d6e-ai/signkit
```

The Rust `signkit` CLI operates contracts through the API. The separate `create-signkit` CLI
installs and upgrades a server.

## Documentation and contributing

Use the [documentation task map](docs/README.md) to find the relevant guide or specification. See
[CONTRIBUTING.md](CONTRIBUTING.md) for development and [SECURITY.md](SECURITY.md) for reporting
vulnerabilities.

## License

The open-source core is AGPL-3.0-only. Security and audit evidence capture are not paywalled. See
[LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
