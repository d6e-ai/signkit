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
