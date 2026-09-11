import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PublishRecipientApprovedCommand } from '$lib/ports/recipient-approve-store';
import { D1RecipientApproveStore } from './d1-recipient-approve-store';

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
			actorId: command.expectedRecipientId,
			envelopeId: command.expectedEnvelopeId,
			eventType: 'recipient.approved',
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
		evidence_event_type: 'recipient.approved',
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
	recipient_role: 'approver',
	recipient_status: 'viewed',
	recipient_capability_hash: command.capabilityHash,
	recipient_capability_expires_at: '2026-09-25T00:00:00.000Z',
	recipient_capability_revoked_at: null,
	routing_order: 1,
	envelope_status: 'in_progress',
	envelope_sent_commit_sha: 'commit-3',
	envelope_repository_head: 'commit-3'
};

const completedRow = {
	...eligibleRow,
	recipient_status: 'completed',
	recipient_capability_revoked_at: command.updatedAt,
	envelope_status: 'in_progress'
};

const siblingRows = [
	{
		id: 'recipient-1',
		role: 'approver',
		routing_order: 1,
		status: 'viewed'
	},
	{
		id: 'recipient-2',
		role: 'signer',
		routing_order: 1,
		status: 'viewed'
	},
	{
		id: 'recipient-3',
		role: 'signer',
		routing_order: 2,
		status: 'pending'
	},
	{
		id: 'recipient-cc',
		role: 'cc',
		routing_order: 1,
		status: 'pending'
	}
];

describe('D1RecipientApproveStore', () => {
	it('resolves identity only by capability hash and prepares a live viewed approver', async () => {
		const fake = fakeD1(
			[eligibleRow, null, null, { sequence: 4, event_hash: 'hash-4' }],
			[siblingRows]
		);
		const result = await new D1RecipientApproveStore(fake.database).prepareApproved(
			command,
			command.updatedAt
		);
		expect(result).toEqual({
			outcome: 'ready',
			organizationId: 'org-1',
			envelopeId: 'env-1',
			recipientId: 'recipient-1',
			recipientRole: 'approver',
			routingOrder: 1,
			sentCommitSha: 'commit-3',
			envelopeStatus: 'in_progress',
			auditHead: { sequence: 4, eventHash: 'hash-4' },
			routing: {
				currentGroupOutstanding: 1,
				remainingActionableOutstanding: 2,
				nextRoutingOrder: 2,
				nextGroupCount: 1
			}
		});
		expect(fake.prepared[0].sql).toContain('recipient.capability_hash = ?');
		expect(fake.prepared[0].sql).not.toContain('recipient.envelope_id = ?');
		expect(fake.prepared[0].bindings).toEqual([command.capabilityHash]);
	});

	it('returns context_mismatch for a stale body without writing', async () => {
		const stale = {
			...command,
			expectedEnvelopeId: 'env-stale',
			expectedRecipientId: 'recipient-stale'
		};
		await expect(
			new D1RecipientApproveStore(fakeD1([eligibleRow]).database).prepareApproved(
				stale,
				command.updatedAt
			)
		).resolves.toEqual({ outcome: 'context_mismatch' });
		const publishFake = fakeD1([eligibleRow]);
		await expect(
			new D1RecipientApproveStore(publishFake.database).publishApproved(stale)
		).resolves.toEqual({ outcome: 'context_mismatch' });
		expect(publishFake.batches).toHaveLength(0);
		expect(publishFake.prepared[0].bindings).toEqual([command.capabilityHash]);
	});

	it('returns role_not_actionable for signer, viewer, and prefill without writing', async () => {
		for (const role of ['signer', 'viewer', 'prefill'] as const) {
			const row = { ...eligibleRow, recipient_role: role };
			await expect(
				new D1RecipientApproveStore(fakeD1([row]).database).prepareApproved(
					command,
					command.updatedAt
				)
			).resolves.toEqual({ outcome: 'role_not_actionable' });
			const publishFake = fakeD1([row]);
			await expect(
				new D1RecipientApproveStore(publishFake.database).publishApproved(command)
			).resolves.toEqual({ outcome: 'role_not_actionable' });
			expect(publishFake.batches).toHaveLength(0);
		}
	});

	it('denies as not_found when pending, revoked, expired, or swapped', async () => {
		await expect(
			new D1RecipientApproveStore(
				fakeD1([{ ...eligibleRow, recipient_status: 'pending' }, null, null]).database
			).prepareApproved(command, command.updatedAt)
		).resolves.toEqual({ outcome: 'not_found' });

		await expect(
			new D1RecipientApproveStore(fakeD1([eligibleRow, null, null]).database).prepareApproved(
				command,
				'2026-09-30T00:00:00.000Z'
			)
		).resolves.toEqual({ outcome: 'not_found' });

		await expect(
			new D1RecipientApproveStore(
				fakeD1([
					{ ...eligibleRow, recipient_capability_revoked_at: '2026-09-11T00:03:00.000Z' },
					null,
					null
				]).database
			).prepareApproved(command, command.updatedAt)
		).resolves.toEqual({ outcome: 'not_found' });

		await expect(
			new D1RecipientApproveStore(fakeD1([null]).database).prepareApproved(
				command,
				command.updatedAt
			)
		).resolves.toEqual({ outcome: 'not_found' });
	});

	it('publishes a single-statement command insert after the capability-hash identity read', async () => {
		const fake = fakeD1([eligibleRow]);
		const result = await new D1RecipientApproveStore(fake.database).publishApproved(command);
		expect(result).toMatchObject({
			outcome: 'published',
			result: {
				recipientId: command.expectedRecipientId,
				envelopeStatus: 'in_progress',
				completedAuditEventId: null
			}
		});
		expect(fake.batches).toHaveLength(1);
		expect(fake.batches[0].map((item) => item.sql)).toEqual([
			expect.stringContaining('INSERT INTO recipient_approved_command')
		]);
		expect(fake.batches[0][0].sql).not.toContain('delivery_outbox');
		expect(fake.prepared[0].bindings).toEqual([command.capabilityHash]);
		expect(fake.batches[0][0].bindings).toContain(command.capabilityHash);
		expect(fake.prepared).toHaveLength(2);
	});

	it('replays a lost successful response after the actor is completed and revoked', async () => {
		const result = await new D1RecipientApproveStore(
			fakeD1([completedRow, storedRow(), completedRow]).database
		).prepareApproved(command, '2026-09-11T00:05:00.000Z');
		expect(result).toMatchObject({
			outcome: 'replayed',
			result: { recipientId: command.expectedRecipientId, envelopeStatus: 'in_progress' }
		});
	});

	it('replays an earlier in-progress receipt after a later recipient completes the envelope', async () => {
		const completedEnvelopeRow = { ...completedRow, envelope_status: 'completed' };
		const result = await new D1RecipientApproveStore(
			fakeD1([completedEnvelopeRow, storedRow(), completedEnvelopeRow]).database
		).prepareApproved(command, '2026-09-11T00:06:00.000Z');
		expect(result).toMatchObject({
			outcome: 'replayed',
			result: { envelopeStatus: 'in_progress' }
		});
	});

	it('re-reads terminal state before accepting a replay after a concurrent publication', async () => {
		const result = await new D1RecipientApproveStore(
			fakeD1([eligibleRow, storedRow(), completedRow]).database
		).prepareApproved(command, command.updatedAt);
		expect(result).toMatchObject({ outcome: 'replayed' });
	});

	it('fails closed when durable replay evidence does not match the command', async () => {
		const result = await new D1RecipientApproveStore(
			fakeD1([completedRow, storedRow({ evidence_event_type: 'recipient.viewed' })]).database
		).prepareApproved(command, command.updatedAt);
		expect(result).toEqual({ outcome: 'integrity_error' });
	});

	it('recomputes the audit hash before accepting terminal replay evidence', async () => {
		const result = await new D1RecipientApproveStore(
			fakeD1([
				completedRow,
				storedRow({ audit_event_hash: 'tampered', evidence_event_hash: 'tampered' })
			]).database
		).prepareApproved(command, command.updatedAt);
		expect(result).toEqual({ outcome: 'integrity_error' });
	});

	it('reports idempotency_conflict when the same key is reused for a different request', async () => {
		const result = await new D1RecipientApproveStore(
			fakeD1([completedRow, storedRow({ request_hash: 'other-fingerprint' })]).database
		).prepareApproved(command, command.updatedAt);
		expect(result).toEqual({ outcome: 'idempotency_conflict' });
	});

	it('replays the stored receipt for the same recipient under a different idempotency key', async () => {
		const differentKey = { ...command, idempotencyKey: 'approved-from-another-tab' };
		const result = await new D1RecipientApproveStore(
			fakeD1([completedRow, null, storedRow(), completedRow]).database
		).prepareApproved(differentKey, '2026-09-11T00:05:00.000Z');
		expect(result).toMatchObject({
			outcome: 'replayed',
			result: { recipientId: command.expectedRecipientId, envelopeStatus: 'in_progress' }
		});
	});

	it('fails closed when a replay receipt exists without the published completed state', async () => {
		const result = await new D1RecipientApproveStore(
			fakeD1([eligibleRow, storedRow(), eligibleRow]).database
		).prepareApproved(command, command.updatedAt);
		expect(result).toEqual({ outcome: 'integrity_error' });
	});

	it('treats completed state without its durable command as an integrity error', async () => {
		const result = await new D1RecipientApproveStore(
			fakeD1([completedRow, null, null]).database
		).prepareApproved(command, command.updatedAt);
		expect(result).toEqual({ outcome: 'integrity_error' });
	});

	it('classifies a lost write as replayed from durable state without parsing the provider error', async () => {
		const fake = fakeD1(
			[eligibleRow, completedRow, storedRow(), completedRow],
			[],
			new Error('UNIQUE constraint failed: recipient_approved_command')
		);
		const result = await new D1RecipientApproveStore(fake.database).publishApproved(command);
		expect(result).toMatchObject({
			outcome: 'replayed',
			result: { auditEventId: command.auditEventId }
		});
	});

	it('rethrows unclassified failures without inspecting provider error strings', async () => {
		const error: Error = new Error('UNIQUE constraint failed: recipient_approved_command');
		const fake = fakeD1(
			[eligibleRow, eligibleRow, null, null, { sequence: 4, event_hash: 'hash-4' }],
			[siblingRows],
			error
		);
		await expect(new D1RecipientApproveStore(fake.database).publishApproved(command)).rejects.toBe(
			error
		);
	});
});
