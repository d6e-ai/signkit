# Durable DOCX conversion

DOCX conversion is an asynchronous-capable, provider-portable job boundary. Both import and export use the same SQL-backed lease and retry model on D1 and PostgreSQL; the design does not require Cloudflare Queues, Workflows, or a Node-only worker process.

## Import

The request path bounds the upload before it reaches object storage, computes its SHA-256 digest, and writes it under an immutable content-addressed key. It then creates one durable import job keyed by the envelope and caller-provided `Idempotency-Key`. Reusing that key with a different source digest, target path, expected generation, or actor is a conflict.

A claimed worker verifies the stored object's size and digest, performs the hostile ZIP/XML checks and constrained DOCX-to-Markdown conversion, and calls the ordinary draft commit service with the original expected generation, actor, and idempotency key. The resulting Git tree contains normalized Markdown only. If the process stops after the draft commit but before acknowledging the job, the next attempt receives the draft commit's safe idempotent replay and can finish the job without creating another revision.

Source DOCX bytes are retained only while a job can still run. A terminal job no longer keeps its source object live; the ordinary object-orphan sweep removes it after the global grace period. This gives interrupted workers time to recover without turning uploads into permanent records.

## Export

An export job captures the trusted immutable revision locator—commit SHA, archive key, and archive SHA-256—when it is created. Every attempt reads and verifies that exact revision rather than consulting the envelope's later mutable pointer. The generated DOCX is written under a content-addressed object key and the job publishes its digest and byte size. Repeated export of the same pinned revision reuses the durable result.

DOCX artifacts never enter the envelope Git repository. They are derived conveniences, not signing evidence; the pinned Git revision and the sent PDF document set remain authoritative.

## Leases, retries, and attempts

Workers claim bounded batches with opaque lease tokens. An abandoned `processing` lease becomes claimable after five minutes. Retryable failures use bounded exponential backoff and stop after the configured maximum attempt count. Invalid DOCX, stale draft generation, immutable-envelope conflicts, and integrity failures are terminal; transient database or object-store failures remain retryable.

Each finished attempt appends an immutable attempt row containing its attempt number, timestamps, outcome, safe error code, and source/result digests where applicable. The job status update and attempt insertion are one database transaction. Attempt records are an operational audit trail; the successful import's legal/business mutation remains the existing chained `draft.revision_created` audit event. Export does not append to the envelope audit chain because it creates a derived copy without changing the agreement.

## Execution

Interactive endpoints may claim and run their newly created job immediately to preserve a low-latency authoring experience. The job is durable before conversion begins, and the protected scheduled drain processes pending, retryable, and abandoned work. Correctness never depends on request-lifetime background work or `waitUntil`.

Object writes precede publication of their SQL result pointer. A crash can therefore leave an unreferenced immutable object, which is safe for the orphan sweep to collect after its grace period; it cannot leave a durable pointer to missing bytes.
