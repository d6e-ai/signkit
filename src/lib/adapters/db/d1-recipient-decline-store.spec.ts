import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PublishRecipientDeclinedCommand } from '$lib/ports/recipient-decline-store';
import { D1RecipientDeclineStore } from './d1-recipient-decline-store';

interface RecordedStatement {
	sql: string;
	bindings: readonly unknown[];
	statement: D1PreparedStatement;
}

function fakeD1(firstResults: readonly unknown[], batchError?: Error) {
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
		if (batchError !== undefined) throw batchError;
		return [];
	});
	return { database: { prepare, batch } as unknown as D1Database, prepared, batches };
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
	auditPayloadJson: '',
	revocationEvidenceVersion: 2,
	revokedRecipientIds: ['recipient-2']
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
	declinedAt: command.updatedAt,
	revokedCapabilities: {
		reason: 'envelope_declined',
		recipientIds: command.revokedRecipientIds
	}
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
		audit_event_id: command.auditEventId,
		audit_sequence: command.expectedAuditSequence + 1,
		previous_audit_hash: command.previousAuditHash,
		audit_event_hash: command.auditEventHash,
		audit_payload_json: command.auditPayloadJson,
		revocation_evidence_version: command.revocationEvidenceVersion,
		revoked_recipient_ids_json: JSON.stringify(command.revokedRecipientIds),
		revoked_recipient_count: command.revokedRecipientIds.length,
		projection_revoked_recipient_ids_json: JSON.stringify(command.revokedRecipientIds),
		projection_has_revocable_recipient: 0,
		projection_has_unsafe_delivery: 0,
		evidence_event_id: command.auditEventId,
		evidence_organization_id: 'org-1',
		evidence_envelope_id: command.expectedEnvelopeId,
		evidence_sequence: command.expectedAuditSequence + 1,
		evidence_event_type: 'recipient.declined',
		evidence_actor_type: 'recipient',
		evidence_actor_id: command.expectedRecipientId,
		evidence_payload_json: command.auditPayloadJson,
		evidence_previous_hash: command.previousAuditHash,
		evidence_event_hash: command.auditEventHash,
		evidence_occurred_at: command.updatedAt,
		...overrides
	};
}

const eligibleRow = {
	organization_id: 'org-1',
	envelope_id: 'env-1',
	recipient_id: 'recipient-1',
	recipient_role: 'signer',
	recipient_status: 'pending',
	recipient_capability_hash: command.capabilityHash,
	recipient_capability_expires_at: '2026-09-25T00:00:00.000Z',
	recipient_capability_revoked_at: null,
	routing_order: 1,
	envelope_status: 'sent',
	envelope_sent_commit_sha: 'commit-3',
	envelope_repository_head: 'commit-3',
	delivery_in_flight: 0,
	revoked_recipient_ids_json: JSON.stringify(command.revokedRecipientIds)
};

const declinedRow = {
	...eligibleRow,
	recipient_status: 'declined',
	recipient_capability_revoked_at: command.updatedAt,
	envelope_status: 'declined'
};

describe('D1RecipientDeclineStore', () => {
	it('resolves identity only by capability hash and prepares a live pending signer', async () => {
		const fake = fakeD1([eligibleRow, null, null, { sequence: 3, event_hash: 'hash-3' }]);
		const result = await new D1RecipientDeclineStore(fake.database).prepareDeclined(
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
			revokedRecipientIds: command.revokedRecipientIds,
			auditHead: { sequence: 3, eventHash: 'hash-3' }
		});
		expect(fake.prepared[0].sql).toContain('recipient.capability_hash = ?');
		expect(fake.prepared[0].sql).not.toContain('recipient.envelope_id = ?');
		expect(fake.prepared[0].bindings).toEqual([command.capabilityHash]);
	});

	it('fences a live delivery lease before preparing audit publication', async () => {
		const row = { ...eligibleRow, delivery_in_flight: 1 };
		const fake = fakeD1([row, null, null]);
		await expect(
			new D1RecipientDeclineStore(fake.database).prepareDeclined(command, command.updatedAt)
		).resolves.toEqual({ outcome: 'delivery_in_flight' });
		expect(fake.prepared.some((statement) => statement.sql.includes('FROM audit_event'))).toBe(
			false
		);
	});

	it('returns context_mismatch for a stale body without writing', async () => {
		const stale = {
			...command,
			expectedEnvelopeId: 'env-stale',
			expectedRecipientId: 'recipient-stale'
		};
		await expect(
			new D1RecipientDeclineStore(fakeD1([eligibleRow]).database).prepareDeclined(
				stale,
				command.updatedAt
			)
		).resolves.toEqual({ outcome: 'context_mismatch' });
		const publishFake = fakeD1([eligibleRow]);
		await expect(
			new D1RecipientDeclineStore(publishFake.database).publishDeclined(stale)
		).resolves.toEqual({ outcome: 'context_mismatch' });
		expect(publishFake.batches).toHaveLength(0);
		expect(publishFake.prepared[0].bindings).toEqual([command.capabilityHash]);
	});

	it('returns role_not_actionable for viewer and prefill without writing', async () => {
		for (const role of ['viewer', 'prefill'] as const) {
			const row = { ...eligibleRow, recipient_role: role };
			await expect(
				new D1RecipientDeclineStore(fakeD1([row]).database).prepareDeclined(
					command,
					command.updatedAt
				)
			).resolves.toEqual({ outcome: 'role_not_actionable' });
			const publishFake = fakeD1([row]);
			await expect(
				new D1RecipientDeclineStore(publishFake.database).publishDeclined(command)
			).resolves.toEqual({ outcome: 'role_not_actionable' });
			expect(publishFake.batches).toHaveLength(0);
		}
	});

	it('denies as not_found when the capability is revoked, expired, or swapped', async () => {
		await expect(
			new D1RecipientDeclineStore(fakeD1([eligibleRow, null, null]).database).prepareDeclined(
				command,
				'2026-09-30T00:00:00.000Z'
			)
		).resolves.toEqual({ outcome: 'not_found' });

		await expect(
			new D1RecipientDeclineStore(
				fakeD1([
					{ ...eligibleRow, recipient_capability_revoked_at: '2026-09-11T00:02:00.000Z' },
					null,
					null
				]).database
			).prepareDeclined(command, command.updatedAt)
		).resolves.toEqual({ outcome: 'not_found' });

		await expect(
			new D1RecipientDeclineStore(fakeD1([null]).database).prepareDeclined(
				command,
				command.updatedAt
			)
		).resolves.toEqual({ outcome: 'not_found' });
	});

	it('publishes a single-statement command insert after the capability-hash identity read', async () => {
		const fake = fakeD1([eligibleRow]);
		const result = await new D1RecipientDeclineStore(fake.database).publishDeclined(command);
		expect(result).toMatchObject({
			outcome: 'published',
			result: { recipientId: command.expectedRecipientId, envelopeStatus: 'declined' }
		});
		expect(fake.batches).toHaveLength(1);
		expect(fake.batches[0].map((item) => item.sql)).toEqual([
			expect.stringContaining('INSERT INTO recipient_declined_command')
		]);
		expect(fake.batches[0][0].sql).not.toContain('delivery_outbox');
		expect(fake.prepared[0].bindings).toEqual([command.capabilityHash]);
		expect(fake.batches[0][0].bindings).toContain(command.capabilityHash);
		expect(fake.prepared).toHaveLength(2);
	});

	it('preserves an unexplained D1 failure when the post-failure state is still ready', async () => {
		const failure = new Error('opaque D1 batch failure');
		const fake = fakeD1(
			[eligibleRow, eligibleRow, null, null, { sequence: 3, event_hash: 'hash-3' }],
			failure
		);
		await expect(new D1RecipientDeclineStore(fake.database).publishDeclined(command)).rejects.toBe(
			failure
		);
	});

	it('replays a lost successful response after the actor is declined and revoked', async () => {
		const result = await new D1RecipientDeclineStore(
			fakeD1([declinedRow, storedRow(), declinedRow]).database
		).prepareDeclined(command, '2026-09-11T00:04:00.000Z');
		expect(result).toMatchObject({
			outcome: 'replayed',
			result: { recipientId: command.expectedRecipientId, envelopeStatus: 'declined' }
		});
	});

	it('re-reads terminal state before accepting a replay after a concurrent publication', async () => {
		const result = await new D1RecipientDeclineStore(
			fakeD1([eligibleRow, storedRow(), declinedRow]).database
		).prepareDeclined(command, command.updatedAt);
		expect(result).toMatchObject({ outcome: 'replayed' });
	});

	it('fails closed when durable replay evidence does not match the command', async () => {
		const result = await new D1RecipientDeclineStore(
			fakeD1([declinedRow, storedRow({ evidence_event_type: 'recipient.viewed' })]).database
		).prepareDeclined(command, command.updatedAt);
		expect(result).toEqual({ outcome: 'integrity_error' });
	});

	it('fails closed when a v2 terminal projection regains capability or delivery authority', async () => {
		for (const override of [
			{ projection_has_revocable_recipient: 1 },
			{ projection_has_unsafe_delivery: 1 },
			{ projection_revoked_recipient_ids_json: '[]' }
		]) {
			const result = await new D1RecipientDeclineStore(
				fakeD1([declinedRow, storedRow(override)]).database
			).prepareDeclined(command, command.updatedAt);
			expect(result).toEqual({ outcome: 'integrity_error' });
		}
	});

	it('recomputes the audit hash before accepting terminal replay evidence', async () => {
		const result = await new D1RecipientDeclineStore(
			fakeD1([
				declinedRow,
				storedRow({ audit_event_hash: 'tampered', evidence_event_hash: 'tampered' })
			]).database
		).prepareDeclined(command, command.updatedAt);
		expect(result).toEqual({ outcome: 'integrity_error' });
	});

	it('reports idempotency_conflict when the same key is reused for a different request', async () => {
		const result = await new D1RecipientDeclineStore(
			fakeD1([declinedRow, storedRow({ request_hash: 'other-fingerprint' })]).database
		).prepareDeclined(command, command.updatedAt);
		expect(result).toEqual({ outcome: 'idempotency_conflict' });
	});

	it('does not disclose the stored receipt under a different idempotency key', async () => {
		const differentKey = { ...command, idempotencyKey: 'declined-from-another-tab' };
		const result = await new D1RecipientDeclineStore(
			fakeD1([declinedRow, null, storedRow(), declinedRow]).database
		).prepareDeclined(differentKey, '2026-09-11T00:04:00.000Z');
		expect(result).toEqual({ outcome: 'not_found' });
	});

	it('fails closed when a replay receipt exists without the published declined state', async () => {
		const result = await new D1RecipientDeclineStore(
			fakeD1([eligibleRow, storedRow(), eligibleRow]).database
		).prepareDeclined(command, command.updatedAt);
		expect(result).toEqual({ outcome: 'integrity_error' });
	});

	it('treats declined state without its durable command as an integrity error', async () => {
		const result = await new D1RecipientDeclineStore(
			fakeD1([declinedRow, null, null]).database
		).prepareDeclined(command, command.updatedAt);
		expect(result).toEqual({ outcome: 'integrity_error' });
	});
});
