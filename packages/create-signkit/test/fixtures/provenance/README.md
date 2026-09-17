# Sigstore verification fixture

`diesel-v2.3.13.bundle.sn.base64` is the base64 encoding of the public GitHub
attestation bundle for:

- repository: `diesel-rs/diesel`
- artifact: `diesel_cli-aarch64-apple-darwin.tar.xz`
- release: `v2.3.13`
- artifact SHA-256: `156a149b6986f4297c036052432c3b4ae27b86d6c149767d620f2eabe3cf74d2`
- compressed bundle SHA-256: `75f9a984c490db8d9cdc8bdacf19de2e834203cc8d81b422d1b616a4fc4e3f6d`
- predicate: `https://slsa.dev/provenance/v1`

The fixture was retrieved through GitHub's public repository-attestations API
on 2026-09-16. The signed blob URL is intentionally not retained.

`sigstore-public-good-trusted-root.json` is the public-good Sigstore trusted
root used to verify the fixed bundle offline. The test performs no network
requests and verifies the genuine DSSE signature, Fulcio certificate, CT log,
and transparency-log evidence with the same certificate policy builder used by
production.
