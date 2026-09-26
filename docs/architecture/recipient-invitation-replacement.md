# Recipient invitation replacement

The sender's Recipients tab exposes the existing session-authorized `POST /api/v1/envelopes/{envelopeId}/recipients/{recipientId}/reissue` command. Replacement changes only that recipient's invitation authority and delivery. It does not recreate the envelope, change the pinned documents or fields, or reset another recipient's decision.

## Eligibility and confirmation

Each recipient has at most one action, independent of how many delivery-history rows exist. The action is available for pending or viewed recipients of sent or in-progress envelopes. Unknown delivery status, routing-blocked delivery and an active delivery attempt disable the action. The server remains authoritative for membership, eligibility, concurrency and terminal transitions; an API key cannot invoke this session-only command.

The confirmation identifies the recipient and explains that the existing invitation link will stop working and a replacement email will be sent later. Copy is role-neutral because invitations also serve approvers and viewers. A successful receipt confirms durable publication, not successful email delivery. Delivery remains the responsibility of the existing retryable outbox.

## Ambiguous results and page state

Delivery history is not a recipient list: replacement appends an additional delivery for the same recipient. Read-only history rows use their distinct projection-row identities rather than recipient IDs, so all deliveries remain visible without duplicate-key rendering errors. The recipient table remains independently keyed by its unique recipient IDs.

The page maintains an independent idempotency attempt for each recipient. A network failure, HTTP 408/429/5xx, malformed JSON or an invalid successful receipt retains the same key. Closing and reopening the confirmation, including switching to another recipient and back, does not discard that attempt. A known rejection or a validated successful receipt clears the attempt for a later intentional replacement. Pending state prevents duplicate clicks and confirmation dismissal.

The client allowlists the receipt and verifies that its envelope and recipient identifiers match the request. Invitation tokens, sealed values, audit internals and storage identifiers are never accepted into the public receipt or displayed by this UI.

On success, the attempt is confirmed and the dialog closes before status refresh begins. A failed refresh therefore shows a separate warning alongside the successful replacement notification; it never tells the sender that the replacement failed or invites an accidental second mutation. No browser-local attempt state is a source of authorization: subsequent page loads still read server state, and every mutation is independently authorized.

## Verification

Client tests cover scoped paths, receipt allowlisting, replay headers and the actual retry request's idempotency header. Browser tests exercise confirmation, pending state, ambiguous retries, eligibility and post-success refresh failures. Deployment acceptance additionally requires a synthetic invitation's old link to be rejected, its replacement email and link to work, exactly one command and audit event to publish, and the document revision to remain unchanged.
