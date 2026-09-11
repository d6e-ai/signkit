import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PublishRecipientSignedCommand } from '$lib/ports/recipient-sign-store';
import { canonicalRecipientSignFingerprint } from '$lib/ports/recipient-sign-store';
import { D1RecipientSignStore } from './d1-recipient-sign-store';

interface RecordedStatement {
	sql: string;
	bindings: readonly unknown[];
	statement: D1PreparedStatement;
}

function fakeD1(
	firstResults: readonly unknown[],
	allResults: readonly unknown[] = [],
	batchError?: Error
) {
	const first: unknown[] = [...firstResults];
	const all: unknown[] = [...allResults];
	const prepared: RecordedStatement[] = [];
	const batches: RecordedStatement[][] = [];
	const prepare = vi.fn((sql: string): D1PreparedStatement => {
		const record: RecordedStatement = { sql, bindings: [], statement: undefined as never };
		const statement = {
			bind: (...bindings: unknown[]): D1PreparedStatement => {
				record.bindings = bindings;
				return statement;
			},
			first: async (): Promise<unknown | null> => first.shift() ?? null,
			all: async (): Promise<{ results: unknown[] }> => ({
				results: (all.shift() as unknown[] | undefined) ?? []
			})
		} as unknown as D1PreparedStatement;
		record.statement = statement;
		prepared.push(record);
		return statement;
	});
	const batch = vi.fn(async (statements: D1PreparedStatement[]): Promise<unknown[]> => {
		batches.push(
			statements.map((statement) => prepared.find((item) => item.statement === statement)!)
		);
		if (batchError !== undefined) throw batchError;
		return [];
	});
	return { database: { prepare, batch } as unknown as D1Database, prepared, batches };
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
	auditEventHash: '',
	auditPayloadJson: '',
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

function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		organization_id: 'org-1',
		envelope_id: command.expectedEnvelopeId,
		recipient_id: command.expectedRecipientId,
		recipient_role: command.recipientRole,
		routing_order: command.routingOrder,
		actor_type: 'recipient',
		actor_id: command.expectedRecipientId,
		idempotency_key: command.idempotencyKey,
		request_hash: command.requestFingerprint,
		capability_hash: command.capabilityHash,
		sent_commit_sha: command.expectedSentCommitSha,
		expected_field_generation: command.expectedFieldGeneration,
		field_values_json: JSON.stringify([
			{ id: fieldId, fieldType: 'signature', valueSha256: command.fieldValues[0].valueSha256 }
		]),
		field_count: 1,
		updated_at: command.updatedAt,
		next_routing_order: command.nextRoutingOrder,
		next_capability_expires_at: command.nextCapabilityExpiresAt,
		released_delivery_count: command.releasedDeliveryCount,
		audit_event_id: command.auditEventId,
		audit_sequence: command.expectedAuditSequence + 1,
		previous_audit_hash: command.previousAuditHash,
		audit_event_hash: command.auditEventHash,
		audit_payload_json: command.auditPayloadJson,
		completed_audit_event_id: command.completedAuditEventId,
		completed_audit_event_hash: command.completedAuditEventHash,
		completed_audit_payload_json: command.completedAuditPayloadJson,
		evidence_event_id: command.auditEventId,
		evidence_organization_id: 'org-1',
		evidence_envelope_id: command.expectedEnvelopeId,
		evidence_sequence: command.expectedAuditSequence + 1,
		evidence_event_type: 'recipient.signed',
		evidence_actor_type: 'recipient',
		evidence_actor_id: command.expectedRecipientId,
		evidence_payload_json: command.auditPayloadJson,
		evidence_previous_hash: command.previousAuditHash,
		evidence_event_hash: command.auditEventHash,
		evidence_occurred_at: command.updatedAt,
		completed_evidence_event_id: null,
		completed_evidence_organization_id: null,
		completed_evidence_envelope_id: null,
		completed_evidence_sequence: null,
		completed_evidence_event_type: null,
		completed_evidence_actor_type: null,
		completed_evidence_actor_id: null,
		completed_evidence_payload_json: null,
		completed_evidence_previous_hash: null,
		completed_evidence_event_hash: null,
		completed_evidence_occurred_at: null,
		...overrides
	};
}

const eligibleRow = {
	organization_id: 'org-1',
	envelope_id: 'env-1',
	recipient_id: 'recipient-1',
	recipient_role: 'signer',
	recipient_status: 'viewed',
	recipient_capability_hash: command.capabilityHash,
	recipient_capability_expires_at: '2026-09-25T00:00:00.000Z',
	recipient_capability_revoked_at: null,
	routing_order: 1,
	envelope_status: 'in_progress',
	envelope_sent_commit_sha: 'commit-3',
	envelope_repository_head: 'commit-3',
	envelope_field_generation: 1
};

const completedRow = {
	...eligibleRow,
	recipient_status: 'completed',
	recipient_capability_revoked_at: command.updatedAt,
	envelope_status: 'in_progress'
};

const siblingRows = [
	{ id: 'recipient-1', role: 'signer', routing_order: 1, status: 'viewed' },
	{ id: 'recipient-2', role: 'signer', routing_order: 1, status: 'viewed' },
	{ id: 'recipient-3', role: 'signer', routing_order: 2, status: 'pending' },
	{ id: 'recipient-cc', role: 'cc', routing_order: 1, status: 'pending' }
];

const fieldRows = [{ id: fieldId, field_type: 'signature', required: 1 }];
const fieldValueRows = [
	{
		field_id: fieldId,
		field_type: 'signature',
		value_json: JSON.stringify('Jane Doe'),
		value_sha256: command.fieldValues[0].valueSha256
	}
];

describe('D1RecipientSignStore', () => {
	it('resolves identity only by capability hash and prepares a live viewed signer with its own fields', async () => {
		const fake = fakeD1(
			[eligibleRow, null, null, { sequence: 4, event_hash: 'hash-4' }],
			[siblingRows, fieldRows]
		);
		const result = await new D1RecipientSignStore(fake.database).prepareSign(
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
			fieldGeneration: 1,
			envelopeStatus: 'in_progress',
			auditHead: { sequence: 4, eventHash: 'hash-4' },
			routing: {
				currentGroupOutstanding: 1,
				remainingActionableOutstanding: 2,
				nextRoutingOrder: 2,
				nextGroupCount: 1
			},
			fields: [{ id: fieldId, fieldType: 'signature', required: true }]
		});
		expect(fake.prepared[0].sql).toContain('recipient.capability_hash = ?');
		expect(fake.prepared[0].bindings).toEqual([command.capabilityHash]);
	});

	it('returns context_mismatch for a stale body without writing', async () => {
		const stale = {
			...command,
			expectedEnvelopeId: 'env-stale',
			expectedRecipientId: 'recipient-stale'
		};
		await expect(
			new D1RecipientSignStore(fakeD1([eligibleRow]).database).prepareSign(stale, command.updatedAt)
		).resolves.toEqual({ outcome: 'context_mismatch' });
		const publishFake = fakeD1([eligibleRow]);
		await expect(
			new D1RecipientSignStore(publishFake.database).publishSign(stale)
		).resolves.toEqual({ outcome: 'context_mismatch' });
		expect(publishFake.batches).toHaveLength(0);
	});

	it('returns role_not_actionable for approver, viewer, and prefill without writing', async () => {
		for (const role of ['approver', 'viewer', 'prefill'] as const) {
			const row = { ...eligibleRow, recipient_role: role };
			await expect(
				new D1RecipientSignStore(fakeD1([row]).database).prepareSign(command, command.updatedAt)
			).resolves.toEqual({ outcome: 'role_not_actionable' });
			const publishFake = fakeD1([row]);
			await expect(
				new D1RecipientSignStore(publishFake.database).publishSign(command)
			).resolves.toEqual({ outcome: 'role_not_actionable' });
			expect(publishFake.batches).toHaveLength(0);
		}
	});

	it('denies as not_found when pending, revoked, expired, or swapped', async () => {
		await expect(
			new D1RecipientSignStore(
				fakeD1([{ ...eligibleRow, recipient_status: 'pending' }, null, null]).database
			).prepareSign(command, command.updatedAt)
		).resolves.toEqual({ outcome: 'not_found' });

		await expect(
			new D1RecipientSignStore(fakeD1([eligibleRow, null, null]).database).prepareSign(
				command,
				'2026-09-30T00:00:00.000Z'
			)
		).resolves.toEqual({ outcome: 'not_found' });

		await expect(
			new D1RecipientSignStore(fakeD1([null]).database).prepareSign(command, command.updatedAt)
		).resolves.toEqual({ outcome: 'not_found' });
	});

	it('publishes a command insert plus one field_value insert per submitted value', async () => {
		const fake = fakeD1([eligibleRow]);
		const result = await new D1RecipientSignStore(fake.database).publishSign(command);
		expect(result).toMatchObject({
			outcome: 'published',
			result: {
				recipientId: command.expectedRecipientId,
				recipientRole: 'signer',
				envelopeStatus: 'in_progress',
				completedAuditEventId: null
			}
		});
		expect(fake.batches).toHaveLength(1);
		const statements = fake.batches[0];
		expect(statements[0].sql).toContain('INSERT INTO recipient_signed_command');
		expect(statements).toHaveLength(2);
		expect(statements[1].sql).toContain('INSERT INTO field_value');
		expect(statements[1].bindings).toEqual([
			'org-1',
			fieldId,
			'env-1',
			'recipient-1',
			'signature',
			command.fieldValues[0].valueJson,
			command.fieldValues[0].valueSha256,
			command.updatedAt
		]);
		const commandBindings = statements[0].bindings as readonly unknown[];
		expect(commandBindings).toContain(
			JSON.stringify([
				{ id: fieldId, fieldType: 'signature', valueSha256: command.fieldValues[0].valueSha256 }
			])
		);
	});

	it('classifies a lost write as replayed from durable state without parsing the provider error', async () => {
		const fake = fakeD1(
			[eligibleRow, completedRow, storedRow(), completedRow],
			[fieldValueRows],
			new Error('UNIQUE constraint failed: recipient_signed_command')
		);
		const result = await new D1RecipientSignStore(fake.database).publishSign(command);
		expect(result).toMatchObject({
			outcome: 'replayed',
			result: { auditEventId: command.auditEventId }
		});
	});

	it('rethrows unclassified failures without inspecting provider error strings', async () => {
		const error: Error = new Error('UNIQUE constraint failed: recipient_signed_command');
		const fake = fakeD1(
			[eligibleRow, eligibleRow, null, null, { sequence: 4, event_hash: 'hash-4' }],
			[siblingRows, fieldRows],
			error
		);
		await expect(new D1RecipientSignStore(fake.database).publishSign(command)).rejects.toBe(error);
	});

	it('fails closed when durable replay evidence does not match the command', async () => {
		const result = await new D1RecipientSignStore(
			fakeD1(
				[completedRow, storedRow({ evidence_event_type: 'recipient.viewed' })],
				[fieldValueRows]
			).database
		).prepareSign(command, command.updatedAt);
		expect(result).toEqual({ outcome: 'integrity_error' });
	});

	it('does not disclose the stored receipt under a different idempotency key', async () => {
		const differentKey = { ...command, idempotencyKey: 'signed-from-another-tab' };
		const result = await new D1RecipientSignStore(
			fakeD1([completedRow, null, storedRow()]).database
		).prepareSign(differentKey, '2026-09-11T00:05:00.000Z');
		expect(result).toEqual({ outcome: 'not_found' });
	});

	it('reconstructs the request fingerprint from stored normalized values', async () => {
		const result = await new D1RecipientSignStore(
			fakeD1([completedRow, storedRow(), completedRow], [fieldValueRows]).database
		).prepareSign(command, command.updatedAt);
		expect(result).toMatchObject({
			outcome: 'existing',
			reconstructedFingerprint: command.requestFingerprint,
			result: { auditEventId: command.auditEventId },
			storedFields: [{ id: fieldId, fieldType: 'signature', required: false }]
		});
	});

	it('reports idempotency_conflict when classifyFailure sees a reconstructed fingerprint mismatch', async () => {
		const fake = fakeD1(
			[eligibleRow, completedRow, storedRow(), completedRow],
			[fieldValueRows],
			new Error('UNIQUE constraint failed: recipient_signed_command')
		);
		const result = await new D1RecipientSignStore(fake.database).publishSign({
			...command,
			requestFingerprint: 'other-fingerprint'
		});
		expect(result).toEqual({ outcome: 'idempotency_conflict' });
	});
});
