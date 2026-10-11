import { describe, expect, it } from 'vitest';
import {
	AUDIT_EVENT_CATALOG,
	WEBHOOK_AUDIT_EVENT_TYPES,
	isAllowedActorType,
	isAuditEventType
} from '$lib/domain/audit';
import type { CompletionEvidenceAuditEvent } from '$lib/ports/completion-artifact-store';
import { canonicalizeWebhookEvents } from '$lib/security/webhook';
import { buildVerifiedAuditChain, type AuditChainStep } from './audit-chain-test-support';
import { verifyAuditEventRecord, verifyCompletionAuditChain } from './audit-event-integrity';

const EVENT_TYPE: string = 'recipient.completion_access_reissued';
const CONTEXT = { envelopeId: 'envelope-1' };

const ANCHORED_STEPS: readonly AuditChainStep[] = [
	{
		id: 'audit-event-1',
		eventType: 'envelope.created',
		actorType: 'user',
		actorId: 'user-1',
		occurredAt: '2026-09-11T00:00:00.000Z',
		payload: { title: 'Agreement' }
	},
	{
		id: 'audit-event-2',
		eventType: 'envelope.completed',
		actorType: 'recipient',
		actorId: 'recipient-1',
		occurredAt: '2026-09-12T00:00:00.000Z',
		payload: { sentCommitSha: 'a'.repeat(40), completedAt: '2026-09-12T00:00:00.000Z' }
	},
	{
		id: 'audit-event-3',
		eventType: 'envelope.completion_artifact_published',
		actorType: 'system',
		actorId: 'completion-artifact-worker',
		occurredAt: '2026-09-12T00:00:01.000Z',
		payload: { manifestSha256: 'm'.repeat(64) }
	}
];

function reissueStep(id: string, actorType: string, actorId: string): AuditChainStep {
	return {
		id,
		eventType: EVENT_TYPE,
		actorType,
		actorId,
		occurredAt: '2026-09-14T00:00:00.000Z',
		payload: {
			recipientId: 'recipient-1',
			predecessorDeliveryId: 'delivery-0',
			deliveryId: `delivery-for-${id}`,
			reissuedAt: '2026-09-14T00:00:00.000Z'
		}
	};
}

describe('recipient.completion_access_reissued audit catalog registration', () => {
	it('is a catalog event writable by user and agent operators only', () => {
		expect(isAuditEventType(EVENT_TYPE)).toBe(true);
		expect(AUDIT_EVENT_CATALOG[EVENT_TYPE]?.actorTypes).toEqual(['user', 'agent']);
		expect(isAllowedActorType(EVENT_TYPE, 'user')).toBe(true);
		expect(isAllowedActorType(EVENT_TYPE, 'agent')).toBe(true);
		expect(isAllowedActorType(EVENT_TYPE, 'system')).toBe(false);
		expect(isAllowedActorType(EVENT_TYPE, 'recipient')).toBe(false);
	});

	it('is subscribable on the webhook surface in catalog order', () => {
		expect(WEBHOOK_AUDIT_EVENT_TYPES).toContain(EVENT_TYPE);
		expect(canonicalizeWebhookEvents([EVENT_TYPE])).toEqual([EVENT_TYPE]);
		expect(canonicalizeWebhookEvents([EVENT_TYPE, 'envelope.completed'])).toEqual([
			'envelope.completed',
			EVENT_TYPE
		]);
		expect(() => canonicalizeWebhookEvents([EVENT_TYPE, EVENT_TYPE])).toThrow();
	});
});

describe('recipient.completion_access_reissued audit integrity', () => {
	it('verifies every event of a full chain that continues past the completion anchor', async () => {
		const events: CompletionEvidenceAuditEvent[] = await buildVerifiedAuditChain(CONTEXT, [
			...ANCHORED_STEPS,
			reissueStep('audit-event-4', 'user', 'user-1'),
			reissueStep('audit-event-5', 'agent', 'api-key-1')
		]);
		for (let index: number = 0; index < events.length; index += 1) {
			expect(events[index].previousHash).toBe(index === 0 ? null : events[index - 1].eventHash);
			await expect(verifyAuditEventRecord(events[index], CONTEXT)).resolves.toBeDefined();
		}
		await expect(verifyAuditEventRecord(events[3], CONTEXT)).resolves.toEqual({
			recipientId: 'recipient-1',
			predecessorDeliveryId: 'delivery-0',
			deliveryId: 'delivery-for-audit-event-4',
			reissuedAt: '2026-09-14T00:00:00.000Z'
		});
	});

	it('leaves the anchored completion prefix and its proof unchanged by later reissues', async () => {
		const before: CompletionEvidenceAuditEvent[] = await buildVerifiedAuditChain(
			CONTEXT,
			ANCHORED_STEPS
		);
		const after: CompletionEvidenceAuditEvent[] = await buildVerifiedAuditChain(CONTEXT, [
			...ANCHORED_STEPS,
			reissueStep('audit-event-4', 'user', 'user-1')
		]);
		expect(after.slice(0, before.length)).toEqual(before);

		const anchoredBefore = await verifyCompletionAuditChain(before.slice(0, 2), CONTEXT, 5_000);
		const anchoredAfter = await verifyCompletionAuditChain(after.slice(0, 2), CONTEXT, 5_000);
		expect(anchoredAfter.proof).toEqual(anchoredBefore.proof);
		expect(anchoredAfter.proof.anchorEventId).toBe('audit-event-2');
		expect(anchoredAfter.proof.headSequence).toBe(2);
	});

	it.each(['system', 'recipient'])(
		'rejects a correctly hashed event stamped with the %s actor',
		async (actorType: string) => {
			const events: CompletionEvidenceAuditEvent[] = await buildVerifiedAuditChain(CONTEXT, [
				...ANCHORED_STEPS,
				reissueStep('audit-event-4', actorType, 'actor-1')
			]);
			await expect(verifyAuditEventRecord(events[3], CONTEXT)).rejects.toThrow(
				'Completion audit event has an unexpected actor type'
			);
		}
	);

	it('rejects a reissue event whose recorded hash no longer matches its fields', async () => {
		const events: CompletionEvidenceAuditEvent[] = await buildVerifiedAuditChain(CONTEXT, [
			...ANCHORED_STEPS,
			reissueStep('audit-event-4', 'user', 'user-1')
		]);
		const reissue: CompletionEvidenceAuditEvent = events[3];
		const tampered: readonly CompletionEvidenceAuditEvent[] = [
			{ ...reissue, eventHash: '0'.repeat(64) },
			{ ...reissue, actorType: 'agent' },
			{ ...reissue, actorId: 'someone-else' },
			{ ...reissue, previousHash: events[1].eventHash },
			{
				...reissue,
				payloadJson: JSON.stringify({
					recipientId: 'recipient-1',
					predecessorDeliveryId: 'delivery-0',
					deliveryId: 'delivery-forged',
					reissuedAt: '2026-09-14T00:00:00.000Z'
				})
			}
		];
		for (const event of tampered) {
			await expect(verifyAuditEventRecord(event, CONTEXT)).rejects.toThrow(
				'Completion audit event hash does not match its recorded fields'
			);
		}
	});
});
