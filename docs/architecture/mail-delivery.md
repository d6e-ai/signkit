# Mail delivery

Mail uses the `MailSender` port and durable SQL outboxes. Queue and scheduler adapters trigger
drains; they do not replace SQL as the publication, lease, or retry authority. Provider acceptance
and SQL completion are separate, so delivery is at-least-once and rare duplicate messages are
possible.

## Provider selection

`SIGNKIT_MAIL_PROVIDER` explicitly selects `smtp` or `cloudflare`, independently of the host
profile. Missing or invalid configuration fails closed; there is no fallback to a different
provider.

- Workers use Nodemailer for SMTP or the `EMAIL` binding for Cloudflare email. The binding is
  required only for the latter. SMTP requires `nodejs_compat`; SignKit rejects SMTP port 25 on
  Workers.
- Node/Docker use the same SMTP adapter or Cloudflare Email Sending's REST adapter. Selecting one
  must not initialize the other's transport.

Configuration and rotation procedures belong in [deployment](../deployment.md), not in a duplicate
variable reference here.

## SMTP contract

- `SIGNKIT_SMTP_SECURE` must be explicit. `true` means implicit TLS; `false` requires STARTTLS.
  Neither mode permits plaintext fallback; the minimum TLS version is 1.2.
- Credentials are an all-or-none username/password pair. Password bytes are not trimmed. Configured
  credentials force authentication even if the server stops advertising AUTH.
- Only a proven 5xx `RCPT TO` rejection naming the message's own recipient is terminal.
  Authentication, sender setup, DATA failures, rate limits, transport failures, and unknown
  responses remain retryable. A 5xx code alone is not enough to discard an invitation or its sealed
  token.
- Provider details are reduced to safe error codes; credentials and server response bodies must not
  enter logs, problem responses, or audit evidence.

The executable contract is in [`smtp.ts`](../../src/lib/adapters/mail/smtp.ts),
[`smtp-config.ts`](../../src/lib/adapters/mail/smtp-config.ts), and their specs. Provider
composition is in [`mail-runtime.ts`](../../src/lib/application/mail/mail-runtime.ts).

## Feature-specific recovery

Invitation expiry and ciphertext scrubbing follow
[instance administration](authorization-and-instance-administration.md). Completion-PDF dependencies
and attachments follow [completion delivery](completion-delivery.md). Terminal completion-mail
recovery is a separate [explicit reissue](completion-access-reissue.md), not an automatic transport
retry or a resurrection of an old grant.
