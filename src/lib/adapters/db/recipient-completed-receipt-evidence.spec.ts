import { describe, expect, it } from 'vitest';
import { hashAuditEventV3 } from '$lib/domain/audit';
import {
	proveRecipientCompletedReceipt,
	type RecipientCompletedReceiptEvidenceRow
} from './recipient-completed-receipt-evidence';

const ENVELOPE_ID: string = '01920003-0000-7000-8000-000000000001';
const RECIPIENT_ID: string = '01920003-0000-7000-8000-000000000002';
const SIGNATURE_FIELD_ID: string = '01920003-0000-7000-8000-00000000000a';
const TEXT_FIELD_ID: string = '01920003-0000-7000-8000-00000000000b';
const AUDIT_EVENT_ID: string = '01920003-0000-7000-8000-000000000010';
const COMPLETION_EVENT_ID: string = '01920003-0000-7000-8000-000000000011';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const CAPABILITY_HASH: string = 'a'.repeat(64);
const COMPLETED_AT: string = '2026-09-24T02:00:00.000Z';
const PREVIOUS_AUDIT_HASH: string = 'b'.repeat(64);
const AUDIT_SEQUENCE: number = 5;
const FIELD_DIGESTS: readonly { id: string; fieldType: string; valueSha256: string }[] = [
	{ id: SIGNATURE_FIELD_ID, fieldType: 'signature', valueSha256: 'c'.repeat(64) },
	{ id: TEXT_FIELD_ID, fieldType: 'text', valueSha256: 'd'.repeat(64) }
].sort((left, right) => (left.id < right.id ? -1 : 1));

/**
 * Builds a row that is internally consistent in every respect the prover
 * checks, so each test can invalidate exactly one fact. The audit hashes are
 * computed the same way the publishing command computes them.
 */
async function signedRow(): Promise<RecipientCompletedReceiptEvidenceRow> {
	const payload = {
		recipientId: RECIPIENT_ID,
		role: 'signer',
		routingOrder: 1,
		sentCommitSha: COMMIT_SHA,
		fields: FIELD_DIGESTS,
		signedAt: COMPLETED_AT
	};
	const auditPayloadJson: string = JSON.stringify(payload);
	const auditEventHash: string = await hashAuditEventV3(
		{
			sequence: AUDIT_SEQUENCE,
			eventType: 'recipient.signed',
			actorType: 'recipient',
			actorId: RECIPIENT_ID,
			occurredAt: COMPLETED_AT,
			payload,
			previousHash: PREVIOUS_AUDIT_HASH
		},
		{ envelopeId: ENVELOPE_ID }
	);
	const completionPayload = { sentCommitSha: COMMIT_SHA, completedAt: COMPLETED_AT };
	const completedAuditPayloadJson: string = JSON.stringify(completionPayload);
	const completedAuditEventHash: string = await hashAuditEventV3(
		{
			sequence: AUDIT_SEQUENCE + 1,
			eventType: 'envelope.completed',
			actorType: 'recipient',
			actorId: RECIPIENT_ID,
			occurredAt: COMPLETED_AT,
			payload: completionPayload,
			previousHash: auditEventHash
		},
		{ envelopeId: ENVELOPE_ID }
	);
	const fieldDigestsJson: string = JSON.stringify(FIELD_DIGESTS);

	return {
		envelopeId: ENVELOPE_ID,
		recipientId: RECIPIENT_ID,
		recipientRole: 'signer',
		routingOrder: 1,
		actorType: 'recipient',
		actorId: RECIPIENT_ID,
		idempotencyKey: 'sign-command-1',
		// Never re-derived for a signer: it covers submitted plaintext values.
		requestHash: 'e'.repeat(64),
		capabilityHash: CAPABILITY_HASH,
		sentCommitSha: COMMIT_SHA,
		updatedAt: COMPLETED_AT,
		nextRoutingOrder: null,
		nextCapabilityExpiresAt: null,
		releasedDeliveryCount: 0,
		auditEventId: AUDIT_EVENT_ID,
		auditSequence: AUDIT_SEQUENCE,
		previousAuditHash: PREVIOUS_AUDIT_HASH,
		auditEventHash,
		auditPayloadJson,
		completedAuditEventId: COMPLETION_EVENT_ID,
		completedAuditEventHash,
		completedAuditPayloadJson,
		fieldValuesJson: fieldDigestsJson,
		fieldCount: FIELD_DIGESTS.length,
		durableFieldDigestsJson: fieldDigestsJson,
		recipientStatus: 'completed',
		recipientProjectedRole: 'signer',
		recipientLocale: 'ja',
		recipientCapabilityHash: CAPABILITY_HASH,
		recipientCapabilityRevokedAt: COMPLETED_AT,
		envelopeStatus: 'completed',
		envelopeSentCommitSha: COMMIT_SHA,
		envelopeRepositoryHead: COMMIT_SHA,
		evidenceEventId: AUDIT_EVENT_ID,
		evidenceEnvelopeId: ENVELOPE_ID,
		evidenceSequence: AUDIT_SEQUENCE,
		evidenceEventType: 'recipient.signed',
		evidenceActorType: 'recipient',
		evidenceActorId: RECIPIENT_ID,
		evidencePayloadJson: auditPayloadJson,
		evidencePreviousHash: PREVIOUS_AUDIT_HASH,
		evidenceEventHash: auditEventHash,
		evidenceOccurredAt: COMPLETED_AT,
		evidenceHashVersion: 3,
		previousEnvelopeId: ENVELOPE_ID,
		previousSequence: AUDIT_SEQUENCE - 1,
		previousEventHash: PREVIOUS_AUDIT_HASH,
		completionEventId: COMPLETION_EVENT_ID,
		completionEnvelopeId: ENVELOPE_ID,
		completionSequence: AUDIT_SEQUENCE + 1,
		completionEventType: 'envelope.completed',
		completionActorType: 'recipient',
		completionActorId: RECIPIENT_ID,
		completionPayloadJson: completedAuditPayloadJson,
		completionPreviousHash: auditEventHash,
		completionEventHash: completedAuditEventHash,
		completionOccurredAt: COMPLETED_AT,
		completionHashVersion: 3
	};
}

describe('proveRecipientCompletedReceipt', () => {
	it('proves a consistent signer row that also completed the envelope', async () => {
		await expect(proveRecipientCompletedReceipt(await signedRow(), 'signed')).resolves.toEqual({
			envelopeId: ENVELOPE_ID,
			recipientId: RECIPIENT_ID,
			idempotencyKey: 'sign-command-1',
			capabilityHash: CAPABILITY_HASH,
			action: 'signed',
			completedAt: COMPLETED_AT,
			envelopeStatus: 'completed',
			envelopeCompletedByThisAction: true,
			locale: 'ja'
		});
	});

	it('refuses to read signer evidence as an approval', async () => {
		await expect(proveRecipientCompletedReceipt(await signedRow(), 'approved')).resolves.toBeNull();
	});

	it.each<readonly [string, Partial<RecipientCompletedReceiptEvidenceRow>]>([
		['a released next group paired with a completion', { nextRoutingOrder: 2 }],
		[
			'a released next group without a reserved expiry',
			{
				completedAuditEventId: null,
				completedAuditEventHash: null,
				completedAuditPayloadJson: null,
				nextRoutingOrder: 2,
				releasedDeliveryCount: 1,
				envelopeStatus: 'in_progress'
			}
		],
		[
			'a released delivery count without a next group',
			{
				completedAuditEventId: null,
				completedAuditEventHash: null,
				completedAuditPayloadJson: null,
				completionEventId: null,
				releasedDeliveryCount: 1,
				envelopeStatus: 'in_progress'
			}
		],
		['a partially present completion triple', { completedAuditPayloadJson: null }],
		['a negative released delivery count', { releasedDeliveryCount: -1 }],
		['a non-integer released delivery count', { releasedDeliveryCount: 'many' }],
		['an out-of-range routing order', { routingOrder: 0 }],
		['a mismatched projected role', { recipientProjectedRole: 'approver' }],
		['a non-terminal recipient status', { recipientStatus: 'viewed' }],
		['an unsupported locale', { recipientLocale: 'de' }],
		['a voided envelope', { envelopeStatus: 'voided' }],
		['an expired envelope', { envelopeStatus: 'expired' }],
		['a completion claimed while still in progress', { envelopeStatus: 'in_progress' }],
		['an unpinned repository head', { envelopeRepositoryHead: 'deadbeef' }],
		[
			'a revocation time that differs from the action',
			{ recipientCapabilityRevokedAt: '2026-09-24T02:00:01.000Z' }
		],
		['a genesis audit sequence', { auditSequence: 1 }],
		[
			'a missing audit predecessor',
			{ previousSequence: null, previousEventHash: null, previousEnvelopeId: null }
		],
		[
			'a duplicated field ID',
			{
				fieldValuesJson: JSON.stringify([FIELD_DIGESTS[0], FIELD_DIGESTS[0]]),
				durableFieldDigestsJson: JSON.stringify([FIELD_DIGESTS[0], FIELD_DIGESTS[0]])
			}
		],
		[
			'unsorted field digests',
			{
				fieldValuesJson: JSON.stringify([...FIELD_DIGESTS].reverse()),
				durableFieldDigestsJson: JSON.stringify([...FIELD_DIGESTS].reverse())
			}
		],
		['a field count that disagrees with the digests', { fieldCount: 1 }],
		[
			'an unknown field type',
			{
				fieldValuesJson: JSON.stringify(
					FIELD_DIGESTS.map((field) => ({ ...field, fieldType: 'stamp' }))
				)
			}
		],
		[
			'a non-digest field value',
			{
				fieldValuesJson: JSON.stringify(
					FIELD_DIGESTS.map((field) => ({ ...field, valueSha256: 'short' }))
				)
			}
		],
		[
			'an extra key on a field digest',
			{
				fieldValuesJson: JSON.stringify(
					FIELD_DIGESTS.map((field) => ({ ...field, valueJson: '"Alice"' }))
				)
			}
		],
		['malformed field JSON', { fieldValuesJson: 'not-json' }],
		['digests absent from the durable rows', { durableFieldDigestsJson: '[]' }],
		['field columns present on an approval-shaped payload', { fieldValuesJson: null }],
		[
			'a rewritten completion payload',
			{ completionPayloadJson: '{}', completedAuditPayloadJson: '{}' }
		],
		['a completion event off the chain', { completionPreviousHash: 'f'.repeat(64) }],
		['a completion event at the wrong sequence', { completionSequence: AUDIT_SEQUENCE + 2 }],
		['a missing completion event row', { completionEventId: null }]
	])('fails closed on %s', async (_name, overrides) => {
		const row: RecipientCompletedReceiptEvidenceRow = { ...(await signedRow()), ...overrides };
		await expect(proveRecipientCompletedReceipt(row, 'signed')).resolves.toBeNull();
	});

	it('proves an in-progress signer row that released the next routing group', async () => {
		const row: RecipientCompletedReceiptEvidenceRow = {
			...(await signedRow()),
			completedAuditEventId: null,
			completedAuditEventHash: null,
			completedAuditPayloadJson: null,
			completionEventId: null,
			completionEnvelopeId: null,
			completionSequence: null,
			completionEventType: null,
			completionActorType: null,
			completionActorId: null,
			completionPayloadJson: null,
			completionPreviousHash: null,
			completionEventHash: null,
			completionOccurredAt: null,
			completionHashVersion: null,
			nextRoutingOrder: 2,
			nextCapabilityExpiresAt: '2026-10-08T02:00:00.000Z',
			releasedDeliveryCount: 1,
			envelopeStatus: 'in_progress'
		};

		await expect(proveRecipientCompletedReceipt(row, 'signed')).resolves.toMatchObject({
			action: 'signed',
			envelopeStatus: 'in_progress',
			envelopeCompletedByThisAction: false
		});
	});

	it('reports a later recipient’s envelope completion without crediting this action', async () => {
		const row: RecipientCompletedReceiptEvidenceRow = {
			...(await signedRow()),
			completedAuditEventId: null,
			completedAuditEventHash: null,
			completedAuditPayloadJson: null,
			completionEventId: null,
			completionEnvelopeId: null,
			completionSequence: null,
			completionEventType: null,
			completionActorType: null,
			completionActorId: null,
			completionPayloadJson: null,
			completionPreviousHash: null,
			completionEventHash: null,
			completionOccurredAt: null,
			completionHashVersion: null,
			envelopeStatus: 'completed'
		};

		await expect(proveRecipientCompletedReceipt(row, 'signed')).resolves.toMatchObject({
			envelopeStatus: 'completed',
			envelopeCompletedByThisAction: false
		});
	});
});
