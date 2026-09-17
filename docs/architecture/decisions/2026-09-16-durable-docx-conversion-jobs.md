# ADR: Use portable SQL leases for DOCX conversion

- Date: 2026-09-16
- Status: accepted

## Context

DOCX import and commit-pinned export were originally executed entirely inside the HTTP request. Their conversion bounds protected memory and archive processing, but a process interruption lost the operation and there was no durable record of retries or failed outcomes. SignKit must offer the same behavior on Cloudflare, a Node VPS, and Vercel-compatible infrastructure.

## Decision

Both conversion directions use one database-backed job abstraction implemented for D1 and PostgreSQL. Request handlers persist inputs and a job before conversion, may process that job inline, and rely on the same protected scheduled drain for recovery. Jobs use bounded leases, exponential retry, a terminal attempt cap, content-addressed object storage, and append-only attempt records.

Import source DOCX and export result DOCX objects stay outside Git. Import workers commit only normalized Markdown through the existing draft persistence service. Export workers pin the exact trusted Git locator at enqueue time.

Cloudflare Queues and Workflows are not the correctness boundary. A deployment may add a wake-up mechanism later, but SQL remains the portable source of job state.

## Consequences

- A failed HTTP request can be recovered without duplicating a draft revision or exporting a different commit.
- Operators get durable, bounded attempt evidence without adding derived exports to the envelope's business audit chain.
- D1 and PostgreSQL require matching job and attempt migrations and adapters.
- Input and result objects must participate in orphan-reference filtering according to job state.
- Scheduled maintenance gains one more protected drain invocation.
