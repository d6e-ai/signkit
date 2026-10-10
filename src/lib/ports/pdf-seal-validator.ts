import type { PdfSealProfile } from './pdf-seal-provider';

/** Frozen evidence and policy inputs for one independent validation. */
export interface PdfSealValidationReference {
	validationId: string;
	operationId: string;
	sourceSha256: string;
	sourceByteSize: number;
	sealedSha256: string;
	sealedByteSize: number;
	requestedProfile: PdfSealProfile;
	signerCertificateSha256: string;
	sealPolicyId: string;
	validationPolicyId: string;
	tsaPolicyId: string | null;
	tsaTrustBundleSha256: string | null;
}

export interface ValidatePdfSealCommand extends PdfSealValidationReference {
	source: ReadableStream<Uint8Array>;
	sealed: ReadableStream<Uint8Array>;
}

export interface PdfSealTimestampChecks {
	responseStatusGranted: true;
	messageImprintValid: true;
	nonceValidWhenPresent: true;
	policyValid: true;
	tokenSignatureValid: true;
	certificatePathValid: true;
	ekuCriticalTimeStampingOnly: true;
	essCertificateBindingValid: true;
	genTimeValid: true;
}

/** Every property required before the first B-B/B-T artifact may be published. */
export interface PdfSealValidationChecks {
	sourcePrefixExact: true;
	incrementalUpdateValid: true;
	byteRangeComplete: true;
	cmsSignatureValid: true;
	cmsSubFilter: 'ETSI.CAdES.detached';
	signerCertificateProtected: true;
	signerCertificateDigestMatches: true;
	certificatePathValid: true;
	sealPolicyValid: true;
	invisibleApprovalSignature: true;
	docMdpAbsent: true;
	noPostSealChanges: true;
	timestamp: PdfSealTimestampChecks | null;
}

export type PdfSealValidationFailureCode =
	| 'source_prefix_mismatch'
	| 'incremental_update_invalid'
	| 'byte_range_invalid'
	| 'cms_signature_invalid'
	| 'cms_profile_invalid'
	| 'signer_certificate_unprotected'
	| 'signer_certificate_mismatch'
	| 'certificate_path_invalid'
	| 'seal_policy_rejected'
	| 'approval_signature_invalid'
	| 'doc_mdp_forbidden'
	| 'post_seal_changes_detected'
	| 'timestamp_missing'
	| 'timestamp_response_rejected'
	| 'timestamp_imprint_mismatch'
	| 'timestamp_nonce_mismatch'
	| 'timestamp_policy_mismatch'
	| 'timestamp_signature_invalid'
	| 'timestamp_trust_invalid'
	| 'timestamp_eku_invalid'
	| 'timestamp_ess_binding_invalid'
	| 'timestamp_time_invalid'
	| 'unsupported_algorithm';

export interface PdfSealValidationBase extends PdfSealValidationReference {
	validatorReceiptId: string;
}

export type PdfSealValidationResult =
	| (PdfSealValidationBase & {
			status: 'valid';
			achievedProfile: PdfSealProfile;
			checks: PdfSealValidationChecks;
	  })
	| (PdfSealValidationBase & {
			status: 'invalid';
			failureCodes: readonly PdfSealValidationFailureCode[];
	  });

export type PdfSealValidatorErrorCode =
	| 'invalid_configuration'
	| 'invalid_request'
	| 'source_size_mismatch'
	| 'sealed_size_mismatch'
	| 'network_error'
	| 'request_timeout'
	| 'rate_limited'
	| 'validator_unavailable'
	| 'validator_authentication_failed'
	| 'validation_conflict'
	| 'validator_rejected'
	| 'validator_redirected'
	| 'invalid_response'
	| 'response_too_large'
	| 'integrity_mismatch';

/**
 * Detail-free transport failure. Raw remote messages, URLs and credentials are
 * deliberately absent so ordinary Error logging cannot disclose them.
 */
export class PdfSealValidatorError extends Error {
	constructor(
		readonly code: PdfSealValidatorErrorCode,
		readonly retryable: boolean,
		readonly httpStatus: number | null = null
	) {
		super(code);
		this.name = 'PdfSealValidatorError';
	}
}

/** Independent validation boundary; a valid result is still not publication. */
export interface PdfSealValidator {
	/**
	 * Each call consumes fresh streams. After a retryable failure, callers reopen
	 * both immutable objects and repeat the same validationId and frozen inputs.
	 */
	validate(command: ValidatePdfSealCommand): Promise<PdfSealValidationResult>;
}
