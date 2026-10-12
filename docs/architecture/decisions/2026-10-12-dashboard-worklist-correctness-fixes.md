# Dashboard worklist correctness fixes

Date: 2026-10-12

Status: Accepted

## Context

Review of the first-pass [worklist backend](./2026-10-12-dashboard-worklist.md)
found five correctness gaps before the feature could ship: recipient
progress counts were not scoped to actionable roles; the PostgreSQL read used
the READ COMMITTED default instead of a shared snapshot; the pagination
cursor was a live envelope-id lookup rather than opaque self-contained
keyset data; D1/PostgreSQL result handling silently defaulted a malformed or
missing result to zero instead of failing; and the HTTP/SSR request helper
parsed the query before authorizing, so a malformed query from an
unauthenticated caller returned 400 instead of 401/403.

## Decision

- `completedRecipientCount`/`actionableRecipientCount` in both store adapters
  are now scoped to `signer`/`approver` recipients only, matching
  `isActionableRecipientRole`. A `cc`, `viewer`, or `prefill` recipient can no
  longer inflate either side of the progress ratio the worklist renders.
- `PostgresDashboardStore` issues `SET TRANSACTION ISOLATION LEVEL
REPEATABLE READ, READ ONLY` as the first statement inside its transaction,
  so the counts query and the rows query see one snapshot. A dedicated
  integration test captures the actual statement sent to PostgreSQL. A
  deterministic two-connection test also commits a write after counts have
  been read but before the page read, proving both reads retain one snapshot.
- The pagination cursor is now an opaque, self-contained, base64url-encoded
  `(updatedAt, id, view, query)` tuple (`application/dashboard/cursor.ts`),
  decoded without any database lookup. Decoding requires an exact match on
  the normalized `(view, query)` context; a mismatch or a malformed cursor
  throws `InvalidDashboardCursorError`, mapped to a 400 RFC 9457 response,
  never a 502. The external `DashboardQuery.cursor`/`DashboardPage.nextCursor`
  wire type remains an opaque string; only the decoded
  `DashboardCursorPosition` crosses into `DashboardStoreQuery`.
- Both store adapters now validate every result they get back -- D1 batch
  success flags and a well-typed counts row, a defined PostgreSQL counts row
  -- and throw rather than defaulting a missing or malformed result to zero.
  A thrown error propagates as a retryable failure; a genuinely empty
  instance still proves real zero counts through the same validated path.
- `resolveDashboardWorklist` now authorizes before parsing the query, and
  tags every failure with a `kind` (`'authorization' | 'validation' |
'store'`). The query candidate object is built with `Object.create(null)`
  against a fixed four-key allow-list, so a `__proto__` or `constructor`
  query parameter is rejected outright rather than risking prototype
  pollution or silent misinterpretation.
- `+page.server.ts` uses that `kind` to fail the whole render closed
  (redirect to `/auth/login`/`/settings`, or `error()`) for an
  `authorization` or `validation` failure, and only renders a retryable
  `worklistError` with `worklist: null` for a `store`-kind failure. It
  `await`s `parent()` first (so the layout gate's own redirect wins before
  any worklist read is attempted) but still derives authority from `locals`
  via the shared helper, never from the parent's resolved data, and sets
  `cache-control: private, no-store`.

## Consequences

Progress bars rendered from `completedRecipientCount`/`actionableRecipientCount`
can no longer show a false positive from a cc/viewer recipient, nor can they
ever exceed 100%. A PostgreSQL deployment under write load can no longer
return mutually inconsistent counts and rows for the same request. A cursor
survives the anchor envelope being updated or deleted between page requests,
and a stale or cross-filter cursor is rejected cleanly instead of silently
producing a wrong or empty page. A storage outage can no longer be confused
with zero recipients or zero envelopes, in either direction. An unauthorized
caller's request is never classified as merely malformed.

## Alternatives considered

- **Re-check the cursor's anchor row against the database on every call:**
  rejected again, for the same reason as the original design -- it ties
  pagination correctness to an anchor row's continued existence and current
  value, which this fix set out to remove.
- **Sign the cursor (HMAC) to prevent tampering:** rejected. The worklist is
  not scoped to data the caller doesn't already have read access to (the
  whole instance's envelopes); a forged cursor can only let a caller jump to
  an arbitrary position within data they can already see, which is not a
  security boundary.
- **Use a timing-based concurrent test alone:** rejected because the write
  might land before or after both reads. The test intercepts only the counts
  query's return boundary, commits using an independent connection, then
  allows the store to continue its real page query.
