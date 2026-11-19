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

[Automatic signing dates](envelope-model.md#entered-dates-and-automatic-signing-dates) are shown as
read-only, with an automatic indicator and the frozen time zone available to the signer. They do
not appear as missing input or inflate manual required-field progress. No browser-generated date
is shown as an already recorded signing date. They are filled only by the final explicit signing
command; entered dates retain their calendar input.

A filled field, viewing a PDF and completing a recipient's action are separate states. Signing and
approval retain explicit confirmation; merely navigating or filling fields never submits an action.
Approvers do not see signer progress. Existing action controllers retain retry and idempotency
behavior. [Sent PDF guarantees](envelope-model.md#sent-agreement-rendering) and
[terminal receipt authority](authorization-and-instance-administration.md#recipient-terminal-receipts)
remain the governing contracts.

## Signing instructions

The canonical send event for new envelopes selects signing instruction version 1 and commits
an ordered list of the exact sent PDF digests. The send event hash in the recipient workspace
identifies that version of the agreement. The recipient sees the versioned consent statement in
the final confirmation. Its accepted locale and text digest, the send event hash, and the field
generation are stored in the same `recipient.signed` event as the signer, revision, field value
digests and signing time. The envelope is bound by the audit hash context. A sender who is also a
signer uses their recipient capability and confirms in the same way. Approvals and views follow
their own workflows.

The browser and bearer API submit the instruction version, displayed locale and reviewed send
hash with the signing request. An absent or mismatched instruction on a marked send fails before
any decision is recorded. A later revision requires a fresh send and a fresh instruction. Exact
replay reproduces the committed decision and instruction. Envelopes already sent without the
marker retain their original request, receipt and evidence formats. Such decisions carry no
versioned instruction.

Completion evidence verifies every named signer's instruction against the sent document set and
its audit event. The existing executed PDF and publication checks connect that evidence to the
document bytes and permitted field overlays. This record attests the recipient-capability action.
Signing-time identity verification, independently retained evidence and provider key authorization
require their own trust controls.

A terminal receipt shows the recipient's action once, its recorded time, whole-envelope progress
and the explanation that document access and action authority have ended. It does not reconstruct
an active document workspace. Completing one recipient's action never implies that every recipient
has finished.
