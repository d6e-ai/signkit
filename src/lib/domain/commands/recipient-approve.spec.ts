import { describe, expect, it } from 'vitest';
import {
	canonicalRecipientApproveRequestJson,
	fingerprintRecipientApproveRequest,
	recipientApprovedAuditPayloadJson,
	validStoredRecipientApprovedReceipt
} from './recipient-approve';

const ENVELOPE_ID: string = '01910000-0000-7000-8000-000000000001';
const RECIPIENT_ID: string = '01910000-0000-7000-8000-000000000002';
const CAPABILITY_HASH: string = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const APPROVED_AT: string = '2026-09-11T00:02:00.000Z';
const SENT_COMMIT: string = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PREVIOUS_HASH: string = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const GOLDEN_REQUEST_JSON: string =
	'{"envelopeId":"01910000-0000-7000-8000-000000000001","recipientId":"01910000-0000-7000-8000-000000000002","capabilityHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}';
const GOLDEN_REQUEST_FINGERPRINT: string =
	'e517edf4d672e051fa9a3aaa403a407d6dcefbd6c66bb25158fd02c31aa065e7';
const GOLDEN_AUDIT_JSON: string =
	'{"recipientId":"01910000-0000-7000-8000-000000000002","role":"approver","routingOrder":1,"sentCommitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","approvedAt":"2026-09-11T00:02:00.000Z"}';
const GOLDEN_EVENT_HASH: string =
	'aab2991ccf9fb8aa72eb57e2df3564fd5467c387047b3f70a7edced9ad0b621a';
const GOLDEN_COMPLETED_JSON: string =
	'{"sentCommitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","completedAt":"2026-09-11T00:02:00.000Z"}';
const GOLDEN_COMPLETED_HASH: string =
	'3723cd63bfe14b8d8811fbd7ad17f00180889884b97e870a479e8b99011c7e1d';

describe('recipient approve command contract', () => {
	it('emits frozen capability-bound request bytes', async () => {
		const requestJson: string = canonicalRecipientApproveRequestJson({
			envelopeId: ENVELOPE_ID,
			recipientId: RECIPIENT_ID,
			capabilityHash: CAPABILITY_HASH
		});
		expect(requestJson).toBe(GOLDEN_REQUEST_JSON);
		expect(
			await fingerprintRecipientApproveRequest({
				envelopeId: ENVELOPE_ID,
				recipientId: RECIPIENT_ID,
				capabilityHash: CAPABILITY_HASH
			})
		).toBe(GOLDEN_REQUEST_FINGERPRINT);
	});

	it('binds envelope, recipient, and capability and changes when any one is swapped', async () => {
		const swappedRecipient: string = await fingerprintRecipientApproveRequest({
			envelopeId: ENVELOPE_ID,
			recipientId: '01910000-0000-7000-8000-000000000099',
			capabilityHash: CAPABILITY_HASH
		});
		const swappedCapability: string = await fingerprintRecipientApproveRequest({
			envelopeId: ENVELOPE_ID,
			recipientId: RECIPIENT_ID,
			capabilityHash: 'b'.repeat(64)
		});
		expect(swappedRecipient).not.toBe(GOLDEN_REQUEST_FINGERPRINT);
		expect(swappedCapability).not.toBe(GOLDEN_REQUEST_FINGERPRINT);
		expect(swappedRecipient).not.toBe(swappedCapability);
	});

	it('emits PII-free audit payload bytes and accepts a matching stored receipt', async () => {
		const auditJson: string = recipientApprovedAuditPayloadJson({
			recipientId: RECIPIENT_ID,
			role: 'approver',
			routingOrder: 1,
			sentCommitSha: SENT_COMMIT,
			approvedAt: APPROVED_AT
		});
		expect(auditJson).toBe(GOLDEN_AUDIT_JSON);
		expect(auditJson).not.toMatch(/recipient@example|skr1_/);
		await expect(
			validStoredRecipientApprovedReceipt({
				envelopeId: ENVELOPE_ID,
				recipientId: RECIPIENT_ID,
				recipientRole: 'approver',
				routingOrder: 1,
				sentCommitSha: SENT_COMMIT,
				capabilityHash: CAPABILITY_HASH,
				requestHash: GOLDEN_REQUEST_FINGERPRINT,
				auditPayloadJson: GOLDEN_AUDIT_JSON,
				auditEventHash: GOLDEN_EVENT_HASH,
				previousAuditHash: PREVIOUS_HASH,
				auditSequence: 4,
				actorType: 'recipient',
				occurredAt: APPROVED_AT,
				evidenceHashVersion: 3,
				completedAuditEventId: null,
				completedAuditEventHash: null,
				completedAuditPayloadJson: null,
				completedEvidenceHashVersion: null,
				nextRoutingOrder: null,
				nextCapabilityExpiresAt: null,
				releasedDeliveryCount: 0
			})
		).resolves.toBe(true);
	});

	it('rejects replay when completed payload key order is rewritten', async () => {
		const valid = {
			envelopeId: ENVELOPE_ID,
			recipientId: RECIPIENT_ID,
			recipientRole: 'approver',
			routingOrder: 1,
			sentCommitSha: SENT_COMMIT,
			capabilityHash: CAPABILITY_HASH,
			requestHash: GOLDEN_REQUEST_FINGERPRINT,
			auditPayloadJson: GOLDEN_AUDIT_JSON,
			auditEventHash: GOLDEN_EVENT_HASH,
			previousAuditHash: PREVIOUS_HASH,
			auditSequence: 4,
			actorType: 'recipient',
			occurredAt: APPROVED_AT,
			evidenceHashVersion: 3,
			completedAuditEventId: '01910000-0000-7000-8000-000000000099',
			completedAuditEventHash: GOLDEN_COMPLETED_HASH,
			completedAuditPayloadJson: GOLDEN_COMPLETED_JSON,
			completedEvidenceHashVersion: 3 as const,
			nextRoutingOrder: null,
			nextCapabilityExpiresAt: null,
			releasedDeliveryCount: 0
		};
		await expect(validStoredRecipientApprovedReceipt(valid)).resolves.toBe(true);
		await expect(
			validStoredRecipientApprovedReceipt({
				...valid,
				completedAuditPayloadJson:
					'{"completedAt":"2026-09-11T00:02:00.000Z","sentCommitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
			})
		).resolves.toBe(false);
		await expect(
			validStoredRecipientApprovedReceipt({
				...valid,
				completedAuditEventId: null,
				nextRoutingOrder: 2
			})
		).resolves.toBe(false);
	});
});
