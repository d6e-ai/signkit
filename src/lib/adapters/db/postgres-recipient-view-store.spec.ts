import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PublishRecipientViewedCommand } from '$lib/ports/recipient-view-store';
import { PostgresRecipientViewStore } from './postgres-recipient-view-store';

interface RecordedQuery {
	text: string;
	values: readonly unknown[];
}
type ScriptedResult = readonly object[] | Error;

class ScriptedPostgres {
	readonly directQueries: RecordedQuery[] = [];
	readonly transactionQueries: RecordedQuery[] = [];
	beginCalls: number = 0;
	readonly #results: ScriptedResult[];

	constructor(results: readonly ScriptedResult[]) {
		this.#results = results.map((result) => (result instanceof Error ? result : [...result]));
	}

	client(): ReturnType<typeof postgres> {
		const direct = this.#tag(this.directQueries);
		Object.assign(direct, {
			begin: async <T>(
				callback: (transaction: ReturnType<typeof postgres>) => Promise<T>
			): Promise<T> => {
				this.beginCalls += 1;
				return callback(this.#tag(this.transactionQueries));
			}
		});
		return direct as ReturnType<typeof postgres>;
	}

	#tag(target: RecordedQuery[]): ReturnType<typeof postgres> {
		const query = async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
			target.push({ text: strings.join('?').replaceAll(/\s+/g, ' ').trim(), values });
			const result = this.#results.shift();
			if (result === undefined) throw new Error('Unexpected PostgreSQL query');
			if (result instanceof Error) throw result;
			return result;
		};
		return query as ReturnType<typeof postgres>;
	}
}

const command: PublishRecipientViewedCommand = {
	organizationId: 'org-1',
	envelopeId: 'env-1',
	recipientId: 'recipient-1',
	capabilityHash: 'cap-hash-1',
	idempotencyKey: 'viewed-1',
	requestFingerprint: '',
	recipientRole: 'signer',
	routingOrder: 1,
	expectedSentCommitSha: 'commit-3',
	updatedAt: '2026-09-11T00:02:00.000Z',
	expectedAuditSequence: 3,
	previousAuditHash: 'hash-3',
	auditEventId: 'viewed-audit-1',
	auditEventHash: 'hash-4',
	auditPayloadJson: ''
};
command.requestFingerprint = createHash('sha256')
	.update(
		JSON.stringify({
			envelopeId: command.envelopeId,
			recipientId: command.recipientId,
			capabilityHash: command.capabilityHash
		})
	)
	.digest('hex');
command.auditPayloadJson = JSON.stringify({
	recipientId: command.recipientId,
	role: command.recipientRole,
	routingOrder: command.routingOrder,
	sentCommitSha: command.expectedSentCommitSha,
	viewedAt: command.updatedAt
});

const eligibleRecipientRow = {
	recipientRole: 'signer',
	recipientStatus: 'pending',
	recipientCapabilityHash: command.capabilityHash,
	recipientCapabilityExpiresAt: '2026-09-25T00:00:00.000Z',
	recipientCapabilityRevokedAt: null,
	routingOrder: 1,
	envelopeStatus: 'sent',
	envelopeSentCommitSha: 'commit-3',
	envelopeRepositoryHead: 'commit-3'
};

const viewedRecipientRow = {
	...eligibleRecipientRow,
	recipientStatus: 'viewed',
	envelopeStatus: 'in_progress'
};

function replayRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		organizationId: command.organizationId,
		envelopeId: command.envelopeId,
		recipientId: command.recipientId,
		recipientRole: command.recipientRole,
		routingOrder: command.routingOrder,
		actorType: 'recipient',
		actorId: command.recipientId,
		idempotencyKey: command.idempotencyKey,
		requestHash: command.requestFingerprint,
		capabilityHash: command.capabilityHash,
		sentCommitSha: command.expectedSentCommitSha,
		updatedAt: command.updatedAt,
		auditEventId: command.auditEventId,
		auditSequence: command.expectedAuditSequence + 1,
		previousAuditHash: command.previousAuditHash,
		auditEventHash: command.auditEventHash,
		auditPayloadJson: command.auditPayloadJson,
		evidenceEventId: command.auditEventId,
		evidenceOrganizationId: command.organizationId,
		evidenceEnvelopeId: command.envelopeId,
		evidenceSequence: command.expectedAuditSequence + 1,
		evidenceEventType: 'recipient.viewed',
		evidenceActorType: 'recipient',
		evidenceActorId: command.recipientId,
		evidencePayloadJson: command.auditPayloadJson,
		evidencePreviousHash: command.previousAuditHash,
		evidenceEventHash: command.auditEventHash,
		evidenceOccurredAt: command.updatedAt,
		...overrides
	};
}

describe('PostgresRecipientViewStore', () => {
	it('locks the envelope then the recipient and atomically publishes status, command, and audit event', async () => {
		const database = new ScriptedPostgres([
			[{ status: 'sent', sentCommitSha: 'commit-3', repositoryHead: 'commit-3' }],
			[eligibleRecipientRow],
			[],
			[],
			[{ sequence: 3, eventHash: command.previousAuditHash }],
			[{ id: command.recipientId }],
			[{ id: command.envelopeId }],
			[],
			[]
		]);
		const result = await new PostgresRecipientViewStore(database.client()).publishViewed(command);
		expect(result).toMatchObject({
			outcome: 'published',
			result: { recipientId: command.recipientId, envelopeStatus: 'in_progress' }
		});
		expect(database.beginCalls).toBe(1);
		const texts = database.transactionQueries.map((query) => query.text);
		expect(texts[0]).toContain('FOR UPDATE');
		expect(texts[0]).toContain('FROM envelope');
		expect(texts.some((text) => text.includes("UPDATE recipient SET status = 'viewed'"))).toBe(
			true
		);
		expect(
			texts.some((text) => text.includes('UPDATE envelope') && text.includes('in_progress'))
		).toBe(true);
		const recipientLockIndex = texts.findIndex((text) => text.includes('FOR UPDATE OF recipient'));
		const envelopeLockIndex = 0;
		expect(recipientLockIndex).toBeGreaterThan(envelopeLockIndex);
		expect(texts).toEqual([
			expect.stringContaining('FOR UPDATE'),
			expect.stringContaining('FOR UPDATE OF recipient'),
			expect.stringContaining('FROM recipient_viewed_command'),
			expect.stringContaining('FROM recipient_viewed_command'),
			expect.stringContaining('FROM audit_event'),
			expect.stringContaining("UPDATE recipient SET status = 'viewed'"),
			expect.stringContaining('UPDATE envelope'),
			expect.stringContaining('INSERT INTO recipient_viewed_command'),
			expect.stringContaining('INSERT INTO audit_event')
		]);
	});

	it('rechecks idempotency after taking the envelope lock and replays the same recipient', async () => {
		const database = new ScriptedPostgres([
			[{ status: 'sent', sentCommitSha: 'commit-3', repositoryHead: 'commit-3' }],
			[viewedRecipientRow],
			[replayRow()]
		]);
		const result = await new PostgresRecipientViewStore(database.client()).publishViewed(command);
		expect(result).toMatchObject({
			outcome: 'replayed',
			result: { auditEventId: command.auditEventId }
		});
		expect(database.transactionQueries).toHaveLength(3);
	});

	it('replays the stored receipt for the same recipient under a different idempotency key', async () => {
		const differentKey = { ...command, idempotencyKey: 'viewed-from-another-tab' };
		const database = new ScriptedPostgres([[viewedRecipientRow], [], [replayRow()]]);
		const result = await new PostgresRecipientViewStore(database.client()).prepareViewed(
			differentKey,
			'2026-09-11T00:02:30.000Z'
		);
		expect(result).toMatchObject({
			outcome: 'replayed',
			result: { recipientId: command.recipientId, envelopeStatus: 'in_progress' }
		});
	});

	it('denies replay as not_found when the stored capability hash was swapped', async () => {
		const database = new ScriptedPostgres([
			[viewedRecipientRow],
			[],
			[replayRow({ capabilityHash: 'wrong-hash' })]
		]);
		const result = await new PostgresRecipientViewStore(database.client()).prepareViewed(
			command,
			'2026-09-11T00:02:30.000Z'
		);
		expect(result).toEqual({ outcome: 'not_found' });
	});

	it('reports idempotency_conflict when the same key is reused for a different request', async () => {
		const database = new ScriptedPostgres([
			[viewedRecipientRow],
			[replayRow({ envelopeId: 'env-2' })]
		]);
		const result = await new PostgresRecipientViewStore(database.client()).prepareViewed(
			command,
			'2026-09-11T00:02:30.000Z'
		);
		expect(result).toEqual({ outcome: 'idempotency_conflict' });
	});

	it('fails closed when durable replay evidence does not match the command', async () => {
		const database = new ScriptedPostgres([
			[viewedRecipientRow],
			[replayRow({ evidenceEventType: 'wrong.type' })]
		]);
		const result = await new PostgresRecipientViewStore(database.client()).prepareViewed(
			command,
			'2026-09-11T00:02:30.000Z'
		);
		expect(result).toEqual({ outcome: 'integrity_error' });
	});

	it('fails closed when a replay receipt exists without the published recipient state', async () => {
		const database = new ScriptedPostgres([[eligibleRecipientRow], [replayRow()]]);
		const result = await new PostgresRecipientViewStore(database.client()).prepareViewed(
			command,
			'2026-09-11T00:02:30.000Z'
		);
		expect(result).toEqual({ outcome: 'integrity_error' });
	});

	it('prepares only an eligible pending recipient with a live capability', async () => {
		const database = new ScriptedPostgres([
			[eligibleRecipientRow],
			[],
			[],
			[{ sequence: 3, eventHash: 'hash-3' }]
		]);
		const result = await new PostgresRecipientViewStore(database.client()).prepareViewed(
			command,
			'2026-09-11T00:02:00.000Z'
		);
		expect(result).toEqual({
			outcome: 'ready',
			recipientRole: 'signer',
			routingOrder: 1,
			sentCommitSha: 'commit-3',
			envelopeStatus: 'sent',
			auditHead: { sequence: 3, eventHash: 'hash-3' }
		});
	});

	it('treats viewed state without its durable command as an integrity error', async () => {
		const database = new ScriptedPostgres([[viewedRecipientRow], [], []]);
		await expect(
			new PostgresRecipientViewStore(database.client()).prepareViewed(
				command,
				'2026-09-11T00:02:30.000Z'
			)
		).resolves.toEqual({ outcome: 'integrity_error' });
	});
});
