import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PublishReadyEnvelopeCommand } from '$lib/ports/envelope-ready-store';
import { D1EnvelopeReadyStore } from './d1-envelope-ready-store';

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

const command: PublishReadyEnvelopeCommand = {
	envelopeId: '01910000-0000-7000-8000-000000000001',
	actorType: 'user',
	actorId: 'user-1',
	idempotencyKey: 'ready-1',
	requestFingerprint: 'a'.repeat(64),
	expectedGeneration: 1,
	expectedCommitSha: '0123456789abcdef0123456789abcdef01234567',
	recipients: [
		{
			id: '01910000-0000-7000-8000-000000000002',
			envelopeId: '01910000-0000-7000-8000-000000000001',
			email: 'a@example.com',
			name: 'Alice',
			role: 'signer',
			locale: 'en',
			routingOrder: 1,
			status: 'pending'
		}
	],
	updatedAt: '2026-09-11T00:02:00.000Z',
	expectedAuditSequence: 2,
	previousAuditHash: 'b'.repeat(64),
	auditEventId: '01910000-0000-7000-8000-000000000003',
	auditEventHash: 'c'.repeat(64),
	auditPayloadJson: '{"generation":1}'
};
command.requestFingerprint = createHash('sha256')
	.update(
		JSON.stringify({
			expectedGeneration: 1,
			recipients: command.recipients.map((recipient) => ({
				email: recipient.email,
				name: recipient.name,
				role: recipient.role,
				locale: recipient.locale,
				routingOrder: recipient.routingOrder
			}))
		})
	)
	.digest('hex');
command.auditPayloadJson = JSON.stringify({
	commitSha: command.expectedCommitSha,
	generation: 1,
	recipients: command.recipients.map((recipient) => ({
		id: recipient.id,
		role: recipient.role,
		routingOrder: recipient.routingOrder
	}))
});

function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		envelope_id: command.envelopeId,
		actor_type: command.actorType,
		actor_id: command.actorId,
		request_hash: command.requestFingerprint,
		expected_generation: 1,
		commit_sha: command.expectedCommitSha,
		recipients_json: JSON.stringify(command.recipients),
		recipient_count: 1,
		updated_at: command.updatedAt,
		audit_event_id: command.auditEventId,
		audit_sequence: 3,
		previous_audit_hash: command.previousAuditHash,
		audit_event_hash: command.auditEventHash,
		audit_payload_json: command.auditPayloadJson,
		evidence_event_id: command.auditEventId,
		evidence_envelope_id: command.envelopeId,
		evidence_sequence: 3,
		evidence_event_type: 'envelope.ready',
		evidence_actor_type: 'user',
		evidence_actor_id: command.actorId,
		evidence_payload_json: command.auditPayloadJson,
		evidence_previous_hash: command.previousAuditHash,
		evidence_event_hash: command.auditEventHash,
		evidence_occurred_at: command.updatedAt,
		...overrides
	};
}

describe('D1EnvelopeReadyStore', () => {
	it('prepares only a non-empty draft at the expected generation', async () => {
		const fake = fakeD1([
			null,
			{
				id: command.envelopeId,
				title: 'Agreement',
				status: 'draft',
				repository_generation: 1,
				repository_head: command.expectedCommitSha,
				repository_archive_key: 'internal',
				repository_archive_sha256: 'd'.repeat(64),
				sent_commit_sha: null,
				created_at: command.updatedAt,
				updated_at: command.updatedAt
			},
			{ sequence: 2, event_hash: command.previousAuditHash }
		]);
		const result = await new D1EnvelopeReadyStore(fake.database).prepareReady(command, 1);
		expect(result).toMatchObject({
			outcome: 'ready',
			envelope: { repositoryHead: command.expectedCommitSha },
			auditHead: { sequence: 2, eventHash: command.previousAuditHash }
		});
		expect(fake.prepared[0].bindings).toEqual([
			command.actorType,
			command.actorId,
			command.idempotencyKey
		]);
	});

	it('publishes command, projection replacement, and every recipient in one D1 batch', async () => {
		const fake = fakeD1([null]);
		const result = await new D1EnvelopeReadyStore(fake.database).publishReady(command);
		expect(result).toMatchObject({ outcome: 'published', result: { status: 'ready' } });
		expect(fake.batches).toHaveLength(1);
		expect(fake.batches[0].map((item) => item.sql)).toEqual([
			expect.stringContaining('INSERT INTO envelope_ready_command'),
			expect.stringContaining('DELETE FROM recipient'),
			expect.stringContaining('INSERT INTO recipient')
		]);
		expect(fake.batches[0][2].bindings).toEqual([
			command.recipients[0].id,
			command.recipients[0].envelopeId,
			command.recipients[0].email,
			command.recipients[0].name,
			command.recipients[0].role,
			command.recipients[0].locale,
			command.recipients[0].routingOrder,
			command.recipients[0].status,
			command.updatedAt,
			command.updatedAt
		]);
		const recipientSql = fake.batches[0][2].sql;
		const placeholderCount = (recipientSql.match(/\?/g) || []).length;
		expect(placeholderCount).toBe(fake.batches[0][2].bindings.length);
	});

	it('fails closed when durable replay evidence does not match the command', async () => {
		const fake = fakeD1([storedRow({ evidence_event_type: 'wrong.type' })]);
		await expect(new D1EnvelopeReadyStore(fake.database).prepareReady(command, 1)).resolves.toEqual(
			{
				outcome: 'integrity_error'
			}
		);
	});

	it('replays only when the stored receipt still matches its fingerprint and audit payload', async () => {
		const replay = new D1EnvelopeReadyStore(fakeD1([storedRow()]).database);
		await expect(replay.prepareReady(command, 1)).resolves.toMatchObject({
			outcome: 'replayed',
			result: { envelopeId: command.envelopeId, recipients: command.recipients }
		});

		const changedRecipientsJson: string = JSON.stringify([
			{ ...command.recipients[0], name: 'Mallory' }
		]);
		const tampered = new D1EnvelopeReadyStore(
			fakeD1([storedRow({ recipients_json: changedRecipientsJson })]).database
		);
		await expect(tampered.prepareReady(command, 1)).resolves.toEqual({
			outcome: 'integrity_error'
		});
	});
});
