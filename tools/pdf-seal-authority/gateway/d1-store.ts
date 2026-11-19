import type {
	ProviderSigningLedger,
	ProviderSigningReservation
} from '../../../src/lib/application/pdf-seals/provider-signing-gate';
import type { PdfSealProviderOperation } from '../../../src/lib/ports/pdf-seal-provider';
import type { PdfSealAuthorizationRequest } from '../../../src/lib/application/pdf-seals/pdf-seal-authorization';

const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Same fixed-width UTC text as Date#toISOString, evaluated once per statement. */
const DB_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const DISPATCH_CUTOFF = "strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds')";

export interface Scope {
	issuer: string;
	audience: string;
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
	updated_at: string;
}

/** Provider-owned permanent reservation. Never retries: any ambiguity propagates. */
export class D1ProviderSigningLedger implements ProviderSigningLedger {
	readonly #db: D1Database;
	readonly #prepareEngine: () => Promise<void>;

	constructor(db: D1Database, prepareEngine: () => Promise<void>) {
		this.#db = db;
		this.#prepareEngine = prepareEngine;
	}

	async reserve(
		input: ProviderSigningReservation,
		reference: PdfSealAuthorizationRequest
	): Promise<'reserved' | 'existing' | 'conflict'> {
		if (!ISO_MILLIS.test(input.expiresAt)) throw new TypeError('invalid expiry');
		const accepted = await this.#existingReservation(input);
		if (accepted !== null) return accepted;
		// A container that is still starting must leave the operation eligible for retry.
		await this.#prepareEngine();
		// D1 batches are transactional. A reservation commits with its receipt or
		// neither row commits. Both unique keys and the ledger clock gate admission.
		const reservation = this.#db
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
			);
		const receipt = this.#db
			.prepare(
				`INSERT INTO provider_signing_receipt
				(issuer, audience, operation_id, envelope_id, receipt_id, source_sha256,
				 source_byte_size, requested_profile, signer_certificate_sha256, seal_policy_id,
				 validation_policy_id, status, created_at, updated_at)
			 SELECT issuer, audience, operation_id, envelope_id, ?, ?, ?, 'pades-b-b', ?, ?, ?,
				'pending', ${DB_NOW}, ${DB_NOW}
			 FROM provider_signing_replay
			 WHERE issuer = ? AND audience = ? AND operation_id = ? AND envelope_id = ?
				AND authorization_sha256 = ?
			 ON CONFLICT (issuer, audience, operation_id) DO NOTHING`
			)
			.bind(
				crypto.randomUUID(),
				reference.sourceSha256,
				reference.sourceByteSize,
				reference.signerCertificateSha256,
				reference.sealPolicyId,
				reference.validationPolicyId,
				input.issuer,
				input.audience,
				input.operationId,
				input.envelopeId,
				input.authorizationSha256
			);
		const [inserted, created] = await this.#db.batch([reservation, receipt]);
		if (inserted.meta.changes === 1 && created.meta.changes === 1) return 'reserved';
		return (await this.#existingReservation(input)) ?? 'conflict';
	}

	async #existingReservation(
		input: ProviderSigningReservation
	): Promise<'existing' | 'conflict' | null> {
		const existing = await this.#db
			.prepare(
				`SELECT operation_id, envelope_id, authorization_sha256 FROM provider_signing_replay
				WHERE issuer = ? AND audience = ? AND (operation_id = ? OR envelope_id = ?)`
			)
			.bind(input.issuer, input.audience, input.operationId, input.envelopeId)
			.first<{ operation_id: string; envelope_id: string; authorization_sha256: string }>();
		if (existing === null) return null;
		return existing.operation_id === input.operationId &&
			existing.envelope_id === input.envelopeId &&
			existing.authorization_sha256 === input.authorizationSha256
			? 'existing'
			: 'conflict';
	}
}

export class D1ReceiptStore {
	readonly #db: D1Database;
	readonly #scope: Scope;

	constructor(db: D1Database, scope: Scope) {
		this.#db = db;
		this.#scope = scope;
	}

	async read(operationId: string): Promise<ReceiptRow | null> {
		return this.#db
			.prepare(
				`SELECT operation_id, envelope_id, receipt_id, source_sha256, source_byte_size,
					requested_profile, signer_certificate_sha256, seal_policy_id, validation_policy_id,
					status, error_code, result_sha256, result_byte_size, updated_at
				FROM provider_signing_receipt WHERE issuer = ? AND audience = ? AND operation_id = ?`
			)
			.bind(this.#scope.issuer, this.#scope.audience, operationId)
			.first<ReceiptRow>();
	}

	/** Exactly one caller wins the right to call the engine. */
	async claim(operationId: string): Promise<boolean> {
		const result = await this.#db
			.prepare(
				`UPDATE provider_signing_receipt SET status = 'processing', updated_at = ${DB_NOW}
			 WHERE issuer = ? AND audience = ? AND operation_id = ? AND status = 'pending'
				AND updated_at > ${DISPATCH_CUTOFF}`
			)
			.bind(this.#scope.issuer, this.#scope.audience, operationId)
			.run();
		return result.meta.changes === 1;
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

	async fail(
		operationId: string,
		errorCode: string,
		engineRequestId: string | null = null
	): Promise<boolean> {
		return (
			(await this.#transition(
				operationId,
				'processing',
				"status = 'failed', error_code = ?, engine_request_id = ?",
				[errorCode, engineRequestId]
			)) === 1
		);
	}

	async #transition(
		operationId: string,
		from: ReceiptRow['status'],
		assignments: string,
		values: (string | number | null)[]
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
			if (Date.now() - Date.parse(row.updated_at) > 120_000) {
				return {
					...base,
					status: 'failed',
					retryable: false,
					errorCode:
						row.status === 'pending' ? 'provider_dispatch_expired' : 'provider_outcome_unknown'
				};
			}
			return { ...base, status: row.status };
		case 'failed':
			return {
				...base,
				status: 'failed',
				errorCode: row.error_code ?? 'signing_failed',
				retryable: false
			};
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
