import { describe, expect, it } from 'vitest';
import {
	commandMatchesRecipientDecisionRouting,
	envelopeCompletedAuditPayloadJson,
	MAX_RELEASE_TTL_MS,
	NEXT_ROUTING_CAPABILITY_TTL_MS,
	nextRoutingCapabilityExpiresAt,
	planRecipientDecisionRouting,
	recipientDecisionRoutingSnapshot,
	validStoredDecisionFollowThrough,
	type RecipientDecisionRoutingRecipient
} from './recipient-decision-routing';

const ACTOR_ID: string = '01910000-0000-7000-8000-000000000002';
const SIGNER_2: string = '01910000-0000-7000-8000-000000000012';
const APPROVER_ID: string = '01910000-0000-7000-8000-000000000013';
const VIEWER_ID: string = '01910000-0000-7000-8000-000000000014';
const CC_ID: string = '01910000-0000-7000-8000-000000000015';
const ENVELOPE_ID: string = '01910000-0000-7000-8000-000000000001';
const DECIDED_AT: string = '2026-09-11T00:02:00.000Z';
const SENT_COMMIT: string = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const GOLDEN_COMPLETED_JSON: string =
	'{"sentCommitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","completedAt":"2026-09-11T00:02:00.000Z"}';
const GOLDEN_EXPIRES_AT: string = '2026-09-25T00:02:00.000Z';

function recipient(
	id: string,
	role: RecipientDecisionRoutingRecipient['role'],
	routingOrder: number,
	status: string = 'pending'
): RecipientDecisionRoutingRecipient {
	return { id, role, status, routingOrder };
}

describe('recipient decision routing', () => {
	it('ignores viewer, cc, and prefill when counting remaining actionable recipients', () => {
		const snapshot = recipientDecisionRoutingSnapshot(ACTOR_ID, 1, [
			recipient(ACTOR_ID, 'signer', 1, 'completed'),
			recipient(VIEWER_ID, 'viewer', 1),
			recipient(CC_ID, 'cc', 1),
			recipient('prefill-1', 'prefill', 1),
			recipient(SIGNER_2, 'signer', 2)
		]);
		expect(snapshot).toEqual({
			currentGroupOutstanding: 0,
			remainingActionableOutstanding: 1,
			nextRoutingOrder: 2,
			nextGroupCount: 1
		});
		expect(planRecipientDecisionRouting(snapshot)).toEqual({
			kind: 'release',
			nextRoutingOrder: 2,
			releasedDeliveryCount: 1
		});
	});

	it('counts a viewer in the next group as a released invitation without mixing them into completion', () => {
		const snapshot = recipientDecisionRoutingSnapshot(ACTOR_ID, 1, [
			recipient(ACTOR_ID, 'approver', 1, 'completed'),
			recipient(SIGNER_2, 'signer', 2),
			recipient(VIEWER_ID, 'viewer', 2),
			recipient(CC_ID, 'cc', 2)
		]);
		expect(snapshot.nextGroupCount).toBe(2);
		expect(snapshot.remainingActionableOutstanding).toBe(1);
		expect(planRecipientDecisionRouting(snapshot).kind).toBe('release');
	});

	it('completes only when no other signer or approver remains', () => {
		const snapshot = recipientDecisionRoutingSnapshot(ACTOR_ID, 2, [
			recipient(SIGNER_2, 'signer', 1, 'completed'),
			recipient(ACTOR_ID, 'approver', 2, 'viewed'),
			recipient(VIEWER_ID, 'viewer', 2),
			recipient(CC_ID, 'cc', 3)
		]);
		expect(snapshot.remainingActionableOutstanding).toBe(0);
		expect(planRecipientDecisionRouting(snapshot)).toEqual({ kind: 'complete' });
	});

	it('continues when another actionable recipient remains in the current group', () => {
		const snapshot = recipientDecisionRoutingSnapshot(ACTOR_ID, 1, [
			recipient(ACTOR_ID, 'signer', 1),
			recipient(APPROVER_ID, 'approver', 1),
			recipient(SIGNER_2, 'signer', 2)
		]);
		expect(snapshot).toEqual({
			currentGroupOutstanding: 1,
			remainingActionableOutstanding: 2,
			nextRoutingOrder: 2,
			nextGroupCount: 1
		});
		expect(planRecipientDecisionRouting(snapshot)).toEqual({ kind: 'continue' });
	});

	it('emits frozen completed-audit bytes and a 14-day capability expiry', () => {
		expect(envelopeCompletedAuditPayloadJson(SENT_COMMIT, DECIDED_AT)).toBe(GOLDEN_COMPLETED_JSON);
		expect(nextRoutingCapabilityExpiresAt(DECIDED_AT)).toBe(GOLDEN_EXPIRES_AT);
		expect(NEXT_ROUTING_CAPABILITY_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000);
		expect(MAX_RELEASE_TTL_MS).toBe(15 * 24 * 60 * 60 * 1000);
	});

	it('accepts a 14-day release and rejects an expiry beyond the 15-day store bound', () => {
		const routing = {
			currentGroupOutstanding: 0,
			remainingActionableOutstanding: 1,
			nextRoutingOrder: 2,
			nextGroupCount: 2
		};
		const base = {
			completedAuditEventId: null,
			completedAuditEventHash: null,
			completedAuditPayloadJson: null,
			nextRoutingOrder: 2,
			releasedDeliveryCount: 2,
			updatedAt: DECIDED_AT
		};
		expect(
			commandMatchesRecipientDecisionRouting(
				{ ...base, nextCapabilityExpiresAt: GOLDEN_EXPIRES_AT },
				routing
			)
		).toBe(true);
		expect(
			commandMatchesRecipientDecisionRouting(
				{
					...base,
					nextCapabilityExpiresAt: new Date(
						Date.parse(DECIDED_AT) + MAX_RELEASE_TTL_MS + 1
					).toISOString()
				},
				routing
			)
		).toBe(false);
		expect(
			commandMatchesRecipientDecisionRouting(
				{
					completedAuditEventId: 'evt-complete',
					completedAuditEventHash: 'c'.repeat(64),
					completedAuditPayloadJson: GOLDEN_COMPLETED_JSON,
					nextRoutingOrder: null,
					nextCapabilityExpiresAt: null,
					releasedDeliveryCount: 0,
					updatedAt: DECIDED_AT
				},
				{ ...routing, remainingActionableOutstanding: 0, nextRoutingOrder: null, nextGroupCount: 0 }
			)
		).toBe(true);
	});

	it('verifies completed follow-through bytes and rejects a tampered completed payload', async () => {
		const auditEventHash: string =
			'17a8048e77bfa9f0cd6553b328131d4b452b8160aaecf5c305a9e1d627bd78e3';
		const completedHash: string =
			'b14c55d20ef61b8e78e8d2a432288bbb9e18a1365fd434aac94d5b3128438c5b';
		await expect(
			validStoredDecisionFollowThrough({
				envelopeId: ENVELOPE_ID,
				recipientId: ACTOR_ID,
				sentCommitSha: SENT_COMMIT,
				occurredAt: DECIDED_AT,
				actorType: 'recipient',
				auditEventHash,
				auditSequence: 4,
				completedAuditEventId: '01910000-0000-7000-8000-000000000099',
				completedAuditEventHash: completedHash,
				completedAuditPayloadJson: GOLDEN_COMPLETED_JSON,
				completedEvidenceHashVersion: 3,
				nextRoutingOrder: null,
				nextCapabilityExpiresAt: null,
				releasedDeliveryCount: 0
			})
		).resolves.toBe(true);
		await expect(
			validStoredDecisionFollowThrough({
				envelopeId: ENVELOPE_ID,
				recipientId: ACTOR_ID,
				sentCommitSha: SENT_COMMIT,
				occurredAt: DECIDED_AT,
				actorType: 'recipient',
				auditEventHash,
				auditSequence: 4,
				completedAuditEventId: '01910000-0000-7000-8000-000000000099',
				completedAuditEventHash: completedHash,
				completedAuditPayloadJson:
					'{"completedAt":"2026-09-11T00:02:00.000Z","sentCommitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
				completedEvidenceHashVersion: 3,
				nextRoutingOrder: null,
				nextCapabilityExpiresAt: null,
				releasedDeliveryCount: 0
			})
		).resolves.toBe(false);
	});
});
