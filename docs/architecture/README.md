# SignKit architecture

Status: normative draft

Last updated: 2026-09-13

These files are the normative architecture, security, and evidence contracts for SignKit. Together they win over [`../api.md`](../api.md), [`../cli.md`](../cli.md), [`../deployment.md`](../deployment.md), and [`../development.md`](../development.md) on any disagreement; those documents summarize what is implemented today and link back into these sections. No individual file below restates that precedence.

| File                                                                                         | Covers                                                                                                    | Status                                                                                                                        |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [overview.md](overview.md)                                                                   | Product boundary and layered architecture                                                                 | policy                                                                                                                        |
| [envelope-model.md](envelope-model.md)                                                       | Envelope state machine, roles, ready/send/fields commands                                                 | implemented                                                                                                                   |
| [draft-git-repository.md](draft-git-repository.md)                                           | Git-backed Markdown draft storage                                                                         | implemented                                                                                                                   |
| [persistence.md](persistence.md)                                                             | Database/object profiles, tenancy rules                                                                   | implemented                                                                                                                   |
| [identifiers.md](identifiers.md)                                                             | UUIDv7 identifier minting and validation                                                                  | implemented                                                                                                                   |
| [authorization-and-instance-administration.md](authorization-and-instance-administration.md) | Operator/recipient authority, recipient decisions, API key grants, instance bootstrap/members/invitations | implemented                                                                                                                   |
| [completion-artifacts.md](completion-artifacts.md)                                           | Completion manifest publication and delivery (Slices A/B); capability reissue                             | implemented — publication, delivery, visual PDF, and capability reissue; cryptographic PDF sealing is backlog                 |
| [agent-contract.md](agent-contract.md)                                                       | Agent/CLI command contract                                                                                | implemented — CLI reads, evidence/PDF download, authoring/send/DOCX mutations, served OpenAPI 3.1, signed retryable webhooks  |
| [documents-localization-open-core.md](documents-localization-open-core.md)                   | DOCX/PDF derivation, localization, open-core licensing boundary                                           | mixed — localization, bounded DOCX, visual completion PDF; cryptographic PDF sealing is backlog; open-core boundary is policy |
| [deployment-and-risks.md](deployment-and-risks.md)                                           | Deployment target boundary and the primary risk register                                                  | mixed — deployment targets are implemented (scaffolded); the risk list is policy, not a status claim                          |

Rationale for early decisions, not normative today, lives in [decisions/](decisions/README.md).

## Reading order

For newcomers: [overview](overview.md) → [envelope-model](envelope-model.md) → [draft-git-repository](draft-git-repository.md) → [persistence](persistence.md) → [identifiers](identifiers.md) → [authorization-and-instance-administration](authorization-and-instance-administration.md) → [completion-artifacts](completion-artifacts.md).
