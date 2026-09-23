# Instance PAdES seal and RFC 3161 boundary — 2026-09-23

The executed agreement PDF is an immutable visual rendering of the completed envelope and its
evidence appendix. It records recipient decisions, but recipients do not present certificate-backed
identities. Adding a PDF signature must not relabel those existing decisions as certificate
signatures or infer a certificate subject from an email address, display name, or d6e-auth claim.

## Decision

SignKit will treat PAdES as an optional **instance seal over the completed PDF**, not as a recipient
certificate signature.

- The existing executed PDF remains the source artifact. A sealed PDF is a second immutable,
  content-addressed artifact produced through a PDF incremental update; the source bytes are never
  overwritten or re-rendered.
- The initial seal is an invisible PDF approval signature. It is not a PDF certification signature
  and does not use a DocMDP transform or declare which later document changes are permitted.
- The first supported profiles are PAdES B-B and B-T. B-B proves that the configured instance
  certificate signed the PDF but supplies no trusted signing time. B-T additionally requires a
  verified RFC 3161 signature time-stamp. A B-T request may never silently succeed as B-B when the
  TSA is unavailable or rejects the request.
- SignKit's current product boundary ends at B-B and B-T. B-LT and B-LTA are not supported,
  advertised, inferred from a successful B-T validation, or emitted as API status. B-LT would
  require complete certificate and revocation material embedded in the PDF. B-LTA would additionally
  require a continuously operated archival renewal service that adds document time-stamps before
  prior algorithms, certificates, revocation evidence, or time-stamps lose trust.
- SignKit never stores a certificate private key in its database, object storage, Git repository,
  release artifacts, logs, or Worker secrets. A seal provider owns key custody and exposes an
  idempotent remote operation. Node/Docker may call a co-located or remote seal provider over HTTPS.
  Cloudflare Workers initially support only a remote seal provider.
- A seal provider is not trusted merely because it returned bytes. Fixtures and every supported
  engine combination must be independently verified with both EU DSS and pyHanko before the profile
  is advertised. Runtime publication also fails closed unless the configured validation boundary
  verifies the source binding, PDF byte range, CMS signature, certificate policy, and requested
  profile.
- Existing completed envelopes are not sealed automatically after this feature is enabled. An
  explicit future backfill records a seal time distinct from the original completion time.

### Long-term validation product decision

B-LT/B-LTA will not be added by relabelling a B-T result or replacing its immutable publication.
Any future implementation must first introduce a versioned derived-artifact model that preserves
the original B-B/B-T bytes and publication evidence. An LT augmentation must independently validate
the exact input revision, embed the complete validation material required by the selected policy,
and publish a new immutable artifact with its own evidence. An LTA service must also own durable
renewal scheduling, monitoring, retry and escalation, algorithm-policy migration, and verification
of every archival time-stamp in the chain.

Until those lifecycle and storage boundaries exist, SignKit fails closed at B-B/B-T and does not
offer an `LT`, `LTA`, `archival`, `long-term valid`, or equivalent product claim. This is a firm
scope decision, not an assertion that every deployment needs B-LT/B-LTA.

The certificate belongs to the SignKit instance operator under an explicit certificate policy.
Certificate issuance, subject verification, HSM/KMS/PKCS#11 or remote-signing custody, backup,
revocation, and rotation remain operator or seal-provider responsibilities. Rotation affects new
seal operations only; previously published PDFs remain immutable.

## Product and legal boundary

The UI and API may describe a verified artifact as an instance-sealed PDF, a certificate-backed PDF,
or a PAdES B-B/B-T artifact as applicable. They must continue to distinguish:

1. visual recipient completion and audit evidence;
2. an instance certificate signature;
3. a trusted RFC 3161 time-stamp; and
4. future long-term validation material.

Implementing any of these layers does not by itself establish an advanced, qualified, or otherwise
legally privileged electronic signature. SignKit will not expose a `qualified` claim without a
separate identity, certificate-policy, qualified-device, trust-list, and jurisdiction-specific
validation design.

## Consequences

- Sealing runs after completion PDF publication and outside recipient decision transactions.
- A requested B-T seal remains pending or failed until a conforming time-stamp is present; there is
  no best-effort downgrade.
- Deployments without a configured seal provider remain fully functional visual-signature services
  and report sealing as disabled rather than pretending that a PDF is sealed.
- The portable application boundary is an authenticated, idempotent seal-provider protocol rather
  than a JavaScript, Rust, Java, or Python library embedded in every runtime.
- Certificate loss prevents new seals but does not erase already-published signed bytes. Suspected
  compromise requires revocation and rotation; it does not authorize rewriting old artifacts.
- A future LT/LTA extension is a new immutable artifact generation, never an in-place mutation or
  automatic status upgrade of the current publication.
- B-LTA is an ongoing managed operation, not a one-time seal-provider response. A deployment that
  cannot guarantee renewal before trust material expires must not enable or advertise it.

The normative implementation contract is in
[`../pdf-sealing.md`](../pdf-sealing.md). The profile requirements derive from
[ETSI EN 319 142-1](https://www.etsi.org/deliver/etsi_en/319100_319199/31914201/01.02.01_60/en_31914201v010201p.pdf),
and the time-stamp protocol and response checks derive from
[RFC 3161](https://www.rfc-editor.org/rfc/rfc3161.html) and
[RFC 5816](https://www.rfc-editor.org/rfc/rfc5816.html).
