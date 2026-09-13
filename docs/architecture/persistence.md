# Persistence

Status: implemented

The initial profiles are:

| Runtime     | Database   | Objects               | Background work                     |
| ----------- | ---------- | --------------------- | ----------------------------------- |
| Node/Docker | PostgreSQL | S3-compatible         | protected outbox drain + REST mail  |
| Cloudflare  | D1 binding | native R2 binding     | scheduled D1 outbox + email binding |
| Vercel      | PostgreSQL | external S3 initially | platform-specific                   |

D1 and PostgreSQL keep distinct migrations behind the same domain-shaped ports. The shared model avoids database enums, arrays, and mandatory JSON-specific column types. Every tenant-owned table carries `organization_id`; composite keys and foreign keys include it so rows cannot be linked across tenants accidentally. Instance-scoped tables (`instance_member`, `instance_bootstrap`, `instance_bootstrap_command`, `api_key`, and the API-key command receipts) do not carry `organization_id` or `instance_id`: one deployment database is the instance boundary, and API keys are owned by a local member rather than a d6e organization. `api_key_organization_grant` and its two command receipts are the single deliberate exception and are neither instance-scoped nor tenant-owned: they are the bridge table that names an organization precisely because their whole purpose is to record that a local instance-scoped key has been explicitly granted access to one external d6e organization. They therefore carry `organization_id` without being part of any tenant's own data, and they are keyed by their own UUIDv7 rather than by a composite tenant key.

SQL and object storage do not share a transaction. Objects are immutable; a successful SQL CAS publishes the new pointer. Failed uploads remain invisible and are reclaimed by the bounded orphan sweep (`POST /api/v1/system/objects/orphan-sweep`) only after a 24-hour grace period and a SQL reference check.

R2 is used through its in-process Worker binding, not the S3/REST endpoint. Node uses the S3 adapter. Native Vercel Blob is not S3-compatible and remains a separate future adapter.
