# SignKit API endpoint reference

## Discovery

- `GET /api/v1/system/capabilities`
- `GET /api/v1/openapi.json`

## Envelope API-key surface

| Scope | Endpoints |
| --- | --- |
| `envelopes:read` | envelope list/detail, draft read, DOCX export, delivery status, completion status/evidence/PDF, PDF seal status and sealed PDF download |
| `drafts:write` | create envelope, commit draft, import DOCX, upload/reorder documents, ready, place fields |
| `envelopes:send` | send, void, and explicitly request a PDF seal |

All routes are rooted at `/api/v1/envelopes`. Path templates are discoverable from the capability document and OpenAPI description.

After `pdfSeal.status` becomes `published`, download the independently validated sealed bytes from
`GET /api/v1/envelopes/{envelopeId}/pdf-seal/pdf`. A not-yet-published seal returns an RFC 9457
`404`; integrity or storage failure returns `503`. The response is private, non-cacheable
`application/pdf` and never reveals object-store coordinates.

## Human-session administration

`/api/v1/instance/**`, `/api/v1/api-keys`, and `/api/v1/webhooks` require an authenticated browser session and active local role. Presenting an API key to these surfaces is refused.

## Recipient surface

`/api/v1/signing/**` uses recipient capability or encrypted recipient-session authority. `/s/{capability}` exchanges the link for a browser session and redirects to `/{locale}/sign/{envelopeId}`.

## Common problem families

- `400`: validation or missing idempotency key
- `401`: missing, unknown, revoked, or expired credential
- `403`: insufficient scope or disallowed credential family
- `404`: resource not found without cross-boundary disclosure
- `409`: idempotency, generation, state, or audit-head conflict
- `413`: bounded request exceeded
- `429`: durable API-key rate limit
- `503`: persistence, object storage, identity verification, or integrity unavailable
