# Dashboard worklist read model

Date: 2026-10-12

Status: Accepted

## Context

Issue #233 asks for a familiar "what's on my plate" worklist on the home
page, not a stats dashboard. The existing `EnvelopeApplicationPort` models one
envelope's authoring/send lifecycle and its mocks are already shared broadly;
the worklist instead needs a cross-envelope aggregate per request (recipient
counts, an active-turn lookup, whole-instance badge counts) computed without
an N+1 of per-envelope detail calls, and it needs the exact same answer from
the HTTP API and from the home page's SSR render.

## Decision

- A dedicated `DashboardStore` port (`src/lib/ports/dashboard-store.ts`) with
  one method, `readDashboard`, rather than growing
  `EnvelopeApplicationPort`. `D1DashboardStore` and `PostgresDashboardStore`
  each compute counts and the page of rows from CTEs in a single consistent
  snapshot (one D1 `batch()`, one PostgreSQL transaction) -- never a query
  per envelope.
- "Active turn" is derived purely from `routing_order` and recipient
  `status`/`role`, matching `recipient-decision-routing.ts`'s sequential
  policy: the active group is whichever outstanding `signer`/`approver`
  group has the lowest routing order, since every recipient is created
  `pending` at send time regardless of order. `actionRequired` checks every
  recipient sharing that order, not just the one recipient surfaced as
  `nextRecipient`, so a parallel co-signer's turn is never missed.
  `actionRequired` is a display classification only; it has no signing
  authority and duplicates no part of the command layer's enforcement.
- `GET /api/v1/dashboard` and the root `+page.server.ts` SSR loader share one
  server-only helper, `resolveDashboardWorklist`
  (`src/lib/server/dashboard-worklist-request.ts`), which independently
  derives session-only instance authorization and validates the bounded
  query on every call. The SSR loader queries the application layer
  directly; it never performs an HTTP self-fetch against the API route.
- Authorization and store-resolution failures are reported as a tagged
  failure outcome, never folded into an empty `DashboardPage`. `+page.server.ts`
  returns `worklist: null` together with a populated `worklistError`
  precisely when the read failed, so the UI can distinguish "nothing in your
  worklist" from "the worklist could not be read right now."
- Search is literal and case-insensitive against the envelope title and
  every recipient's name/email, with `%`, `_`, `\` escaped before binding.
  Pagination uses a stable `updated_at DESC, id DESC` keyset cursor so tied
  timestamps still produce a deterministic page boundary.
- Caller-email normalization happens once, in the `DashboardApplication`
  layer, before either store is called; the stores themselves compare
  whatever email they are given exactly, case-sensitively.
- New forward-only migrations add `envelope(updated_at DESC, id DESC)` and
  `recipient(envelope_id, role, status)` indexes (D1 `0058`, PostgreSQL
  `0054`) rather than reusing the existing status-leading or
  routing-order-leading indexes, neither of which can serve this access
  pattern.

## Consequences

The worklist can answer "what needs me" for an instance with hundreds of
envelopes in two bounded queries, with whole-instance badge counts that never
drift from the filtered row count's underlying data. Authorization logic for
this feature lives in exactly one place even though it is called from two
routing surfaces. A caller whose identity cannot be verified, or whose store
is unavailable, is never silently handed an empty-looking worklist.

The read model intentionally does not reuse `EnvelopeApplicationPort`'s
mocks or detail-fetch path; a future UI aggregate with similar needs should
get its own port rather than extending this one or that one.

## Alternatives considered

- **Extend `EnvelopeApplicationPort` with a `listForDashboard` method:**
  rejected. It would force every existing envelope mock and adapter to grow
  a method unrelated to the single-envelope lifecycle they model.
- **Compute `actionRequired`/`nextRecipient` by calling `getDetail` per
  envelope:** rejected. N+1 per page render, and it duplicates routing logic
  that already lives in `recipient-decision-routing.ts` instead of deriving
  it from the same underlying facts in one query.
- **Let the SSR loader call the HTTP API via `fetch`:** rejected. Same
  process, same authorization decision; a self-fetch would only add latency
  and a second place that could drift from the API's own validation.
