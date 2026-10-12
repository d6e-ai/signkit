import { sha256TextHex } from '$lib/domain/audit';

export interface ReopenCanonicalRequest {
	expectedGeneration: number;
	expectedFieldGeneration: number;
	expectedReadyAuditEventId: string;
}

export interface ReopenAuditPayload {
	commitSha: string;
	generation: number;
	fieldGeneration: number;
	readyAuditEventId: string;
}

export interface StoredReopenReceiptInput {
	envelopeId: string;
	expectedGeneration: number;
	expectedFieldGeneration: number;
	readyAuditEventId: string;
	commitSha: string;
	requestHash: string;
	auditPayloadJson: string;
}

export function canonicalReopenRequestJson(request: ReopenCanonicalRequest): string {
	return JSON.stringify({
		expectedGeneration: request.expectedGeneration,
		expectedFieldGeneration: request.expectedFieldGeneration,
		expectedReadyAuditEventId: request.expectedReadyAuditEventId
	});
}

export async function fingerprintReopenRequest(request: ReopenCanonicalRequest): Promise<string> {
	return sha256TextHex(canonicalReopenRequestJson(request));
}

export function reopenAuditPayloadJson(payload: ReopenAuditPayload): string {
	return JSON.stringify({
		commitSha: payload.commitSha,
		generation: payload.generation,
		fieldGeneration: payload.fieldGeneration,
		readyAuditEventId: payload.readyAuditEventId
	});
}

export async function validStoredReopenReceipt(row: StoredReopenReceiptInput): Promise<boolean> {
	const requestFingerprint: string = await fingerprintReopenRequest({
		expectedGeneration: row.expectedGeneration,
		expectedFieldGeneration: row.expectedFieldGeneration,
		expectedReadyAuditEventId: row.readyAuditEventId
	});
	const expectedAuditPayload: string = reopenAuditPayloadJson({
		commitSha: row.commitSha,
		generation: row.expectedGeneration,
		fieldGeneration: row.expectedFieldGeneration + 1,
		readyAuditEventId: row.readyAuditEventId
	});
	return requestFingerprint === row.requestHash && expectedAuditPayload === row.auditPayloadJson;
}
