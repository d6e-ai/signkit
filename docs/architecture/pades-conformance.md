# PAdES conformance harness

Status: CI conformance gate for the accepted [PDF sealing design](pdf-sealing.md). It is not a
runtime sealing implementation.

The harness generates fresh, test-only PAdES B-B and B-T instance seals for every run. It uses an
ephemeral RSA signing key and an ephemeral RFC 3161 TSA key; neither private key is written to the
repository or uploaded as a CI artifact. The public fixture certificates are intentionally labelled
`SignKit CI TEST ONLY` and are directly trusted only by this isolated validation job.

The generated seal is an invisible PDF approval signature. The harness rejects a DocMDP
certification signature, requires `/ETSI.CAdES.detached`, checks that the source PDF remains the exact
prefix of the incremental update, and verifies that the PDF byte range covers the signed revision
apart from `/Contents`. B-T tokens must bind the exact TSA certificate with SHA-256
`SigningCertificateV2`/`ESSCertIDv2`; legacy SHA-1 ESS identifiers are not accepted by this gate. The
TSA EKU must be critical and contain only `id-kp-timeStamping`. A mutation inside the signed source
bytes must be rejected for both profiles.

Two pinned engines enforce complementary gates:

- EU DSS 6.5 is the profile gate. It must report exactly `PAdES_BASELINE_B` or
  `PAdES_BASELINE_T`, validate the signature, and validate the B-T signature time-stamp.
- pyHanko validates the cryptographic signature, pinned test trust, RFC 3161 token, and PDF
  incremental-update differences. pyHanko documents that it does not by itself determine every
  structural requirement of a PAdES profile, so it is not the sole profile gate.

Both validator entry points add the same SignKit policy check around their upstream engine. Negative
fixtures cover missing or mismatched ESS bindings and absent, non-critical, or multi-purpose TSA EKU,
in addition to signed-byte mutations. This explicit layer is necessary because generic validators can
accept a cryptographically valid timestamp without enforcing every deployment policy.

The validation time and pyHanko's internal AdES wall-clock fallbacks are fixed to
`2026-09-23T00:00:00Z` for repeatable policy results, but private keys are freshly generated. Signed
PDF bytes and their hashes therefore differ between runs. CI records hashes, certificate fingerprints,
the locked Python library versions, the pinned DSS version and dependency tree, the effective Java and
Maven versions, and validator reports instead of comparing golden signed bytes. The job has a bounded
20-minute runtime.

## Runtime boundary

The harness runs only on the Node/Docker-capable CI host. It does not add Python, Java, pyHanko, or
DSS to the SignKit application image.

Cloudflare Python Workers can run supported pure-Python and PyEmscripten packages, but pyHanko and
its cryptographic dependency stack have not been qualified for that runtime. Python Worker support
is therefore unverified and out of scope, not assumed impossible. EU DSS requires a JVM and cannot
run inside the Worker isolate. Cloudflare sealing consequently still requires an authenticated
remote seal provider and a separately trusted validation boundary before runtime publication can be
implemented.

Fixture trust also is not a production certificate policy: revocation fetching is disabled, the
test leaf certificates are pinned directly, and the local TSA does not establish real-world time
provenance. Passing this job must never be presented as an advanced, qualified, or legally
privileged signature result.

## Local run

Use Python 3.12, uv, and Java 21:

```sh
uv sync --project tools/pades-conformance --locked
output_dir="$(mktemp -d)"
uv run --project tools/pades-conformance --locked \
  python tools/pades-conformance/generate.py --out "$output_dir"
```

Validate the unmodified PDFs with pyHanko's AdES validator, using only the generated public fixture
certificates as trust anchors. The wrapper fixes wall-clock fallbacks and enforces SignKit's timestamp
policy; keep difference analysis enabled:

```sh
trust_args=(--trust-replace)
for certificate in "$output_dir"/trust/*.pem; do
  trust_args+=(--trust "$certificate")
done
for profile in b-b b-t; do
  uv run --project tools/pades-conformance --locked \
    python tools/pades-conformance/pyhanko_frozen.py \
    --signkit-expect "valid-$profile" \
    sign adesverify \
    "${trust_args[@]}" \
    --no-revocation-check \
    --validation-time 2026-09-23T00:00:00Z \
    --pretty-print "$output_dir/pades-$profile.pdf" \
    > "$output_dir/reports/pyhanko-$profile.txt"
done
```

The equivalent commands with `--signkit-expect rejected-b-b` or `rejected-b-t` must fail for the
tampered PDFs after their timestamp policy passes. `--signkit-expect rejected-policy` must fail for
every `invalid-*.pdf` policy fixture. Finally, run DSS with strict repository checksum handling:

```sh
mvn -B -ntp -C -f tools/pades-conformance/dss/pom.xml \
  compile exec:java \
  -Dexec.mainClass=ai.d6e.signkit.pades.DssValidate \
  -Dexec.args="$output_dir"
```

Only the exact PDF fixtures, public certificates, checksums, version manifest, provenance files, and
validator reports declared by `verify_artifacts.py` are eligible for upload. Missing, additional, or
symlinked paths fail closed before upload, and every resolved file is scanned for private-key material.
