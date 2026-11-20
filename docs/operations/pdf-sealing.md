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

## Authorization rollout and custody

- Provision the independently managed issuer, key-service routes and provider-owned replay database
  described in the [provider contract](../architecture/pdf-sealing.md#provider-and-deployment-boundary).
  The standalone PostgreSQL ledger uses `tools/pdf-seal-authority/postgres-schema.sql`; the
  Cloudflare deployment uses [its standalone D1 ledger](#cloudflare-workers-with-a-managed-signing-key).
  Retain reservations and the provider receipt history through backup and recovery.
- Retire the old bearer-only key ingress before enabling the new protocol. Existing published seals
  stay downloadable. Preserve the records of queued legacy seal jobs. An unfinished seal can advance
  only with its exact frozen policy and an independent verified grant using the new routes. Never
  retry an ambiguous private operation with a different ID or recreate the provider ledger.
- Retry authorization and submission while the key service has accepted no reservation. After
  reservation, retries can only reconcile the original operation. A missing receipt requires
  checking the provider's key-use audit before any recovery decision.
- Enable the complete provider and validator tuple including `PDF_SEAL_AUTHORIZATION_ISSUER`,
  `PDF_SEAL_AUTHORIZATION_AUDIENCE` and `PDF_SEAL_AUTHORIZATION_PUBLIC_KEY`. The last value is the
  canonical unpadded base64url of an uncompressed P-256 public point. A legacy tuple without the
  authorization settings disables new requests and the drain. Ordinary completion PDFs and old
  recipient requests use their usual workflow.
- Rotate the issuer key separately from the certificate. Coordinate the trust pin at the client and
  provider, stop issuance under a compromised key immediately, and stop admission until the pins
  match. Keep the same issuer and audience identity and durable replay ledger across rotations.
  The issuer maintains issuance and access records. The key operator owns certificate rotation,
  revocation, reservation reconciliation and evidence of key-service outcomes.

### Cloudflare Workers with a managed signing key

Deploy one isolated set of four Workers per environment. Restrict issuer, evidence-store and
provider deployment access to their trusted administrators. The Cloudflare account administrator can
change these bindings and belongs to the hosted trust boundary. A customer-controlled evidence store
is ineligible for this profile. The engine and issuer have service bindings and no public route.
The gateway's scheduling credential and the validator's credential are the only credentials
SignKit receives.

1. Create a dedicated D1 ledger from `tools/pdf-seal-authority/gateway/schema.sql` and a private
   R2 result bucket. Bind the issuer to the trusted recipient and completion stores for one
   audience. Keep reservations when replacing Workers and images.
2. Provision one [signing key](#signing-key-backends) for the environment. Issue a leaf
   certificate for its public key under the validator's trusted CA. The leaf requires digital
   signature and content commitment key usage. Install its DER SHA-256 pin at the issuer, gateway,
   validator and SignKit. For a private CA, provide the CA certificate to verifiers through the
   approved trust channel. Keep the CA private key offline. The engine verifies each signature
   against the leaf's public key before embedding it.
3. Keep the instruction issuer's ES256 key in its own Worker secrets. Use independent 32-byte
   random values encoded as unpadded base64url for the scheduling, issuer, engine, and validator
   credentials. Restrict management and audit roles separately.
4. Generate SvelteKit types with `pnpm run check` and run the [release command](#release-command).
   The Docker builds use hash-pinned Python wheels for Linux x86-64. The validator runs with
   container internet access disabled.
5. When SignKit and the services run in the same Cloudflare account, bind SignKit's
   `PDF_SEAL_PROVIDER_SERVICE` to the gateway and `PDF_SEAL_VALIDATOR_SERVICE` to the validator.
   Keep the corresponding HTTPS URLs in the seal policy so the transport can construct and
   validate each protocol endpoint. The service bindings carry the existing authenticated requests
   without exposing the private engine or the instruction issuer to SignKit.

| Role        | Runtime secrets                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `issuer`    | `ISSUER_TOKEN`, `ISSUER_PRIVATE_KEY_PKCS8` (base64 DER)                                              |
| `gateway`   | `GATEWAY_TOKEN`, `ISSUER_TOKEN`, `ENGINE_TOKEN`                                                      |
| `engine`    | `ENGINE_TOKEN`, `SEAL_CERTIFICATE_DER` and `SEAL_CA_DER` (base64 DER), plus the selected key backend |
| `validator` | `VALIDATOR_TOKEN`, `SEAL_CA_DER` (base64 DER trust root)                                             |

Verify in the non-production environment before enabling production. Use a disposable completed
envelope with verified signing instructions. Check that missing, invalid, expired and mismatched
grants create no reservations and produce no key-use events. Submit the valid grant and exact
PDF, replay the same operation, and correlate one successful key use with the provider receipt.
Verify the sealed result and original PDF through SignKit. Repeat the deployment with
separate production keys, buckets, ledgers and credentials. Activate only the complete B-B tuple and
preserve existing signing requests and published artifacts.

#### Release command

Keep a release manifest per environment outside the repository. Use a Cloudflare deployment token
in an environment variable for each role, or substitute `{"profile": "name"}` for a named cf
authentication profile. Scope deployers to the resources they manage, and keep the app deployer
separate from the trusted signing and validation deployers. The issuer, engine and gateway use
service bindings within the manifest's `accountId`. Add an `accountId` to `deploy.validator` to
deploy the validator to a separately administered account and connect to it over HTTPS.

```json
{
	"accountId": "<Cloudflare account ID>",
	"settings": {
		"SEAL_WORKER_PREFIX": "<Worker name prefix>",
		"SEAL_KEY_BACKEND": "vercel-kms",
		"SEAL_ISSUER": "<issuer>",
		"SEAL_AUDIENCE": "<audience>",
		"SEAL_CERTIFICATE_SHA256": "<certificate pin>",
		"SEAL_POLICY_ID": "<seal policy>",
		"VALIDATION_POLICY_ID": "<validation policy>",
		"SEAL_AUTHORIZATION_PUBLIC_KEY": "<ES256 public key>",
		"SEAL_EVIDENCE_DB_ID": "<evidence D1 ID>",
		"SEAL_EVIDENCE_BUCKET": "<evidence R2 name>",
		"SEAL_LEDGER_DB_ID": "<separate replay D1 ID>",
		"SEAL_RESULT_BUCKET": "<private result R2 name>",
		"SEAL_LOCATION_HINT": "<optional Durable Object location hint, such as apac-se>"
	},
	"deploy": {
		"issuer": { "tokenEnv": "CF_ISSUER_DEPLOY_TOKEN" },
		"engine": { "tokenEnv": "CF_ENGINE_DEPLOY_TOKEN" },
		"validator": { "tokenEnv": "CF_VALIDATOR_DEPLOY_TOKEN" },
		"gateway": { "tokenEnv": "CF_GATEWAY_DEPLOY_TOKEN" }
	}
}
```

The engine and validator containers run where their Durable Objects live. Without
`SEAL_LOCATION_HINT`, each object was created near its first request and stays there; Cloudflare
does not relocate it. Set the optional hint to one of Cloudflare's
[location hints](https://developers.cloudflare.com/durable-objects/reference/data-location/) to
place both containers in a region. Changing the hint addresses a new hinted object rather than
moving the old one; neither object stores data, so nothing is migrated, and the first seal after
the change waits for a cold container. A hint is a request, not a guarantee: after deploying, read
each container instance's location before relying on it. Signed PDFs and signing attributes pass
through the engine container, so this is the setting that keeps them in a region.

Set `secretsFile` on each role for initial provisioning or rotation. Use a private JSON file
path relative to the manifest or an absolute path. Omit it to retain the deployed Worker secrets.
The signer project or HSM host is provisioned separately by the key operator.

```sh
node tools/pdf-seal-authority/deploy-cloudflare.mjs /path/to/release.json --apply
```

Without `--apply` the command builds and previews the four prebuilt Workers locally. `--only
engine,validator` limits the build, preview and deploy to those roles, for example after a
placement change; the other Workers keep their active versions. With
`--apply` it runs all four previews before deploying the issuer, engine, validator and gateway in
that order. Each upload uses its own credentials, targets existing data resources and stops the
release on failure. Worker and container rollouts can finish at different times. After a partial
release, inspect the active versions and container readiness before retrying with the same
manifest and replay ledger. `DOCKER_CONFIG` and `DOCKER_HOST`, when configured, select the Docker
registry credential store and the daemon used by `cf deploy`. Use the same daemon as the builder.
Enable the complete SignKit `PDF_SEAL_*` configuration after verifying the key service and
validator in that environment, then check both PDF downloads through SignKit.

Before production, check actual deployer and resource permissions. Cloudflare lets Worker editors
bind D1 and R2 without separate direct resource access. If the application deployer is outside the
trusted recipient and publication plane, isolate its evidence and signing resources in an account
the app deployer cannot access, as required by the [provider contract](../architecture/pdf-sealing.md#provider-and-deployment-boundary).

#### Signing key backends

Set `SEAL_KEY_BACKEND` to `vercel-kms`, `aws-kms`, or `pkcs11-hsm` for the engine. Configure the
selected backend before releasing. A different signing key requires a new certificate pin and
policy generation. Keep pending operations on their original policy until reconciled, then revoke
the retired backend credentials and remove its Worker secrets.

Use Vercel KMS with SignKit only for self-hosted instances used for internal business. Use another
key backend for customer-facing SignKit services. See the [Vercel KMS availability and terms](https://vercel.com/docs/kms)
and [Public Beta Agreement](https://vercel.com/docs/release-phases/public-beta-agreement#2-license-grant).

For Vercel KMS, deploy `tools/pdf-seal-authority/vercel-signer` to a dedicated, OIDC-enabled Vercel
project per environment. Use an `RS256` issuer with a Vercel-generated key and a grant for that
project and environment only. Keep SignKit's deployment and project credentials outside the grant.
Bind `VERCEL_KMS_ISSUER_ID`, `VERCEL_KMS_KEY_ID`, `VERCEL_KMS_FINGERPRINT` and an independent
`VERCEL_SIGNER_TOKEN` as signer project secrets. Bind the same expected key ID, public key
fingerprint and signer token at the Cloudflare engine, plus `VERCEL_SIGNER_URL`, the dedicated
`https://<project>.vercel.app/api/sign` endpoint. The function accepts the engine's one authorized
request for CMS signed attributes and uses its own deployment OIDC token for the managed key. Its
key-use record contains the operation and request identifiers. Customer deployment credentials
must have no authority to modify the signer project or its KMS grant. For certificate rotation,
stage a new issuer and signer deployment under a new policy generation. Keep the prior issuer
available until its accepted operations are reconciled.

For AWS KMS, create an RSA `SIGN_VERIFY` key and issue the certificate using `GetPublicKey`.
Grant the engine principal `kms:GetPublicKey` and `kms:Sign` on the exact key ARN. Require
`kms:SigningAlgorithm` of `RSASSA_PKCS1_V1_5_SHA_256` and `kms:MessageType` of `DIGEST` for
`Sign`. Bind `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` and `AWS_KMS_KEY_ARN`
at the engine. Use CloudTrail for key-use reconciliation.

For a self-hosted PKCS#11 HSM, install `tools/pdf-seal-authority/hsm-signer/requirements-linux-amd64.lock`
with Python 3.12 and `pip install --require-hashes --only-binary=:all: -r <lock-file>` on Linux
amd64. Run `python tools/pdf-seal-authority/hsm-signer/server.py` as a
dedicated service account with access to the HSM vendor module, token and PIN file. Terminate TLS
at a trusted reverse proxy that routes `POST /api/sign` to `127.0.0.1:8079` and disables upstream
request retries. Configure the signer with `HSM_PKCS11_MODULE` (absolute module path),
`HSM_PKCS11_TOKEN_SERIAL`, `HSM_PKCS11_KEY_ID` (hex `CKA_ID`), and `HSM_PKCS11_PIN_FILE`.
Provision an RSA signing key generated on the device with sensitive, non-exportable attributes and
a corresponding public key. Configure `HSM_SIGNER_TOKEN`, `HSM_SIGNER_KEY_ID`, and
`HSM_SIGNER_FINGERPRINT` (SHA-256 of the DER SubjectPublicKeyInfo) on both the signer and engine.
Set `HSM_SIGNER_URL` to the HTTPS signing endpoint on the engine. Restrict the signer credential
to the private engine and correlate HSM key-use records with gateway operation IDs.

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
2. Inventory jobs that are not published. Drain them to a terminal state before switching a
   single-policy issuer and key service. If serving policies in parallel, route only to configured
   handlers for the exact pinned policy tuple and keep the replay ledger shared for the same issuer
   and audience. Resolve every accepted operation ID against its original provider receipt.
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
