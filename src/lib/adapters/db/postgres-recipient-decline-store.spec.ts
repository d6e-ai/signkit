import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PublishRecipientDeclinedCommand } from '$lib/ports/recipient-decline-store';
import { PostgresRecipientDeclineStore } from './postgres-recipient-decline-store';

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

const command: PublishRecipientDeclinedCommand = {
	capabilityHash: 'cap-hash-1',
	expectedEnvelopeId: 'env-1',
	expectedRecipientId: 'recipient-1',
	idempotencyKey: 'declined-1',
	requestFingerprint: '',
	recipientRole: 'signer',
	routingOrder: 1,
	expectedSentCommitSha: 'commit-3',
	updatedAt: '2026-09-11T00:03:00.000Z',
	expectedAuditSequence: 3,
	previousAuditHash: 'hash-3',
	auditEventId: 'declined-audit-1',
	auditEventHash: 'hash-4',
	auditPayloadJson: ''
};
command.requestFingerprint = createHash('sha256')
	.update(
		JSON.stringify({
			envelopeId: command.expectedEnvelopeId,
			recipientId: command.expectedRecipientId,
			capabilityHash: command.capabilityHash
		})
	)
	.digest('hex');
command.auditPayloadJson = JSON.stringify({
	recipientId: command.expectedRecipientId,
	role: command.recipientRole,
	routingOrder: command.routingOrder,
	sentCommitSha: command.expectedSentCommitSha,
	declinedAt: command.updatedAt
});
command.auditEventHash = createHash('sha256')
	.update(
		JSON.stringify({
			actorId: command.expectedRecipientId,
			envelopeId: command.expectedEnvelopeId,
			eventType: 'recipient.declined',
			occurredAt: command.updatedAt,
			organizationId: 'org-1',
			payload: JSON.parse(command.auditPayloadJson) as unknown,
			previousHash: command.previousAuditHash
		})
	)
	.digest('hex');

const eligibleRecipientRow = {
	organizationId: 'org-1',
	envelopeId: 'env-1',
	recipientId: 'recipient-1',
	recipientRole: 'signer' as const,
	recipientStatus: 'pending',
	recipientCapabilityHash: command.capabilityHash,
	recipientCapabilityExpiresAt: '2026-09-25T00:00:00.000Z',
	recipientCapabilityRevokedAt: null,
	routingOrder: 1,
	envelopeStatus: 'sent',
	envelopeSentCommitSha: 'commit-3',
	envelopeRepositoryHead: 'commit-3'
};

const declinedRecipientRow = {
	...eligibleRecipientRow,
	recipientStatus: 'declined',
	recipientCapabilityRevokedAt: command.updatedAt,
	envelopeStatus: 'declined'
};

const actorLockRow = {
	id: 'recipient-1',
	organizationId: 'org-1',
	envelopeId: 'env-1',
	recipientRole: 'signer' as const,
	recipientStatus: 'pending',
	recipientCapabilityHash: command.capabilityHash,
	recipientCapabilityExpiresAt: '2026-09-25T00:00:00.000Z',
	recipientCapabilityRevokedAt: null,
	routingOrder: 1
};

const siblingLockRow = {
	id: 'recipient-2',
	organizationId: 'org-1',
	envelopeId: 'env-1',
	recipientRole: 'signer' as const,
	recipientStatus: 'pending',
	recipientCapabilityHash: 'cap-hash-2',
	recipientCapabilityExpiresAt: null,
	recipientCapabilityRevokedAt: null,
	routingOrder: 2
};

function replayRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		organizationId: 'org-1',
		envelopeId: command.expectedEnvelopeId,
		recipientId: command.expectedRecipientId,
		recipientRole: command.recipientRole,
		routingOrder: command.routingOrder,
		actorType: 'recipient',
		actorId: command.expectedRecipientId,
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
		evidenceOrganizationId: 'org-1',
		evidenceEnvelopeId: command.expectedEnvelopeId,
		evidenceSequence: command.expectedAuditSequence + 1,
		evidenceEventType: 'recipient.declined',
		evidenceActorType: 'recipient',
		evidenceActorId: command.expectedRecipientId,
		evidencePayloadJson: command.auditPayloadJson,
		evidencePreviousHash: command.previousAuditHash,
		evidenceEventHash: command.auditEventHash,
		evidenceOccurredAt: command.updatedAt,
		...overrides
	};
}

describe('PostgresRecipientDeclineStore', () => {
	it('locks the envelope then all recipients in id order and never writes delivery_outbox', async () => {
		const database = new ScriptedPostgres([
			[eligibleRecipientRow],
			[{ status: 'sent', sentCommitSha: 'commit-3', repositoryHead: 'commit-3' }],
			[actorLockRow, siblingLockRow],
			[],
			[],
			[{ sequence: 3, eventHash: command.previousAuditHash }],
			[{ id: command.expectedRecipientId }],
			[],
			[{ id: command.expectedEnvelopeId }],
			[],
			[]
		]);
		const result = await new PostgresRecipientDeclineStore(database.client()).publishDeclined(
			command
		);
		expect(result).toMatchObject({
			outcome: 'published',
			result: { recipientId: command.expectedRecipientId, envelopeStatus: 'declined' }
		});
		expect(database.beginCalls).toBe(1);
		expect(database.directQueries[0].text).toContain('recipient.capability_hash =');
		expect(database.directQueries[0].values).toEqual([command.capabilityHash]);
		const texts = database.transactionQueries.map((query) => query.text);
		expect(texts.some((text) => text.includes('delivery_outbox'))).toBe(false);
		expect(texts[0]).toContain('FROM envelope');
		expect(texts[0]).toContain('FOR UPDATE');
		expect(texts[1]).toContain('FROM recipient');
		expect(texts[1]).toContain('ORDER BY id');
		expect(texts[1]).toContain('FOR UPDATE');
		expect(texts).toEqual([
			expect.stringContaining('FOR UPDATE'),
			expect.stringContaining('ORDER BY id'),
			expect.stringContaining('FROM recipient_declined_command'),
			expect.stringContaining('FROM recipient_declined_command'),
			expect.stringContaining('FROM audit_event'),
			expect.stringContaining("SET status = 'declined'"),
			expect.stringContaining('status <>'),
			expect.stringContaining("SET status = 'declined'"),
			expect.stringContaining('INSERT INTO recipient_declined_command'),
			expect.stringContaining('INSERT INTO audit_event')
		]);
		expect(texts[5]).toContain('capability_revoked_at');
		expect(texts[6]).toContain('capability_revoked_at');
		expect(texts[6]).toContain('capability_hash IS NOT NULL');
		expect(texts[6]).not.toContain("status = 'declined'");
		expect(texts[6]).toContain('status <>');
	});

	it('returns context_mismatch for a stale body without opening a write transaction', async () => {
		const database = new ScriptedPostgres([[eligibleRecipientRow]]);
		const stale = {
			...command,
			expectedEnvelopeId: 'env-stale',
			expectedRecipientId: 'recipient-stale'
		};
		const result = await new PostgresRecipientDeclineStore(database.client()).publishDeclined(
			stale
		);
		expect(result).toEqual({ outcome: 'context_mismatch' });
		expect(database.beginCalls).toBe(0);
		expect(database.transactionQueries).toHaveLength(0);
	});

	it('returns role_not_actionable for viewer and prefill without writing', async () => {
		const database = new ScriptedPostgres([[{ ...eligibleRecipientRow, recipientRole: 'viewer' }]]);
		const result = await new PostgresRecipientDeclineStore(database.client()).prepareDeclined(
			command,
			command.updatedAt
		);
		expect(result).toEqual({ outcome: 'role_not_actionable' });
		expect(database.beginCalls).toBe(0);
	});

	it('rechecks idempotency after locks and replays a lost response from current rows', async () => {
		const database = new ScriptedPostgres([
			[declinedRecipientRow],
			[{ status: 'declined', sentCommitSha: 'commit-3', repositoryHead: 'commit-3' }],
			[
				{
					...actorLockRow,
					recipientStatus: 'declined',
					recipientCapabilityRevokedAt: command.updatedAt
				},
				siblingLockRow
			],
			[replayRow()]
		]);
		const result = await new PostgresRecipientDeclineStore(database.client()).publishDeclined(
			command
		);
		expect(result).toMatchObject({
			outcome: 'replayed',
			result: { auditEventId: command.auditEventId }
		});
		expect(database.transactionQueries).toHaveLength(3);
		expect(
			database.transactionQueries.some((query) => query.text.includes('UPDATE recipient'))
		).toBe(false);
	});

	it('does not disclose the stored receipt under a different idempotency key', async () => {
		const differentKey = { ...command, idempotencyKey: 'declined-from-another-tab' };
		const database = new ScriptedPostgres([
			[declinedRecipientRow],
			[],
			[replayRow()],
			[declinedRecipientRow]
		]);
		const result = await new PostgresRecipientDeclineStore(database.client()).prepareDeclined(
			differentKey,
			'2026-09-11T00:04:00.000Z'
		);
		expect(result).toEqual({ outcome: 'not_found' });
	});

	it('fails closed when durable replay evidence does not match the command', async () => {
		const database = new ScriptedPostgres([
			[declinedRecipientRow],
			[replayRow({ evidenceEventType: 'recipient.viewed' })]
		]);
		const result = await new PostgresRecipientDeclineStore(database.client()).prepareDeclined(
			command,
			command.updatedAt
		);
		expect(result).toEqual({ outcome: 'integrity_error' });
	});

	it('recomputes the audit hash before accepting terminal replay evidence', async () => {
		const database = new ScriptedPostgres([
			[declinedRecipientRow],
			[replayRow({ auditEventHash: 'tampered', evidenceEventHash: 'tampered' })]
		]);
		const result = await new PostgresRecipientDeclineStore(database.client()).prepareDeclined(
			command,
			command.updatedAt
		);
		expect(result).toEqual({ outcome: 'integrity_error' });
	});

	it('reports idempotency_conflict when the same key is reused for a different request', async () => {
		const database = new ScriptedPostgres([
			[declinedRecipientRow],
			[replayRow({ requestHash: 'other-fingerprint' })]
		]);
		const result = await new PostgresRecipientDeclineStore(database.client()).prepareDeclined(
			command,
			command.updatedAt
		);
		expect(result).toEqual({ outcome: 'idempotency_conflict' });
	});

	it('re-reads state before accepting a replay after a concurrent publication', async () => {
		const database = new ScriptedPostgres([
			[eligibleRecipientRow],
			[replayRow()],
			[declinedRecipientRow]
		]);
		const result = await new PostgresRecipientDeclineStore(database.client()).prepareDeclined(
			command,
			command.updatedAt
		);
		expect(result).toMatchObject({ outcome: 'replayed' });
	});

	it('prepares only an eligible live signer or approver', async () => {
		const database = new ScriptedPostgres([
			[eligibleRecipientRow],
			[],
			[],
			[{ sequence: 3, eventHash: 'hash-3' }]
		]);
		const result = await new PostgresRecipientDeclineStore(database.client()).prepareDeclined(
			command,
			command.updatedAt
		);
		expect(result).toEqual({
			outcome: 'ready',
			organizationId: 'org-1',
			envelopeId: 'env-1',
			recipientId: 'recipient-1',
			recipientRole: 'signer',
			routingOrder: 1,
			sentCommitSha: 'commit-3',
			envelopeStatus: 'sent',
			auditHead: { sequence: 3, eventHash: 'hash-3' }
		});
	});

	it('denies as not_found when the capability is revoked or expired', async () => {
		const expired = new ScriptedPostgres([[eligibleRecipientRow], [], []]);
		await expect(
			new PostgresRecipientDeclineStore(expired.client()).prepareDeclined(
				command,
				'2026-09-30T00:00:00.000Z'
			)
		).resolves.toEqual({ outcome: 'not_found' });

		const revoked = new ScriptedPostgres([
			[
				{
					...eligibleRecipientRow,
					recipientCapabilityRevokedAt: '2026-09-11T00:02:00.000Z'
				}
			],
			[],
			[]
		]);
		await expect(
			new PostgresRecipientDeclineStore(revoked.client()).prepareDeclined(
				command,
				command.updatedAt
			)
		).resolves.toEqual({ outcome: 'not_found' });
	});

	it('treats declined state without its durable command as an integrity error', async () => {
		const database = new ScriptedPostgres([[declinedRecipientRow], [], []]);
		await expect(
			new PostgresRecipientDeclineStore(database.client()).prepareDeclined(
				command,
				command.updatedAt
			)
		).resolves.toEqual({ outcome: 'integrity_error' });
	});
});
