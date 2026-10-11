import { describe, expect, it } from 'vitest';
import {
	canonicalRecipientSignFingerprint,
	fingerprintRecipientSignRequest,
	fingerprintValuesFromStored,
	reconstructRecipientSignFingerprint,
	recipientSignedAuditPayloadJson,
	validStoredRecipientSignedReceipt
} from './recipient-sign';

const ENVELOPE_ID: string = '01910000-0000-7000-8000-000000000001';
const RECIPIENT_ID: string = '01910000-0000-7000-8000-000000000002';
const FIELD_ID: string = '01910000-0000-7000-8000-000000000003';
const SECOND_FIELD_ID: string = '01910000-0000-7000-8000-000000000004';
const CAPABILITY_HASH: string = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SIGNED_AT: string = '2026-09-11T00:02:00.000Z';
const SENT_COMMIT: string = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PREVIOUS_HASH: string = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const GOLDEN_REQUEST_JSON: string =
	'{"envelopeId":"01910000-0000-7000-8000-000000000001","recipientId":"01910000-0000-7000-8000-000000000002","capabilityHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedFieldGeneration":1,"values":[{"fieldId":"01910000-0000-7000-8000-000000000003","value":"Jane Doe"}]}';
const GOLDEN_REQUEST_FINGERPRINT: string =
	'737b00bcc5206ca8aca645509c087b88b20a16240e36ea856a6b6bf99f087235';
const GOLDEN_VALUE_JSON: string = '"Jane Doe"';
const GOLDEN_VALUE_SHA256: string =
	'02d343e3e1d05133fe1a6520d1800a02bf6d90526d942976706151ec25d8649c';
const GOLDEN_AUDIT_JSON: string =
	'{"recipientId":"01910000-0000-7000-8000-000000000002","role":"signer","routingOrder":1,"sentCommitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","fields":[{"id":"01910000-0000-7000-8000-000000000003","fieldType":"text","valueSha256":"02d343e3e1d05133fe1a6520d1800a02bf6d90526d942976706151ec25d8649c"}],"signedAt":"2026-09-11T00:02:00.000Z"}';
const GOLDEN_EVENT_HASH: string =
	'17a8048e77bfa9f0cd6553b328131d4b452b8160aaecf5c305a9e1d627bd78e3';
const GOLDEN_COMPLETED_JSON: string =
	'{"sentCommitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","completedAt":"2026-09-11T00:02:00.000Z"}';
const GOLDEN_COMPLETED_HASH: string =
	'b14c55d20ef61b8e78e8d2a432288bbb9e18a1365fd434aac94d5b3128438c5b';

describe('recipient sign command contract', () => {
	it('emits frozen fingerprint bytes independent of submission order', async () => {
		expect(
			canonicalRecipientSignFingerprint({
				envelopeId: ENVELOPE_ID,
				recipientId: RECIPIENT_ID,
				capabilityHash: CAPABILITY_HASH,
				expectedFieldGeneration: 1,
				values: [{ fieldId: FIELD_ID, value: 'Jane Doe' }]
			})
		).toBe(GOLDEN_REQUEST_JSON);
		expect(
			await fingerprintRecipientSignRequest({
				envelopeId: ENVELOPE_ID,
				recipientId: RECIPIENT_ID,
				capabilityHash: CAPABILITY_HASH,
				expectedFieldGeneration: 1,
				values: [
					{ fieldId: SECOND_FIELD_ID, value: 'Beta' },
					{ fieldId: FIELD_ID, value: 'Jane Doe' }
				]
			})
		).not.toBe(GOLDEN_REQUEST_FINGERPRINT);
		expect(
			await fingerprintRecipientSignRequest({
				envelopeId: ENVELOPE_ID,
				recipientId: RECIPIENT_ID,
				capabilityHash: CAPABILITY_HASH,
				expectedFieldGeneration: 1,
				values: [{ fieldId: FIELD_ID, value: 'Jane Doe' }]
			})
		).toBe(GOLDEN_REQUEST_FINGERPRINT);
	});

	it('reconstructs the same digest from stored value_json and rejects a swapped digest', async () => {
		const stored = [
			{
				fieldId: FIELD_ID,
				valueJson: GOLDEN_VALUE_JSON,
				valueSha256: GOLDEN_VALUE_SHA256
			}
		];
		expect(fingerprintValuesFromStored(stored)).toEqual([{ fieldId: FIELD_ID, value: 'Jane Doe' }]);
		await expect(
			reconstructRecipientSignFingerprint({
				envelopeId: ENVELOPE_ID,
				recipientId: RECIPIENT_ID,
				capabilityHash: CAPABILITY_HASH,
				expectedFieldGeneration: 1,
				fieldCount: 1,
				stored
			})
		).resolves.toBe(GOLDEN_REQUEST_FINGERPRINT);
		await expect(
			reconstructRecipientSignFingerprint({
				envelopeId: ENVELOPE_ID,
				recipientId: RECIPIENT_ID,
				capabilityHash: CAPABILITY_HASH,
				expectedFieldGeneration: 1,
				fieldCount: 1,
				stored: [{ ...stored[0], valueSha256: 'c'.repeat(64) }]
			})
		).resolves.toBeNull();
	});

	it('emits PII-free audit payload bytes and accepts a matching stored receipt', async () => {
		const auditJson: string = recipientSignedAuditPayloadJson({
			recipientId: RECIPIENT_ID,
			role: 'signer',
			routingOrder: 1,
			sentCommitSha: SENT_COMMIT,
			fields: [{ id: FIELD_ID, fieldType: 'text', valueSha256: GOLDEN_VALUE_SHA256 }],
			signedAt: SIGNED_AT
		});
		expect(auditJson).toBe(GOLDEN_AUDIT_JSON);
		expect(auditJson).not.toContain('Jane Doe');
		await expect(
			validStoredRecipientSignedReceipt({
				envelopeId: ENVELOPE_ID,
				recipientId: RECIPIENT_ID,
				recipientRole: 'signer',
				routingOrder: 1,
				sentCommitSha: SENT_COMMIT,
				requestHash: GOLDEN_REQUEST_FINGERPRINT,
				reconstructedFingerprint: GOLDEN_REQUEST_FINGERPRINT,
				auditPayloadJson: GOLDEN_AUDIT_JSON,
				auditEventHash: GOLDEN_EVENT_HASH,
				previousAuditHash: PREVIOUS_HASH,
				auditSequence: 4,
				actorType: 'recipient',
				occurredAt: SIGNED_AT,
				evidenceHashVersion: 3,
				storedValueDigests: [{ fieldId: FIELD_ID, valueSha256: GOLDEN_VALUE_SHA256 }],
				evidenceFields: [{ id: FIELD_ID, fieldType: 'text', valueSha256: GOLDEN_VALUE_SHA256 }],
				fieldCount: 1,
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

	it('rejects replay when the reconstructed fingerprint or completed payload is tampered', async () => {
		const base = {
			envelopeId: ENVELOPE_ID,
			recipientId: RECIPIENT_ID,
			recipientRole: 'signer',
			routingOrder: 1,
			sentCommitSha: SENT_COMMIT,
			requestHash: GOLDEN_REQUEST_FINGERPRINT,
			reconstructedFingerprint: GOLDEN_REQUEST_FINGERPRINT,
			auditPayloadJson: GOLDEN_AUDIT_JSON,
			auditEventHash: GOLDEN_EVENT_HASH,
			previousAuditHash: PREVIOUS_HASH,
			auditSequence: 4,
			actorType: 'recipient',
			occurredAt: SIGNED_AT,
			evidenceHashVersion: 3,
			storedValueDigests: [{ fieldId: FIELD_ID, valueSha256: GOLDEN_VALUE_SHA256 }],
			evidenceFields: [{ id: FIELD_ID, fieldType: 'text', valueSha256: GOLDEN_VALUE_SHA256 }],
			fieldCount: 1,
			completedAuditEventId: '01910000-0000-7000-8000-000000000099',
			completedAuditEventHash: GOLDEN_COMPLETED_HASH,
			completedAuditPayloadJson: GOLDEN_COMPLETED_JSON,
			completedEvidenceHashVersion: 3 as const,
			nextRoutingOrder: null,
			nextCapabilityExpiresAt: null,
			releasedDeliveryCount: 0
		};
		await expect(validStoredRecipientSignedReceipt(base)).resolves.toBe(true);
		await expect(
			validStoredRecipientSignedReceipt({
				...base,
				reconstructedFingerprint: 'd'.repeat(64)
			})
		).resolves.toBe(false);
		await expect(
			validStoredRecipientSignedReceipt({
				...base,
				completedAuditPayloadJson:
					'{"completedAt":"2026-09-11T00:02:00.000Z","sentCommitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
			})
		).resolves.toBe(false);
	});
});
