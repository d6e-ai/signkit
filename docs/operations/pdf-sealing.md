# PDF sealing operations

Status: operational runbook for the optional PAdES B-B/B-T instance seal

This runbook covers the external seal provider, its certificate, the RFC 3161 time-stamp authority
(TSA), and the independent validator. SignKit never holds the certificate private key. Every seal
job freezes the source PDF digest, requested profile, signer-certificate digest, and policy IDs when
the request is accepted. Do not edit a `pdf_seal_job`, delete its objects, replace a published PDF,
or create a second remote operation to recover an incident.

Sealing is an instance signature over the completed agreement PDF. It is not a recipient
certificate signature, a PDF certification signature, or a claim that an electronic signature is
advanced or qualified.

## First response

1. Stop changing provider, certificate, TSA, or validator configuration while gathering evidence.
2. Record the incident start time and affected envelope/job IDs. Do not record bearer tokens,
   private-key references, raw provider bodies, or object keys in a ticket.
3. Read the public status for each affected envelope. `failed` reports a stable `errorCode` and
   whether an automatic retry remains possible.
4. Confirm whether the provider accepted the job's existing operation ID. Never submit the source
   under a new ID to resolve an ambiguous response.
5. Restore the failed dependency, then run the ordinary protected PDF-seal drain. A crashed lease is
   reclaimed after five minutes; do not clear it in SQL.
6. Complete the [recovery verification](#recovery-verification) before closing the incident.

To read status without putting the API token in a command argument, enter it silently and pass a
temporary curl configuration over standard input:

```sh
read -rs SIGNKIT_API_TOKEN
printf '\n'
{
  printf 'header = "Authorization: Bearer %s"\n' "$SIGNKIT_API_TOKEN"
  printf 'header = "Accept: application/json"\n'
} | curl --fail-with-body --silent --show-error --config - \
  "${SIGNKIT_ORIGIN}/api/v1/envelopes/${ENVELOPE_ID}/pdf-seal"
unset SIGNKIT_API_TOKEN
```

For database-level diagnosis, use read-only queries. The public status API should remain the normal
operator interface.

```sql
SELECT id, envelope_id, status, next_action, attempt_sequence, retry_failures,
       retryable, last_error_code, requested_profile,
       signer_certificate_sha256, seal_policy_id, validation_policy_id,
       created_at, updated_at, failed_at
FROM pdf_seal_job
WHERE envelope_id = '<ENVELOPE_ID>';

SELECT attempt_number, action, outcome, error_code, started_at, finished_at
FROM pdf_seal_attempt
WHERE job_id = '<JOB_ID>'
ORDER BY attempt_number;
```

Use `wrangler d1 execute <DATABASE_NAME> --remote --command '<READ_ONLY_SQL>'` for D1 or a
read-only `psql` service for PostgreSQL. Take a database snapshot before any broader investigation.

## Certificate private-key loss

### Suspected temporary loss

- Prevent new requests by removing **all** `PDF_SEAL_*` values in one deployment change. Leaving a
  partial configuration fails closed with `503`; removing all values intentionally disables new
  requests and makes the drain a `204` no-op. Published sealed-PDF downloads remain available.
- Preserve the database, source PDFs, sealed objects, validation reports, provider records, public
  certificate chain, and revocation evidence. Do not copy a recovered private key into SignKit.
- Restore the same key inside the provider's HSM/KMS/remote-signing boundary. Confirm its public
  certificate SHA-256 equals the job's frozen `signer_certificate_sha256` before reenabling the
  exact prior policy.
- Resume the ordinary drain. In-flight jobs continue with their frozen certificate digest and
  policy IDs; current configuration does not rewrite them.

### Definitive loss

- Disable sealing as above. If compromise is possible, follow
  [revocation or expiry](#certificate-revocation-compromise-or-expiry) immediately.
- Do not point an existing operation at a replacement key. It would violate the frozen policy and
  independent validation must reject it.
- Rotate to a new policy generation for future envelopes. Existing unpublished jobs cannot be
  migrated to a different certificate by the supported runtime. Preserve them and their attempts
  as incident evidence.

Loss prevents new or unfinished seals; it does not invalidate or erase already-published bytes by
itself. Their validation outcome depends on the certificate status, profile, validation policy, and
relevant time evidence.

## Planned certificate rotation

1. Obtain the new certificate in the provider key boundary and calculate its DER certificate
   SHA-256 independently.
2. Inventory jobs that are not published. Drain them to publication, or keep the old key and policy
   available at the provider until they reach a terminal state. The provider must continue to
   resolve every old operation ID against its original key.
3. Create a new `PDF_SEAL_POLICY_ID`; update `PDF_SEAL_SIGNER_CERTIFICATE_SHA256` and any changed
   validation policy. Never reuse a policy ID for different semantics.
4. Deploy the complete `PDF_SEAL_*` tuple atomically. A partial tuple fails closed.
5. Request a seal for a disposable completed envelope and perform all recovery-verification steps.
6. Retain the old public certificate chain and validation material for the retention period of old
   artifacts. Retire the old private key only after no unfinished job references it.

Rotation applies only to new requests. It does not rewrite published artifacts or change frozen
jobs already in progress.

## Certificate revocation, compromise, or expiry

1. Disable new sealing and the drain by removing the complete `PDF_SEAL_*` tuple.
2. For suspected compromise, revoke the certificate through its issuer and preserve the CA's
   incident time, reason, CRL/OCSP evidence, certificate chain, and affected time range outside
   SignKit. For planned expiry, rotate before `notAfter`; do not wait for jobs to fail.
3. Identify affected jobs by `signer_certificate_sha256`, not by display name or certificate
   subject. Distinguish published artifacts from unfinished jobs.
4. Configure a new certificate and new seal-policy generation for future requests.
5. Never replace or silently re-seal a published artifact. Communicate the incident and validation
   context to relying parties when required.

B-B has no trusted signing time. B-T proves a validated RFC 3161 token under the frozen policy, but
neither profile automatically embeds the long-term revocation material required by B-LT. Do not
claim that a later validation result alone proves historical validity.

## TSA outage

This section applies only to `pades-b-t`.

- Confirm that the TSA endpoint, policy OID, trust bundle, and provider clock are correct. Never
  change the frozen TSA tuple of an existing job.
- Leave the job on its current operation ID and restore the TSA/provider dependency. A B-T request
  never downgrades to B-B; missing, invalid, or policy-mismatched time stamps cannot publish.
- Retryable failures back off and are reclaimed by the normal drain. Eight consecutive retryable
  failures become terminal. There is currently no supported operator requeue for a terminal job;
  do not reset counters or clone rows in SQL.
- If continued B-B operation is needed, change the instance policy only for **future envelopes**
  after an explicit risk decision. It cannot satisfy or replace an existing B-T request.

## Seal-provider outage or ambiguous submission

- For an unambiguous outage, restore the same authenticated provider endpoint and run the normal
  drain. Retryable failures preserve their next action and frozen tuple.
- For a timeout, disconnect, redirect, malformed response, or source-stream failure after dispatch,
  treat submission as ambiguous. SignKit checkpoints `recover_submit` and queries the same stable
  operation ID without resending the source.
- The provider must return the original receipt and frozen metadata. A changed receipt, digest,
  certificate, policy, or profile is an integrity failure, not a recoverable outage.
- Do not delete the remote operation, invent a replacement operation ID, or manually upload provider
  output. Provider success never bypasses independent validation and atomic publication.

## Validator outage

- Restore the independent validator and run the normal drain. SignKit retains and re-verifies the
  immutable sealed object, then retries `validate`; it does not ask the provider to sign again.
- A transport outage or validator `5xx` is retryable. An invalid CMS, byte range, source prefix,
  certificate path, policy, profile, or time stamp is a permanent integrity result and must not be
  overridden.
- Eight consecutive retryable failures become terminal. There is currently no supported operator
  requeue; preserve the job and validation evidence rather than editing SQL.

## Recovery verification

Recovery is complete only when all of these checks pass:

1. The status endpoint returns `published`, the requested and achieved profiles are identical, and
   the signer-certificate digest and validation-report digest match the incident record.
2. `HEAD /api/v1/envelopes/{envelopeId}/pdf-seal/pdf` returns `200`, `application/pdf`,
   `Cache-Control: private, no-store`, the expected content length, and an `ETag` containing the
   published sealed-PDF SHA-256.
3. A fresh `GET` download hashes to that same SHA-256. The download path independently checks SQL,
   object metadata, byte count, and bytes; a drift must return `503`, never unverified content.
4. A read-only database check finds one `pdf_seal_publication` for the envelope and an
   `envelope.pdf_seal_published` audit event. Do not expose its object keys or internal receipts in
   a ticket.
5. The independent validator verifies the downloaded bytes under the frozen validation policy. For
   B-T, every configured RFC 3161 check must pass.
6. The drain is healthy on a later run and no affected retryable job remains due for processing.

Download to a protected temporary directory and verify the public digest:

```sh
umask 077
SIGNKIT_VERIFY_DIR="$(mktemp -d)"
read -rs SIGNKIT_API_TOKEN
printf '\n'
{
  printf 'header = "Authorization: Bearer %s"\n' "$SIGNKIT_API_TOKEN"
} | curl --fail-with-body --silent --show-error --config - \
  --output "${SIGNKIT_VERIFY_DIR}/sealed-agreement.pdf" \
  "${SIGNKIT_ORIGIN}/api/v1/envelopes/${ENVELOPE_ID}/pdf-seal/pdf"
unset SIGNKIT_API_TOKEN
sha256sum "${SIGNKIT_VERIFY_DIR}/sealed-agreement.pdf"
```

Remove the temporary copy according to the instance's document-retention and secure-deletion
policy. Do not paste the PDF, API token, provider token, or private-key material into an incident
tracker.

## Known operational boundary

The current runtime automatically retries only while a failure remains retryable and the
consecutive-failure budget is not exhausted. It intentionally has no SQL repair recipe and no API
to requeue a terminal job or migrate it to another certificate/policy. Adding an audited,
evidence-preserving operator retry command is separate product work; until then, terminal jobs
remain immutable incident evidence.
