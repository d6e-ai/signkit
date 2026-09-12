import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
	DeclinePreparation,
	PublishRecipientDeclinedCommand,
	RecipientDeclineStore
} from '$lib/ports/recipient-decline-store';
import { RecipientDeclinedApplication } from './recipient-declined';

const token: string = `skr1_${'A'.repeat(43)}`;
const organizationId: string = 'org-1';
const envelopeId: string = '01910000-0000-7000-8000-000000000001';
const recipientId: string = '01910000-0000-7000-8000-000000000002';

const ready: Extract<DeclinePreparation, { outcome: 'ready' }> = {
	outcome: 'ready',
	organizationId,
	envelopeId,
	recipientId,
	recipientRole: 'signer',
	routingOrder: 1,
	sentCommitSha: 'a'.repeat(40),
	envelopeStatus: 'sent',
	revokedRecipientIds: [
		'01910000-0000-7000-8000-000000000003',
		'01910000-0000-7000-8000-000000000004'
	],
	auditHead: { sequence: 3, eventHash: 'audit-head-3' }
};

function store(
	preparations: DeclinePreparation[] = [ready],
	publishResults: Array<Awaited<ReturnType<RecipientDeclineStore['publishDeclined']>>> = []
): RecipientDeclineStore & {
	prepareDeclined: ReturnType<typeof vi.fn>;
	publishDeclined: ReturnType<typeof vi.fn>;
} {
	return {
		prepareDeclined: vi.fn(
			async (): Promise<DeclinePreparation> =>
				preparations.shift() ?? { outcome: 'integrity_error' }
		),
		publishDeclined: vi.fn(
			async (command: PublishRecipientDeclinedCommand) =>
				publishResults.shift() ?? {
					outcome: 'published' as const,
					result: {
						envelopeId: command.expectedEnvelopeId,
						recipientId: command.expectedRecipientId,
						recipientRole: command.recipientRole,
						routingOrder: command.routingOrder,
						sentCommitSha: command.expectedSentCommitSha,
						envelopeStatus: 'declined' as const,
						declinedAt: command.updatedAt,
						auditEventId: command.auditEventId
					}
				}
		)
	};
}

const input = {
	token,
	expectedEnvelopeId: envelopeId,
	expectedRecipientId: recipientId,
	idempotencyKey: 'decline-browser-tab-1'
};

function expectedFingerprint(capabilityHash: string): string {
	return createHash('sha256')
		.update(
			JSON.stringify({
				envelopeId,
				recipientId,
				capabilityHash
			})
		)
		.digest('hex');
}

describe('RecipientDeclinedApplication', () => {
	it('publishes a PII-free, hash-chained decline command without reauthorizing afterwards', async () => {
		const storePort = store();
		const result = await new RecipientDeclinedApplication(
			storePort,
			() => new Date('2026-09-11T00:02:00.000Z')
		).decline(input);

		expect(result.outcome).toBe('published');
		const command: PublishRecipientDeclinedCommand = storePort.publishDeclined.mock.calls[0][0];
		expect(command).toMatchObject({
			expectedEnvelopeId: envelopeId,
			expectedRecipientId: recipientId,
			idempotencyKey: input.idempotencyKey,
			recipientRole: ready.recipientRole,
			routingOrder: ready.routingOrder,
			expectedAuditSequence: 3,
			previousAuditHash: 'audit-head-3',
			updatedAt: '2026-09-11T00:02:00.000Z'
		});
		expect(JSON.parse(command.auditPayloadJson)).toEqual({
			recipientId,
			role: 'signer',
			routingOrder: 1,
			sentCommitSha: ready.sentCommitSha,
			declinedAt: '2026-09-11T00:02:00.000Z',
			revokedCapabilities: {
				reason: 'envelope_declined',
				recipientIds: ready.revokedRecipientIds
			}
		});
		expect(command.revocationEvidenceVersion).toBe(2);
		expect(command.revokedRecipientIds).toEqual(ready.revokedRecipientIds);
		expect(command.auditPayloadJson).not.toMatch(/recipient@example|Recipient|skr1_|archive/);
	});

	it('computes a stable capability-bound request fingerprint', async () => {
		const storePort = store();
		await new RecipientDeclinedApplication(
			storePort,
			() => new Date('2026-09-11T00:02:00.000Z')
		).decline(input);

		const command: PublishRecipientDeclinedCommand = storePort.publishDeclined.mock.calls[0][0];
		expect(command.requestFingerprint).toBe(expectedFingerprint(command.capabilityHash));

		const secondStorePort = store();
		await new RecipientDeclinedApplication(
			secondStorePort,
			() => new Date('2026-09-11T00:05:00.000Z')
		).decline(input);
		const secondCommand: PublishRecipientDeclinedCommand =
			secondStorePort.publishDeclined.mock.calls[0][0];
		expect(secondCommand.requestFingerprint).toBe(command.requestFingerprint);
	});

	it('does not call the store again once a replay is found, and skips publication', async () => {
		const receipt = {
			envelopeId,
			recipientId,
			recipientRole: 'signer' as const,
			routingOrder: 1,
			sentCommitSha: ready.sentCommitSha,
			envelopeStatus: 'declined' as const,
			declinedAt: '2026-09-11T00:01:00.000Z',
			auditEventId: 'audit-declined'
		};
		const storePort = store([{ outcome: 'replayed', result: receipt }]);
		await expect(new RecipientDeclinedApplication(storePort).decline(input)).resolves.toEqual({
			outcome: 'replayed',
			result: receipt
		});
		expect(storePort.prepareDeclined).toHaveBeenCalledTimes(1);
		expect(storePort.publishDeclined).not.toHaveBeenCalled();
	});

	it('passes through terminal preparation outcomes without publishing', async () => {
		for (const outcome of [
			'not_found',
			'context_mismatch',
			'role_not_actionable',
			'delivery_in_flight'
		] as const) {
			const storePort = store([{ outcome }]);
			await expect(new RecipientDeclinedApplication(storePort).decline(input)).resolves.toEqual({
				outcome
			});
			expect(storePort.publishDeclined).not.toHaveBeenCalled();
		}
	});

	it('retries bounded audit-head races with a fresh non-regressing declined timestamp', async () => {
		const secondReady: Extract<DeclinePreparation, { outcome: 'ready' }> = {
			...ready,
			auditHead: { sequence: 4, eventHash: 'audit-head-4' }
		};
		const storePort = store([ready, secondReady], [{ outcome: 'audit_conflict' }]);
		const timestamps: Date[] = [
			new Date('2026-09-11T00:02:00.000Z'),
			new Date('2026-09-11T00:02:01.000Z'),
			new Date('2026-09-11T00:02:02.000Z')
		];
		await expect(
			new RecipientDeclinedApplication(
				storePort,
				() => timestamps.shift() ?? new Date('2026-09-11T00:02:02.000Z')
			).decline(input)
		).resolves.toMatchObject({ outcome: 'published' });
		expect(storePort.publishDeclined).toHaveBeenCalledTimes(2);
		const commands: PublishRecipientDeclinedCommand[] = storePort.publishDeclined.mock.calls.map(
			(call): PublishRecipientDeclinedCommand => call[0]
		);
		expect(commands.map((command): string => command.updatedAt)).toEqual([
			'2026-09-11T00:02:00.000Z',
			'2026-09-11T00:02:01.000Z'
		]);
		expect(commands[1].previousAuditHash).toBe('audit-head-4');
	});

	it('returns the terminal audit conflict once retries are exhausted', async () => {
		const storePort = store(
			[ready, { ...ready }, { ...ready }],
			[{ outcome: 'audit_conflict' }, { outcome: 'audit_conflict' }, { outcome: 'audit_conflict' }]
		);
		await expect(new RecipientDeclinedApplication(storePort).decline(input)).resolves.toEqual({
			outcome: 'audit_conflict'
		});
		expect(storePort.prepareDeclined).toHaveBeenCalledTimes(3);
		expect(storePort.publishDeclined).toHaveBeenCalledTimes(3);
	});
});
