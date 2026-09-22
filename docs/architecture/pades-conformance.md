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
apart from `/Contents`. A mutation inside the signed source bytes must be rejected for both profiles.

Two pinned engines enforce complementary gates:

- EU DSS 6.5 is the profile gate. It must report exactly `PAdES_BASELINE_B` or
  `PAdES_BASELINE_T`, validate the signature, and validate the B-T signature time-stamp.
- pyHanko validates the cryptographic signature, pinned test trust, RFC 3161 token, and PDF
  incremental-update differences. pyHanko documents that it does not by itself determine every
  structural requirement of a PAdES profile, so it is not the sole profile gate.

The validation time is fixed for repeatable policy results, but private keys are freshly generated.
Signed PDF bytes and their hashes therefore differ between runs. CI records the hashes, certificate
fingerprints, exact tool versions, and validator reports instead of comparing golden signed bytes.

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
certificates as trust anchors. Keep difference analysis enabled:

```sh
for profile in b-b b-t; do
  uv run --project tools/pades-conformance --locked pyhanko sign adesverify \
    --trust-replace \
    --trust "$output_dir/trust/signer.pem" \
    --trust "$output_dir/trust/tsa.pem" \
    --no-revocation-check \
    --validation-time 2026-09-23T00:00:00Z \
    --pretty-print "$output_dir/pades-$profile.pdf" \
    > "$output_dir/reports/pyhanko-$profile.txt"
done
```

The equivalent commands for `tampered-b-b.pdf` and `tampered-b-t.pdf` must fail. Finally, run DSS:

```sh
mvn -B -ntp -f tools/pades-conformance/dss/pom.xml \
  compile exec:java \
  -Dexec.mainClass=ai.d6e.signkit.pades.DssValidate \
  -Dexec.args="$output_dir"
```

Only the PDF fixtures, public certificates, checksums, version manifest, and validator reports are
eligible for upload. CI scans the allowlisted artifact paths for private-key material before upload.
