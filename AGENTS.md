# Working in SignKit

- Start documentation lookup at [docs/README.md](docs/README.md). Read only the topic and sections
  relevant to the change, not the entire documentation tree.
- Architecture specifications define required guarantees; code and tests show what is implemented.
  Report disagreements instead of treating a proposal as shipped or silently weakening a guarantee.
- Keep current specifications in `docs/architecture/`, dated decision rationale in
  `docs/architecture/decisions/`, and usage/runbooks elsewhere in `docs/`. Decisions are optional
  background, not prerequisites for understanding a feature.
- Maintain one canonical description of each contract. Link to it rather than copying it into
  indexes, ADRs, guides, or skills. Keep README human-readable.
- Do not retain completed plans, investigation transcripts, PR/test-count logs, or superseded
  designs as current documentation. Git preserves their history.
- Never put deployment-specific accounts, domains, identities, resource IDs, credentials, or backup
  contents in repository documentation.
