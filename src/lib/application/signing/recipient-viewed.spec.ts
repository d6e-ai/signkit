import { describe, expect, it, vi } from 'vitest';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import type {
	PublishRecipientViewedCommand,
	RecipientViewStore,
	ViewedPreparation
} from '$lib/ports/recipient-view-store';
import type { RecipientAccessApplicationPort } from './recipient-access';
import { RecipientViewedApplication } from './recipient-viewed';

const token: string = `skr1_${'A'.repeat(43)}`;
const context: RecipientSigningContext = {
	organizationId: 'org-1',
	envelopeId: '01910000-0000-7000-8000-000000000001',
	recipientId: '01910000-0000-7000-8000-000000000002',
	recipientName: 'Recipient',
	recipientRole: 'signer',
	recipientLocale: 'en',
	recipientStatus: 'pending',
	envelopeTitle: 'Agreement',
	envelopeStatus: 'sent',
	expiresAt: '2026-09-25T00:00:00.000Z',
	sentRevision: {
		commitSha: 'a'.repeat(40),
		archiveKey: `draft-repositories/v1/organizations/org-1/envelopes/01910000-0000-7000-8000-000000000001/sha256/${'b'.repeat(64)}.git.gz`,
		archiveSha256: 'b'.repeat(64)
	}
};

const ready: ViewedPreparation = {
	outcome: 'ready',
	recipientRole: 'signer',
	routingOrder: 1,
	sentCommitSha: context.sentRevision.commitSha,
	envelopeStatus: 'sent',
	auditHead: { sequence: 3, eventHash: 'audit-head-3' }
};

function access(results: Array<RecipientSigningContext | null>): RecipientAccessApplicationPort {
	return {
		resolve: vi.fn(async (): Promise<RecipientSigningContext | null> => results.shift() ?? null)
	};
}

function store(
	preparations: ViewedPreparation[] = [ready],
	publishResults: Array<Awaited<ReturnType<RecipientViewStore['publishViewed']>>> = []
): RecipientViewStore & {
	prepareViewed: ReturnType<typeof vi.fn>;
	publishViewed: ReturnType<typeof vi.fn>;
} {
	return {
		prepareViewed: vi.fn(
			async (): Promise<ViewedPreparation> => preparations.shift() ?? { outcome: 'integrity_error' }
		),
		publishViewed: vi.fn(
			async (command: PublishRecipientViewedCommand) =>
				publishResults.shift() ?? {
					outcome: 'published' as const,
					result: {
						envelopeId: command.envelopeId,
						recipientId: command.recipientId,
						recipientRole: command.recipientRole,
						routingOrder: command.routingOrder,
						sentCommitSha: command.expectedSentCommitSha,
						envelopeStatus: 'in_progress' as const,
						viewedAt: command.updatedAt,
						auditEventId: command.auditEventId
					}
				}
		)
	};
}

const input = {
	token,
	expectedEnvelopeId: context.envelopeId,
	expectedRecipientId: context.recipientId,
	idempotencyKey: 'viewed-browser-tab-1'
};

describe('RecipientViewedApplication', () => {
	it('publishes a PII-free, hash-chained first-view command and reauthorizes afterwards', async () => {
		const accessPort = access([context, { ...context, recipientStatus: 'viewed' }]);
		const storePort = store();
		const result = await new RecipientViewedApplication(
			accessPort,
			storePort,
			() => new Date('2026-09-11T00:02:00.000Z')
		).view(input);

		expect(result.outcome).toBe('published');
		expect(accessPort.resolve).toHaveBeenCalledTimes(2);
		const command: PublishRecipientViewedCommand = storePort.publishViewed.mock.calls[0][0];
		expect(command).toMatchObject({
			organizationId: context.organizationId,
			envelopeId: context.envelopeId,
			recipientId: context.recipientId,
			idempotencyKey: input.idempotencyKey,
			recipientRole: context.recipientRole,
			expectedAuditSequence: 3,
			previousAuditHash: 'audit-head-3'
		});
		expect(JSON.parse(command.auditPayloadJson)).toEqual({
			recipientId: context.recipientId,
			role: 'signer',
			routingOrder: 1,
			sentCommitSha: context.sentRevision.commitSha,
			viewedAt: '2026-09-11T00:02:00.000Z'
		});
		expect(command.auditPayloadJson).not.toMatch(/recipient@example|Recipient|skr1_|archive/);
	});

	it('rejects stale-tab envelope and recipient IDs before any mutation preparation', async () => {
		for (const mismatch of [
			{ ...input, expectedEnvelopeId: '01910000-0000-7000-8000-000000000099' },
			{ ...input, expectedRecipientId: '01910000-0000-7000-8000-000000000099' }
		]) {
			const storePort = store();
			await expect(
				new RecipientViewedApplication(access([context]), storePort).view(mismatch)
			).resolves.toEqual({ outcome: 'context_mismatch' });
			expect(storePort.prepareViewed).not.toHaveBeenCalled();
			expect(storePort.publishViewed).not.toHaveBeenCalled();
		}
	});

	it('fails closed for an inactive capability without calling the store', async () => {
		const storePort = store();
		await expect(
			new RecipientViewedApplication(access([null]), storePort).view(input)
		).resolves.toEqual({ outcome: 'not_found' });
		expect(storePort.prepareViewed).not.toHaveBeenCalled();
	});

	it('replays same-recipient views and still reauthorizes the live capability', async () => {
		const receipt = {
			envelopeId: context.envelopeId,
			recipientId: context.recipientId,
			recipientRole: 'signer' as const,
			routingOrder: 1,
			sentCommitSha: context.sentRevision.commitSha,
			envelopeStatus: 'in_progress' as const,
			viewedAt: '2026-09-11T00:01:00.000Z',
			auditEventId: 'audit-viewed'
		};
		const storePort = store([{ outcome: 'replayed', result: receipt }]);
		await expect(
			new RecipientViewedApplication(
				access([context, { ...context, recipientStatus: 'viewed' }]),
				storePort
			).view(input)
		).resolves.toEqual({ outcome: 'replayed', result: receipt });
		expect(storePort.publishViewed).not.toHaveBeenCalled();
	});

	it('handles continued outcome for reissued capabilities and reauthorizes live capability', async () => {
		const receipt = {
			envelopeId: context.envelopeId,
			recipientId: context.recipientId,
			recipientRole: 'signer' as const,
			routingOrder: 1,
			sentCommitSha: context.sentRevision.commitSha,
			envelopeStatus: 'in_progress' as const,
			viewedAt: '2026-09-11T00:01:00.000Z',
			auditEventId: 'audit-viewed'
		};
		const storePort = store([{ outcome: 'continued', result: receipt }]);
		await expect(
			new RecipientViewedApplication(
				access([context, { ...context, recipientStatus: 'viewed' }]),
				storePort
			).view(input)
		).resolves.toEqual({ outcome: 'continued', result: receipt });
		expect(storePort.publishViewed).not.toHaveBeenCalled();
	});

	it('retries bounded audit-head races with a fresh non-regressing viewed timestamp', async () => {
		const secondReady: ViewedPreparation = {
			...ready,
			auditHead: { sequence: 4, eventHash: 'audit-head-4' }
		};
		const storePort = store([ready, secondReady], [{ outcome: 'audit_conflict' }]);
		const timestamps: Date[] = [
			new Date('2026-09-11T00:01:59.000Z'),
			new Date('2026-09-11T00:02:00.000Z'),
			new Date('2026-09-11T00:02:01.000Z'),
			new Date('2026-09-11T00:02:02.000Z')
		];
		await expect(
			new RecipientViewedApplication(
				access([context, { ...context, recipientStatus: 'viewed' }]),
				storePort,
				() => timestamps.shift() ?? new Date('2026-09-11T00:02:03.000Z')
			).view(input)
		).resolves.toMatchObject({ outcome: 'published' });
		expect(storePort.publishViewed).toHaveBeenCalledTimes(2);
		const commands: PublishRecipientViewedCommand[] = storePort.publishViewed.mock.calls.map(
			(call): PublishRecipientViewedCommand => call[0]
		);
		expect(commands.map((command): string => command.updatedAt)).toEqual([
			'2026-09-11T00:02:00.000Z',
			'2026-09-11T00:02:01.000Z'
		]);
		expect(commands[1].previousAuditHash).toBe('audit-head-4');
	});

	it('returns not_found if the capability is revoked before the response is disclosed', async () => {
		await expect(
			new RecipientViewedApplication(access([context, null]), store()).view(input)
		).resolves.toEqual({ outcome: 'not_found' });
	});

	it('rejects authorization-boundary drift after publication', async () => {
		const drifted: RecipientSigningContext = {
			...context,
			recipientStatus: 'viewed',
			sentRevision: { ...context.sentRevision, commitSha: 'c'.repeat(40) }
		};
		await expect(
			new RecipientViewedApplication(access([context, drifted]), store()).view(input)
		).resolves.toEqual({ outcome: 'integrity_error' });
	});
});
