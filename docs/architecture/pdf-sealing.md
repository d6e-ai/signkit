# PDF sealing

Status: accepted design for Issue #78; provider and validator transports are implemented but
unwired; no sealing runtime, API, migration, or publication dependency is implemented yet

## Boundary and terminology

The current completion PDF is the executed agreement: the immutable sent document set, signed field
values drawn at frozen coordinates, and the evidence appendix. It remains the source of truth even
when sealing is enabled.

A **sealed PDF** is a separate immutable artifact that adds an invisible PAdES signature over that
completed PDF. The signer is the configured SignKit **instance**, not an envelope recipient. The
seal does not upgrade typed, drawn, approved, or viewed recipient decisions into certificate-backed
recipient signatures, and certificate identity is never inferred from recipient email, name, or
authentication claims.

The initial seal is an invisible **approval signature**, not a PDF certification signature. It is
deliberately non-DocMDP: its signature dictionary has no certification-signature `/Reference` entry
with `/TransformMethod /DocMDP`, the document catalogue has no `/Perms /DocMDP` entry for it, and
SignKit does not attach an allowed-change policy to the seal. “Instance seal” must not be shortened
to “certification signature” in API names, storage names, audit events, logs, or product copy.

Sealing adds cryptographic evidence; it does not decide legal effect. Product copy must not
describe B-B, B-T, or their certificate as an advanced or qualified signature without a separate,
explicit qualification result from an appropriate trust and identity design.

## Profiles

The initial profile vocabulary is exactly `pades-b-b` and `pades-b-t`.

| Requested profile | Required result                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pades-b-b`       | An `ETSI.CAdES.detached` CMS signature, complete source-covering `ByteRange`, protected signer certificate, and valid certificate path under the configured policy. |
| `pades-b-t`       | Every B-B property plus a verified RFC 3161 signature time-stamp trusted under the configured TSA policy.                                                           |

The request and durable result carry separate `requestedProfile` and `achievedProfile` values. A
B-T operation is successful only when `achievedProfile` is B-T. A TSA timeout, rejection, invalid
token, wrong policy, wrong imprint, or untrusted TSA never publishes a B-B result for that request.

B-LT and B-LTA are deferred. B-LT requires complete certificate and revocation values in the PDF
Document Security Store. B-LTA additionally requires a document time-stamp and an operational
renewal schedule before algorithms, certificates, or previous time-stamps cease to be trustworthy.

## Artifact and publication flow

Sealing is a durable reconciliation step after `completion_artifact_pdf` exists. It is never added
to the recipient sign/approve transaction.

1. Resolve one immutable source PDF pointer and independently verify its object key, byte length,
   and SHA-256.
2. Freeze the requested profile and public policy identifiers: source PDF digest, expected signer
   certificate digest, seal-provider policy ID, TSA policy ID and trust-bundle digest when
   applicable,
   and validation-policy version.
3. Submit the bounded source stream to the seal provider under a stable, opaque operation ID.
   Reusing that ID with identical input returns the same operation; reusing it with different input
   is a conflict.
4. Poll a submitted operation rather than keeping a Worker invocation open for an unbounded signing
   or TSA request. An ambiguous transport failure is resolved by reading the same operation ID.
5. Before publication, independently validate the returned PDF against the frozen source and
   policy. In particular, the output must retain the exact source bytes as its prefix and add only a
   valid incremental update, the `ByteRange` must cover the signed revision except `/Contents`, and
   the CMS, signer certificate, profile, and optional time-stamp must all verify.
6. Write the bounded result and validation report as immutable, content-addressed objects. Publish
   their pointers, the durable command receipt, job state, and a chained
   `envelope.pdf_seal_published` audit event atomically in D1 or PostgreSQL.

Provider output is not deterministic because certificates and time-stamps can vary. Safe replay
therefore depends on the durable operation ID and provider receipt, not on rebuilding the same bytes
from scratch. Provider authentication material, internal object keys, and signing-key references
are never exposed through public status, logs, webhooks, or errors.

## State and failure semantics

The future API exposes this state as `pdfSeal.status`; it does not introduce a
`pdfCertification` resource. The state machine is explicit:

- `disabled`: this instance has no valid seal policy or runtime provider;
- `not_requested`: a completion PDF exists, but no seal was requested;
- `pending`: a durable request exists and is eligible for work or retry;
- `processing`: a bounded lease owns the current attempt;
- `failed`: processing stopped with an operator-safe error code and retryability signal; and
- `published`: one verified sealed-PDF pointer is immutable for the request.

The persistence layer follows the existing bounded-claim pattern: stable ordering, unique claim
tokens, lease expiry and reclaim, capped attempts, exponential backoff, evidence-checked command
replay, and no provider call inside a database transaction. D1 publishes through a rollback-on-
failed-predicate command trigger; PostgreSQL locks the envelope, source PDF, and sealing job
in a stable order before the equivalent transaction.

Retryable failures include transport interruption, timeout, provider 5xx/rate limiting, an
explicitly temporary key or HSM outage, and validation-service unavailability. Permanent or
integrity failures include a missing or different source, operation-ID reuse with different input,
unsupported algorithms, the wrong certificate or profile, certificate policy rejection, an
invalid CMS/byte range, and an invalid or policy-mismatched time-stamp. Exhaustion makes a retryable
failure terminal without relabelling an unverified artifact as published.

If a future instance policy makes sealing required, completion delivery waits for
`published`; failure must remain visible to an operator. An optional policy may continue to deliver
the original visual PDF, but it must not label that attachment as instance-sealed.

## Key, certificate, and TSA trust

SignKit stores only public policy metadata and opaque provider references. Private keys and PKCS#12
passwords must not enter application SQL, D1, R2/S3, Git, release assets, audit payloads, logs, or
Worker secrets. The seal provider holds or delegates the signing operation to a PKCS#11 HSM, KMS,
Cloud Signature Consortium service, or equivalent non-exportable key boundary.

Each operation pins the expected signer certificate SHA-256 and validation policy. A certificate
rotation creates a new policy generation for future operations; public certificate material needed
to validate old artifacts remains available. Definitive key loss or unknown key identifiers fail
permanently, while an explicitly temporary device outage may retry. Compromise requires certificate
revocation, policy retirement, and a new key; old artifacts are never rewritten silently.

For B-T, the seal provider and independent validator must check at least the RFC 3161 response
status, message imprint and hash OID, request nonce when present, TSA policy OID, token signature,
pinned TSA chain, and the relationship between `genTime` and the configured validation policy. As
required by [RFC 3161 section 2.3](https://www.rfc-editor.org/rfc/rfc3161.html#section-2.3), the TSA
signing certificate's Extended Key Usage extension must be critical and contain only
`id-kp-timeStamping`; an absent, non-critical, or multi-purpose EKU is rejected.

The time-stamp token must also bind the exact TSA signing certificate through an ESS certificate
identifier signed attribute. `SigningCertificate` with `ESSCertID` is accepted for SHA-1 only when
the configured algorithm policy still permits SHA-1. For every other certificate-hash algorithm,
`SigningCertificateV2` with `ESSCertIDv2` is required, as specified by
[RFC 5816 section 2.2.1](https://www.rfc-editor.org/rfc/rfc5816.html#section-2.2.1). The identifier's
certificate hash and any issuer/serial fields must match the certificate that verifies the token
signature, following the verification update in
[RFC 5816 section 2.2.2](https://www.rfc-editor.org/rfc/rfc5816.html#section-2.2.2). Missing,
malformed, mismatched, or policy-disallowed identifiers fail validation. Ambient operating-system
or TLS roots are not document-signing trust roots. TSA and revocation endpoints are static operator
configuration, never URLs supplied by an envelope or certificate without an explicit allowlist.

## Provider and deployment boundary

The application depends on a provider-neutral, authenticated HTTPS protocol with submit, status,
and result operations. The protocol accepts a stable operation ID, source digest and bounded source
stream, requested profile, and non-secret policy identifiers. It returns bounded sealed bytes and a
structured receipt; it never returns or accepts a raw private key.

The initial remote transport derives every endpoint from one operator-configured HTTPS base URL;
provider responses cannot redirect the application or supply a status or result URL. It uses
`PUT {base}/pdf-seals/{operationId}` for the streamed source, `GET` on that same URL for status, and
`GET {base}/pdf-seals/{operationId}/result` for the bounded result. The operation ID is also the
idempotency key. Every response echoes the frozen source digest and size, exact requested profile,
signer-certificate digest, seal and validation policy identifiers, and the B-T TSA policy tuple.
The result requires an exact content length and SHA-256 and must achieve the requested profile;
redirects, changed metadata, profile substitution, and arbitrary response URLs fail closed.
Transport requests use manual redirect handling. Any 3xx or already-redirected response is rejected
as a permanent provider error and its body is cancelled before parsing; a submit remains ambiguous
because the original provider may already have accepted the stable operation ID.
After submit returns a provider receipt, every ordinary status and result request pins that receipt
and rejects a changed echo. A separate receipt-free status operation exists only to reconcile an
ambiguous submit outcome; its first valid receipt must be persisted before ordinary polling. A
source-length failure discovered while the PUT body is already being consumed is also ambiguous,
because the provider may have created the stable operation before the stream failed.

`PdfSealProvider` and the remote HTTPS adapter implement only this untrusted transport boundary.
They are not runtime-wired and do not make sealing available. Provider success cannot publish an
artifact until the separate independent validator, durable job, and atomic publication boundary are
implemented.

The application port is named `PdfSealProvider`; `PdfCertificationProvider` and `Certifier`
are deliberately not used because both collide with PDF certification-signature and certificate-
authority terminology.

## Independent validator protocol

`PdfSealValidator` is a provider-neutral gate between untrusted provider output and future atomic
publication. The remote adapter is implemented but deliberately unwired. It does not expose a
runtime capability, write an artifact, or treat a validator receipt as publication.

One validation freezes a stable validation ID and seal operation ID together with both PDFs' exact
SHA-256 and byte length, requested profile, signer-certificate SHA-256, seal-policy ID,
validation-policy ID, and the B-T TSA policy/trust-bundle tuple. Its only endpoint is derived from
one credential-free HTTPS base URL:
`PUT {base}/pdf-seal-validations/{validationId}`. The stable validation ID is also the idempotency
key. Repeating the ID with byte-identical PDFs and identical frozen metadata must return the stored
result (or safely repeat the pure validation); `409` is reserved for reusing it with different
input. A retry reopens both immutable objects because request streams are single-use. Redirects are
handled manually and any 3xx, redirected, or opaque-redirect response fails permanently; a response
cannot supply another URL.

The request media type is `application/vnd.signkit.pdf-seal-validation-v1`. Its bounded binary body
is the exact source PDF followed immediately by the exact sealed PDF. Frozen source and sealed
length headers delimit the frames without base64 or multipart buffering. The adapter rejects a
short or long frame while streaming; the remote validator must independently hash both frames,
compare their exact lengths and digests, and echo every frozen field. The source frame is capped by
the shared 32 MiB completion-PDF lifecycle bound, and deployment policy chooses a sealed-result
bound no larger than 64 MiB. B-B responses echo both TSA fields as explicit `null`; omission is an
integrity failure. JSON is requested with identity content encoding so transparent decompression
cannot invalidate its bounded byte accounting.

A successful JSON result is bounded to 64 KiB and must report the exact requested profile plus all
of these checks as true: exact source prefix, valid incremental update, complete `ByteRange`, valid
`ETSI.CAdES.detached` CMS, protected and digest-matching signer certificate, certificate path and
seal policy, invisible approval signature, no DocMDP transform/catalogue entry, and no bytes after
the signed revision. B-T additionally requires true RFC 3161 status, imprint, nonce-when-present,
policy, token signature, pinned path, critical time-stamping-only EKU, ESS certificate binding, and
`genTime` checks. B-B requires no timestamp result; B-T requires one. Profile substitution is an
integrity failure, never a downgrade.

An invalid document is a successful protocol response with one or more allowlisted failure codes;
it is not a retryable transport error. Only timeout, transport interruption, rate limiting, 5xx,
and validation-service unavailability retry. Authentication, request rejection, validation-ID
conflict, redirects, malformed or oversized responses, changed echoes, and integrity failures are
permanent. Errors contain only a stable code, retryability, and optional HTTP status: remote URLs,
credentials, response bodies, raw engine messages, certificate material, and provider key
references never cross the port.

The eventual runtime must configure a validator trust boundary independent of the signing provider,
read both immutable objects with their existing digest/size checks, persist the structured result,
then re-read and re-hash the exact sealed object immediately before publishing its pointer. None of
that wiring is part of this slice.

| Runtime            | Initial support                                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node/Docker        | Remote HTTPS seal provider and independent validator, which may be separately deployed alongside the app. A subprocess or key file in the app container is not the portable contract.               |
| Cloudflare Workers | Remote HTTPS seal provider and remote independent validator only. No certificate private key or PKCS#12 bundle in Worker secrets; D1/R2 retain only jobs, public metadata, and immutable artifacts. |
| Vercel             | Unspecified until its deployment profile becomes supported; it must use the same provider and validator contracts rather than divergent in-process implementations.                                 |

Cloudflare processing starts at concurrency one and streams the source where possible. Returned
bytes and all validation inputs remain bounded so the Worker cannot multiply large in-memory PDF
copies. The provider should return quickly with an operation receipt and perform slow HSM, TSA, or
validation work asynchronously.

## Verification gate

Before any profile appears in runtime capabilities, representative B-B and B-T fixtures must pass
both the European Commission's EU DSS validator and pyHanko under explicit trust roots and a fixed
validation policy. The conformance matrix records exact tool versions and includes at least:

- valid B-B and B-T output, including source-prefix and complete-byte-range checks;
- modified source content, audit appendix, `ByteRange`, CMS value, and signer certificate;
- timestamp wrong imprint, nonce, policy, trust root, signature, non-critical/multi-purpose TSA EKU,
  or missing/mismatched ESS certificate binding;
- a DocMDP `/Reference` transform, catalogue `/Perms /DocMDP` entry, or claimed allowed-change
  policy on the initial approval seal;
- expired and revoked signer/TSA certificates at the applicable validation time;
- bytes appended after the sealing revision;
- provider replay, ambiguous response loss, validation outage, and certificate rotation; and
- identical D1/PostgreSQL job, receipt, pointer, and audit outcomes.

EU DSS and pyHanko are independent conformance checks; neither the signing provider's success
response nor a PDF viewer's badge is proof of profile compliance. Test certificates and keys are
fixture-only and must be unmistakably unrelated to any deployment certificate.

## Source bound and legacy behavior

The former generation/read mismatch is resolved. Executed-PDF generation, private and public
completion downloads, and completion-evidence reads now share the 32 MiB
`MAX_PUBLISHED_COMPLETION_PDF_BYTES` lifecycle bound. Before invoking the provider, the future
sealing runtime must still verify the immutable object's recorded length and SHA-256 under that
same source bound. The remote provider adapter independently enforces the attested stream length;
its separately configured result bound caps the full PDF after the incremental sealing update.

Envelopes completed before sealing support remain `not_requested`. There is no automatic
historical sealing: applying a current certificate or time-stamp later could otherwise be mistaken
for evidence that existed at the original completion time. A future explicit backfill preserves and
reports both `completedAt` and the later certificate/time-stamp time.

The eventual migration and API slices must also update object-orphan reachability, backup/restore
runbooks, capabilities, OpenAPI, the Rust CLI, completion delivery, audit exports, webhook event
catalogues, and operator/public UI. This design intentionally adds none of those surfaces until the
conformance gate and provider protocol have been proven.

See the dated rationale in
[`decisions/2026-09-23-instance-pades-seal-and-rfc3161.md`](decisions/2026-09-23-instance-pades-seal-and-rfc3161.md).
