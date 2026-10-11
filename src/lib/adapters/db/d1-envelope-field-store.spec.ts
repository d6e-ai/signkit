import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
	AuthoringFieldsIntegrityError,
	type PublishFieldPlacementCommand
} from '$lib/ports/envelope-field-store';
import { D1EnvelopeFieldStore } from './d1-envelope-field-store';

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
			first: async (): Promise<unknown | null> => results.shift() ?? null,
			all: async (): Promise<{ results: unknown[] }> => ({
				results: (results.shift() as unknown[] | undefined) ?? []
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
		return [];
	});
	return { database: { prepare, batch } as unknown as D1Database, prepared, batches };
}

const command: PublishFieldPlacementCommand = {
	envelopeId: '01910000-0000-7000-8000-000000000001',
	actorType: 'user',
	actorId: 'user-1',
	idempotencyKey: 'fields-1',
	requestFingerprint: 'a'.repeat(64),
	expectedGeneration: 1,
	expectedFieldGeneration: 0,
	expectedCommitSha: '0123456789abcdef0123456789abcdef01234567',
	fields: [
		{
			id: '01910000-0000-7000-8000-000000000010',
			envelopeId: '01910000-0000-7000-8000-000000000001',
			recipientId: '01910000-0000-7000-8000-000000000002',
			documentId: '01900000-0000-7000-8000-000000000021',
			documentPath: null,
			fieldType: 'signature',
			label: 'Signature',
			required: true,
			position: 1,
			geometry: null
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
			expectedGeneration: command.expectedGeneration,
			expectedFieldGeneration: command.expectedFieldGeneration,
			fields: command.fields.map((field) => ({
				recipientId: field.recipientId,
				documentId: field.documentId,
				fieldType: field.fieldType,
				label: field.label,
				required: field.required,
				position: field.position,
				geometry: field.geometry
			}))
		})
	)
	.digest('hex');
command.auditPayloadJson = JSON.stringify({
	commitSha: command.expectedCommitSha,
	generation: command.expectedGeneration,
	fieldGeneration: command.expectedFieldGeneration + 1,
	fields: command.fields.map((field) => ({
		id: field.id,
		recipientId: field.recipientId,
		documentId: field.documentId,
		documentPath: field.documentPath,
		fieldType: field.fieldType,
		required: field.required,
		position: field.position,
		geometry: field.geometry
	}))
});

function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		envelope_id: command.envelopeId,
		actor_type: command.actorType,
		actor_id: command.actorId,
		request_hash: command.requestFingerprint,
		expected_generation: command.expectedGeneration,
		expected_field_generation: command.expectedFieldGeneration,
		commit_sha: command.expectedCommitSha,
		fields_json: JSON.stringify(command.fields),
		field_count: 1,
		updated_at: command.updatedAt,
		audit_event_id: command.auditEventId,
		audit_sequence: 3,
		previous_audit_hash: command.previousAuditHash,
		audit_event_hash: command.auditEventHash,
		audit_payload_json: command.auditPayloadJson,
		evidence_event_id: command.auditEventId,
		evidence_envelope_id: command.envelopeId,
		evidence_sequence: 3,
		evidence_event_type: 'envelope.fields_placed',
		evidence_actor_type: 'user',
		evidence_actor_id: command.actorId,
		evidence_payload_json: command.auditPayloadJson,
		evidence_previous_hash: command.previousAuditHash,
		evidence_event_hash: command.auditEventHash,
		evidence_occurred_at: command.updatedAt,
		...overrides
	};
}

describe('D1EnvelopeFieldStore', () => {
	it('prepares only a ready envelope at the expected generation and field generation', async () => {
		const fake = fakeD1([
			null,
			{
				id: command.envelopeId,
				created_by_user_id: 'user-1',
				title: 'Agreement',
				status: 'ready',
				repository_generation: 1,
				repository_head: command.expectedCommitSha,
				repository_archive_key: 'internal',
				repository_archive_sha256: 'd'.repeat(64),
				sent_commit_sha: null,
				field_generation: 0,
				created_at: command.updatedAt,
				updated_at: command.updatedAt
			},
			{ sequence: 2, event_hash: command.previousAuditHash },
			[]
		]);
		const result = await new D1EnvelopeFieldStore(fake.database).prepareFieldPlacement(
			command,
			1,
			0
		);
		expect(result).toMatchObject({
			outcome: 'ready',
			envelope: { repositoryHead: command.expectedCommitSha },
			auditHead: { sequence: 2, eventHash: command.previousAuditHash }
		});
	});

	it('publishes the command, complete field replacement, in one D1 batch', async () => {
		const fake = fakeD1([null]);
		const result = await new D1EnvelopeFieldStore(fake.database).publishFieldPlacement(command);
		expect(result).toMatchObject({ outcome: 'published', result: { fieldGeneration: 1 } });
		expect(fake.batches).toHaveLength(1);
		expect(fake.batches[0].map((item) => item.sql)).toEqual([
			expect.stringContaining('INSERT INTO envelope_field_placement_command'),
			expect.stringContaining('DELETE FROM envelope_field'),
			expect.stringContaining('INSERT INTO envelope_field')
		]);
		expect(fake.batches[0][2].bindings).toContain(command.fields[0].id);
		expect(JSON.stringify(result)).not.toContain('Signature');
	});

	it('fails closed when durable replay evidence does not match the command', async () => {
		const fake = fakeD1([storedRow({ evidence_event_type: 'wrong.type' })]);
		await expect(
			new D1EnvelopeFieldStore(fake.database).prepareFieldPlacement(command, 1, 0)
		).resolves.toEqual({ outcome: 'integrity_error' });
	});

	it('replays only when the stored receipt still matches its fingerprint and audit payload', async () => {
		const replay = new D1EnvelopeFieldStore(fakeD1([storedRow()]).database);
		await expect(replay.prepareFieldPlacement(command, 1, 0)).resolves.toMatchObject({
			outcome: 'replayed',
			result: { envelopeId: command.envelopeId, fieldGeneration: 1 }
		});

		const tamperedFieldsJson: string = JSON.stringify([
			{ ...command.fields[0], label: 'Tampered' }
		]);
		const tampered = new D1EnvelopeFieldStore(
			fakeD1([storedRow({ fields_json: tamperedFieldsJson })]).database
		);
		await expect(tampered.prepareFieldPlacement(command, 1, 0)).resolves.toEqual({
			outcome: 'integrity_error'
		});
	});

	it('reads authoring fields from a single envelope LEFT JOIN snapshot', async () => {
		const fake = fakeD1([
			[
				{
					repository_generation: 2,
					field_generation: 3,
					repository_head: command.expectedCommitSha,
					id: command.fields[0].id,
					recipient_id: command.fields[0].recipientId,
					document_id: command.fields[0].documentId,
					document_path: null,
					field_type: 'signature',
					label: 'Signature',
					required: 1,
					position: 1,
					page: null,
					x: null,
					y: null,
					width: null,
					height: null
				}
			]
		]);
		const snapshot = await new D1EnvelopeFieldStore(fake.database).readAuthoringFields(
			command.envelopeId
		);
		expect(snapshot).toMatchObject({
			generation: 2,
			fieldGeneration: 3,
			commitSha: command.expectedCommitSha,
			fields: [{ id: command.fields[0].id, label: 'Signature', geometry: null }]
		});
		expect(fake.prepared).toHaveLength(1);
		expect(fake.prepared[0].sql).toContain('LEFT JOIN envelope_field');
	});

	it('returns an empty field set from the LEFT JOIN sentinel without borrowing a stale generation', async () => {
		const fake = fakeD1([
			[
				{
					repository_generation: 1,
					field_generation: 4,
					repository_head: command.expectedCommitSha,
					id: null,
					recipient_id: null,
					document_id: null,
					document_path: null,
					field_type: null,
					label: null,
					required: null,
					position: null,
					page: null,
					x: null,
					y: null,
					width: null,
					height: null
				}
			]
		]);
		await expect(
			new D1EnvelopeFieldStore(fake.database).readAuthoringFields(command.envelopeId)
		).resolves.toEqual({
			envelopeId: command.envelopeId,
			generation: 1,
			fieldGeneration: 4,
			commitSha: command.expectedCommitSha,
			fields: []
		});
	});

	it('rejects invalid field types, labels, and partial geometry instead of returning a subset', async () => {
		const invalidType = fakeD1([
			[
				{
					repository_generation: 1,
					field_generation: 1,
					repository_head: command.expectedCommitSha,
					id: command.fields[0].id,
					recipient_id: command.fields[0].recipientId,
					document_id: command.fields[0].documentId,
					document_path: null,
					field_type: 'stamp',
					label: 'Signature',
					required: 1,
					position: 1,
					page: null,
					x: null,
					y: null,
					width: null,
					height: null
				}
			]
		]);
		await expect(
			new D1EnvelopeFieldStore(invalidType.database).readAuthoringFields(command.envelopeId)
		).rejects.toBeInstanceOf(AuthoringFieldsIntegrityError);

		const partialGeometry = fakeD1([
			[
				{
					repository_generation: 1,
					field_generation: 1,
					repository_head: command.expectedCommitSha,
					id: command.fields[0].id,
					recipient_id: command.fields[0].recipientId,
					document_id: command.fields[0].documentId,
					document_path: null,
					field_type: 'signature',
					label: 'Signature',
					required: 1,
					position: 1,
					page: 1,
					x: null,
					y: 0.1,
					width: 0.2,
					height: 0.05
				}
			]
		]);
		await expect(
			new D1EnvelopeFieldStore(partialGeometry.database).readAuthoringFields(command.envelopeId)
		).rejects.toBeInstanceOf(AuthoringFieldsIntegrityError);

		const emptyLabel = fakeD1([
			[
				{
					repository_generation: 1,
					field_generation: 1,
					repository_head: command.expectedCommitSha,
					id: command.fields[0].id,
					recipient_id: command.fields[0].recipientId,
					document_id: command.fields[0].documentId,
					document_path: null,
					field_type: 'signature',
					label: '',
					required: 1,
					position: 1,
					page: null,
					x: null,
					y: null,
					width: null,
					height: null
				}
			]
		]);
		await expect(
			new D1EnvelopeFieldStore(emptyLabel.database).readAuthoringFields(command.envelopeId)
		).rejects.toBeInstanceOf(AuthoringFieldsIntegrityError);
	});
});
