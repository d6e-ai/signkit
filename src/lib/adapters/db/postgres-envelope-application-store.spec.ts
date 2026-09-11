import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import type { CreateEnvelopeCommand } from '$lib/application/envelopes/model';
import type { Envelope } from '$lib/domain/envelope';
import { PostgresEnvelopeApplicationStore } from './postgres-envelope-application-store';

describe('PostgresEnvelopeApplicationStore', () => {
	it('creates the organization projection, envelope, idempotency key, and audit event atomically', async () => {
		const database = new ScriptedPostgres([
			[{ id: command.organizationId }],
			[envelopeRow()],
			[{ requestHash: command.requestFingerprint, envelopeId: command.envelopeId }],
			[]
		]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		const result = await store.createIdempotently(command);

		expect(result).toEqual({ outcome: 'created', envelope });
		expect(database.beginCalls).toBe(1);
		expect(database.transactionQueries).toHaveLength(4);
		expect(database.transactionQueries[0].text).toContain('INSERT INTO organization');
		expect(database.transactionQueries[1].text).toContain('INSERT INTO envelope');
		expect(database.transactionQueries[2].text).toContain('INSERT INTO idempotency_key');
		expect(database.transactionQueries[3].text).toContain('INSERT INTO audit_event');
		expect(database.transactionQueries[3].values).toContain(command.auditEventId);
		expect(database.transactionQueries[3].values).toContain(command.auditEventHash);
	});

	it('returns the current envelope for a matching replay without adding another audit event', async () => {
		const database = new ScriptedPostgres([
			[{ id: command.organizationId }],
			[],
			[{ requestHash: command.requestFingerprint, envelopeId: command.envelopeId }],
			[envelopeRow()]
		]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		const result = await store.createIdempotently(command);

		expect(result).toEqual({ outcome: 'replayed', envelope });
		expect(database.beginCalls).toBe(1);
		expect(database.transactionQueries).toHaveLength(4);
		expect(database.transactionQueries.some((query) => query.text.includes('audit_event'))).toBe(
			false
		);
	});

	it('distinguishes an idempotency-key conflict from a replay', async () => {
		const database = new ScriptedPostgres([
			[{ id: command.organizationId }],
			[],
			[{ requestHash: 'different-request', envelopeId: command.envelopeId }]
		]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		const result = await store.createIdempotently(command);

		expect(result).toEqual({ outcome: 'conflict' });
		expect(database.beginCalls).toBe(1);
		expect(database.transactionQueries).toHaveLength(3);
	});

	it('uses an organization-scoped stable cursor and limit-plus-one pagination', async () => {
		const first = envelopeRow({ id: '00000000-0000-8000-a000-000000000003' });
		const second = envelopeRow({ id: '00000000-0000-8000-a000-000000000002' });
		const lookahead = envelopeRow({ id: '00000000-0000-8000-a000-000000000001' });
		const database = new ScriptedPostgres([[first, second, lookahead]]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		const page = await store.listForOrganization(command.organizationId, {
			cursor: first.id,
			limit: 2
		});

		expect(page.items.map((item) => item.id)).toEqual([first.id, second.id]);
		expect(page.nextCursor).toBe(second.id);
		expect(database.directQueries).toHaveLength(1);
		const query = database.directQueries[0];
		expect(query.text).toContain('cursor_envelope.organization_id');
		expect(query.text).toContain('ORDER BY e.created_at DESC, e.id DESC');
		expect(query.values.filter((value) => value === command.organizationId)).toHaveLength(2);
		expect(query.values.at(-1)).toBe(3);
	});

	it('rejects an unbounded limit before querying PostgreSQL', async () => {
		const database = new ScriptedPostgres([]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		await expect(
			store.listForOrganization(command.organizationId, { cursor: null, limit: 101 })
		).rejects.toThrow(/between 1 and 100/);
		expect(database.directQueries).toHaveLength(0);
	});
});

interface RecordedQuery {
	text: string;
	values: readonly unknown[];
}

type ScriptedResult = readonly object[];

class ScriptedPostgres {
	readonly directQueries: RecordedQuery[] = [];
	readonly transactionQueries: RecordedQuery[] = [];
	beginCalls = 0;
	private readonly results: ScriptedResult[];

	constructor(results: readonly ScriptedResult[]) {
		this.results = results.map((result) => [...result]);
	}

	client(): ReturnType<typeof postgres> {
		const direct = this.tag(this.directQueries);
		Object.assign(direct, {
			begin: async <T>(
				callback: (transaction: ReturnType<typeof postgres>) => Promise<T>
			): Promise<T> => {
				this.beginCalls += 1;
				return callback(this.tag(this.transactionQueries));
			}
		});
		return direct as ReturnType<typeof postgres>;
	}

	private tag(target: RecordedQuery[]): ReturnType<typeof postgres> {
		const query = async (
			strings: TemplateStringsArray,
			...values: readonly unknown[]
		): Promise<ScriptedResult> => {
			target.push({ text: normalizeSql(strings), values });
			const result = this.results.shift();
			if (!result) throw new Error('Unexpected PostgreSQL query');
			return result;
		};
		return query as ReturnType<typeof postgres>;
	}
}

const command: CreateEnvelopeCommand = {
	actor: { id: 'user_1', type: 'user' },
	auditEventHash: 'b'.repeat(64),
	auditEventId: '00000000-0000-8000-a000-000000000002',
	createdAt: '2026-09-11T00:00:00.000Z',
	envelopeId: '00000000-0000-8000-a000-000000000001',
	idempotencyKey: 'request-1',
	organizationId: 'org_1',
	organizationName: 'Workspace',
	requestFingerprint: 'a'.repeat(64),
	title: 'Agreement'
};

const envelope: Envelope = {
	id: command.envelopeId,
	organizationId: command.organizationId,
	title: command.title,
	status: 'draft',
	repositoryGeneration: 0,
	repositoryHead: null,
	repositoryArchiveKey: null,
	repositoryArchiveSha256: null,
	sentCommitSha: null,
	createdAt: command.createdAt,
	updatedAt: command.createdAt
};

function envelopeRow(overrides: Partial<Envelope> = {}): Envelope {
	return { ...envelope, ...overrides };
}

function normalizeSql(strings: TemplateStringsArray): string {
	return strings.join('?').replaceAll(/\s+/g, ' ').trim();
}
