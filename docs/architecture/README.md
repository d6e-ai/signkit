# Architecture

Read the specification for the behavior you are changing, not this entire tree.
[Overview](overview.md) is a short introduction; usage and operations start at the
[documentation task map](../README.md).

Specifications define required guarantees. Code and tests establish what is implemented; a
disagreement is documentation or implementation drift to resolve, not permission to weaken the
guarantee or claim planned work is shipped.

| Topic                                                              | Specification                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Envelope states, ready/reopen/send, fields, and sent PDFs          | [Envelope model](envelope-model.md)                                       |
| Markdown revisions, ordered PDF manifests, archive limits          | [Draft Git](draft-git-repository.md)                                      |
| Persistent identifiers                                             | [UUIDv7 identifiers](identifiers.md)                                      |
| Operator, API-key, recipient, membership, and invitation authority | [Authorization](authorization-and-instance-administration.md)             |
| Authorized member and invitation display labels                    | [Instance display metadata](instance-display-metadata.md)                 |
| Private saved recipients                                           | [Contact book](recipient-contact-book.md)                                 |
| Sender preparation and final review                                | [Sender workflow](sender-workflow.md)                                     |
| Recipient document review and field navigation                     | [Recipient workflow](recipient-workflow.md)                               |
| Review through an agent or CLI                                     | [Contract review workflow](contract-review-workflow.md)                   |
| Dashboard reads, filters, search, and pagination                   | [Worklist](dashboard-worklist.md)                                         |
| SQL/object ownership, atomicity, migrations                        | [Persistence](persistence.md)                                             |
| Behavior-preserving code changes                                   | [Code boundaries](code-boundaries.md)                                     |
| Completion publication, evidence, PDF, and delivery                | [Completion artifacts](completion-artifacts.md)                           |
| Explicit terminal-mail recovery                                    | [Completion access reissue](completion-access-reissue.md)                 |
| Recipient invitation replacement                                   | [Invitation replacement](recipient-invitation-replacement.md)             |
| Drawn-signature storage and collection                             | [Signature asset retention](signature-asset-retention.md)                 |
| Optional PAdES instance sealing                                    | [PDF sealing](pdf-sealing.md)                                             |
| CI-only seal fixtures and validators                               | [PAdES conformance](pades-conformance.md)                                 |
| Durable DOCX import/export                                         | [DOCX conversion jobs](docx-conversion-jobs.md)                           |
| Mail providers, TLS, and delivery failure classification           | [Mail delivery](mail-delivery.md)                                         |
| Agent API, idempotency, and webhooks                               | [Agent contract](agent-contract.md)                                       |
| Localization and licensing policy                                  | [Documents, localization, open core](documents-localization-open-core.md) |
| Supported hosting boundaries and risks                             | [Deployment and risks](deployment-and-risks.md)                           |
| cf configuration and compatibility paths                           | [Cloudflare tooling](cloudflare-tooling.md)                               |
| Deployment CLI internals and release verification                  | [create-signkit](create-signkit.md)                                       |

[Decision records](decisions/README.md) explain choices only when their rationale is needed.
Completed plans, test-run logs, and superseded proposals belong in Git history, not in the current
specification or its reading prerequisites.
