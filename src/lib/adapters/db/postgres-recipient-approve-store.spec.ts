import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PublishRecipientApprovedCommand } from '$lib/ports/recipient-approve-store';
import { PostgresRecipientApproveStore } from './postgres-recipient-approve-store';

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

const command: PublishRecipientApprovedCommand = {
	capabilityHash: 'cap-hash-1',
	expectedEnvelopeId: 'env-1',
	expectedRecipientId: 'recipient-1',
	idempotencyKey: 'approved-1',
	requestFingerprint: '',
	recipientRole: 'approver',
	routingOrder: 1,
	expectedSentCommitSha: 'commit-3',
	updatedAt: '2026-09-11T00:04:00.000Z',
	nextRoutingOrder: null,
	nextCapabilityExpiresAt: null,
	releasedDeliveryCount: 0,
	expectedAuditSequence: 4,
	previousAuditHash: 'hash-4',
	auditEventId: 'approved-audit-1',
	auditEventHash: 'hash-5',
	auditPayloadJson: '',
	completedAuditEventId: null,
	completedAuditEventHash: null,
	completedAuditPayloadJson: null
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
	approvedAt: command.updatedAt
});
command.auditEventHash = createHash('sha256')
	.update(
		JSON.stringify({
			hashVersion: 3,
			envelopeId: command.expectedEnvelopeId,
			sequence: command.expectedAuditSequence + 1,
			eventType: 'recipient.approved',
			actorType: 'recipient',
			actorId: command.expectedRecipientId,
			occurredAt: command.updatedAt,
			payload: JSON.parse(command.auditPayloadJson) as unknown,
			previousHash: command.previousAuditHash
		})
	)
	.digest('hex');

const eligibleRecipientRow = {
	envelopeId: 'env-1',
	recipientId: 'recipient-1',
	recipientRole: 'approver' as const,
	recipientStatus: 'viewed',
	recipientCapabilityHash: command.capabilityHash,
	recipientCapabilityExpiresAt: '2026-09-25T00:00:00.000Z',
	recipientCapabilityRevokedAt: null,
	routingOrder: 1,
	envelopeStatus: 'in_progress',
	envelopeSentCommitSha: 'commit-3',
	envelopeRepositoryHead: 'commit-3'
};

const completedRecipientRow = {
	...eligibleRecipientRow,
	recipientStatus: 'completed',
	recipientCapabilityRevokedAt: command.updatedAt,
	envelopeStatus: 'in_progress'
};

const actorLockRow = {
	id: 'recipient-1',
	envelopeId: 'env-1',
	recipientRole: 'approver' as const,
	recipientStatus: 'viewed',
	recipientCapabilityHash: command.capabilityHash,
	recipientCapabilityExpiresAt: '2026-09-25T00:00:00.000Z',
	recipientCapabilityRevokedAt: null,
	routingOrder: 1
};

const siblingLockRow = {
	id: 'recipient-2',
	envelopeId: 'env-1',
	recipientRole: 'signer' as const,
	recipientStatus: 'viewed',
	recipientCapabilityHash: 'cap-hash-2',
	recipientCapabilityExpiresAt: '2026-09-25T00:00:00.000Z',
	recipientCapabilityRevokedAt: null,
	routingOrder: 1
};

const laterLockRow = {
	id: 'recipient-3',
	envelopeId: 'env-1',
	recipientRole: 'signer' as const,
	recipientStatus: 'pending',
	recipientCapabilityHash: 'cap-hash-3',
	recipientCapabilityExpiresAt: null,
	recipientCapabilityRevokedAt: null,
	routingOrder: 2
};

const laterViewerLockRow = {
	...laterLockRow,
	id: 'recipient-viewer',
	recipientRole: 'viewer' as const,
	recipientCapabilityHash: 'cap-hash-viewer'
};

const laterPrefillLockRow = {
	...laterLockRow,
	id: 'recipient-prefill',
	recipientRole: 'prefill' as const,
	recipientCapabilityHash: 'cap-hash-prefill'
};

function completedCommand(): PublishRecipientApprovedCommand {
	const completedAuditPayloadJson: string = JSON.stringify({
		sentCommitSha: command.expectedSentCommitSha,
		completedAt: command.updatedAt
	});
	const completedAuditEventHash: string = createHash('sha256')
		.update(
			JSON.stringify({
				hashVersion: 3,
				envelopeId: command.expectedEnvelopeId,
				sequence: command.expectedAuditSequence + 2,
				eventType: 'envelope.completed',
				actorType: 'recipient',
				actorId: command.expectedRecipientId,
				occurredAt: command.updatedAt,
				payload: JSON.parse(completedAuditPayloadJson) as unknown,
				previousHash: command.auditEventHash
			})
		)
		.digest('hex');
	return {
		...command,
		completedAuditEventId: 'completed-audit-1',
		completedAuditEventHash,
		completedAuditPayloadJson
	};
}

function replayRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
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
		nextRoutingOrder: command.nextRoutingOrder,
		nextCapabilityExpiresAt: command.nextCapabilityExpiresAt,
		releasedDeliveryCount: command.releasedDeliveryCount,
		auditEventId: command.auditEventId,
		auditSequence: command.expectedAuditSequence + 1,
		previousAuditHash: command.previousAuditHash,
		auditEventHash: command.auditEventHash,
		auditPayloadJson: command.auditPayloadJson,
		completedAuditEventId: command.completedAuditEventId,
		completedAuditEventHash: command.completedAuditEventHash,
		completedAuditPayloadJson: command.completedAuditPayloadJson,
		evidenceEventId: command.auditEventId,
		evidenceEnvelopeId: command.expectedEnvelopeId,
		evidenceSequence: command.expectedAuditSequence + 1,
		evidenceEventType: 'recipient.approved',
		evidenceActorType: 'recipient',
		evidenceActorId: command.expectedRecipientId,
		evidencePayloadJson: command.auditPayloadJson,
		evidencePreviousHash: command.previousAuditHash,
		evidenceEventHash: command.auditEventHash,
		evidenceOccurredAt: command.updatedAt,
		evidenceHashVersion: 3,
		completedEvidenceEventId: null,
		completedEvidenceEnvelopeId: null,
		completedEvidenceSequence: null,
		completedEvidenceEventType: null,
		completedEvidenceActorType: null,
		completedEvidenceActorId: null,
		completedEvidencePayloadJson: null,
		completedEvidencePreviousHash: null,
		completedEvidenceEventHash: null,
		completedEvidenceOccurredAt: null,
		completedEvidenceHashVersion: null,
		...overrides
	};
}

function completedReplayRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const completed: PublishRecipientApprovedCommand = completedCommand();
	return replayRow({
		completedAuditEventId: completed.completedAuditEventId,
		completedAuditEventHash: completed.completedAuditEventHash,
		completedAuditPayloadJson: completed.completedAuditPayloadJson,
		completedEvidenceEventId: completed.completedAuditEventId,
		completedEvidenceEnvelopeId: completed.expectedEnvelopeId,
		completedEvidenceSequence: completed.expectedAuditSequence + 2,
		completedEvidenceEventType: 'envelope.completed',
		completedEvidenceActorType: 'recipient',
		completedEvidenceActorId: completed.expectedRecipientId,
		completedEvidencePayloadJson: completed.completedAuditPayloadJson,
		completedEvidencePreviousHash: completed.auditEventHash,
		completedEvidenceEventHash: completed.completedAuditEventHash,
		completedEvidenceOccurredAt: completed.updatedAt,
		completedEvidenceHashVersion: 3,
		...overrides
	});
}

describe('PostgresRecipientApproveStore', () => {
	it('locks the envelope, then recipients, then delivery_outbox in id order', async () => {
		const database = new ScriptedPostgres([
			[eligibleRecipientRow],
			[{ status: 'in_progress', sentCommitSha: 'commit-3', repositoryHead: 'commit-3' }],
			[actorLockRow, siblingLockRow, laterLockRow],
			[{ id: 'delivery-1' }, { id: 'delivery-3' }],
			[],
			[],
			[{ sequence: 4, eventHash: command.previousAuditHash }],
			[{ id: command.expectedRecipientId }],
			[{ id: command.expectedEnvelopeId }],
			[],
			[]
		]);
		const result = await new PostgresRecipientApproveStore(database.client()).publishApproved(
			command
		);
		expect(result).toMatchObject({
			outcome: 'published',
			result: { recipientId: command.expectedRecipientId, envelopeStatus: 'in_progress' }
		});
		expect(database.beginCalls).toBe(1);
		expect(database.directQueries[0].text).toContain('recipient.capability_hash =');
		expect(database.directQueries[0].values).toEqual([command.capabilityHash]);
		const texts = database.transactionQueries.map((query) => query.text);
		expect(texts[0]).toContain('FROM envelope');
		expect(texts[0]).toContain('FOR UPDATE');
		expect(texts[1]).toContain('FROM recipient');
		expect(texts[1]).toContain('ORDER BY id');
		expect(texts[1]).toContain('FOR UPDATE');
		expect(texts[2]).toContain('FROM delivery_outbox');
		expect(texts[2]).toContain('ORDER BY id');
		expect(texts[2]).toContain('FOR UPDATE');
		expect(texts).toEqual([
			expect.stringContaining('FOR UPDATE'),
			expect.stringContaining('ORDER BY id'),
			expect.stringContaining('delivery_outbox'),
			expect.stringContaining('FROM recipient_approved_command'),
			expect.stringContaining('FROM recipient_approved_command'),
			expect.stringContaining('FROM audit_event'),
			expect.stringContaining("SET status = 'completed'"),
			expect.stringContaining('UPDATE envelope'),
			expect.stringContaining('INSERT INTO recipient_approved_command'),
			expect.stringContaining('INSERT INTO audit_event')
		]);
		expect(texts[6]).toContain('capability_revoked_at');
		expect(texts[6]).toContain("status = 'viewed'");
		expect(texts.some((text) => text.includes('status <>'))).toBe(false);
		expect(texts.filter((text) => text.includes('UPDATE delivery_outbox')).length).toBe(0);
	});

	it('releases the next routing group and preserves outbox ciphertext when the current group is clear', async () => {
		const releaseCommand: PublishRecipientApprovedCommand = {
			...command,
			nextRoutingOrder: 2,
			nextCapabilityExpiresAt: '2026-09-25T12:00:00.000Z',
			releasedDeliveryCount: 2
		};
		const database = new ScriptedPostgres([
			[eligibleRecipientRow],
			[{ status: 'in_progress', sentCommitSha: 'commit-3', repositoryHead: 'commit-3' }],
			[actorLockRow, laterLockRow, laterViewerLockRow, laterPrefillLockRow],
			[
				{ id: 'delivery-3', status: 'blocked', retryable: true, sealedCapability: 'sealed-3' },
				{
					id: 'delivery-viewer',
					status: 'blocked',
					retryable: true,
					sealedCapability: 'sealed-viewer'
				},
				{
					id: 'delivery-prefill',
					status: 'blocked',
					retryable: true,
					sealedCapability: 'sealed-prefill'
				}
			],
			[],
			[],
			[{ sequence: 4, eventHash: command.previousAuditHash }],
			[{ id: command.expectedRecipientId }],
			[{ id: laterLockRow.id }, { id: laterViewerLockRow.id }],
			[{ id: 'delivery-3' }, { id: 'delivery-viewer' }],
			[{ id: command.expectedEnvelopeId }],
			[],
			[]
		]);
		const result = await new PostgresRecipientApproveStore(database.client()).publishApproved(
			releaseCommand
		);
		expect(result).toMatchObject({
			outcome: 'published',
			result: { envelopeStatus: 'in_progress', nextRoutingOrder: 2 }
		});
		const texts = database.transactionQueries.map((query) => query.text);
		expect(texts.some((text) => text.includes('capability_expires_at'))).toBe(true);
		expect(texts.some((text) => text.includes("SET status = 'pending'"))).toBe(true);
		expect(texts.some((text) => text.includes('sealed_capability'))).toBe(true);
		expect(texts.filter((text) => /UPDATE delivery_outbox/.test(text)).length).toBe(1);
		const outboxUpdate: string | undefined = texts.find((text) =>
			text.includes('UPDATE delivery_outbox')
		);
		expect(outboxUpdate).toBeDefined();
		expect(outboxUpdate).not.toMatch(/sealed_capability\s*=/);
		const recipientRelease: string | undefined = texts.find(
			(text: string): boolean =>
				text.includes('UPDATE recipient') && text.includes('SET capability_expires_at')
		);
		expect(recipientRelease).toContain("role IN ('signer', 'approver', 'viewer')");
		expect(recipientRelease).not.toContain("'prefill'");
		expect(outboxUpdate).toContain("target.role IN ('signer', 'approver', 'viewer')");
	});

	it('completes the envelope and appends envelope.completed when no non-CC recipients remain', async () => {
		const completeCommand: PublishRecipientApprovedCommand = completedCommand();
		const database = new ScriptedPostgres([
			[eligibleRecipientRow],
			[{ status: 'in_progress', sentCommitSha: 'commit-3', repositoryHead: 'commit-3' }],
			[actorLockRow, laterViewerLockRow, laterPrefillLockRow],
			[
				{ id: 'delivery-pending', status: 'pending', retryable: true, sealedCapability: 'sealed' },
				{ id: 'delivery-delivered', status: 'delivered', retryable: false, sealedCapability: null }
			],
			[],
			[],
			[{ sequence: 4, eventHash: command.previousAuditHash }],
			[{ id: command.expectedRecipientId }],
			[],
			[],
			[],
			[],
			[{ id: command.expectedEnvelopeId }],
			[],
			[],
			[]
		]);
		const result = await new PostgresRecipientApproveStore(database.client()).publishApproved(
			completeCommand
		);
		expect(result).toMatchObject({
			outcome: 'published',
			result: {
				envelopeStatus: 'completed',
				completedAuditEventId: 'completed-audit-1'
			}
		});
		const texts = database.transactionQueries.map((query) => query.text);
		expect(texts.some((text) => text.includes("SET status = 'completed'"))).toBe(true);
		expect(texts.filter((text) => text.includes('INSERT INTO audit_event')).length).toBe(2);
		expect(texts.some((text) => text.includes('envelope.completed'))).toBe(true);
		const capabilityScrub: string | undefined = texts.find(
			(text: string): boolean =>
				text.includes('UPDATE recipient') && text.includes("status <> 'completed'")
		);
		expect(capabilityScrub).toContain('capability_revoked_at');
		const deliveryScrub: string | undefined = texts.find(
			(text: string): boolean =>
				text.includes('UPDATE delivery_outbox') && text.includes('envelope_terminal')
		);
		expect(deliveryScrub).toContain("status IN ('blocked', 'pending')");
		expect(deliveryScrub).toContain("status = 'failed' AND retryable");
		expect(deliveryScrub).toContain('sealed_capability = NULL');
		expect(deliveryScrub).toContain('claim_token = NULL');
	});

	it('returns delivery_in_flight before publishing terminal state', async () => {
		const database = new ScriptedPostgres([
			[eligibleRecipientRow],
			[{ status: 'in_progress', sentCommitSha: 'commit-3', repositoryHead: 'commit-3' }],
			[actorLockRow],
			[
				{
					id: 'delivery-processing',
					status: 'processing',
					retryable: true,
					sealedCapability: 'sealed'
				}
			],
			[],
			[]
		]);
		const result = await new PostgresRecipientApproveStore(database.client()).publishApproved(
			completedCommand()
		);
		expect(result).toEqual({ outcome: 'delivery_in_flight' });
		expect(
			database.transactionQueries.some((query: RecordedQuery): boolean =>
				query.text.startsWith('UPDATE')
			)
		).toBe(false);
	});

	it('returns context_mismatch for a stale body without opening a write transaction', async () => {
		const database = new ScriptedPostgres([[eligibleRecipientRow]]);
		const stale = {
			...command,
			expectedEnvelopeId: 'env-stale',
			expectedRecipientId: 'recipient-stale'
		};
		const result = await new PostgresRecipientApproveStore(database.client()).publishApproved(
			stale
		);
		expect(result).toEqual({ outcome: 'context_mismatch' });
		expect(database.beginCalls).toBe(0);
		expect(database.transactionQueries).toHaveLength(0);
	});

	it('returns role_not_actionable for a signer without writing', async () => {
		const database = new ScriptedPostgres([[{ ...eligibleRecipientRow, recipientRole: 'signer' }]]);
		const result = await new PostgresRecipientApproveStore(database.client()).prepareApproved(
			command,
			command.updatedAt
		);
		expect(result).toEqual({ outcome: 'role_not_actionable' });
		expect(database.beginCalls).toBe(0);
	});

	it('rechecks idempotency after locks and replays a lost response from current rows', async () => {
		const database = new ScriptedPostgres([
			[completedRecipientRow],
			[{ status: 'in_progress', sentCommitSha: 'commit-3', repositoryHead: 'commit-3' }],
			[
				{
					...actorLockRow,
					recipientStatus: 'completed',
					recipientCapabilityRevokedAt: command.updatedAt
				},
				siblingLockRow
			],
			[{ id: 'delivery-1' }],
			[replayRow()]
		]);
		const result = await new PostgresRecipientApproveStore(database.client()).publishApproved(
			command
		);
		expect(result).toMatchObject({
			outcome: 'replayed',
			result: { auditEventId: command.auditEventId }
		});
		expect(
			database.transactionQueries.some((query) => query.text.includes('UPDATE recipient'))
		).toBe(false);
	});

	it('does not disclose the stored receipt under a different idempotency key', async () => {
		const differentKey = { ...command, idempotencyKey: 'approved-from-another-tab' };
		const database = new ScriptedPostgres([
			[completedRecipientRow],
			[],
			[replayRow()],
			[completedRecipientRow]
		]);
		const result = await new PostgresRecipientApproveStore(database.client()).prepareApproved(
			differentKey,
			'2026-09-11T00:05:00.000Z'
		);
		expect(result).toEqual({ outcome: 'not_found' });
	});

	it('replays an earlier in-progress receipt after a later recipient completes the envelope', async () => {
		const completedEnvelopeRecipient = {
			...completedRecipientRow,
			envelopeStatus: 'completed'
		};
		const database = new ScriptedPostgres([
			[completedEnvelopeRecipient],
			[replayRow()],
			[completedEnvelopeRecipient]
		]);
		const result = await new PostgresRecipientApproveStore(database.client()).prepareApproved(
			command,
			'2026-09-11T00:06:00.000Z'
		);
		expect(result).toMatchObject({
			outcome: 'replayed',
			result: { envelopeStatus: 'in_progress' }
		});
	});

	it('replays a completed receipt only while its terminal projection remains intact', async () => {
		const completedEnvelopeRecipient = {
			...completedRecipientRow,
			envelopeStatus: 'completed'
		};
		const intact = new ScriptedPostgres([
			[completedEnvelopeRecipient],
			[completedReplayRow()],
			[{ hasRevocableRecipient: false, hasUnsafeDelivery: false }],
			[completedEnvelopeRecipient]
		]);
		await expect(
			new PostgresRecipientApproveStore(intact.client()).prepareApproved(command, command.updatedAt)
		).resolves.toMatchObject({ outcome: 'replayed', result: { envelopeStatus: 'completed' } });

		for (const projection of [
			{ hasRevocableRecipient: true, hasUnsafeDelivery: false },
			{ hasRevocableRecipient: false, hasUnsafeDelivery: true }
		]) {
			const drifted = new ScriptedPostgres([
				[completedEnvelopeRecipient],
				[completedReplayRow()],
				[projection]
			]);
			await expect(
				new PostgresRecipientApproveStore(drifted.client()).prepareApproved(
					command,
					command.updatedAt
				)
			).resolves.toEqual({ outcome: 'integrity_error' });
		}
	});

	it('fails closed when durable replay evidence does not match the command', async () => {
		const database = new ScriptedPostgres([
			[completedRecipientRow],
			[replayRow({ evidenceEventType: 'recipient.viewed' })]
		]);
		const result = await new PostgresRecipientApproveStore(database.client()).prepareApproved(
			command,
			command.updatedAt
		);
		expect(result).toEqual({ outcome: 'integrity_error' });
	});

	it('recomputes the audit hash before accepting terminal replay evidence', async () => {
		const database = new ScriptedPostgres([
			[completedRecipientRow],
			[replayRow({ auditEventHash: 'tampered', evidenceEventHash: 'tampered' })]
		]);
		const result = await new PostgresRecipientApproveStore(database.client()).prepareApproved(
			command,
			command.updatedAt
		);
		expect(result).toEqual({ outcome: 'integrity_error' });
	});

	it('reports idempotency_conflict when the same key is reused for a different request', async () => {
		const database = new ScriptedPostgres([
			[completedRecipientRow],
			[replayRow({ requestHash: 'other-fingerprint' })]
		]);
		const result = await new PostgresRecipientApproveStore(database.client()).prepareApproved(
			command,
			command.updatedAt
		);
		expect(result).toEqual({ outcome: 'idempotency_conflict' });
	});

	it('prepares only an eligible live viewed approver', async () => {
		const database = new ScriptedPostgres([
			[eligibleRecipientRow],
			[],
			[],
			[
				{
					id: 'recipient-1',
					role: 'approver',
					routingOrder: 1,
					status: 'viewed'
				},
				{
					id: 'recipient-2',
					role: 'signer',
					routingOrder: 1,
					status: 'viewed'
				}
			],
			[{ sequence: 4, eventHash: 'hash-4' }]
		]);
		const result = await new PostgresRecipientApproveStore(database.client()).prepareApproved(
			command,
			command.updatedAt
		);
		expect(result).toEqual({
			outcome: 'ready',
			envelopeId: 'env-1',
			recipientId: 'recipient-1',
			recipientRole: 'approver',
			routingOrder: 1,
			sentCommitSha: 'commit-3',
			envelopeStatus: 'in_progress',
			auditHead: { sequence: 4, eventHash: 'hash-4' },
			routing: {
				currentGroupOutstanding: 1,
				remainingActionableOutstanding: 1,
				nextRoutingOrder: null,
				nextGroupCount: 0
			}
		});
	});

	it('denies as not_found when the capability is revoked, expired, or still pending', async () => {
		const expired = new ScriptedPostgres([[eligibleRecipientRow], [], []]);
		await expect(
			new PostgresRecipientApproveStore(expired.client()).prepareApproved(
				command,
				'2026-09-30T00:00:00.000Z'
			)
		).resolves.toEqual({ outcome: 'not_found' });

		const revoked = new ScriptedPostgres([
			[
				{
					...eligibleRecipientRow,
					recipientCapabilityRevokedAt: '2026-09-11T00:03:00.000Z'
				}
			],
			[],
			[]
		]);
		await expect(
			new PostgresRecipientApproveStore(revoked.client()).prepareApproved(
				command,
				command.updatedAt
			)
		).resolves.toEqual({ outcome: 'not_found' });

		const pending = new ScriptedPostgres([
			[{ ...eligibleRecipientRow, recipientStatus: 'pending' }],
			[],
			[]
		]);
		await expect(
			new PostgresRecipientApproveStore(pending.client()).prepareApproved(
				command,
				command.updatedAt
			)
		).resolves.toEqual({ outcome: 'not_found' });
	});

	it('treats completed state without its durable command as an integrity error', async () => {
		const database = new ScriptedPostgres([[completedRecipientRow], [], []]);
		await expect(
			new PostgresRecipientApproveStore(database.client()).prepareApproved(
				command,
				command.updatedAt
			)
		).resolves.toEqual({ outcome: 'integrity_error' });
	});

	it('classifies a unique-constraint failure from durable state without parsing the provider error', async () => {
		const error: Error = new Error('duplicate key value violates unique constraint');
		const database = new ScriptedPostgres([
			[eligibleRecipientRow],
			[{ status: 'in_progress', sentCommitSha: 'commit-3', repositoryHead: 'commit-3' }],
			[actorLockRow, siblingLockRow],
			[{ id: 'delivery-1' }],
			error,
			[completedRecipientRow],
			[replayRow()],
			[completedRecipientRow]
		]);
		const result = await new PostgresRecipientApproveStore(database.client()).publishApproved(
			command
		);
		expect(result).toMatchObject({ outcome: 'replayed' });
	});
});
