# Recipient workflow

The active workspace starts with the agreement title, role, action status and link expiry. Decline
is a secondary action with its own confirmation. Documents remain the primary surface; the
browser-native PDF link is available during loading, after rendering and on failure, with one
open action per viewer.

Signers see progress for required fields and a next-missing-field action beside the documents.
The expandable field navigator names each destination's document and page. Selecting a field
switches to its document and waits for that viewer's page descriptors and mounted control before
scrolling and focusing. A later field selection or manual document switch cancels the earlier
focus request. Required-field validation uses the same navigation before opening final confirmation.
Optional fields remain available through the navigator and document overlays.

A filled field, viewing a PDF and completing a recipient's action are separate states. Signing and
approval retain explicit confirmation; merely navigating or filling fields never submits an action.
Approvers do not see signer progress. Existing action controllers retain retry and idempotency
behavior. [Sent PDF guarantees](envelope-model.md#sent-agreement-rendering) and
[terminal receipt authority](authorization-and-instance-administration.md#recipient-terminal-receipts)
remain the governing contracts.

A terminal receipt shows the recipient's action once, its recorded time, whole-envelope progress
and the explanation that document access and action authority have ended. It does not reconstruct
an active document workspace. Completing one recipient's action never implies that every recipient
has finished.
