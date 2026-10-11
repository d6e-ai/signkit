# Sender workflow

The sender prepares documents, recipients, signature positions, and a final
review. `draft` and `ready` are persistence states, not actions a sender must
understand. The sidebar, theme, shared page container, and design tokens stay
consistent with the rest of SignKit.

## Forward actions

- Documents: save pending edits before continuing. Committed files have a PDF
  preview; text editing and technical details are secondary controls.
- Recipients: validate identity beside each input, focus the first invalid
  input, and preserve entered values after failures. The same gate applies
  when tabs or keyboard input bypass the usual step order. Save document edits
  before the internal ready command.
- Signature positions: load the complete private authoring field set before
  editing. Its revision, IDs, count, public metadata, and document/recipient
  links must agree with the current detail projection. An incomplete or stale
  read cannot become a replace-all baseline. Saving refreshes that baseline
  using the new field IDs from the mutation receipt.
- Review: list documents, recipients, their languages and roles, and placement
  readiness with nearby correction actions. Only the final Send action starts
  delivery; navigation to review does not send. No second send-confirmation
  dialog is needed after this review.

Each step has one primary forward action. Optional saves, export, contacts, and
corrections are secondary. Invalid input does not disable the forward action:
attempting it gives an actionable inline error. Pending requests and unavailable
data can disable operations to prevent races.

## Corrections and unsaved work

Ready but unsent envelopes can be reopened for document or recipient changes
through the [atomic reopen command](decisions/2026-10-11-envelope-reopen-and-authoring-fields.md).
Stored recipients are prefilled, including role, language, and routing order.
Reopening clears signature positions, so this consequence requires confirmation.
Saved positions remain editable while ready; sent or closed envelopes remain
read-only. A failed reopen does not clear local fields or navigate away.

Unsaved document, recipient, and placement edits warn before internal navigation
or reload. Full-page navigation uses the native unload warning, without a second
custom confirmation. Removing all retained recipients must not restore them
during a document-save reload.

PDF upload, DOCX import, and document reordering or removal save pending text
first. They use the refreshed revision and retain new manifest members. A failed
refresh stops the subsequent mutation rather than submitting a partial document
list. Form edits and document mutations are locked while a request is in flight.

## Design basis and verification

[NN/g heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) and
[progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
inform familiar terms and secondary technical controls. The primary action and
final review follow [GOV.UK buttons](https://design-system.service.gov.uk/components/button/)
and [check answers](https://design-system.service.gov.uk/patterns/check-answers/).
These are design choices, not claims of WCAG conformance or legal certification.

Browser tests cover save failures, tab jumps, retained recipients, unload guards,
placement hydration, final-send gating, and a real 390px viewport. Automated
tests do not replace testing with first-time users.
