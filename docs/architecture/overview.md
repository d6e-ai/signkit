# Overview

Status: policy

## Product boundary

SignKit is a modular monolith for drafting, sending, signing, retaining, and automating agreements. It is not a d6e-specific workflow product: d6e can orchestrate work before and after signature through the same versioned API and webhooks available to every integrator.

The open-source core must remain useful on its own. Security and evidence collection are never paywalled. Enterprise licensing applies to higher-order integrations and policy features, not to the correctness of signatures or audit capture.

OpenSign and Documenso were inspected only as product references. Both repositories use AGPL-3.0 boundaries, and Documenso has separately licensed enterprise code. SignKit must use original code, names, schema, copy, and visual expression unless the project deliberately adopts compatible license obligations later.

## Architecture

```text
SvelteKit UI · REST API · public signing links · webhooks
                            │
                 application commands/queries
                            │
       envelope · draft Git · signing · audit policies
                            │
      ┌──────────┬──────────┼──────────┬───────────┐
      │ DB port  │ object   │ identity │ jobs/mail │
      ├ Postgres ├ S3       ├ d6e-auth ├ outbox    │
      └ D1       └ R2       └ guest    └ Queue     │
```

Runtime services are created from each SvelteKit request. Cloudflare bindings come from `event.platform.env`; request-scoped state is never held in module globals. The domain and application layers do not import a platform SDK.
