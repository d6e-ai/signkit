# Request-scoped authorization reads and consistent envelope detail

Date: 2026-10-12
Status: Accepted

## Context

Repeated public-key fetches and duplicate member reads add latency before a page can load. D1 envelope detail also reads related rows through several sequential calls. Envelope-wide signature-field queries cannot use the existing partial document indexes efficiently.

## Decision

- Retain a bounded set of jose remote JWKS resolvers keyed by the configured JWKS URL. Only public verification keys are shared; each token still passes the existing signature, issuer, audience, expiry, and identity-claim validation. jose continues to control key refresh, rotation, and retry behavior.
- Share the authenticated caller's membership result between the hook and root layout only within the same request. Another caller or another request must resolve its own membership. Persistence failure remains unavailable, never an empty-instance or active-member result.
- Keep mutation-time authorization guards and API-key ownership checks unchanged. A read snapshot is not authority to bypass a later atomic mutation check.
- Fetch D1 envelope detail in one transactional batch, preserving the existing row validation and public projection. Add forward read indexes matching the envelope-wide field queries without replacing the document-specific indexes.
- Handle dashboard aggregation and client-side request waterfalls separately in issue #233; they change the read API and loading behavior rather than just persistence mechanics.

## Consequences

A membership change after the current request's read snapshot is observed on the next request; no membership snapshot survives across requests. Mutations retain their existing durable authorization boundary. Cold isolates and resolver eviction can still require a JWKS fetch. On Workers, jose does not share a request-bound pending fetch between concurrent cold requests.

The detail batch returns related rows from one read boundary and reduces D1 round trips without introducing a provider-neutral transaction framework. The indexes require a normal forward migration on each supported database.

Local query-plan and call-count tests demonstrate the eliminated work. They do not establish deployed latency, database placement, or Core Web Vitals; those require separate measurements after deployment.
