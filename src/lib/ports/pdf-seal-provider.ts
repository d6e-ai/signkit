export const PDF_SEAL_PROFILES: readonly PdfSealProfile[] = ['pades-b-b', 'pades-b-t'];

export type PdfSealProfile = 'pades-b-b' | 'pades-b-t';

/**
 * Public, frozen inputs that identify one provider operation. Private-key
 * references and provider credentials deliberately do not cross this port.
 */
export interface PdfSealOperationReference {
	operationId: string;
	sourceSha256: string;
	sourceByteSize: number;
	requestedProfile: PdfSealProfile;
	signerCertificateSha256: string;
	sealPolicyId: string;
	validationPolicyId: string;
	tsaPolicyId: string | null;
	tsaTrustBundleSha256: string | null;
}

export interface SubmitPdfSealOperation extends PdfSealOperationReference {
	source: ReadableStream<Uint8Array>;
}

export interface PdfSealOperationReceipt extends PdfSealOperationReference {
	providerReceiptId: string;
}

export type PdfSealOperationBase = PdfSealOperationReceipt;

export type PdfSealProviderOperation =
	| (PdfSealOperationBase & { status: 'pending' | 'processing' })
	| (PdfSealOperationBase & {
			status: 'failed';
			errorCode: string;
			retryable: boolean;
	  })
	| PdfSealSucceededOperation;

export interface PdfSealSucceededOperation extends PdfSealOperationBase {
	status: 'succeeded';
	achievedProfile: PdfSealProfile;
	resultSha256: string;
	resultByteSize: number;
}

export interface PdfSealResult {
	bytes: Uint8Array<ArrayBuffer>;
	sha256: string;
	byteSize: number;
	achievedProfile: PdfSealProfile;
	providerReceiptId: string;
}

export type PdfSealProviderErrorCode =
	| 'invalid_configuration'
	| 'invalid_request'
	| 'source_size_mismatch'
	| 'network_error'
	| 'request_timeout'
	| 'rate_limited'
	| 'provider_unavailable'
	| 'provider_authentication_failed'
	| 'operation_not_found'
	| 'operation_conflict'
	| 'provider_rejected'
	| 'provider_redirected'
	| 'invalid_response'
	| 'response_too_large'
	| 'integrity_mismatch';

/**
 * A deliberately detail-free provider failure. The message is always the
 * stable code so credentials, URLs, provider bodies, and key references do
 * not accidentally enter logs through ordinary Error serialization.
 */
export class PdfSealProviderError extends Error {
	constructor(
		readonly code: PdfSealProviderErrorCode,
		readonly retryable: boolean,
		readonly ambiguous: boolean,
		readonly httpStatus: number | null = null
	) {
		super(code);
		this.name = 'PdfSealProviderError';
	}
}

/**
 * Provider-neutral asynchronous sealing boundary. A successful provider
 * result remains untrusted until an independent PdfSealValidator accepts it.
 */
export interface PdfSealProvider {
	submit(command: SubmitPdfSealOperation): Promise<PdfSealProviderOperation>;
	/** Reconcile an accepted operation while pinning its provider receipt. */
	getStatus(receipt: PdfSealOperationReceipt): Promise<PdfSealProviderOperation>;
	/**
	 * Recover only after an ambiguous submit outcome, before a receipt is known.
	 * Callers must persist the returned receipt before using getStatus.
	 */
	recoverAmbiguousSubmit(reference: PdfSealOperationReference): Promise<PdfSealProviderOperation>;
	readResult(operation: PdfSealSucceededOperation): Promise<PdfSealResult>;
}
