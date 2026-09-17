# ADR: require release provenance before Cloudflare mutation

Date: 2026-09-16

## Status

Accepted

## Context

The release manifest and bundle are assets in the same mutable publishing
system. Matching SHA-256 values prove that the selected bytes match the
manifest, but a replaced bundle plus replaced manifest could still agree.
The release workflow already publishes GitHub build-provenance attestations
with `actions/attest`; the deployment CLI must make that independent identity
evidence part of its trust boundary.

## Decision

`create-signkit plan`, `deploy`, and `upgrade` download the selected Cloudflare
bundle once and hash those exact bytes. Before any recovery-file creation or
Cloudflare mutation, the CLI queries the official `d6e-ai/signkit` GitHub
attestation endpoint for that digest and verifies every returned bundle using
Sigstore's online public-good trust root.

The certificate and signed SLSA provenance must agree on:

- the immutable SignKit repository and owner ids;
- the public `release-cloudflare-bundle.yml` workflow, tag ref, and source
  commit;
- a GitHub-hosted runner triggered by the tag push;
- SLSA provenance v1 with the GitHub Actions workflow build type;
- exactly one subject matching the release bundle basename and downloaded
  SHA-256.

Stable and beta releases use the same mandatory policy. Multiple equivalent
attestations from workflow reruns are accepted. Missing, conflicting, invalid,
malformed, oversized, or unavailable provenance fails closed. Verification is
online-only: stale trust-root fallback is not allowed. Attestation lists,
compressed bundles, decompressed JSON, and HTTP requests have explicit bounds.
Signed blob URLs and certificate contents are not included in output.

Release tags are limited to 35 ASCII bytes. This keeps every expected Fulcio
OID claim in DER UTF8String short-form encoding, which the selected
`sigstore` verifier compares without a binary-to-text conversion ambiguity.
Longer tags are rejected during release selection, before bundle or
attestation download.

The verified bytes remain in memory and are passed directly to extraction;
the bundle is not downloaded again. `plan` therefore performs release network
I/O but remains free of deployment-state, recovery-file, or Cloudflare
mutation. Sigstore may create or refresh its standard per-user TUF
trust-metadata cache. `adopt` does not select a release and does not perform
provenance verification.

## Consequences

- A bundle and matching replaced manifest cannot deploy without matching
  GitHub/Sigstore evidence from the pinned release workflow.
- Deployments fail safely while GitHub or Sigstore trust-root services are
  unavailable; operators cannot bypass verification with the beta channel.
- `plan` downloads the release bundle, so it is slower and uses more bandwidth
  than a manifest-only preview.
- Workflow, repository, or ownership identity changes require an explicit
  code and policy update before new releases become deployable.
