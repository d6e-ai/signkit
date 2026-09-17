import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import type { PublishVoidedEnvelopeCommand } from '$lib/ports/envelope-void-store';
import { PostgresEnvelopeVoidStore } from './postgres-envelope-void-store';

interface RecordedQuery {
	text: string;
	values: readonly unknown[];
}

class ScriptedPostgres {
	readonly queries: RecordedQuery[] = [];
	readonly #results: readonly object[][];
	#resultIndex: number = 0;

	constructor(results: readonly (readonly object[])[]) {
		this.#results = results.map((result) => [...result]);
	}

	client(): ReturnType<typeof postgres> {
		const transaction = this.#tag();
		const client = this.#tag();
		Object.assign(client, {
			begin: async <T>(callback: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> =>
				callback(transaction)
		});
		return client;
	}

	#tag(): ReturnType<typeof postgres> {
		const query = async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
			this.queries.push({ text: strings.join('?').replaceAll(/\s+/g, ' ').trim(), values });
			const result: readonly object[] | undefined = this.#results[this.#resultIndex];
			this.#resultIndex += 1;
			if (result === undefined) throw new Error('Unexpected PostgreSQL query');
			return result;
		};
		return query as ReturnType<typeof postgres>;
	}
}

const command: PublishVoidedEnvelopeCommand = {
	envelopeId: 'env-1',
	actorType: 'user',
	actorId: 'user-1',
	idempotencyKey: 'void-1',
	requestFingerprint: 'request-hash',
	expectedStatus: 'sent',
	expectedGeneration: 3,
	repositoryHead: 'commit-3',
	sentCommitSha: 'commit-3',
	updatedAt: '2026-09-12T02:00:00.000Z',
	expectedAuditSequence: 8,
	previousAuditHash: 'hash-8',
	revokedRecipientIds: ['r1', 'r2'],
	auditEventId: 'audit-9',
	auditEventHash: 'hash-9',
	auditPayloadJson: '{}'
};

const envelopeRow = {
	status: 'sent',
	repositoryGeneration: 3,
	repositoryHead: 'commit-3',
	sentCommitSha: 'commit-3'
};

describe('PostgresEnvelopeVoidStore', () => {
	it('locks envelope, recipients, command evidence, deliveries, and audit head before mutation', async () => {
		const database = new ScriptedPostgres([
			[envelopeRow],
			[
				{ id: 'r1', status: 'pending', capabilityHash: 'h1', capabilityRevokedAt: null },
				{ id: 'r2', status: 'viewed', capabilityHash: 'h2', capabilityRevokedAt: null }
			],
			[],
			[
				{ id: 'd1', status: 'pending', retryable: true },
				{ id: 'd2', status: 'blocked', retryable: true }
			],
			[{ sequence: 8, eventHash: 'hash-8' }],
			[{ id: 'd1' }, { id: 'd2' }],
			[{ id: 'r1' }, { id: 'r2' }],
			[{ id: 'env-1' }],
			[],
			[]
		]);
		await expect(
			new PostgresEnvelopeVoidStore(database.client()).publishVoid(command)
		).resolves.toMatchObject({
			outcome: 'published',
			result: { status: 'voided', revokedCapabilityCount: 2 }
		});
		const texts: readonly string[] = database.queries.map((query) => query.text);
		expect(texts).toHaveLength(10);
		expect(texts[0]).toContain('FROM envelope');
		expect(texts[0]).toContain('FOR UPDATE');
		expect(texts[1]).toContain('FROM recipient');
		expect(texts[1]).toContain('ORDER BY id FOR UPDATE');
		expect(texts[2]).toContain('FROM envelope_void_command');
		expect(texts[3]).toContain('FROM delivery_outbox');
		expect(texts[3]).toContain('ORDER BY id FOR UPDATE');
		expect(texts[4]).toContain('FROM audit_event');
		expect(texts[4]).toContain('FOR UPDATE');
		expect(texts[5]).toContain('UPDATE delivery_outbox');
		expect(texts[6]).toContain('UPDATE recipient');
		expect(texts[7]).toContain("SET status = 'voided'");
		expect(texts[8]).toContain('INSERT INTO envelope_void_command');
		expect(texts[9]).toContain('INSERT INTO audit_event');
	});

	it('fences processing delivery before any terminal mutation', async () => {
		const database = new ScriptedPostgres([
			[envelopeRow],
			[
				{ id: 'r1', status: 'pending', capabilityHash: 'h1', capabilityRevokedAt: null },
				{ id: 'r2', status: 'viewed', capabilityHash: 'h2', capabilityRevokedAt: null }
			],
			[],
			[{ id: 'd1', status: 'processing', retryable: true }]
		]);
		await expect(
			new PostgresEnvelopeVoidStore(database.client()).publishVoid(command)
		).resolves.toEqual({
			outcome: 'delivery_in_flight'
		});
		expect(database.queries).toHaveLength(4);
		expect(database.queries.some((query) => query.text.startsWith('UPDATE'))).toBe(false);
	});
});
