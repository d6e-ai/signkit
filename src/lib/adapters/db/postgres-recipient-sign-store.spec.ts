import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PublishRecipientSignedCommand } from '$lib/ports/recipient-sign-store';
import { canonicalRecipientSignFingerprint } from '$lib/ports/recipient-sign-store';
import { PostgresRecipientSignStore } from './postgres-recipient-sign-store';

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

const fieldId: string = 'field-1';
const command: PublishRecipientSignedCommand = {
	capabilityHash: 'cap-hash-1',
	expectedEnvelopeId: 'env-1',
	expectedRecipientId: 'recipient-1',
	idempotencyKey: 'signed-1',
	requestFingerprint: '',
	recipientRole: 'signer',
	routingOrder: 1,
	expectedSentCommitSha: 'commit-3',
	expectedFieldGeneration: 1,
	fieldValues: [
		{
			fieldId,
			fieldType: 'signature',
			valueJson: JSON.stringify('Jane Doe'),
			valueSha256: createHash('sha256').update(JSON.stringify('Jane Doe')).digest('hex')
		}
	],
	updatedAt: '2026-09-11T00:04:00.000Z',
	nextRoutingOrder: null,
	nextCapabilityExpiresAt: null,
	releasedDeliveryCount: 0,
	expectedAuditSequence: 4,
	previousAuditHash: 'hash-4',
	auditEventId: 'signed-audit-1',
	auditEventHash: 'hash-5',
	auditPayloadJson: '{}',
	completedAuditEventId: null,
	completedAuditEventHash: null,
	completedAuditPayloadJson: null
};
command.requestFingerprint = createHash('sha256')
	.update(
		canonicalRecipientSignFingerprint({
			envelopeId: command.expectedEnvelopeId,
			recipientId: command.expectedRecipientId,
			capabilityHash: command.capabilityHash,
			expectedFieldGeneration: command.expectedFieldGeneration,
			values: [{ fieldId, value: 'Jane Doe' }]
		})
	)
	.digest('hex');
command.auditPayloadJson = JSON.stringify({
	recipientId: command.expectedRecipientId,
	role: 'signer',
	routingOrder: command.routingOrder,
	sentCommitSha: command.expectedSentCommitSha,
	fields: [
		{ id: fieldId, fieldType: 'signature', valueSha256: command.fieldValues[0].valueSha256 }
	],
	signedAt: command.updatedAt
});
command.auditEventHash = createHash('sha256')
	.update(
		JSON.stringify({
			actorId: command.expectedRecipientId,
			envelopeId: command.expectedEnvelopeId,
			eventType: 'recipient.signed',
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
	recipientStatus: 'viewed',
	recipientCapabilityHash: command.capabilityHash,
	recipientCapabilityExpiresAt: '2026-09-25T00:00:00.000Z',
	recipientCapabilityRevokedAt: null,
	routingOrder: 1,
	envelopeStatus: 'in_progress',
	envelopeSentCommitSha: 'commit-3',
	envelopeRepositoryHead: 'commit-3',
	envelopeFieldGeneration: 1
};

const completedRecipientRow = {
	...eligibleRecipientRow,
	recipientStatus: 'completed',
	recipientCapabilityRevokedAt: command.updatedAt,
	envelopeStatus: 'completed'
};

const actorLockRow = {
	id: 'recipient-1',
	organizationId: 'org-1',
	envelopeId: 'env-1',
	recipientRole: 'signer' as const,
	recipientStatus: 'viewed',
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
	recipientStatus: 'viewed',
	recipientCapabilityHash: 'cap-hash-2',
	recipientCapabilityExpiresAt: '2026-09-25T00:00:00.000Z',
	recipientCapabilityRevokedAt: null,
	routingOrder: 1
};

const laterSignerLockRow = {
	...siblingLockRow,
	id: 'recipient-3',
	recipientStatus: 'pending',
	recipientCapabilityHash: 'cap-hash-3',
	recipientCapabilityExpiresAt: null,
	routingOrder: 2
};

const laterViewerLockRow = {
	...laterSignerLockRow,
	id: 'recipient-viewer',
	recipientRole: 'viewer' as const,
	recipientCapabilityHash: 'cap-hash-viewer'
};

const laterPrefillLockRow = {
	...laterSignerLockRow,
	id: 'recipient-prefill',
	recipientRole: 'prefill' as const,
	recipientCapabilityHash: 'cap-hash-prefill'
};

function completedCommand(): PublishRecipientSignedCommand {
	const completedAuditPayloadJson: string = JSON.stringify({
		sentCommitSha: command.expectedSentCommitSha,
		completedAt: command.updatedAt
	});
	const completedAuditEventHash: string = createHash('sha256')
		.update(
			JSON.stringify({
				actorId: command.expectedRecipientId,
				envelopeId: command.expectedEnvelopeId,
				eventType: 'envelope.completed',
				occurredAt: command.updatedAt,
				organizationId: 'org-1',
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

function completedReplayRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const completed: PublishRecipientSignedCommand = completedCommand();
	const fieldValuesJson: string = JSON.stringify(
		completed.fieldValues.map((value) => ({
			id: value.fieldId,
			fieldType: value.fieldType,
			valueSha256: value.valueSha256
		}))
	);
	return {
		organizationId: 'org-1',
		envelopeId: completed.expectedEnvelopeId,
		recipientId: completed.expectedRecipientId,
		recipientRole: completed.recipientRole,
		routingOrder: completed.routingOrder,
		actorType: 'recipient',
		actorId: completed.expectedRecipientId,
		idempotencyKey: completed.idempotencyKey,
		requestHash: completed.requestFingerprint,
		capabilityHash: completed.capabilityHash,
		sentCommitSha: completed.expectedSentCommitSha,
		expectedFieldGeneration: completed.expectedFieldGeneration,
		fieldValuesJson,
		fieldCount: completed.fieldValues.length,
		updatedAt: completed.updatedAt,
		nextRoutingOrder: null,
		nextCapabilityExpiresAt: null,
		releasedDeliveryCount: 0,
		auditEventId: completed.auditEventId,
		auditSequence: completed.expectedAuditSequence + 1,
		previousAuditHash: completed.previousAuditHash,
		auditEventHash: completed.auditEventHash,
		auditPayloadJson: completed.auditPayloadJson,
		completedAuditEventId: completed.completedAuditEventId,
		completedAuditEventHash: completed.completedAuditEventHash,
		completedAuditPayloadJson: completed.completedAuditPayloadJson,
		evidenceEventId: completed.auditEventId,
		evidenceOrganizationId: 'org-1',
		evidenceEnvelopeId: completed.expectedEnvelopeId,
		evidenceSequence: completed.expectedAuditSequence + 1,
		evidenceEventType: 'recipient.signed',
		evidenceActorType: 'recipient',
		evidenceActorId: completed.expectedRecipientId,
		evidencePayloadJson: completed.auditPayloadJson,
		evidencePreviousHash: completed.previousAuditHash,
		evidenceEventHash: completed.auditEventHash,
		evidenceOccurredAt: completed.updatedAt,
		completedEvidenceEventId: completed.completedAuditEventId,
		completedEvidenceOrganizationId: 'org-1',
		completedEvidenceEnvelopeId: completed.expectedEnvelopeId,
		completedEvidenceSequence: completed.expectedAuditSequence + 2,
		completedEvidenceEventType: 'envelope.completed',
		completedEvidenceActorType: 'recipient',
		completedEvidenceActorId: completed.expectedRecipientId,
		completedEvidencePayloadJson: completed.completedAuditPayloadJson,
		completedEvidencePreviousHash: completed.auditEventHash,
		completedEvidenceEventHash: completed.completedAuditEventHash,
		completedEvidenceOccurredAt: completed.updatedAt,
		...overrides
	};
}

describe('PostgresRecipientSignStore', () => {
	it('locks the envelope, then recipients, then envelope_field (all in id order) before inserting the field value', async () => {
		const database = new ScriptedPostgres([
			[eligibleRecipientRow],
			[
				{
					status: 'in_progress',
					sentCommitSha: 'commit-3',
					repositoryHead: 'commit-3',
					fieldGeneration: 1
				}
			],
			[actorLockRow, siblingLockRow],
			[],
			[{ id: fieldId, fieldType: 'signature', required: true }],
			[],
			[],
			[],
			[{ sequence: 4, eventHash: command.previousAuditHash }],
			[{ id: command.expectedRecipientId }],
			[{ id: command.expectedEnvelopeId }],
			[],
			[],
			[]
		]);
		const result = await new PostgresRecipientSignStore(database.client()).publishSign(command);
		expect(result).toMatchObject({
			outcome: 'published',
			result: { recipientId: command.expectedRecipientId, envelopeStatus: 'in_progress' }
		});
		expect(database.beginCalls).toBe(1);
		expect(database.directQueries[0].text).toContain('recipient.capability_hash =');

		const texts = database.transactionQueries.map((query) => query.text);
		expect(texts[0]).toContain('FROM envelope');
		expect(texts[0]).toContain('FOR UPDATE');
		expect(texts[1]).toContain('FROM recipient');
		expect(texts[1]).toContain('ORDER BY id');
		expect(texts[1]).toContain('FOR UPDATE');
		expect(texts[2]).toContain('delivery_outbox');
		expect(texts[3]).toContain('FROM envelope_field');
		expect(texts[3]).toContain('ORDER BY id');
		expect(texts[3]).toContain('FOR UPDATE');
		expect(texts[4]).toContain('FROM field_value');
		expect(texts[4]).toContain('ORDER BY field_id');
		expect(texts[4]).toContain('FOR UPDATE');
		expect(texts).toEqual([
			expect.stringContaining('FOR UPDATE'),
			expect.stringContaining('ORDER BY id'),
			expect.stringContaining('delivery_outbox'),
			expect.stringContaining('FROM envelope_field'),
			expect.stringContaining('FROM field_value'),
			expect.stringContaining('FROM recipient_signed_command'),
			expect.stringContaining('FROM recipient_signed_command'),
			expect.stringContaining('FROM audit_event'),
			expect.stringContaining("SET status = 'completed'"),
			expect.stringContaining('UPDATE envelope'),
			expect.stringContaining('INSERT INTO recipient_signed_command'),
			expect.stringContaining('INSERT INTO field_value'),
			expect.stringContaining('INSERT INTO audit_event')
		]);
		expect(texts.filter((text) => text.includes('UPDATE delivery_outbox')).length).toBe(0);
	});

	it('releases only signer, approver, and viewer deliveries in the next routing group', async () => {
		const releaseCommand: PublishRecipientSignedCommand = {
			...command,
			nextRoutingOrder: 2,
			nextCapabilityExpiresAt: '2026-09-25T12:00:00.000Z',
			releasedDeliveryCount: 2
		};
		const database = new ScriptedPostgres([
			[eligibleRecipientRow],
			[
				{
					status: 'in_progress',
					sentCommitSha: 'commit-3',
					repositoryHead: 'commit-3',
					fieldGeneration: 1
				}
			],
			[actorLockRow, laterSignerLockRow, laterViewerLockRow, laterPrefillLockRow],
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
			[{ id: fieldId, fieldType: 'signature', required: true }],
			[],
			[],
			[],
			[{ sequence: 4, eventHash: command.previousAuditHash }],
			[{ id: command.expectedRecipientId }],
			[{ id: laterSignerLockRow.id }, { id: laterViewerLockRow.id }],
			[{ id: 'delivery-3' }, { id: 'delivery-viewer' }],
			[{ id: command.expectedEnvelopeId }],
			[],
			[],
			[]
		]);
		const result = await new PostgresRecipientSignStore(database.client()).publishSign(
			releaseCommand
		);
		expect(result).toMatchObject({
			outcome: 'published',
			result: { envelopeStatus: 'in_progress', nextRoutingOrder: 2 }
		});
		const texts: string[] = database.transactionQueries.map(
			(query: RecordedQuery): string => query.text
		);
		const recipientRelease: string | undefined = texts.find(
			(text: string): boolean =>
				text.includes('UPDATE recipient') && text.includes('SET capability_expires_at')
		);
		expect(recipientRelease).toContain("role IN ('signer', 'approver', 'viewer')");
		expect(recipientRelease).not.toContain("'prefill'");
		const outboxRelease: string | undefined = texts.find((text: string): boolean =>
			text.includes('UPDATE delivery_outbox AS delivery')
		);
		expect(outboxRelease).toContain("target.role IN ('signer', 'approver', 'viewer')");
		expect(outboxRelease).not.toMatch(/sealed_capability\s*=/);
	});

	it('revokes observer capabilities and terminalizes mutable deliveries on completion', async () => {
		const database = new ScriptedPostgres([
			[eligibleRecipientRow],
			[
				{
					status: 'in_progress',
					sentCommitSha: 'commit-3',
					repositoryHead: 'commit-3',
					fieldGeneration: 1
				}
			],
			[actorLockRow, laterViewerLockRow, laterPrefillLockRow],
			[
				{ id: 'delivery-blocked', status: 'blocked', retryable: true, sealedCapability: 'sealed' },
				{ id: 'delivery-delivered', status: 'delivered', retryable: false, sealedCapability: null }
			],
			[{ id: fieldId, fieldType: 'signature', required: true }],
			[],
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
			[],
			[]
		]);
		const result = await new PostgresRecipientSignStore(database.client()).publishSign(
			completedCommand()
		);
		expect(result).toMatchObject({
			outcome: 'published',
			result: { envelopeStatus: 'completed', completedAuditEventId: 'completed-audit-1' }
		});
		const texts: string[] = database.transactionQueries.map(
			(query: RecordedQuery): string => query.text
		);
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
			[
				{
					status: 'in_progress',
					sentCommitSha: 'commit-3',
					repositoryHead: 'commit-3',
					fieldGeneration: 1
				}
			],
			[actorLockRow],
			[
				{
					id: 'delivery-processing',
					status: 'processing',
					retryable: true,
					sealedCapability: 'sealed'
				}
			],
			[{ id: fieldId, fieldType: 'signature', required: true }],
			[],
			[],
			[]
		]);
		const result = await new PostgresRecipientSignStore(database.client()).publishSign(
			completedCommand()
		);
		expect(result).toEqual({ outcome: 'delivery_in_flight' });
		expect(
			database.transactionQueries.some((query: RecordedQuery): boolean =>
				query.text.startsWith('UPDATE')
			)
		).toBe(false);
	});

	it('returns not_found without opening a transaction when no recipient matches the capability hash', async () => {
		const database = new ScriptedPostgres([[]]);
		const result = await new PostgresRecipientSignStore(database.client()).publishSign(command);
		expect(result).toEqual({ outcome: 'not_found' });
		expect(database.beginCalls).toBe(0);
	});

	it('returns role_not_actionable without opening a transaction for a non-signer capability', async () => {
		const database = new ScriptedPostgres([
			[{ ...eligibleRecipientRow, recipientRole: 'approver' }]
		]);
		const result = await new PostgresRecipientSignStore(database.client()).publishSign(command);
		expect(result).toEqual({ outcome: 'role_not_actionable' });
		expect(database.beginCalls).toBe(0);
	});

	it('does not disclose the stored receipt under a different idempotency key', async () => {
		const differentKey = { ...command, idempotencyKey: 'signed-from-another-tab' };
		const database = new ScriptedPostgres([
			[
				{
					...eligibleRecipientRow,
					recipientStatus: 'completed',
					recipientCapabilityRevokedAt: command.updatedAt
				}
			],
			[],
			[{ envelopeId: command.expectedEnvelopeId, capabilityHash: command.capabilityHash }]
		]);
		const result = await new PostgresRecipientSignStore(database.client()).prepareSign(
			differentKey,
			'2026-09-11T00:05:00.000Z'
		);
		expect(result).toEqual({ outcome: 'not_found' });
	});

	it('replays a completed receipt only while its terminal projection remains intact', async () => {
		const storedValue = {
			fieldId,
			fieldType: 'signature' as const,
			valueJson: command.fieldValues[0].valueJson,
			valueSha256: command.fieldValues[0].valueSha256
		};
		const intact = new ScriptedPostgres([
			[completedRecipientRow],
			[completedReplayRow()],
			[storedValue],
			[{ hasRevocableRecipient: false, hasUnsafeDelivery: false }],
			[completedRecipientRow]
		]);
		await expect(
			new PostgresRecipientSignStore(intact.client()).prepareSign(command, command.updatedAt)
		).resolves.toMatchObject({ outcome: 'existing', result: { envelopeStatus: 'completed' } });

		for (const projection of [
			{ hasRevocableRecipient: true, hasUnsafeDelivery: false },
			{ hasRevocableRecipient: false, hasUnsafeDelivery: true }
		]) {
			const drifted = new ScriptedPostgres([
				[completedRecipientRow],
				[completedReplayRow()],
				[storedValue],
				[projection]
			]);
			await expect(
				new PostgresRecipientSignStore(drifted.client()).prepareSign(command, command.updatedAt)
			).resolves.toEqual({ outcome: 'integrity_error' });
		}
	});

	it('resolves a ready preparation including this recipient own field declarations', async () => {
		const database = new ScriptedPostgres([
			[eligibleRecipientRow],
			[],
			[],
			[actorLockRow, siblingLockRow],
			[{ sequence: 4, eventHash: 'hash-4' }],
			[{ id: fieldId, fieldType: 'signature', required: true }]
		]);
		const result = await new PostgresRecipientSignStore(database.client()).prepareSign(
			command,
			command.updatedAt
		);
		expect(result).toMatchObject({
			outcome: 'ready',
			recipientId: 'recipient-1',
			fieldGeneration: 1,
			fields: [{ id: fieldId, fieldType: 'signature', required: true }]
		});
	});
});
