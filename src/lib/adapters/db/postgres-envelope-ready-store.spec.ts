import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PublishReadyEnvelopeCommand } from '$lib/ports/envelope-ready-store';
import { PostgresEnvelopeReadyStore } from './postgres-envelope-ready-store';

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
			expectedGeneration: command.expectedGeneration,
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
	generation: command.expectedGeneration,
	recipients: command.recipients.map((recipient) => ({
		id: recipient.id,
		role: recipient.role,
		routingOrder: recipient.routingOrder
	}))
});

describe('PostgresEnvelopeReadyStore', () => {
	it('locks and atomically publishes status, command, recipients, and audit event', async () => {
		const database = new ScriptedPostgres([
			[],
			[{ status: 'draft', repositoryGeneration: 1, repositoryHead: command.expectedCommitSha }],
			[],
			[{ sequence: 2, eventHash: command.previousAuditHash }],
			[{ id: command.envelopeId }],
			[],
			[],
			[],
			[]
		]);
		const result = await new PostgresEnvelopeReadyStore(database.client()).publishReady(command);
		expect(result).toMatchObject({ outcome: 'published', result: { status: 'ready' } });
		expect(database.beginCalls).toBe(1);
		expect(database.transactionQueries.map((query) => query.text)).toEqual([
			expect.stringContaining('FOR UPDATE'),
			expect.stringContaining('FROM envelope_ready_command'),
			expect.stringContaining('FROM audit_event'),
			expect.stringContaining("UPDATE envelope SET status = 'ready'"),
			expect.stringContaining('INSERT INTO envelope_ready_command'),
			expect.stringContaining('DELETE FROM recipient'),
			expect.stringContaining('INSERT INTO recipient'),
			expect.stringContaining('INSERT INTO audit_event')
		]);
	});

	it('rechecks idempotency after taking the envelope lock', async () => {
		const replayRow = {
			envelopeId: command.envelopeId,
			actorType: command.actorType,
			actorId: command.actorId,
			requestHash: command.requestFingerprint,
			expectedGeneration: 1,
			commitSha: command.expectedCommitSha,
			recipientsJson: JSON.stringify(command.recipients),
			recipientCount: 1,
			updatedAt: command.updatedAt,
			auditEventId: command.auditEventId,
			auditSequence: 3,
			previousAuditHash: command.previousAuditHash,
			auditEventHash: command.auditEventHash,
			auditPayloadJson: command.auditPayloadJson,
			evidenceEventId: command.auditEventId,
			evidenceEnvelopeId: command.envelopeId,
			evidenceSequence: 3,
			evidenceEventType: 'envelope.ready',
			evidenceActorType: 'user',
			evidenceActorId: command.actorId,
			evidencePayloadJson: command.auditPayloadJson,
			evidencePreviousHash: command.previousAuditHash,
			evidenceEventHash: command.auditEventHash,
			evidenceOccurredAt: command.updatedAt
		};
		const database = new ScriptedPostgres([
			[],
			[{ status: 'draft', repositoryGeneration: 1, repositoryHead: command.expectedCommitSha }],
			[replayRow]
		]);
		const result = await new PostgresEnvelopeReadyStore(database.client()).publishReady(command);
		expect(result).toMatchObject({
			outcome: 'replayed',
			result: { auditEventId: command.auditEventId }
		});
		expect(database.transactionQueries).toHaveLength(2);
	});
});
