import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PublishRecipientViewedCommand } from '$lib/ports/recipient-view-store';
import { D1RecipientViewStore } from './d1-recipient-view-store';

interface RecordedStatement {
	sql: string;
	bindings: readonly unknown[];
	statement: D1PreparedStatement;
}

function fakeD1(firstResults: readonly unknown[]) {
	const results: unknown[] = [...firstResults];
	const prepared: RecordedStatement[] = [];
	const batches: RecordedStatement[][] = [];
	const prepare = vi.fn((sql: string): D1PreparedStatement => {
		const record: RecordedStatement = { sql, bindings: [], statement: undefined as never };
		const statement = {
			bind: (...bindings: unknown[]): D1PreparedStatement => {
				record.bindings = bindings;
				return statement;
			},
			first: async (): Promise<unknown | null> => results.shift() ?? null
		} as unknown as D1PreparedStatement;
		record.statement = statement;
		prepared.push(record);
		return statement;
	});
	const batch = vi.fn(async (statements: D1PreparedStatement[]): Promise<unknown[]> => {
		batches.push(
			statements.map((statement) => prepared.find((item) => item.statement === statement)!)
		);
		return [];
	});
	return { database: { prepare, batch } as unknown as D1Database, prepared, batches };
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

function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		organization_id: command.organizationId,
		envelope_id: command.envelopeId,
		recipient_id: command.recipientId,
		recipient_role: command.recipientRole,
		routing_order: command.routingOrder,
		actor_type: 'recipient',
		actor_id: command.recipientId,
		idempotency_key: command.idempotencyKey,
		request_hash: command.requestFingerprint,
		capability_hash: command.capabilityHash,
		sent_commit_sha: command.expectedSentCommitSha,
		updated_at: command.updatedAt,
		audit_event_id: command.auditEventId,
		audit_sequence: command.expectedAuditSequence + 1,
		previous_audit_hash: command.previousAuditHash,
		audit_event_hash: command.auditEventHash,
		audit_payload_json: command.auditPayloadJson,
		evidence_event_id: command.auditEventId,
		evidence_organization_id: command.organizationId,
		evidence_envelope_id: command.envelopeId,
		evidence_sequence: command.expectedAuditSequence + 1,
		evidence_event_type: 'recipient.viewed',
		evidence_actor_type: 'recipient',
		evidence_actor_id: command.recipientId,
		evidence_payload_json: command.auditPayloadJson,
		evidence_previous_hash: command.previousAuditHash,
		evidence_event_hash: command.auditEventHash,
		evidence_occurred_at: command.updatedAt,
		...overrides
	};
}

const eligibleRow = {
	recipient_role: 'signer',
	recipient_status: 'pending',
	recipient_capability_hash: command.capabilityHash,
	recipient_capability_expires_at: '2026-09-25T00:00:00.000Z',
	recipient_capability_revoked_at: null,
	routing_order: 1,
	envelope_status: 'sent',
	envelope_sent_commit_sha: 'commit-3',
	envelope_repository_head: 'commit-3'
};

const viewedRow = {
	...eligibleRow,
	recipient_status: 'viewed',
	envelope_status: 'in_progress'
};

describe('D1RecipientViewStore', () => {
	it('prepares only an eligible pending, non-cc, non-expired, non-revoked recipient', async () => {
		const fake = fakeD1([eligibleRow, null, null, { sequence: 3, event_hash: 'hash-3' }]);
		const result = await new D1RecipientViewStore(fake.database).prepareViewed(
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

	it('denies as not_found when the capability is revoked, expired, or swapped', async () => {
		const base = eligibleRow;
		const store = new D1RecipientViewStore(fakeD1([base]).database);
		await expect(store.prepareViewed(command, '2026-09-30T00:00:00.000Z')).resolves.toEqual({
			outcome: 'not_found'
		});

		const revoked = new D1RecipientViewStore(
			fakeD1([{ ...base, recipient_capability_revoked_at: '2026-09-11T00:01:30.000Z' }]).database
		);
		await expect(revoked.prepareViewed(command, '2026-09-11T00:02:00.000Z')).resolves.toEqual({
			outcome: 'not_found'
		});

		const swapped = new D1RecipientViewStore(
			fakeD1([{ ...base, recipient_capability_hash: 'wrong-hash' }]).database
		);
		await expect(swapped.prepareViewed(command, '2026-09-11T00:02:00.000Z')).resolves.toEqual({
			outcome: 'not_found'
		});
	});

	it('publishes a single-statement command insert', async () => {
		const fake = fakeD1([]);
		const result = await new D1RecipientViewStore(fake.database).publishViewed(command);
		expect(result).toMatchObject({
			outcome: 'published',
			result: { recipientId: command.recipientId, envelopeStatus: 'in_progress' }
		});
		expect(fake.batches).toHaveLength(1);
		expect(fake.batches[0].map((item) => item.sql)).toEqual([
			expect.stringContaining('INSERT INTO recipient_viewed_command')
		]);
		expect(fake.batches[0][0].bindings).toContain(command.capabilityHash);
		expect(fake.prepared).toHaveLength(1);
	});

	it('replays the stored receipt for the same recipient even under a different idempotency key', async () => {
		const differentKey = { ...command, idempotencyKey: 'viewed-from-another-tab' };
		const result = await new D1RecipientViewStore(
			fakeD1([viewedRow, null, storedRow()]).database
		).prepareViewed(differentKey, '2026-09-11T00:02:30.000Z');
		expect(result).toMatchObject({
			outcome: 'replayed',
			result: { recipientId: command.recipientId, envelopeStatus: 'in_progress' }
		});
	});

	it('scopes every replay lookup to the requesting recipient id, never another recipient', async () => {
		const otherRecipient = { ...command, recipientId: 'recipient-2', capabilityHash: 'cap-hash-2' };
		const fake = fakeD1([
			{ ...viewedRow, recipient_capability_hash: otherRecipient.capabilityHash },
			null,
			null
		]);
		await new D1RecipientViewStore(fake.database).prepareViewed(
			otherRecipient,
			'2026-09-11T00:02:30.000Z'
		);
		expect(fake.prepared[0].bindings).toEqual([
			otherRecipient.organizationId,
			otherRecipient.envelopeId,
			otherRecipient.recipientId
		]);
		expect(fake.prepared[1].bindings).toEqual([
			otherRecipient.organizationId,
			otherRecipient.recipientId,
			otherRecipient.idempotencyKey
		]);
		expect(fake.prepared[2].bindings).toEqual([
			otherRecipient.organizationId,
			otherRecipient.recipientId
		]);
	});

	it('denies replay as not_found when the stored capability hash was swapped', async () => {
		const result = await new D1RecipientViewStore(
			fakeD1([viewedRow, null, storedRow({ capability_hash: 'wrong-hash' })]).database
		).prepareViewed(command, '2026-09-11T00:02:30.000Z');
		expect(result).toEqual({ outcome: 'not_found' });
	});

	it('reports idempotency_conflict when the same key is reused for a different request', async () => {
		const result = await new D1RecipientViewStore(
			fakeD1([viewedRow, storedRow({ envelope_id: 'env-2' })]).database
		).prepareViewed(command, '2026-09-11T00:02:30.000Z');
		expect(result).toEqual({ outcome: 'idempotency_conflict' });
	});

	it('fails closed when durable replay evidence does not match the command', async () => {
		const result = await new D1RecipientViewStore(
			fakeD1([viewedRow, storedRow({ evidence_event_type: 'wrong.type' })]).database
		).prepareViewed(command, '2026-09-11T00:02:30.000Z');
		expect(result).toEqual({ outcome: 'integrity_error' });
	});

	it('fails closed when a replay receipt exists without the published recipient state', async () => {
		const result = await new D1RecipientViewStore(
			fakeD1([eligibleRow, storedRow()]).database
		).prepareViewed(command, '2026-09-11T00:02:30.000Z');
		expect(result).toEqual({ outcome: 'integrity_error' });
	});

	it('treats viewed state without its durable command as an integrity error', async () => {
		const result = await new D1RecipientViewStore(
			fakeD1([viewedRow, null, null]).database
		).prepareViewed(command, '2026-09-11T00:02:30.000Z');
		expect(result).toEqual({ outcome: 'integrity_error' });
	});
});
