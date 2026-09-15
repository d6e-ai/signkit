# Security Policy

## Supported versions

SignKit is pre-1.0 and has no long-term-support policy. Only the latest tagged release and the `main` branch are supported; please upgrade before reporting an issue against an older tag.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/d6e-ai/signkit/security/advisories/new) (the repository's Security tab → "Report a vulnerability"). Do not open a public issue for security reports.

This is a small, early-stage project maintained without a dedicated security team, so responses are best-effort — we aim to acknowledge reports within a few days, but there is no formal SLA.

## Scope

Areas of particular interest, drawn from the project's own risk register in [docs/architecture/deployment-and-risks.md](docs/architecture/deployment-and-risks.md):

- cross-tenant data leakage between organizations
- webhook SSRF, DNS rebinding, or signing-secret handling
- credential, session, and encryption-key handling
- the fail-closed instance bootstrap gate (owner email match vs local-only unsafe opt-in)

See that document for the full, current list of known risk classes before filing a report.
