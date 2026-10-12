# Dashboard worklist (backend)

Issue #233 replaces the dashboard's client-side detail-fetch waterfall with
a server-rendered contract worklist. This document covers the read model,
the HTTP surface, and the SSR loader.

`GET /api/v1/system/capabilities` advertises this feature as
`dashboardWorklist`, with its session-only read endpoint and supported views.
It explicitly rejects API-key authentication in the discovery contract, just
as the route does at runtime; the bearer-key read endpoint list is unchanged.

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
  that _entire_ active group, not merely when they happen to be
  `nextRecipient` -- a parallel co-signer's own turn must never be missed.
- `cc`, `viewer`, and `prefill` roles never participate: they are excluded
  from both the active-turn lookup and the display recipient's eligibility
  for `nextRecipient`, and from `completedRecipientCount`/`actionableRecipientCount`
  -- both are scoped to `signer`/`approver` only, so `completedRecipientCount`
  can never exceed `actionableRecipientCount`.
- `action_required` and `waiting` are therefore exclusive buckets over the
  same `sent`/`in_progress` envelopes, decided by one `EXISTS` predicate and
  its negation inside a single query, so they can never disagree about which
  envelopes exist at all.

## Store adapters

`D1DashboardStore` and `PostgresDashboardStore` both compute one
`DashboardPage` with:

- Two read statements with a fixed query count, executed inside one D1
  `batch()` or one PostgreSQL repeatable-read transaction. The first computes
  whole-instance counts independently of the current page or search. It
  necessarily scans instance envelopes and evaluates indexed recipient
  predicates for active envelopes; it is not constant-cost with data volume.
- The second selects the ordered envelope page before computing recipient
  summaries. D1 restricts its recipient CTEs to those page IDs; PostgreSQL
  uses correlated `LATERAL` lookups. Historical recipients outside the page
  are not included in summary windows or aggregates. Search and active-view
  selection can still examine other matching candidates.
- A stable `updated_at DESC, id DESC` keyset cursor. The cursor itself is an
  opaque, self-contained, base64url-encoded `(updatedAt, id, view, query)`
  tuple (`application/dashboard/cursor.ts`), decoded without ever looking up
  its anchor row in the database: a since-mutated or since-deleted anchor
  changes nothing about the page boundary, unlike a cursor that re-resolves
  `updated_at` from a live row by id. Decoding is bound to the exact
  normalized `(view, query)` the caller is currently requesting; a cursor
  minted under a different view or search text is rejected as a 400, not
  silently reinterpreted against the new filter. PostgreSQL carries a
  lossless UTC microsecond ordering key separately from the public display
  timestamp and binds the boundary as `text` before casting to `timestamptz`,
  avoiding the driver's millisecond `Date` serializer and connection
  timezone dependence.
- Literal `LIKE` search over the title and every recipient's name/email,
  with `%`, `_`, and `\` escaped before binding. Both the stored text and
  bound pattern are folded inside the database, preserving exact accented
  and Japanese searches without mixing JavaScript and SQL folding rules.
  ASCII case-insensitive matching is portable; broader Unicode case-folding
  parity is tracked in [#236](https://github.com/d6e-ai/signkit/issues/236).
- SQL parameter binding throughout; no string-interpolated user input.

`counts` and `items` are read from one consistent snapshot: one D1 `batch()`
or one PostgreSQL transaction, never two independent round trips that could
observe different `NOW()`-relative state. On PostgreSQL this is explicit:
a plain `BEGIN` is READ COMMITTED, under which each statement in the same
transaction can still see a different, independently-committed snapshot if a
write lands between them. The store issues `SET TRANSACTION ISOLATION LEVEL
REPEATABLE READ, READ ONLY` as the transaction's first statement, so the
counts query and the rows query always see the same snapshot. Both D1 and
PostgreSQL adapters validate every result they get back (batch success
flags, a present and well-typed counts row) and throw rather than
defaulting a missing or malformed result to zero -- a thrown error
surfaces as a retryable failure, while a genuinely empty instance still
proves real zero counts through the same validated path.

Caller-email normalization (lowercasing) happens once, in
`DashboardApplication` (`dashboard-service.ts`), before the store is called.
The stores themselves do exact, case-sensitive comparisons against whatever
email they are given -- this keeps the normalization policy in one place
instead of duplicating it in two SQL dialects.

## HTTP and SSR

`GET /api/v1/dashboard` (`src/routes/api/v1/dashboard/+server.ts`) and the
root page's SSR loader (`src/routes/+page.server.ts`) both delegate to
`resolveDashboardWorklist` (`src/lib/server/dashboard-worklist-request.ts`):

- Authorization runs _before_ query parsing: `authorizeInstanceRequest` is
  called first (anonymous -> 401, suspended/non-member -> 403,
  identity-unavailable -> 503, an API-key-only request -> 403, never falling
  through to a cookie session), so an unauthorized caller always sees their
  authorization failure, never a 400 that incidentally also reveals their
  query string was malformed. There is no caller/email request parameter
  anywhere in this feature; the caller is always the authenticated session,
  never request-supplied.
- Bounded query validation: `view` must be a known value, `q` is capped at
  200 characters, `cursor` is bounded to the base64url alphabet (it is an
  opaque blob, not a SignKit identifier), `limit` defaults to 25 and is
  capped at 100. The query candidate object is built with `Object.create(null)`
  and only ever receives the four fixed, allow-listed keys -- a parameter
  named `__proto__` or `constructor` is rejected outright, never
  reinterpreted as a prototype or constructor reference. An unknown query
  parameter or a duplicated known one is likewise rejected (400) rather than
  silently ignored or silently resolved to whichever occurrence won.
- A resolution failure for the durable store maps to 503; a read failure
  from the store maps to 502; an invalid cursor maps to 400. Every failure
  carries a `kind` (`'authorization' | 'validation' | 'store'`) alongside the
  HTTP `Response`, so a caller of `resolveDashboardWorklist` can tell a
  storage outage apart from an authorization or validation failure without
  re-parsing the response body.

The SSR loader (`+page.server.ts`) `await`s `parent()` first, so
`+layout.server.ts`'s own redirect/error (anonymous caller, unbootstrapped
instance, non-active member) takes effect before any worklist read is
attempted -- but authority for the read itself still comes from
`resolveDashboardWorklist` reading `locals` directly, never from the
parent's already-resolved `instanceMemberRole`. An `authorization` or
`validation` failure independently fails the whole render closed (a redirect
to `/auth/login` or `/settings`, or SvelteKit's `error()`), mirroring the
layout's own fail-closed behavior; it is never folded into a successful page
with a populated `worklistError`. Only a `store`-kind failure renders as a
retryable `worklistError` with `worklist: null` -- the one case where the
page itself renders normally and lets the UI offer a retry. The loader also
sets `cache-control: private, no-store`.

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
