# Initial architecture decisions — 2026-09-11

These notes record the rationale behind the normative design in `docs/design.md`.

- Scaffolded the application at the repository root with the official `sv create` CLI and pnpm.
- Chose the shadcn-svelte Luma preset and its official Sidebar primitive for the application shell.
- Chose an original implementation rather than moving OpenSign or Documenso code. Their behavior informed product analysis, but their AGPL/commercial licensing boundaries make copy-based migration inappropriate without a deliberate license decision.
- Adopted one envelope per send, with several ordered files and one Git repository per envelope.
- Limited Git tracking to Markdown source. DOCX, PDF, signatures, and evidence bundles are derived objects.
- Made Node/PostgreSQL/S3 and Cloudflare/D1/R2 equal first-class profiles. Vercel remains lower priority.
- Assigned SAML/enterprise SSO responsibility to d6e-auth. SignKit retains tenant authorization, signing capabilities, and agent credentials.
- Defined audit capture as open-source infrastructure; paid licensing applies to export, SIEM, policy, and compliance capabilities.
- Kept workflow automation generic. d6e can compose pre-sign and post-sign workflows through versioned commands and webhooks without customer-specific logic in SignKit.
