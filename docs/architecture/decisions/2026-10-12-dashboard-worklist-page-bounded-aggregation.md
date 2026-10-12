# Dashboard worklist: page-bounded recipient aggregation and cursor precision

Date: 2026-10-12

Status: Accepted

## Context

A further review found two remaining correctness gaps in the worklist read
path (see [read model](./2026-10-12-dashboard-worklist.md) and
[correctness fixes](./2026-10-12-dashboard-worklist-correctness-fixes.md)):

1. The page-of-rows query built `first_recipient`/`next_actionable`/
   `recipient_agg` by windowing or grouping the _entire_ `recipient` table
   before joining down to the already-`LIMIT`-ed page of envelopes. On D1,
   SQLite's planner happened to use an indexed per-`envelope_id` search once
   restricted to `envelope_id IN (SELECT id FROM page_envelopes)`. On
   PostgreSQL, `EXPLAIN` showed the planner choosing a `Seq Scan` over the
   whole `recipient` table via a hash semi-join for that same `IN (subquery)`
   form -- proportional to total recipient volume, including historical and
   terminal envelopes far outside the page.
2. The opaque pagination cursor's `updatedAt` was produced by
   `Date#toISOString()` on PostgreSQL, which truncates to millisecond
   precision. `postgres` (the driver) independently reintroduces the same
   truncation on the way _in_: any JS value bound as a `timestamptz`-cast
   parameter is round-tripped through its own `Date`-based serializer before
   it reaches the wire, discarding microseconds regardless of how precise
   the original string was.

## Decision

- PostgreSQL's recipient lookups are now `LEFT JOIN LATERAL` subqueries
  correlated to `page_envelopes pe` one row at a time (`WHERE
recipient.envelope_id = pe.id`, `ORDER BY ... LIMIT 1` for first-recipient
  and next-actionable, a plain aggregate for progress), never an `envelope_id
IN (SELECT id FROM page_envelopes)` form. The correlation keeps summaries
  scoped to each selected envelope and allows indexed lookups. PostgreSQL
  still chooses the physical plan; this is not a guarantee of one index
  plan for every dataset or configuration. The integration test checks
  `EXPLAIN` with 300 off-page historical envelopes.
- D1's three recipient CTEs are restricted to `envelope_id IN (SELECT id
FROM page_envelopes)`, which SQLite's planner already answers as an
  indexed `SEARCH recipient USING (COVERING) INDEX ... (envelope_id=?)` for
  every reference -- confirmed by an `EXPLAIN QUERY PLAN` assertion in
  `d1-dashboard-store.integration.spec.ts` that fails if any step becomes a
  bare `SCAN recipient`.
- Both stores' active-turn predicate (`action_required`/`waiting`, used by
  the counts query, the page bucket filter, and the final `actionRequired`
  column) is now a correlated per-envelope `EXISTS` with an inline
  `MIN(routing_order)` subquery, not a `ROW_NUMBER()` window over the whole
  table. The whole-instance counts query therefore no longer carries its own
  `next_actionable` CTE/window at all; it scans `envelope` once and evaluates
  the correlated predicate only for rows already matched to
  `sent`/`in_progress`.
- The cursor's ordering timestamp is now minted in SQL with explicit
  microsecond precision -- `to_char(e.updated_at AT TIME ZONE 'UTC',
'YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z'` on PostgreSQL -- carried through
  `DashboardRow.updatedAtOrdering`, separate from the existing display
  `updatedAt` field (unchanged). Comparing a decoded cursor against stored
  data binds the validated timestamp as `text` before casting it to
  `timestamptz`. The driver therefore preserves the exact string on the wire;
  PostgreSQL parses its explicit UTC `Z` suffix independently of the
  connection's `TimeZone`. Integration tests cover microseconds, exact ties,
  and a connection configured to `Asia/Tokyo`.
- `decodeDashboardCursor` validates the timestamp's calendar fields
  explicitly (year/month/day/hour/minute/second ranges, including leap-year
  February 29) instead of relying on `Date.parse`, which normalizes an
  out-of-range date (`2026-02-30` becomes `2026-03-02`) rather than rejecting
  it. Year `0000` is rejected, matching PostgreSQL's `timestamptz`, which has
  no year zero.

## Consequences

Per-page recipient summaries no longer window or group all historical
recipients. Whole-instance counts still scan envelopes, and search/view
selection can inspect matching candidates, so total query cost is not
constant with workspace size. The integration tests guard the indexed
summary access pattern. A keyset cursor now carries the same precision PostgreSQL actually
stores, so two envelopes updated within the same millisecond (a controlled,
synthetic scenario the real application's own `Date.now()`-based writes do
not currently produce, but the column type allows and a future write path
could) no longer risk a skipped or repeated row. A tampered or malformed
cursor timestamp is rejected before any query runs, never silently
reinterpreted as a different, rolled-over calendar date.

## Alternatives considered

- **Keep `envelope_id IN (subquery)` and add a PostgreSQL planner hint
  (`SET enable_seqscan = off`) around the query:** rejected. Session-level
  planner hints are blunt, affect unrelated statements in the same
  transaction, and do not address the actual access pattern; per-envelope
  correlation expresses the intended lookup without changing planner settings.
- **Store microseconds by having the write path use a higher-precision
  clock:** rejected as out of scope here -- the write path's precision is a
  separate, unrelated decision, and the cursor must be correct for whatever
  precision the column actually holds, not only for what today's writers
  happen to produce.
- **Decompose timestamps into numeric `make_timestamptz` arguments:** not
  needed. Binding as `text` first preserves precision and the UTC suffix
  without a second timestamp parser or reliance on the session timezone.
