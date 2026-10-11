import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	AuthoringFieldsIntegrityError,
	type PublishFieldPlacementCommand
} from '$lib/ports/envelope-field-store';
import { PostgresEnvelopeFieldStore } from './postgres-envelope-field-store';

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

describe('PostgresEnvelopeFieldStore', () => {
	it('locks the envelope and referenced recipients in order before replacing the field set', async () => {
		const database = new ScriptedPostgres([
			[],
			[
				{
					status: 'ready',
					repositoryGeneration: 1,
					repositoryHead: command.expectedCommitSha,
					fieldGeneration: 0
				}
			],
			[],
			[{ sequence: 2, eventHash: command.previousAuditHash }],
			[{ id: command.fields[0].recipientId, role: 'signer' }],
			[{ id: command.envelopeId }],
			[],
			[],
			[],
			[]
		]);
		const result = await new PostgresEnvelopeFieldStore(database.client()).publishFieldPlacement(
			command
		);
		expect(result).toMatchObject({ outcome: 'published', result: { fieldGeneration: 1 } });
		expect(database.beginCalls).toBe(1);
		expect(database.transactionQueries.map((query) => query.text)).toEqual([
			expect.stringContaining('FOR UPDATE'),
			expect.stringContaining('FROM envelope_field_placement_command'),
			expect.stringContaining('FROM audit_event'),
			expect.stringMatching(/FROM recipient[\s\S]*FOR UPDATE/),
			expect.stringContaining('UPDATE envelope'),
			expect.stringContaining('DELETE FROM envelope_field'),
			expect.stringContaining('INSERT INTO envelope_field'),
			expect.stringContaining('INSERT INTO envelope_field_placement_command'),
			expect.stringContaining('INSERT INTO audit_event')
		]);
		expect(result).toMatchObject({
			outcome: 'published',
			result: { fields: [{ id: command.fields[0].id }] }
		});
		expect(JSON.stringify(result)).not.toContain('Signature');
	});

	it('fails closed when a referenced recipient is not a signer', async () => {
		const database = new ScriptedPostgres([
			[],
			[
				{
					status: 'ready',
					repositoryGeneration: 1,
					repositoryHead: command.expectedCommitSha,
					fieldGeneration: 0
				}
			],
			[],
			[{ sequence: 2, eventHash: command.previousAuditHash }],
			[{ id: command.fields[0].recipientId, role: 'viewer' }]
		]);
		const result = await new PostgresEnvelopeFieldStore(database.client()).publishFieldPlacement(
			command
		);
		expect(result).toEqual({ outcome: 'invalid_recipient' });
	});

	it('rechecks idempotency after taking the envelope lock', async () => {
		const replayRow = {
			envelopeId: command.envelopeId,
			actorType: command.actorType,
			actorId: command.actorId,
			requestHash: command.requestFingerprint,
			expectedGeneration: command.expectedGeneration,
			expectedFieldGeneration: command.expectedFieldGeneration,
			commitSha: command.expectedCommitSha,
			fieldsJson: JSON.stringify(command.fields),
			fieldCount: 1,
			updatedAt: command.updatedAt,
			auditEventId: command.auditEventId,
			auditSequence: 3,
			previousAuditHash: command.previousAuditHash,
			auditEventHash: command.auditEventHash,
			auditPayloadJson: command.auditPayloadJson,
			evidenceEventId: command.auditEventId,
			evidenceEnvelopeId: command.envelopeId,
			evidenceSequence: 3,
			evidenceEventType: 'envelope.fields_placed',
			evidenceActorType: 'user',
			evidenceActorId: command.actorId,
			evidencePayloadJson: command.auditPayloadJson,
			evidencePreviousHash: command.previousAuditHash,
			evidenceEventHash: command.auditEventHash,
			evidenceOccurredAt: command.updatedAt
		};
		const database = new ScriptedPostgres([
			[],
			[
				{
					status: 'ready',
					repositoryGeneration: 1,
					repositoryHead: command.expectedCommitSha,
					fieldGeneration: 0
				}
			],
			[replayRow]
		]);
		const result = await new PostgresEnvelopeFieldStore(database.client()).publishFieldPlacement(
			command
		);
		expect(result).toMatchObject({
			outcome: 'replayed',
			result: { auditEventId: command.auditEventId }
		});
		expect(database.transactionQueries).toHaveLength(2);
	});

	it('reads authoring fields from a single envelope LEFT JOIN snapshot', async () => {
		const database = new ScriptedPostgres([
			[
				{
					repositoryGeneration: 2,
					fieldGeneration: 3,
					repositoryHead: command.expectedCommitSha,
					id: command.fields[0].id,
					recipientId: command.fields[0].recipientId,
					documentId: command.fields[0].documentId,
					documentPath: null,
					fieldType: 'signature',
					label: 'Signature',
					required: true,
					position: 1,
					page: null,
					x: null,
					y: null,
					width: null,
					height: null
				}
			]
		]);
		const snapshot = await new PostgresEnvelopeFieldStore(database.client()).readAuthoringFields(
			command.envelopeId
		);
		expect(snapshot).toMatchObject({
			generation: 2,
			fieldGeneration: 3,
			fields: [{ label: 'Signature', geometry: null }]
		});
		expect(database.directQueries[0]?.text).toContain('LEFT JOIN envelope_field');
	});

	it('returns an empty field set from the LEFT JOIN sentinel at the current fieldGeneration', async () => {
		const database = new ScriptedPostgres([
			[
				{
					repositoryGeneration: 1,
					fieldGeneration: 4,
					repositoryHead: command.expectedCommitSha,
					id: null,
					recipientId: null,
					documentId: null,
					documentPath: null,
					fieldType: null,
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
			new PostgresEnvelopeFieldStore(database.client()).readAuthoringFields(command.envelopeId)
		).resolves.toEqual({
			envelopeId: command.envelopeId,
			generation: 1,
			fieldGeneration: 4,
			commitSha: command.expectedCommitSha,
			fields: []
		});
	});

	it('rejects invalid field types and partial geometry instead of returning a subset', async () => {
		const invalid = new ScriptedPostgres([
			[
				{
					repositoryGeneration: 1,
					fieldGeneration: 1,
					repositoryHead: command.expectedCommitSha,
					id: command.fields[0].id,
					recipientId: command.fields[0].recipientId,
					documentId: command.fields[0].documentId,
					documentPath: null,
					fieldType: 'stamp',
					label: 'Signature',
					required: true,
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
			new PostgresEnvelopeFieldStore(invalid.client()).readAuthoringFields(command.envelopeId)
		).rejects.toBeInstanceOf(AuthoringFieldsIntegrityError);

		const emptyLabel = new ScriptedPostgres([
			[
				{
					repositoryGeneration: 1,
					fieldGeneration: 1,
					repositoryHead: command.expectedCommitSha,
					id: command.fields[0].id,
					recipientId: command.fields[0].recipientId,
					documentId: command.fields[0].documentId,
					documentPath: null,
					fieldType: 'signature',
					label: '',
					required: true,
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
			new PostgresEnvelopeFieldStore(emptyLabel.client()).readAuthoringFields(command.envelopeId)
		).rejects.toBeInstanceOf(AuthoringFieldsIntegrityError);
	});
});
