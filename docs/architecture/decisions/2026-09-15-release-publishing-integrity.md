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
- Pass the build job's exact six-name SHA-256 asset inventory to the final
  publication job as a job output. Immediately before changing draft state,
  `publish-release` refuses a missing or extra remote asset, downloads every
  asset again, and verifies every byte against that inventory. npm success is
  therefore insufficient to publish a draft whose assets changed after the
  upload job finished.
- Pin checkout, Node/pnpm setup, Rust toolchain, and attestation actions to full
  reviewed commit SHAs. Keep the human-readable upstream version beside each
  pin so upgrades remain explicit and reviewable.

## Consequences

Release retries converge only when the tag's draft still represents the exact
same build. Recovery from any mismatch requires a new release version rather
than rewriting published identity. GitHub hosts the provenance attestations.
Deploy-time verification is specified separately in
[2026-09-16-create-signkit-provenance-verification.md](2026-09-16-create-signkit-provenance-verification.md);
the checksum manifest is still not treated as a signature. Repository
immutable releases are a required administrative
control before pushing a release tag; the workflow's draft checks do not claim
to replace that GitHub setting.
