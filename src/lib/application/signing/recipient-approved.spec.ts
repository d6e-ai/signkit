import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
	ApprovePreparation,
	ApproveRoutingSnapshot,
	PublishRecipientApprovedCommand,
	RecipientApproveStore
} from '$lib/ports/recipient-approve-store';
import { RecipientApprovedApplication } from './recipient-approved';

const token: string = `skr1_${'A'.repeat(43)}`;
const organizationId: string = 'org-1';
const envelopeId: string = '01910000-0000-7000-8000-000000000001';
const recipientId: string = '01910000-0000-7000-8000-000000000002';

function routing(overrides: Partial<ApproveRoutingSnapshot> = {}): ApproveRoutingSnapshot {
	return {
		currentGroupOutstanding: 1,
		remainingActionableOutstanding: 2,
		nextRoutingOrder: null,
		nextGroupCount: 0,
		...overrides
	};
}

function ready(
	overrides: Partial<ApprovePreparation & { outcome: 'ready' }> = {}
): ApprovePreparation {
	return {
		outcome: 'ready',
		organizationId,
		envelopeId,
		recipientId,
		recipientRole: 'approver',
		routingOrder: 1,
		sentCommitSha: 'a'.repeat(40),
		envelopeStatus: 'in_progress',
		auditHead: { sequence: 3, eventHash: 'audit-head-3' },
		routing: routing(),
		...overrides
	};
}

function store(
	preparations: ApprovePreparation[] = [ready()],
	publishResults: Array<Awaited<ReturnType<RecipientApproveStore['publishApproved']>>> = []
): RecipientApproveStore & {
	prepareApproved: ReturnType<typeof vi.fn>;
	publishApproved: ReturnType<typeof vi.fn>;
} {
	return {
		prepareApproved: vi.fn(
			async (): Promise<ApprovePreparation> =>
				preparations.shift() ?? { outcome: 'integrity_error' }
		),
		publishApproved: vi.fn(
			async (command: PublishRecipientApprovedCommand) =>
				publishResults.shift() ?? {
					outcome: 'published' as const,
					result: {
						envelopeId: command.expectedEnvelopeId,
						recipientId: command.expectedRecipientId,
						recipientRole: command.recipientRole,
						routingOrder: command.routingOrder,
						sentCommitSha: command.expectedSentCommitSha,
						envelopeStatus:
							command.completedAuditEventId === null
								? ('in_progress' as const)
								: ('completed' as const),
						approvedAt: command.updatedAt,
						auditEventId: command.auditEventId,
						completedAuditEventId: command.completedAuditEventId,
						nextRoutingOrder: command.nextRoutingOrder
					}
				}
		)
	};
}

const input = {
	token,
	expectedEnvelopeId: envelopeId,
	expectedRecipientId: recipientId,
	idempotencyKey: 'approve-browser-tab-1'
};

function expectedFingerprint(capabilityHash: string): string {
	return createHash('sha256')
		.update(JSON.stringify({ envelopeId, recipientId, capabilityHash }))
		.digest('hex');
}

describe('RecipientApprovedApplication', () => {
	it('publishes a PII-free, hash-chained approval command without a release or completion', async () => {
		const storePort = store();
		const result = await new RecipientApprovedApplication(
			storePort,
			() => new Date('2026-09-11T00:02:00.000Z')
		).approve(input);

		expect(result.outcome).toBe('published');
		const command: PublishRecipientApprovedCommand = storePort.publishApproved.mock.calls[0][0];
		expect(command).toMatchObject({
			expectedEnvelopeId: envelopeId,
			expectedRecipientId: recipientId,
			idempotencyKey: input.idempotencyKey,
			recipientRole: 'approver',
			routingOrder: 1,
			expectedAuditSequence: 3,
			previousAuditHash: 'audit-head-3',
			updatedAt: '2026-09-11T00:02:00.000Z',
			nextRoutingOrder: null,
			nextCapabilityExpiresAt: null,
			releasedDeliveryCount: 0,
			completedAuditEventId: null,
			completedAuditEventHash: null,
			completedAuditPayloadJson: null
		});
		expect(JSON.parse(command.auditPayloadJson)).toEqual({
			recipientId,
			role: 'approver',
			routingOrder: 1,
			sentCommitSha: 'a'.repeat(40),
			approvedAt: '2026-09-11T00:02:00.000Z'
		});
		expect(command.auditPayloadJson).not.toMatch(/recipient@example|Recipient|skr1_|archive/);
	});

	it('computes a stable capability-bound request fingerprint', async () => {
		const storePort = store();
		await new RecipientApprovedApplication(
			storePort,
			() => new Date('2026-09-11T00:02:00.000Z')
		).approve(input);
		const command: PublishRecipientApprovedCommand = storePort.publishApproved.mock.calls[0][0];
		expect(command.requestFingerprint).toBe(expectedFingerprint(command.capabilityHash));

		const secondStorePort = store();
		await new RecipientApprovedApplication(
			secondStorePort,
			() => new Date('2026-09-11T00:05:00.000Z')
		).approve(input);
		const secondCommand: PublishRecipientApprovedCommand =
			secondStorePort.publishApproved.mock.calls[0][0];
		expect(secondCommand.requestFingerprint).toBe(command.requestFingerprint);
	});

	it('releases the next routing group with a bounded future capability expiry when the current group clears', async () => {
		const storePort = store([
			ready({
				routing: routing({ currentGroupOutstanding: 0, nextRoutingOrder: 2, nextGroupCount: 2 })
			})
		]);
		await new RecipientApprovedApplication(
			storePort,
			() => new Date('2026-09-11T00:02:00.000Z')
		).approve(input);
		const command: PublishRecipientApprovedCommand = storePort.publishApproved.mock.calls[0][0];
		expect(command.nextRoutingOrder).toBe(2);
		expect(command.releasedDeliveryCount).toBe(2);
		expect(command.completedAuditEventId).toBeNull();
		expect(Date.parse(command.nextCapabilityExpiresAt as string)).toBeGreaterThan(
			Date.parse(command.updatedAt)
		);
	});

	it('appends a deterministic envelope.completed event chained onto the approval hash when no non-CC recipients remain', async () => {
		const storePort = store([
			ready({ routing: routing({ currentGroupOutstanding: 0, remainingActionableOutstanding: 0 }) })
		]);
		await new RecipientApprovedApplication(
			storePort,
			() => new Date('2026-09-11T00:02:00.000Z')
		).approve(input);
		const command: PublishRecipientApprovedCommand = storePort.publishApproved.mock.calls[0][0];
		expect(command.nextRoutingOrder).toBeNull();
		expect(command.releasedDeliveryCount).toBe(0);
		expect(command.completedAuditEventId).not.toBeNull();
		expect(command.completedAuditEventId).not.toBe(command.auditEventId);
		expect(JSON.parse(command.completedAuditPayloadJson as string)).toEqual({
			sentCommitSha: 'a'.repeat(40),
			completedAt: '2026-09-11T00:02:00.000Z'
		});
		const expectedCompletedHash: string = createHash('sha256')
			.update(
				JSON.stringify({
					hashVersion: 2,
					organizationId,
					envelopeId,
					sequence: 5,
					eventType: 'envelope.completed',
					actorType: 'recipient',
					actorId: recipientId,
					occurredAt: '2026-09-11T00:02:00.000Z',
					payload: { sentCommitSha: 'a'.repeat(40), completedAt: '2026-09-11T00:02:00.000Z' },
					previousHash: command.auditEventHash
				})
			)
			.digest('hex');
		expect(command.completedAuditEventHash).toBe(expectedCompletedHash);
	});

	it('does not call the store again once a replay is found, and skips publication', async () => {
		const receipt = {
			envelopeId,
			recipientId,
			recipientRole: 'approver' as const,
			routingOrder: 1,
			sentCommitSha: 'a'.repeat(40),
			envelopeStatus: 'in_progress' as const,
			approvedAt: '2026-09-11T00:01:00.000Z',
			auditEventId: 'audit-approved',
			completedAuditEventId: null,
			nextRoutingOrder: null
		};
		const storePort = store([{ outcome: 'replayed', result: receipt }]);
		await expect(new RecipientApprovedApplication(storePort).approve(input)).resolves.toEqual({
			outcome: 'replayed',
			result: receipt
		});
		expect(storePort.prepareApproved).toHaveBeenCalledTimes(1);
		expect(storePort.publishApproved).not.toHaveBeenCalled();
	});

	it('passes through terminal preparation outcomes without publishing', async () => {
		for (const outcome of ['not_found', 'context_mismatch', 'role_not_actionable'] as const) {
			const storePort = store([{ outcome }]);
			await expect(new RecipientApprovedApplication(storePort).approve(input)).resolves.toEqual({
				outcome
			});
			expect(storePort.publishApproved).not.toHaveBeenCalled();
		}
	});

	it('retries bounded audit-head races with a fresh non-regressing approved timestamp', async () => {
		const secondReady: ApprovePreparation = ready({
			auditHead: { sequence: 4, eventHash: 'audit-head-4' }
		});
		const storePort = store([ready(), secondReady], [{ outcome: 'audit_conflict' }]);
		const timestamps: Date[] = [
			new Date('2026-09-11T00:02:00.000Z'),
			new Date('2026-09-11T00:02:01.000Z'),
			new Date('2026-09-11T00:02:02.000Z')
		];
		await expect(
			new RecipientApprovedApplication(
				storePort,
				() => timestamps.shift() ?? new Date('2026-09-11T00:02:02.000Z')
			).approve(input)
		).resolves.toMatchObject({ outcome: 'published' });
		expect(storePort.publishApproved).toHaveBeenCalledTimes(2);
		const commands: PublishRecipientApprovedCommand[] = storePort.publishApproved.mock.calls.map(
			(call): PublishRecipientApprovedCommand => call[0]
		);
		expect(commands.map((command): string => command.updatedAt)).toEqual([
			'2026-09-11T00:02:00.000Z',
			'2026-09-11T00:02:01.000Z'
		]);
		expect(commands[1].previousAuditHash).toBe('audit-head-4');
	});

	it('returns the terminal audit conflict once retries are exhausted', async () => {
		const storePort = store(
			[ready(), ready(), ready()],
			[{ outcome: 'audit_conflict' }, { outcome: 'audit_conflict' }, { outcome: 'audit_conflict' }]
		);
		await expect(new RecipientApprovedApplication(storePort).approve(input)).resolves.toEqual({
			outcome: 'audit_conflict'
		});
		expect(storePort.prepareApproved).toHaveBeenCalledTimes(3);
		expect(storePort.publishApproved).toHaveBeenCalledTimes(3);
	});
});
