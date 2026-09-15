# Release publishing integrity — 2026-09-15

## Context

The tag workflow installed `npm@^11.5.1` dynamically inside the privileged
publish job and uploaded release assets with `--clobber`. A rerun could
therefore select a different npm implementation or replace bytes already
attached to the tag. Manifest SHA-256 protected consumers only relative to the
manifest stored in that same release, and no provenance attestation was
generated.

## Decision

- Pin npm exactly in root `package.json` and `pnpm-lock.yaml`. The frozen
  workspace install verifies registry integrity, and the publish job refuses a
  selected binary whose reported version differs from the committed pin.
- A tag creates a draft release once. Reruns never edit its channel metadata or
  clobber assets: a public release, mismatched prerelease flag, unexpected asset,
  or expected name with different bytes fails closed. Existing expected assets
  are downloaded and byte-compared before reuse; only absent expected assets
  are uploaded.
- Generate GitHub build-provenance attestations for the completed local asset
  set only after every expected draft asset was uploaded or byte-verified, and
  before npm/public release. This avoids creating provenance for a mismatched
  rerun that the release rejects. Attestation generation has narrowly scoped
  OIDC and attestation permissions in the build job.

## Consequences

Release retries converge only when the tag's draft still represents the exact
same build. Recovery from any mismatch requires a new release version rather
than rewriting published identity. GitHub hosts and verifies the provenance
attestations, but `create-signkit` has no local attestation verifier today; it
continues to enforce the official-repository, manifest, size, and SHA-256
boundary. If deploy-time policy is to require provenance, track a follow-up
issue to add a fail-closed verifier instead of claiming generation alone closes
that boundary.
