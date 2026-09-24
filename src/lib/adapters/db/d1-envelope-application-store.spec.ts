import { describe, expect, it, vi } from 'vitest';
import type { CreateEnvelopeCommand } from '$lib/application/envelopes/model';
import type { Envelope } from '$lib/domain/envelope';
import type { PublishDraftRevisionCommand } from '$lib/ports/draft-mutation-store';
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
	runError?: Error;
}

const command: CreateEnvelopeCommand = {
	actor: { id: 'user-1', type: 'user' },
	auditEventHash: 'audit-hash',
	auditEventId: '01900000-0000-7000-8000-000000000003',
	createdAt: '2026-09-11T00:00:00.000Z',
	createdByUserId: 'user-1',
	envelopeId: '01900000-0000-7000-8000-000000000001',
	idempotencyKey: 'request-1',
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
		created_by_user_id: command.createdByUserId,
		title,
		status: 'draft',
		repository_generation: 0,
		repository_head: null,
		repository_archive_key: null,
		repository_archive_sha256: null,
		sent_commit_sha: null,
		field_generation: 0,
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
			run: async (): Promise<{ meta: { changes: number } }> => {
				if (options.runError !== undefined) throw options.runError;
				return { meta: { changes: 1 } };
			}
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
	it('atomically creates the envelope, audit event, and idempotency row', async () => {
		const fake: FakeD1 = createFakeD1({ firstResults: [null] });
		const store: D1EnvelopeApplicationStore = new D1EnvelopeApplicationStore(fake.database);

		const result = await store.createIdempotently(command);

		expect(result).toEqual({
			outcome: 'created',
			envelope: {
				id: command.envelopeId,
				createdByUserId: command.createdByUserId,
				title: command.title,
				status: 'draft',
				repositoryGeneration: 0,
				repositoryHead: null,
				repositoryArchiveKey: null,
				repositoryArchiveSha256: null,
				sentCommitSha: null,
				fieldGeneration: 0,
				createdAt: command.createdAt,
				updatedAt: command.createdAt
			}
		});
		expect(fake.batch).toHaveBeenCalledOnce();
		expect(fake.batches).toHaveLength(1);
		expect(fake.batches[0]).toHaveLength(3);
		expect(fake.batches[0].map((record: StatementRecord): string => record.sql)).toEqual([
			expect.stringContaining('INSERT INTO envelope'),
			expect.stringContaining('INSERT INTO audit_event'),
			expect.stringContaining('INSERT INTO idempotency_key')
		]);
		expect(fake.batches[0][0].bindings).toEqual([
			command.envelopeId,
			command.createdByUserId,
			command.title,
			command.createdAt,
			command.createdAt
		]);
		expect(fake.batches[0][1].bindings).toEqual([
			command.auditEventId,
			command.envelopeId,
			'user',
			command.actor.id,
			JSON.stringify({ title: command.title }),
			command.auditEventHash,
			command.createdAt
		]);
		expect(fake.batches[0][2].bindings).toEqual([
			command.actor.id,
			command.idempotencyKey,
			command.requestFingerprint,
			command.envelopeId,
			command.createdAt
		]);
	});

	it('replays the stored envelope, not the freshly minted candidate identifier', async () => {
		// The candidate ID is minted per attempt, so the durable record's envelope
		// is authoritative for a replay.
		const storedEnvelopeId: string = '01900000-0000-7000-8000-0000000000ff';
		const row: Record<string, unknown> = envelopeRow(storedEnvelopeId);
		const fake: FakeD1 = createFakeD1({
			firstResults: [
				{ envelope_id: storedEnvelopeId, request_hash: command.requestFingerprint },
				row
			]
		});
		const store: D1EnvelopeApplicationStore = new D1EnvelopeApplicationStore(fake.database);

		const result = await store.createIdempotently(command);

		expect(storedEnvelopeId).not.toBe(command.envelopeId);
		expect(result.outcome).toBe('replayed');
		expect(result).toMatchObject({ envelope: { id: storedEnvelopeId } });
		expect(fake.batch).not.toHaveBeenCalled();
		expect(fake.prepared[0].bindings).toEqual([command.actor.id, command.idempotencyKey]);
		expect(fake.prepared[1].bindings).toEqual([storedEnvelopeId]);
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

	it('uses limit plus one and returns a next cursor', async () => {
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

		const page = await store.listEnvelopes({
			cursor: null,
			limit: 2
		});

		expect(page.items.map((item: Envelope): string => item.id)).toEqual([firstId, secondId]);
		expect(page.nextCursor).toBe(secondId);
		expect(fake.prepared[0].sql).toContain('ORDER BY created_at DESC, id DESC');
		expect(fake.prepared[0].bindings).toEqual([3]);
	});

	it('scopes cursor resolution and the following page', async () => {
		const cursorId: string = '01900000-0000-7000-8000-000000000010';
		const cursorUpdatedAt: string = '2026-09-11T02:00:00.000Z';
		const fake: FakeD1 = createFakeD1({
			firstResults: [{ id: cursorId, created_at: cursorUpdatedAt }],
			allResults: [[envelopeRow('01900000-0000-7000-8000-000000000009')]]
		});
		const store: D1EnvelopeApplicationStore = new D1EnvelopeApplicationStore(fake.database);

		await store.listEnvelopes({ cursor: cursorId, limit: 2 });

		expect(fake.prepared[0].bindings).toEqual([cursorId]);
		expect(fake.prepared[1].bindings).toEqual([cursorUpdatedAt, cursorUpdatedAt, cursorId, 3]);
	});

	it('returns no results for a missing cursor', async () => {
		const fake: FakeD1 = createFakeD1({ firstResults: [null] });
		const store: D1EnvelopeApplicationStore = new D1EnvelopeApplicationStore(fake.database);

		await expect(
			store.listEnvelopes({
				cursor: '01900000-0000-7000-8000-000000000099',
				limit: 25
			})
		).resolves.toEqual({ items: [], nextCursor: null });
		expect(fake.prepared).toHaveLength(1);
	});

	it('rejects an unbounded list limit before querying D1', async () => {
		const fake: FakeD1 = createFakeD1();
		const store: D1EnvelopeApplicationStore = new D1EnvelopeApplicationStore(fake.database);

		await expect(store.listEnvelopes({ cursor: null, limit: 101 })).rejects.toThrow(
			/between 1 and 100/
		);
		expect(fake.prepared).toHaveLength(0);
	});

	it('prepares a draft revision from the envelope and audit head', async () => {
		const fake: FakeD1 = createFakeD1({
			firstResults: [null, envelopeRow(command.envelopeId), { sequence: 1, event_hash: 'head-1' }]
		});
		const store = new D1EnvelopeApplicationStore(fake.database);

		await expect(store.prepareDraftRevision(draftCommand, 0)).resolves.toMatchObject({
			outcome: 'ready',
			envelope: { id: command.envelopeId, repositoryGeneration: 0 },
			auditHead: { sequence: 1, eventHash: 'head-1' }
		});
		expect(fake.prepared[0].bindings).toEqual([
			draftCommand.actorType,
			draftCommand.actorId,
			draftCommand.idempotencyKey
		]);
	});

	it('replays a prepared draft revision and conflicts when the envelope differs', async () => {
		const stored = draftCommandRow();
		const replayStore = new D1EnvelopeApplicationStore(
			createFakeD1({ firstResults: [stored] }).database
		);
		await expect(replayStore.prepareDraftRevision(draftCommand, 0)).resolves.toEqual({
			outcome: 'replayed',
			revision: publishedDraftRevision
		});

		const conflictStore = new D1EnvelopeApplicationStore(
			createFakeD1({
				firstResults: [{ ...stored, envelope_id: 'another-envelope' }]
			}).database
		);
		await expect(conflictStore.prepareDraftRevision(draftCommand, 0)).resolves.toEqual({
			outcome: 'idempotency_conflict'
		});
	});

	it.each([
		['missing audit event', { evidence_event_id: null }],
		['wrong event type', { evidence_event_type: 'envelope.created' }],
		['wrong actor', { evidence_actor_id: 'other-actor' }],
		['wrong payload', { evidence_payload_json: '{"generation":99}' }],
		['wrong previous hash', { evidence_previous_hash: 'other-head' }],
		['wrong event hash', { evidence_event_hash: 'other-event-hash' }],
		['wrong timestamp', { evidence_occurred_at: '2026-09-11T02:00:00.000Z' }]
	])('fails closed when replay evidence has %s', async (_name, override) => {
		const store = new D1EnvelopeApplicationStore(
			createFakeD1({ firstResults: [{ ...draftCommandRow(), ...override }] }).database
		);

		await expect(store.prepareDraftRevision(draftCommand, 0)).resolves.toEqual({
			outcome: 'integrity_error'
		});
	});

	it('publishes through the trigger-backed command insert', async () => {
		const fake: FakeD1 = createFakeD1({ firstResults: [null] });
		const store = new D1EnvelopeApplicationStore(fake.database);

		await expect(store.publishDraftRevision(draftCommand)).resolves.toEqual({
			outcome: 'published',
			revision: publishedDraftRevision
		});
		const insert = fake.prepared.at(-1);
		expect(insert?.sql).toContain('INSERT INTO draft_revision_command');
		expect(insert?.bindings).toEqual([
			draftCommand.envelopeId,
			draftCommand.actorType,
			draftCommand.actorId,
			draftCommand.idempotencyKey,
			draftCommand.requestFingerprint,
			draftCommand.expectedGeneration,
			draftCommand.resultingGeneration,
			draftCommand.commitSha,
			draftCommand.archiveKey,
			draftCommand.archiveSha256,
			draftCommand.updatedAt,
			draftCommand.auditEventId,
			2,
			draftCommand.previousAuditHash,
			draftCommand.auditEventHash,
			draftCommand.auditPayloadJson
		]);
	});

	it('classifies a concurrent duplicate by durable readback without parsing the error', async () => {
		const fake: FakeD1 = createFakeD1({
			runError: new Error('opaque provider failure'),
			firstResults: [null, draftCommandRow()]
		});
		const store = new D1EnvelopeApplicationStore(fake.database);

		await expect(store.publishDraftRevision(draftCommand)).resolves.toEqual({
			outcome: 'replayed',
			revision: publishedDraftRevision
		});
	});

	it('classifies a losing generation CAS after a failed D1 publish', async () => {
		const advancedEnvelope = {
			...envelopeRow(command.envelopeId),
			repository_generation: 1,
			repository_head: draftCommand.commitSha,
			repository_archive_key: draftCommand.archiveKey,
			repository_archive_sha256: draftCommand.archiveSha256
		};
		const fake: FakeD1 = createFakeD1({
			runError: new Error('opaque provider failure'),
			firstResults: [null, null, advancedEnvelope]
		});
		const store = new D1EnvelopeApplicationStore(fake.database);

		await expect(store.publishDraftRevision(draftCommand)).resolves.toEqual({
			outcome: 'generation_conflict'
		});
	});

	it('classifies an audit-head race after a failed D1 publish', async () => {
		const fake: FakeD1 = createFakeD1({
			runError: new Error('opaque provider failure'),
			firstResults: [
				null,
				null,
				envelopeRow(command.envelopeId),
				{ sequence: 2, event_hash: 'new-head' }
			]
		});
		const store = new D1EnvelopeApplicationStore(fake.database);

		await expect(store.publishDraftRevision(draftCommand)).resolves.toEqual({
			outcome: 'audit_conflict'
		});
	});

	it('reads recipients, ready audit event, and fields without capability hashes or labels', async () => {
		const readyEnvelope = {
			...envelopeRow(command.envelopeId),
			status: 'ready',
			repository_generation: 1,
			field_generation: 1
		};
		const fake: FakeD1 = createFakeD1({
			firstResults: [readyEnvelope, { id: '01900000-0000-7000-8000-000000000033' }],
			allResults: [
				[
					{
						id: '01900000-0000-7000-8000-000000000021',
						email: 'signer@example.com',
						name: 'Signer',
						role: 'signer',
						locale: 'en',
						routing_order: 1,
						status: 'pending'
					}
				],
				[
					{
						id: '01900000-0000-7000-8000-000000000022',
						recipient_id: '01900000-0000-7000-8000-000000000021',
						document_path: 'documents/agreement.md',
						field_type: 'signature',
						required: 1,
						position: 1,
						page: 1,
						x: 0.1,
						y: 0.2,
						width: 0.3,
						height: 0.05
					}
				]
			]
		});
		const store = new D1EnvelopeApplicationStore(fake.database);

		const detail = await store.readDetail(command.envelopeId);

		expect(detail?.readyAuditEventId).toBe('01900000-0000-7000-8000-000000000033');
		expect(detail?.recipients).toEqual([
			{
				id: '01900000-0000-7000-8000-000000000021',
				email: 'signer@example.com',
				name: 'Signer',
				role: 'signer',
				locale: 'en',
				routingOrder: 1,
				status: 'pending'
			}
		]);
		expect(detail?.fields[0]).toMatchObject({
			id: '01900000-0000-7000-8000-000000000022',
			geometry: { page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.05 }
		});
		expect(JSON.stringify(detail)).not.toContain('capability');
		const sql = fake.prepared.map((record) => record.sql).join('\n');
		expect(sql).toContain('FROM recipient');
		expect(sql).toContain("event_type = 'envelope.ready'");
		expect(sql).toContain('FROM envelope_field');
		expect(sql).not.toContain('capability_hash');
		expect(sql).not.toContain('label');
	});

	it('lists draft revision locators bounded by limit and cursor', async () => {
		const fake = createFakeD1({
			allResults: [
				[
					draftCommandRow(),
					{
						...draftCommandRow(),
						resulting_generation: 2,
						commit_sha: '2'.repeat(40),
						archive_sha256: '2'.repeat(64)
					}
				]
			]
		});
		const store = new D1EnvelopeApplicationStore(fake.database);

		const locators = await store.listDraftRevisionLocators(command.envelopeId, { limit: 10 });
		expect(locators).toHaveLength(2);
		expect(locators[0].generation).toBe(1);
		expect(locators[0].commitSha).toBe(draftCommand.commitSha);
		expect(locators[0].archiveKey).toBe(draftCommand.archiveKey);
		expect(locators[0].archiveSha256).toBe(draftCommand.archiveSha256);

		const sql = fake.prepared.map((record) => record.sql).join('\n');
		expect(sql).toContain('FROM draft_revision_command');
		expect(sql).toContain('ORDER BY resulting_generation DESC');
	});

	it('does not clamp the truncation-detection limit back down to the public max', async () => {
		const fake = createFakeD1({ allResults: [[]] });
		const store = new D1EnvelopeApplicationStore(fake.database);

		// DraftPersistenceService.listRevisions requests the public max (100)
		// plus one extra row to detect truncation; the store must forward 101,
		// not clamp it back to 100, or truncation at exactly 100 revisions
		// would never be reported.
		await store.listDraftRevisionLocators(command.envelopeId, { limit: 101 });

		expect(fake.prepared[0].bindings).toContain(101);
	});

	it('finds draft revision locator by generation and by commit', async () => {
		const fake = createFakeD1({
			firstResults: [draftCommandRow(), draftCommandRow()]
		});
		const store = new D1EnvelopeApplicationStore(fake.database);

		const byGen = await store.findDraftRevisionLocatorByGeneration(command.envelopeId, 1);
		expect(byGen).not.toBeNull();
		expect(byGen?.generation).toBe(1);

		const byCommit = await store.findDraftRevisionLocatorByCommit(
			command.envelopeId,
			draftCommand.commitSha
		);
		expect(byCommit).not.toBeNull();
		expect(byCommit?.commitSha).toBe(draftCommand.commitSha);
	});
});

const draftCommand: PublishDraftRevisionCommand = {
	envelopeId: command.envelopeId,
	actorType: 'user',
	actorId: command.actor.id,
	idempotencyKey: 'draft-request-1',
	requestFingerprint: 'c'.repeat(64),
	expectedGeneration: 0,
	resultingGeneration: 1,
	commitSha: 'd'.repeat(40),
	archiveKey: 'draft-repositories/archive.git.gz',
	archiveSha256: 'e'.repeat(64),
	updatedAt: '2026-09-11T01:00:00.000Z',
	expectedAuditSequence: 1,
	previousAuditHash: 'head-1',
	auditEventId: '01900000-0000-7000-8000-000000000004',
	auditEventHash: 'f'.repeat(64),
	auditPayloadJson: '{"generation":1}'
};

const publishedDraftRevision = {
	generation: 1,
	commitSha: draftCommand.commitSha,
	archiveKey: draftCommand.archiveKey,
	archiveSha256: draftCommand.archiveSha256,
	updatedAt: draftCommand.updatedAt,
	auditEventId: draftCommand.auditEventId
};

function draftCommandRow(): Record<string, unknown> {
	return {
		envelope_id: draftCommand.envelopeId,
		actor_type: draftCommand.actorType,
		actor_id: draftCommand.actorId,
		request_hash: draftCommand.requestFingerprint,
		resulting_generation: draftCommand.resultingGeneration,
		commit_sha: draftCommand.commitSha,
		archive_key: draftCommand.archiveKey,
		archive_sha256: draftCommand.archiveSha256,
		updated_at: draftCommand.updatedAt,
		audit_event_id: draftCommand.auditEventId,
		audit_sequence: draftCommand.expectedAuditSequence + 1,
		previous_audit_hash: draftCommand.previousAuditHash,
		audit_event_hash: draftCommand.auditEventHash,
		audit_payload_json: draftCommand.auditPayloadJson,
		evidence_event_id: draftCommand.auditEventId,
		evidence_envelope_id: draftCommand.envelopeId,
		evidence_sequence: draftCommand.expectedAuditSequence + 1,
		evidence_event_type: 'draft.revision_created',
		evidence_actor_type: draftCommand.actorType,
		evidence_actor_id: draftCommand.actorId,
		evidence_payload_json: draftCommand.auditPayloadJson,
		evidence_previous_hash: draftCommand.previousAuditHash,
		evidence_event_hash: draftCommand.auditEventHash,
		evidence_occurred_at: draftCommand.updatedAt
	};
}
