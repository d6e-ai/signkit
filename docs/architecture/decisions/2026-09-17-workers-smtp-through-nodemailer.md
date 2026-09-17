# Workers SMTP through Nodemailer 10 — 2026-09-17

## Context

The original mail-provider decision limited `smtp` to Node/Docker and Vercel because the project had not established a supported SMTP implementation on Cloudflare Workers. That made the provider selector depend on the runtime even though Nodemailer 10 now documents its ESM SMTP transport as supported on Workers with `nodejs_compat`.

## Decision

Use the existing `NodemailerSmtpMailSender` on Cloudflare Workers as well as Node. `resolveWorkerMailSender` is asynchronous so it can dynamically import the SMTP adapter only when `SIGNKIT_MAIL_PROVIDER=smtp`. The native `EMAIL` binding remains the implementation of `SIGNKIT_MAIL_PROVIDER=cloudflare` on Workers.

Workers reject SMTP port 25 before constructing a transporter because the platform prohibits outbound port 25. All other SMTP validation and security invariants remain shared with Node: explicit TLS mode, mandatory STARTTLS when implicit TLS is disabled, TLS 1.2 minimum, paired credentials, forced authentication when credentials are present, bounded timeouts, and recipient-scoped permanent-failure classification. Missing, invalid, or runtime-incompatible configuration fails closed without switching providers.

The checked-in Wrangler profiles and `create-signkit --cloudflare` continue to default to the native Cloudflare Email binding. A self-hosted operator may explicitly select `smtp` and provide `SIGNKIT_SMTP_*`; the managed installer exposes the same choice with `--mail-provider smtp`, omits the `EMAIL` binding, and accepts the SMTP password only through its bounded secret-stdin flow.

## Consequences

- Workers and Node support the same two provider choices without changing the `MailSender` port or durable outbox semantics.
- Workers SMTP requires `nodejs_compat`, already present in both Wrangler profiles, and a public SMTP submission endpoint other than port 25.
- The `EMAIL` binding is required only when `cloudflare` is selected; SMTP does not silently fall back to it.
- A Cloudflare build is a required regression check because the Worker bundle now includes Nodemailer's ESM SMTP path.
