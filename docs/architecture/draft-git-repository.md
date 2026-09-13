# Draft Git repository

Status: implemented (streaming archive production, orphan collection, and broader recovery tests remain before production use)

Tracked content is deliberately narrow:

```text
documents/<stable-document-id>.md
```

The database owns titles, ordering, recipients, field coordinates, state, and artifact references. Git never contains DOCX, PDF, signature images, access tokens, or evidence bundles.

Each edit performs these steps:

1. Read the current generation, archive key, SHA-256, and Git head.
2. Download the bounded compressed repository archive and verify its external SHA-256.
3. Restore a request-local in-memory filesystem and reject unsafe paths, excess files, and excess size.
4. Use `isomorphic-git` to edit, stage, and commit Markdown files with human/agent/system attribution.
5. Serialize sorted repository files and gzip them deterministically.
6. Upload to an immutable, content-addressed object key.
7. Publish the expected-generation pointer, durable idempotency result, and `draft.revision_created` audit event atomically in the database.
8. If publication loses a race, return a typed conflict; unreferenced content-addressed uploads are garbage-collected later and are never deleted on the request path.

Recommended key:

```text
draft-repositories/v1/organizations/{organization}/envelopes/{envelope}/sha256/{sha256}.git.gz
```

Git SHA-1 identifies revisions but is not the storage integrity boundary. Every archive and final artifact also has a SHA-256 digest. The current application service implements bounded archive reads, external SHA-256 verification, immutable object writes, and generation-based publication. `GET /api/v1/envelopes/{envelopeId}/draft` exposes normalized Markdown without leaking the internal object key or archive bytes. `POST /api/v1/envelopes/{envelopeId}/draft/commits` accepts one to fifty direct `documents/*.md` edits, requires an expected generation and idempotency key, and optionally records automation provenance. D1 uses a trigger-backed command table and PostgreSQL uses a row lock plus transaction so the pointer, replay result, and audit event become visible together. Streaming archive production, orphan collection, and broader recovery tests remain before production use.
