# Mail provider: SMTP and Cloudflare — 2026-09-14

Invitation and completion delivery previously picked a mail transport implicitly from whichever credentials were present: the native `EMAIL` binding on Cloudflare Workers, or the Cloudflare Email Sending REST API everywhere else. There was no way to run Node/Docker or Vercel against a generic SMTP relay, and no explicit switch recording which transport a deployment intended to use.

## Decision

Introduce `SIGNKIT_MAIL_PROVIDER` as the single, explicit selector for mail transport, accepting exactly two values:

- `smtp` — a production-quality Nodemailer SMTP client, available on Node/Docker and Vercel only.
- `cloudflare` — Cloudflare Email Sending: the native `EMAIL` binding on Workers, the existing REST sender on Node/Docker and Vercel.

SignKit intentionally supports only the native `EMAIL` binding on Cloudflare Workers and does not bundle or support a Worker SMTP client, so `smtp` is rejected there (fails closed) rather than attempted, regardless of what the Workers runtime itself can otherwise do on the network. The existing Cloudflare REST sender for non-Workers runtimes is kept as-is under the `cloudflare` provider; there was no evidence justifying its removal.

Resend, and any other SMTP-speaking provider, is reached exclusively through `smtp` and its ordinary SMTP endpoint and credentials — there is no Resend-specific adapter, configuration field, or code path. This keeps the provider surface at exactly two values and avoids a per-vendor adapter that would only wrap the same SMTP protocol.

The generic SMTP configuration (`SIGNKIT_SMTP_HOST`, `SIGNKIT_SMTP_PORT`, `SIGNKIT_SMTP_SECURE`, `SIGNKIT_SMTP_USERNAME`, `SIGNKIT_SMTP_PASSWORD`) has no plaintext path: `SIGNKIT_SMTP_SECURE` is required and must be exactly `true` (implicit TLS) or `false` (mandatory STARTTLS that aborts rather than falling back to plaintext) — there is no default, so unset or blank fails closed. Username and password must be supplied together or not at all; the password is never trimmed, so its exact bytes reach the server. An unset, malformed, or runtime-incompatible provider or configuration resolves to no mail sender (fail closed) rather than guessing intent, matching how missing delivery configuration already behaved before this change.

SMTP failure classification preserves the existing durable-outbox invariant (see [envelope-model.md](../envelope-model.md)): provider authentication, sender setup, unknown-provider errors, transport failures, and rate limits all remain retryable, and only a proven recipient-scoped permanent rejection is terminal. A bare 5xx reply code is not sufficient proof — AUTH, MAIL FROM, and DATA can all fail at 5xx for reasons unrelated to the recipient. Only Nodemailer's `RCPT TO` rejection of the message's own recipient, at a permanent (5xx) reply, is treated as non-retryable; everything else, including EAUTH/ENOAUTH, is retryable by design. `forceAuth` is set whenever credentials are configured, so a server that silently fails to advertise `AUTH` cannot make the client send unauthenticated instead of failing closed.

## Consequences

- `resolveWorkerMailSender` and `resolveNodeMailSender` (`src/lib/application/mail/mail-runtime.ts`) are now the single place recipient invitation, instance invitation, and completion delivery resolve a `MailSender`, replacing duplicated ad hoc selection.
- `wrangler.jsonc` and `wrangler.build.jsonc` ship `SIGNKIT_MAIL_PROVIDER=cloudflare` as a plain (non-secret) `vars` entry, so Workers deployments do not need to set it separately and cannot accidentally select `smtp`.
- Every existing Node/Docker or Vercel deployment that relied on Cloudflare Email Sending without setting a provider must now also set `SIGNKIT_MAIL_PROVIDER=cloudflare`, or delivery stops (fails closed) rather than silently continuing on the old default.
- The `MailSender` port, durable outboxes, retry/backoff behavior, idempotent delivery, and error/secret sanitization are unchanged — only the transport selection and the addition of the SMTP adapter are new.
