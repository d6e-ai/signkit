# Code boundaries

Use these boundaries for behavior-preserving refactoring. Product contract changes need their own
specification and tests, not incidental changes hidden inside a shared helper.

## Ownership

- HTTP, UI, and CLI translate inputs and transport results. Application commands own use cases;
  domain functions own pure policy; ports describe capabilities; adapters own provider protocols and
  row mapping.
- Share logic only when inputs, results, failures, timing, and limits mean the same thing. Similar
  syntax is not enough. Avoid mode-heavy universal command, job, publisher, or dependency-injection
  frameworks.
- Shared composition belongs in `src/lib/application/runtime/`. Feature runtimes assemble only the
  dependencies they need, rather than borrowing another feature's runtime. Request identity and
  bindings never become shared state.
- Pure ready contracts and recipient routing live in `src/lib/domain/commands/`. They do not replace
  D1 trigger checks or PostgreSQL transactions and locks.

## Contracts to preserve

Read the relevant specification rather than copying its invariants here:

- [Authorization](authorization-and-instance-administration.md): identities, local membership, key
  owners/scopes, recipient consent, and system authority.
- [Envelope model](envelope-model.md), [draft Git](draft-git-repository.md), and
  [persistence](persistence.md): state transitions, generation checks, canonical request/audit
  bytes, durable replay, and atomic publication.
- [Completion artifacts](completion-artifacts.md), [sealing](pdf-sealing.md), and
  [signature retention](signature-asset-retention.md): pinned evidence, byte verification,
  publication order, leases, and collection coordination.
- [Agent contract](agent-contract.md): explicit actions, opaque failures, and replay of an ambiguous
  attempt with the same body and idempotency key.

Callers retain their own stream limits, error classification, retry budget, lease/state transitions,
and cookie rules. A shared bounded reader or backoff calculation does not make these policies
interchangeable. Never describe external mail delivery as exactly-once because a database receipt is
durable.

## Verification

Use the [development checks](../development.md) for changed paths and contracts. Compare canonical
bytes and failure outcomes, not only happy-path results. Distinguish SQLite harness tests, real
PostgreSQL, workerd, adapter builds, and complete workflow tests. A build or fixture is not proof of
a hosted integration. Record the current change's evidence in its PR; do not keep stale test counts
or a completed implementation plan in this specification.
