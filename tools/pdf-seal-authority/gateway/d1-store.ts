import type {
	ProviderSigningLedger,
	ProviderSigningReservation
} from '../../../src/lib/application/pdf-seals/provider-signing-gate';
import type { PdfSealProviderOperation } from '../../../src/lib/ports/pdf-seal-provider';

const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Same fixed-width UTC text as Date#toISOString, evaluated once per statement. */
const DB_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export interface Scope {
	issuer: string;
	audience: string;
}

export interface ReceiptReference {
	operationId: string;
	envelopeId: string;
	sourceSha256: string;
	sourceByteSize: number;
	signerCertificateSha256: string;
	sealPolicyId: string;
	validationPolicyId: string;
}

export interface ReceiptRow {
	operation_id: string;
	envelope_id: string;
	receipt_id: string;
	source_sha256: string;
	source_byte_size: number;
	requested_profile: 'pades-b-b';
	signer_certificate_sha256: string;
	seal_policy_id: string;
	validation_policy_id: string;
	status: 'pending' | 'processing' | 'succeeded' | 'failed';
	error_code: string | null;
	result_sha256: string | null;
	result_byte_size: number | null;
}

/** Provider-owned permanent reservation. Never retries: any ambiguity propagates. */
export class D1ProviderSigningLedger implements ProviderSigningLedger {
	readonly #db: D1Database;

	constructor(db: D1Database) {
		this.#db = db;
	}

	async reserve(input: ProviderSigningReservation): Promise<'reserved' | 'existing' | 'conflict'> {
		if (!ISO_MILLIS.test(input.expiresAt)) throw new TypeError('invalid expiry');
		// Single statement: either unique key (operation or envelope) suppresses the insert, and the
		// admission is bounded by the database clock.
		const inserted = await this.#db
			.prepare(
				`INSERT OR IGNORE INTO provider_signing_replay
					(issuer, audience, envelope_id, operation_id, authorization_sha256, accepted_at, expires_at)
				SELECT ?, ?, ?, ?, ?, ${DB_NOW}, ?
				WHERE ${DB_NOW} < ?`
			)
			.bind(
				input.issuer,
				input.audience,
				input.envelopeId,
				input.operationId,
				input.authorizationSha256,
				input.expiresAt,
				input.expiresAt
			)
			.run();
		if (inserted.meta.changes === 1) return 'reserved';
		const existing = await this.#db
			.prepare(
				`SELECT envelope_id, authorization_sha256 FROM provider_signing_replay
				WHERE issuer = ? AND audience = ? AND operation_id = ?`
			)
			.bind(input.issuer, input.audience, input.operationId)
			.first<{ envelope_id: string; authorization_sha256: string }>();
		return existing !== null &&
			existing.envelope_id === input.envelopeId &&
			existing.authorization_sha256 === input.authorizationSha256
			? 'existing'
			: 'conflict';
	}

	/** True when the operation or its envelope already consumed a reservation in this scope. */
	async known(scope: Scope, operationId: string, envelopeId: string): Promise<boolean> {
		const row = await this.#db
			.prepare(
				`SELECT 1 AS found FROM provider_signing_replay
				WHERE issuer = ? AND audience = ? AND (operation_id = ? OR envelope_id = ?)`
			)
			.bind(scope.issuer, scope.audience, operationId, envelopeId)
			.first<{ found: number }>();
		return row !== null;
	}
}

export class D1ReceiptStore {
	readonly #db: D1Database;
	readonly #scope: Scope;

	constructor(db: D1Database, scope: Scope) {
		this.#db = db;
		this.#scope = scope;
	}

	/** Receipt exists only for an already reserved operation of the same envelope. */
	async createPending(reference: ReceiptReference, receiptId: string): Promise<void> {
		const result = await this.#db
			.prepare(
				`INSERT OR IGNORE INTO provider_signing_receipt
					(issuer, audience, operation_id, envelope_id, receipt_id, source_sha256,
					 source_byte_size, requested_profile, signer_certificate_sha256, seal_policy_id,
					 validation_policy_id, status, created_at, updated_at)
				SELECT issuer, audience, operation_id, envelope_id, ?, ?, ?, 'pades-b-b', ?, ?, ?,
					'pending', ${DB_NOW}, ${DB_NOW}
				FROM provider_signing_replay
				WHERE issuer = ? AND audience = ? AND operation_id = ? AND envelope_id = ?`
			)
			.bind(
				receiptId,
				reference.sourceSha256,
				reference.sourceByteSize,
				reference.signerCertificateSha256,
				reference.sealPolicyId,
				reference.validationPolicyId,
				this.#scope.issuer,
				this.#scope.audience,
				reference.operationId,
				reference.envelopeId
			)
			.run();
		if (result.meta.changes !== 1) throw new Error('receipt_not_created');
	}

	async read(operationId: string): Promise<ReceiptRow | null> {
		return this.#db
			.prepare(
				`SELECT operation_id, envelope_id, receipt_id, source_sha256, source_byte_size,
					requested_profile, signer_certificate_sha256, seal_policy_id, validation_policy_id,
					status, error_code, result_sha256, result_byte_size
				FROM provider_signing_receipt WHERE issuer = ? AND audience = ? AND operation_id = ?`
			)
			.bind(this.#scope.issuer, this.#scope.audience, operationId)
			.first<ReceiptRow>();
	}

	/** Exactly one caller wins the right to call the engine. */
	async claim(operationId: string): Promise<boolean> {
		return (await this.#transition(operationId, 'pending', "status = 'processing'", [])) === 1;
	}

	async succeed(
		operationId: string,
		result: { sha256: string; byteSize: number; engineRequestId: string }
	): Promise<boolean> {
		return (
			(await this.#transition(
				operationId,
				'processing',
				"status = 'succeeded', result_sha256 = ?, result_byte_size = ?, engine_request_id = ?",
				[result.sha256, result.byteSize, result.engineRequestId]
			)) === 1
		);
	}

	async fail(operationId: string, errorCode: string): Promise<boolean> {
		return (
			(await this.#transition(operationId, 'processing', "status = 'failed', error_code = ?", [
				errorCode
			])) === 1
		);
	}

	async #transition(
		operationId: string,
		from: ReceiptRow['status'],
		assignments: string,
		values: (string | number)[]
	): Promise<number> {
		const result = await this.#db
			.prepare(
				`UPDATE provider_signing_receipt SET ${assignments}, updated_at = ${DB_NOW}
				WHERE issuer = ? AND audience = ? AND operation_id = ? AND status = ?`
			)
			.bind(...values, this.#scope.issuer, this.#scope.audience, operationId, from)
			.run();
		return result.meta.changes;
	}
}

/** Remote provider status contract. The engine/HSM request id is never part of it. */
export function operationOf(row: ReceiptRow): PdfSealProviderOperation {
	const base = {
		operationId: row.operation_id,
		sourceSha256: row.source_sha256,
		sourceByteSize: row.source_byte_size,
		requestedProfile: row.requested_profile,
		signerCertificateSha256: row.signer_certificate_sha256,
		sealPolicyId: row.seal_policy_id,
		validationPolicyId: row.validation_policy_id,
		tsaPolicyId: null,
		tsaTrustBundleSha256: null,
		providerReceiptId: row.receipt_id
	} as const;
	switch (row.status) {
		case 'pending':
		case 'processing':
			return { ...base, status: row.status };
		case 'failed':
			return { ...base, status: 'failed', errorCode: row.error_code ?? 'signing_failed', retryable: false };
		case 'succeeded':
			return {
				...base,
				status: 'succeeded',
				achievedProfile: row.requested_profile,
				resultSha256: row.result_sha256 ?? '',
				resultByteSize: row.result_byte_size ?? 0
			};
	}
}
