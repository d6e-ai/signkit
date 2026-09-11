import { describe, expect, it, vi } from 'vitest';
import type { CreateEnvelopeCommand } from '$lib/application/envelopes/model';
import type { Envelope } from '$lib/domain/envelope';
import { D1EnvelopeApplicationStore } from './d1-envelope-application-store';

interface StatementRecord {
	sql: string;
	bindings: readonly unknown[];
	statement: D1PreparedStatement;
}

interface FakeD1 {
	batches: StatementRecord[][];
	database: D1Database;
	prepared: StatementRecord[];
	batch: ReturnType<typeof vi.fn>;
}

interface FakeD1Options {
	allResults?: readonly (readonly unknown[])[];
	batchError?: Error;
	firstResults?: readonly unknown[];
}

const command: CreateEnvelopeCommand = {
	actor: { id: 'user-1', type: 'user' },
	auditEventHash: 'audit-hash',
	auditEventId: '01900000-0000-7000-8000-000000000003',
	createdAt: '2026-09-11T00:00:00.000Z',
	envelopeId: '01900000-0000-7000-8000-000000000001',
	idempotencyKey: 'request-1',
	organizationId: '01900000-0000-7000-8000-000000000002',
	organizationName: 'Workspace',
	requestFingerprint: 'request-hash',
	title: 'Agreement'
};

function envelopeRow(
	id: string,
	updatedAt: string = command.createdAt,
	title: string = command.title
): Record<string, unknown> {
	return {
		id,
		organization_id: command.organizationId,
		title,
		status: 'draft',
		repository_generation: 0,
		repository_head: null,
		repository_archive_key: null,
		repository_archive_sha256: null,
		sent_commit_sha: null,
		created_at: command.createdAt,
		updated_at: updatedAt
	};
}

function createFakeD1(options: FakeD1Options = {}): FakeD1 {
	const firstResults: unknown[] = [...(options.firstResults ?? [])];
	const allResults: (readonly unknown[])[] = [...(options.allResults ?? [])];
	const prepared: StatementRecord[] = [];
	const batches: StatementRecord[][] = [];

	const prepare = vi.fn((sql: string): D1PreparedStatement => {
		const record: StatementRecord = {
			sql,
			bindings: [],
			statement: undefined as unknown as D1PreparedStatement
		};
		const statement = {
			bind: (...bindings: unknown[]): D1PreparedStatement => {
				record.bindings = bindings;
				return statement;
			},
			first: async (): Promise<unknown | null> => firstResults.shift() ?? null,
			all: async (): Promise<{ results: readonly unknown[] }> => ({
				results: allResults.shift() ?? []
			}),
			run: async (): Promise<{ meta: { changes: number } }> => ({ meta: { changes: 1 } })
		} as unknown as D1PreparedStatement;
		record.statement = statement;
		prepared.push(record);
		return statement;
	});
	const batch = vi.fn(async (statements: D1PreparedStatement[]): Promise<unknown[]> => {
		batches.push(
			statements.map((statement: D1PreparedStatement): StatementRecord => {
				const record: StatementRecord | undefined = prepared.find(
					(candidate: StatementRecord): boolean => candidate.statement === statement
				);
				if (record === undefined) throw new Error('Unknown prepared statement.');
				return record;
			})
		);
		if (options.batchError !== undefined) throw options.batchError;
		return [];
	});
	const database = { prepare, batch } as unknown as D1Database;
	return { batches, database, prepared, batch };
}

describe('D1EnvelopeApplicationStore', () => {
	it('atomically creates the organization projection, envelope, audit event, and idempotency row', async () => {
		const fake: FakeD1 = createFakeD1({ firstResults: [null] });
		const store: D1EnvelopeApplicationStore = new D1EnvelopeApplicationStore(fake.database);

		const result = await store.createIdempotently(command);

		expect(result).toEqual({
			outcome: 'created',
			envelope: {
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
			}
		});
		expect(fake.batch).toHaveBeenCalledOnce();
		expect(fake.batches).toHaveLength(1);
		expect(fake.batches[0]).toHaveLength(4);
		expect(fake.batches[0].map((record: StatementRecord): string => record.sql)).toEqual([
			expect.stringContaining('INSERT INTO organization'),
			expect.stringContaining('INSERT INTO envelope'),
			expect.stringContaining('INSERT INTO audit_event'),
			expect.stringContaining('INSERT INTO idempotency_key')
		]);
		expect(fake.batches[0][0].bindings).toEqual([
			command.organizationId,
			command.organizationId,
			command.organizationName,
			command.createdAt
		]);
		expect(fake.batches[0][1].bindings).toEqual([
			command.envelopeId,
			command.organizationId,
			command.organizationId,
			command.title,
			command.createdAt,
			command.createdAt
		]);
		expect(fake.batches[0][2].bindings).toEqual([
			command.auditEventId,
			command.organizationId,
			command.envelopeId,
			'user',
			command.actor.id,
			JSON.stringify({ title: command.title }),
			command.auditEventHash,
			command.createdAt
		]);
		expect(fake.batches[0][3].bindings).toEqual([
			command.organizationId,
			command.actor.id,
			command.idempotencyKey,
			command.requestFingerprint,
			command.envelopeId,
			command.createdAt
		]);
	});

	it('returns a replay only when the scoped key and request hash match', async () => {
		const row: Record<string, unknown> = envelopeRow(command.envelopeId);
		const fake: FakeD1 = createFakeD1({
			firstResults: [
				{ envelope_id: command.envelopeId, request_hash: command.requestFingerprint },
				row
			]
		});
		const store: D1EnvelopeApplicationStore = new D1EnvelopeApplicationStore(fake.database);

		const result = await store.createIdempotently(command);

		expect(result.outcome).toBe('replayed');
		expect(result).toMatchObject({ envelope: { id: command.envelopeId } });
		expect(fake.batch).not.toHaveBeenCalled();
		expect(fake.prepared[0].bindings).toEqual([
			command.organizationId,
			command.actor.id,
			command.idempotencyKey
		]);
		expect(fake.prepared[1].bindings).toEqual([command.organizationId, command.envelopeId]);
	});

	it('reports a conflict when a scoped key was used for another request', async () => {
		const fake: FakeD1 = createFakeD1({
			firstResults: [{ envelope_id: command.envelopeId, request_hash: 'different-hash' }]
		});
		const store: D1EnvelopeApplicationStore = new D1EnvelopeApplicationStore(fake.database);

		await expect(store.createIdempotently(command)).resolves.toEqual({ outcome: 'conflict' });
		expect(fake.batch).not.toHaveBeenCalled();
	});

	it('classifies a concurrent uniqueness failure using the durable idempotency row', async () => {
		const fake: FakeD1 = createFakeD1({
			batchError: new Error('UNIQUE constraint failed'),
			firstResults: [
				null,
				{ envelope_id: command.envelopeId, request_hash: command.requestFingerprint },
				envelopeRow(command.envelopeId)
			]
		});
		const store: D1EnvelopeApplicationStore = new D1EnvelopeApplicationStore(fake.database);

		await expect(store.createIdempotently(command)).resolves.toMatchObject({
			outcome: 'replayed',
			envelope: { id: command.envelopeId }
		});
		expect(fake.batch).toHaveBeenCalledOnce();
	});

	it('does not hide a batch failure that has no idempotency record', async () => {
		const batchError: Error = new Error('D1 unavailable');
		const fake: FakeD1 = createFakeD1({ batchError, firstResults: [null, null] });
		const store: D1EnvelopeApplicationStore = new D1EnvelopeApplicationStore(fake.database);

		await expect(store.createIdempotently(command)).rejects.toBe(batchError);
	});

	it('uses limit plus one and returns an organization-scoped next cursor', async () => {
		const firstId: string = '01900000-0000-7000-8000-000000000011';
		const secondId: string = '01900000-0000-7000-8000-000000000010';
		const extraId: string = '01900000-0000-7000-8000-000000000009';
		const fake: FakeD1 = createFakeD1({
			allResults: [
				[
					envelopeRow(firstId, '2026-09-11T03:00:00.000Z', 'First'),
					envelopeRow(secondId, '2026-09-11T02:00:00.000Z', 'Second'),
					envelopeRow(extraId, '2026-09-11T01:00:00.000Z', 'Extra')
				]
			]
		});
		const store: D1EnvelopeApplicationStore = new D1EnvelopeApplicationStore(fake.database);

		const page = await store.listForOrganization(command.organizationId, {
			cursor: null,
			limit: 2
		});

		expect(page.items.map((item: Envelope): string => item.id)).toEqual([firstId, secondId]);
		expect(page.nextCursor).toBe(secondId);
		expect(fake.prepared[0].sql).toContain('WHERE organization_id = ?');
		expect(fake.prepared[0].sql).toContain('ORDER BY created_at DESC, id DESC');
		expect(fake.prepared[0].bindings).toEqual([command.organizationId, 3]);
	});

	it('scopes cursor resolution and the following page to the organization', async () => {
		const cursorId: string = '01900000-0000-7000-8000-000000000010';
		const cursorUpdatedAt: string = '2026-09-11T02:00:00.000Z';
		const fake: FakeD1 = createFakeD1({
			firstResults: [{ id: cursorId, created_at: cursorUpdatedAt }],
			allResults: [[envelopeRow('01900000-0000-7000-8000-000000000009')]]
		});
		const store: D1EnvelopeApplicationStore = new D1EnvelopeApplicationStore(fake.database);

		await store.listForOrganization(command.organizationId, { cursor: cursorId, limit: 2 });

		expect(fake.prepared[0].bindings).toEqual([command.organizationId, cursorId]);
		expect(fake.prepared[1].bindings).toEqual([
			command.organizationId,
			cursorUpdatedAt,
			cursorUpdatedAt,
			cursorId,
			3
		]);
	});

	it('returns no results for a cursor outside the organization', async () => {
		const fake: FakeD1 = createFakeD1({ firstResults: [null] });
		const store: D1EnvelopeApplicationStore = new D1EnvelopeApplicationStore(fake.database);

		await expect(
			store.listForOrganization(command.organizationId, {
				cursor: '01900000-0000-7000-8000-000000000099',
				limit: 25
			})
		).resolves.toEqual({ items: [], nextCursor: null });
		expect(fake.prepared).toHaveLength(1);
	});

	it('rejects an unbounded list limit before querying D1', async () => {
		const fake: FakeD1 = createFakeD1();
		const store: D1EnvelopeApplicationStore = new D1EnvelopeApplicationStore(fake.database);

		await expect(
			store.listForOrganization(command.organizationId, { cursor: null, limit: 101 })
		).rejects.toThrow(/between 1 and 100/);
		expect(fake.prepared).toHaveLength(0);
	});
});
