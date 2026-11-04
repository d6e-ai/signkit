# Contributing

Thanks for your interest in SignKit. This is a small, early-stage project — please keep changes
focused.

## Setup

pnpm is required (not npm or yarn); the version is pinned via `packageManager` in `package.json` and
`engine-strict=true` in `.npmrc`. `corepack enable` is enough to get the right pnpm.

```sh
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
pnpm run dev
```

See [docs/development.md](docs/development.md) for the full local setup, migrations, and repository
layout. Use the [documentation task map](docs/README.md) for other topics; reading every
architecture file or ADR is not a prerequisite.

## Tests

```sh
pnpm run test          # full suite: server + browser + create-signkit
pnpm run test:unit     # vitest --project server --project postgres
pnpm run test:browser  # vitest --project browser (Chromium)
```

PostgreSQL integration suites are skipped unless `POSTGRES_TEST_URL` points at a disposable
database:

```sh
POSTGRES_TEST_URL=postgres://signkit_test:signkit_test@127.0.0.1:5432/signkit_test pnpm run test:unit -- --run
```

Never point `POSTGRES_TEST_URL` at a database you care about — these suites apply migrations and
write data.

## Lint and typecheck

```sh
pnpm run lint    # prettier --check . && eslint .
pnpm run check   # Paraglide compile + svelte-kit sync + svelte-check
pnpm run format  # prettier --write .
```

## Rust CLI (`cli/`)

```sh
cd cli
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

## Pull requests

- Keep PRs focused on one change.
- Add or update tests for any behavior change.
- Update the canonical architecture specification when behavior changes, and link to it from usage
  guides rather than repeating its contract. Keep decision records to short rationale, not
  implementation transcripts. Do not retain superseded designs or completed plans as current
  documentation.
- Run lint, typecheck, the test suite, the build targets, and the Rust CLI checks locally.
  `.github/workflows/ci.yml` is manual (`gh workflow run ci.yml --ref <branch>`); it does not run on
  a pull request.

## License

SignKit is licensed under AGPL-3.0-only (see [LICENSE](LICENSE)). By contributing, you agree that
your contributions are licensed under the same terms.
