# Dashboard worklist (backend)

Backend half of issue #233: a familiar "what's on my plate" worklist, not a
stats dashboard. The UI half (root `+page.svelte`, locale messages) is owned
separately; this document covers the read model, the HTTP surface, and the
SSR loader.

## Contract

`src/lib/application/dashboard/model.ts` is the shared contract between the
backend and the UI:

- `DashboardView`: `'all' | 'action_required' | 'waiting' | 'drafts' | 'completed'`.
  `action_required` and `waiting` are mutually exclusive subsets of
  `sent`/`in_progress` envelopes. `drafts` covers `draft`/`ready`. `completed`
  covers only `completed`. `all` is unfiltered, including `declined`,
  `expired`, and `voided`.
- `DashboardItem`: one worklist row -- the envelope, a display-only "current
  recipient" summary (first by routing order then id, regardless of role or
  status), recipient counts, the `nextRecipient` (earliest outstanding
  signer/approver), and `actionRequired`.
- `DashboardPage`: `items`, a `nextCursor`, and whole-instance `counts` that
  stay stable regardless of the active search text (the view-switcher badges
  must never look like they dropped to the filtered count).
- `DashboardQuery`: `view`, `query`, `cursor`, `limit`.

`actionRequired` is a **display classification**, computed for the signed-in
caller's own session email. It decides what the worklist highlights; it
carries no signing authority of its own -- that remains entirely the domain
command layer's (`recipient-decision-routing.ts`) to enforce.

## Why a dedicated read port

`DashboardStore` (`src/lib/ports/dashboard-store.ts`) is deliberately not an
extension of `EnvelopeApplicationPort`. That port models a single envelope's
authoring/send lifecycle; this is a cross-envelope UI aggregate computed
entirely in SQL (recipient counts, the active-turn lookup) in one request.
Growing the envelope port to also carry this read model would force every
existing envelope mock and adapter to grow an unrelated method. `DashboardStore`
has one method, `readDashboard`, and both adapters compute it without ever
issuing a per-row `getDetail`-style call.

## Active-turn semantics

A recipient's routing group is "active" when it holds the lowest
`routing_order` among outstanding (`pending`/`viewed`) `signer`/`approver`
recipients for the envelope -- this matches the domain's sequential routing
policy (`recipient-decision-routing.ts`) exactly, without duplicating its
state machine: every recipient is inserted at send time with status `pending`
regardless of routing order, so "future" groups are indistinguishable from
the active one by status alone, only by order.

- `nextRecipient` is the earliest recipient (by routing order, then id) in
  that active group.
- `actionRequired` is true only when the signed-in caller holds a seat in
  that *entire* active group, not merely when they happen to be
  `nextRecipient` -- a parallel co-signer's own turn must never be missed.
- `cc`, `viewer`, and `prefill` roles never participate: they are excluded
  from both the active-turn lookup and the display recipient's eligibility
  for `nextRecipient`.
- `action_required` and `waiting` are therefore exclusive buckets over the
  same `sent`/`in_progress` envelopes, decided by one `EXISTS` predicate and
  its negation inside a single query, so they can never disagree about which
  envelopes exist at all.

## Store adapters

`D1DashboardStore` and `PostgresDashboardStore` both compute one
`DashboardPage` with:

- One query (D1: two statements inside one `batch()`; PostgreSQL: one
  transaction) producing whole-instance `counts` independent of row volume --
  never one query per status.
- A second query producing the page of rows, joined against CTEs for the
  active-turn lookup, the first-recipient-by-routing-order summary, and the
  per-envelope recipient aggregates (count/completed/actionable).
- A stable `updated_at DESC, id DESC` keyset cursor, so a tie in `updated_at`
  (common in bulk-seeded or bulk-imported data) still produces a
  deterministic, non-skipping page boundary.
- A literal, case-insensitive `LIKE` search over the envelope title and every
  recipient's name/email, with `%`, `_`, and `\` escaped before binding --
  never interpreted as search metacharacters.
- SQL parameter binding throughout; no string-interpolated user input.

`counts` and `items` are read from one consistent snapshot: one D1 `batch()`
or one PostgreSQL transaction, never two independent round trips that could
observe different `NOW()`-relative state.

Caller-email normalization (lowercasing) happens once, in
`DashboardApplication` (`dashboard-service.ts`), before the store is called.
The stores themselves do exact, case-sensitive comparisons against whatever
email they are given -- this keeps the normalization policy in one place
instead of duplicating it in two SQL dialects.

## HTTP and SSR

`GET /api/v1/dashboard` (`src/routes/api/v1/dashboard/+server.ts`) and the
root page's SSR loader (`src/routes/+page.server.ts`) both delegate to
`resolveDashboardWorklist` (`src/lib/server/dashboard-worklist-request.ts`):

- Session-only instance authorization via `authorizeInstanceRequest`:
  anonymous -> 401, suspended/non-member -> 403, identity-unavailable -> 503,
  an API-key-only request -> 403 (never falls through to a cookie session).
  There is no caller/email request parameter anywhere in this feature; the
  caller is always the authenticated session, never request-supplied.
- Bounded query validation: `view` must be a known value, `q` is capped at
  200 characters, `cursor` must be a SignKit UUIDv7, `limit` defaults to 25
  and is capped at 100. An unknown query parameter or a duplicated known one
  is rejected (400) rather than silently ignored or silently resolved to
  whichever occurrence won.
- A resolution failure for the durable store maps to 503; a read failure
  from the store maps to 502. Neither is folded into an empty page: a
  caller who cannot be authorized, or whose store is unavailable, must never
  look identical to a member who legitimately has nothing in their worklist.

The SSR loader queries the application layer directly -- it never issues an
HTTP self-fetch against `/api/v1/dashboard`. Both surfaces still derive their
own authorization independently (same helper, called separately), so neither
depends on the other's cache or on `+layout.server.ts`'s page-access gate
having already run.

`+page.server.ts` returns `{ worklist, worklistQuery, worklistError }`.
`worklist` is `null` exactly when `worklistError` is non-null; there is no
state in which both are populated or both are empty by coincidence.

## Client

`src/lib/client/dashboard.ts` is a thin, typed fetch wrapper
(`DashboardClient.worklist(params)`) following the existing client pattern
(`contacts.ts`): RFC 9457 problem parsing via `http-problem.ts`, same-origin
credentials, no retry/backoff policy of its own.
