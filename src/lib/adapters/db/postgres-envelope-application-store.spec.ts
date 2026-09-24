import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import type { CreateEnvelopeCommand } from '$lib/application/envelopes/model';
import type { Envelope } from '$lib/domain/envelope';
import type { PublishDraftRevisionCommand } from '$lib/ports/draft-mutation-store';
import { PostgresEnvelopeApplicationStore } from './postgres-envelope-application-store';

describe('PostgresEnvelopeApplicationStore', () => {
	it('creates the envelope, idempotency key, and audit event atomically', async () => {
		const database = new ScriptedPostgres([
			[],
			[envelopeRow()],
			[{ requestHash: command.requestFingerprint, envelopeId: command.envelopeId }],
			[]
		]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		const result = await store.createIdempotently(command);

		expect(result).toEqual({ outcome: 'created', envelope });
		expect(database.beginCalls).toBe(1);
		expect(database.transactionQueries).toHaveLength(4);
		expect(database.transactionQueries[0].text).toContain('FROM idempotency_key');
		expect(database.transactionQueries[1].text).toContain('INSERT INTO envelope');
		expect(database.transactionQueries[1].values).toContain(command.envelopeId);
		expect(database.transactionQueries[2].text).toContain('INSERT INTO idempotency_key');
		expect(database.transactionQueries[3].text).toContain('INSERT INTO audit_event');
		expect(database.transactionQueries[3].values).toContain(command.auditEventId);
		expect(database.transactionQueries[3].values).toContain(command.auditEventHash);
	});

	it('replays the stored envelope, not the freshly minted candidate ID', async () => {
		const storedEnvelopeId: string = '01910000-0000-7000-8000-0000000000ff';
		const database = new ScriptedPostgres([
			[{ requestHash: command.requestFingerprint, envelopeId: storedEnvelopeId }],
			[envelopeRow({ id: storedEnvelopeId })]
		]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		const result = await store.createIdempotently(command);

		expect(result).toEqual({
			outcome: 'replayed',
			envelope: { ...envelope, id: storedEnvelopeId }
		});
		expect(database.beginCalls).toBe(1);
		expect(database.transactionQueries).toHaveLength(2);
		expect(database.transactionQueries[1].values).toContain(storedEnvelopeId);
		expect(database.transactionQueries.some((query) => query.text.includes('audit_event'))).toBe(
			false
		);
		expect(
			database.transactionQueries.some((query) => query.text.includes('INSERT INTO envelope'))
		).toBe(false);
	});

	it('distinguishes an idempotency-key conflict from a replay', async () => {
		const database = new ScriptedPostgres([
			[{ requestHash: 'different-request', envelopeId: command.envelopeId }]
		]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		const result = await store.createIdempotently(command);

		expect(result).toEqual({ outcome: 'conflict' });
		expect(database.beginCalls).toBe(1);
		expect(database.transactionQueries).toHaveLength(1);
	});

	it('resolves a lost idempotency-key race into a replay after rolling back its candidate envelope', async () => {
		const winningEnvelopeId: string = '01910000-0000-7000-8000-0000000000fe';
		const database = new ScriptedPostgres([
			[],
			[envelopeRow()],
			[],
			[{ requestHash: command.requestFingerprint, envelopeId: winningEnvelopeId }],
			[envelopeRow({ id: winningEnvelopeId })]
		]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		const result = await store.createIdempotently(command);

		expect(result).toEqual({
			outcome: 'replayed',
			envelope: { ...envelope, id: winningEnvelopeId }
		});
		expect(database.beginCalls).toBe(1);
		expect(database.transactionQueries).toHaveLength(3);
		expect(database.directQueries).toHaveLength(2);
	});

	it('uses a stable cursor and limit-plus-one pagination', async () => {
		const first = envelopeRow({ id: '01910000-0000-7000-8000-000000000003' });
		const second = envelopeRow({ id: '01910000-0000-7000-8000-000000000002' });
		const lookahead = envelopeRow({ id: '01910000-0000-7000-8000-000000000001' });
		const database = new ScriptedPostgres([[first, second, lookahead]]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		const page = await store.listEnvelopes({
			cursor: first.id,
			limit: 2
		});

		expect(page.items.map((item: Envelope): string => item.id)).toEqual([first.id, second.id]);
		expect(page.nextCursor).toBe(second.id);
		expect(database.directQueries).toHaveLength(1);
		const query = database.directQueries[0];
		expect(query.text).toContain('ORDER BY e.created_at DESC, e.id DESC');
		expect(query.values.at(-1)).toBe(3);
	});

	it('rejects an unbounded limit before querying PostgreSQL', async () => {
		const database = new ScriptedPostgres([]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		await expect(store.listEnvelopes({ cursor: null, limit: 101 })).rejects.toThrow(
			/between 1 and 100/
		);
		expect(database.directQueries).toHaveLength(0);
	});

	it('prepares a draft revision with the current audit head', async () => {
		const database = new ScriptedPostgres([
			[],
			[envelopeRow()],
			[{ sequence: '1', eventHash: 'head-1' }]
		]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		await expect(store.prepareDraftRevision(draftCommand, 0)).resolves.toMatchObject({
			outcome: 'ready',
			envelope: { id: command.envelopeId },
			auditHead: { sequence: 1, eventHash: 'head-1' }
		});
		expect(database.directQueries).toHaveLength(3);
	});

	it('replays a draft command before checking the current generation', async () => {
		const database = new ScriptedPostgres([[draftCommandRow()]]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		await expect(store.prepareDraftRevision(draftCommand, 0)).resolves.toEqual({
			outcome: 'replayed',
			revision: publishedDraftRevision
		});
		expect(database.directQueries).toHaveLength(1);
	});

	it.each([
		['missing audit event', { evidenceEventId: null }],
		['wrong envelope', { evidenceEnvelopeId: 'other-envelope' }],
		['wrong sequence', { evidenceSequence: 99 }],
		['wrong event type', { evidenceEventType: 'envelope.created' }],
		['wrong actor', { evidenceActorType: 'agent' }],
		['wrong payload', { evidencePayloadJson: '{"generation":99}' }],
		['wrong previous hash', { evidencePreviousHash: 'other-head' }],
		['wrong event hash', { evidenceEventHash: 'other-event-hash' }],
		['wrong timestamp', { evidenceOccurredAt: '2026-09-11T02:00:00.000Z' }]
	])('fails closed when replay evidence has %s', async (_name, override) => {
		const database = new ScriptedPostgres([[{ ...draftCommandRow(), ...override }]]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		await expect(store.prepareDraftRevision(draftCommand, 0)).resolves.toEqual({
			outcome: 'integrity_error'
		});
		expect(database.directQueries).toHaveLength(1);
	});

	it('treats a key reused for another envelope as an idempotency conflict', async () => {
		const database = new ScriptedPostgres([[{ ...draftCommandRow(), envelopeId: 'other' }]]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		await expect(store.prepareDraftRevision(draftCommand, 0)).resolves.toEqual({
			outcome: 'idempotency_conflict'
		});
	});

	it('locks the envelope and atomically publishes the pointer, command, and audit event', async () => {
		const database = new ScriptedPostgres([
			[],
			[envelopeRow()],
			[],
			[{ sequence: 1, eventHash: 'head-1' }],
			[{ id: command.envelopeId }],
			[],
			[]
		]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		await expect(store.publishDraftRevision(draftCommand)).resolves.toEqual({
			outcome: 'published',
			revision: publishedDraftRevision
		});
		expect(database.beginCalls).toBe(1);
		expect(database.transactionQueries).toHaveLength(7);
		expect(database.transactionQueries[1].text).toContain('FOR UPDATE');
		expect(database.transactionQueries[4].text).toContain('UPDATE envelope');
		expect(database.transactionQueries[5].text).toContain('INSERT INTO draft_revision_command');
		expect(database.transactionQueries[6].text).toContain('INSERT INTO audit_event');
		expect(database.transactionQueries[6].text).toContain("'draft.revision_created'");
	});

	it('rechecks idempotency after waiting for the envelope row lock', async () => {
		const database = new ScriptedPostgres([[], [envelopeRow()], [draftCommandRow()]]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		await expect(store.publishDraftRevision(draftCommand)).resolves.toEqual({
			outcome: 'replayed',
			revision: publishedDraftRevision
		});
		expect(database.transactionQueries).toHaveLength(3);
	});

	it('returns an audit conflict without mutating when the chain head moved', async () => {
		const database = new ScriptedPostgres([
			[],
			[envelopeRow()],
			[],
			[{ sequence: 2, eventHash: 'new-head' }]
		]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		await expect(store.publishDraftRevision(draftCommand)).resolves.toEqual({
			outcome: 'audit_conflict'
		});
		expect(database.transactionQueries).toHaveLength(4);
	});

	it('returns a generation conflict after locking a revision changed by another key', async () => {
		const database = new ScriptedPostgres([[], [envelopeRow({ repositoryGeneration: 1 })], []]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		await expect(store.publishDraftRevision(draftCommand)).resolves.toEqual({
			outcome: 'generation_conflict'
		});
		expect(database.transactionQueries[1].text).toContain('FOR UPDATE');
		expect(database.transactionQueries).toHaveLength(3);
	});

	it('classifies a concurrent cross-envelope key collision by readback', async () => {
		const database = new ScriptedPostgres([
			[],
			[envelopeRow()],
			[],
			[{ sequence: 1, eventHash: 'head-1' }],
			[{ id: command.envelopeId }],
			new Error('opaque uniqueness failure'),
			[{ ...draftCommandRow(), envelopeId: 'other-envelope' }]
		]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		await expect(store.publishDraftRevision(draftCommand)).resolves.toEqual({
			outcome: 'idempotency_conflict'
		});
		expect(database.beginCalls).toBe(1);
		expect(database.directQueries).toHaveLength(1);
	});

	it('reads recipients, ready audit event, and fields without capability hashes or labels', async () => {
		const database = new ScriptedPostgres([
			[
				{
					id: command.envelopeId,
					title: command.title,
					status: 'ready',
					repositoryGeneration: 1,
					repositoryHead: 'a'.repeat(40),
					repositoryArchiveKey: 'archive',
					repositoryArchiveSha256: 'b'.repeat(64),
					sentCommitSha: null,
					fieldGeneration: 1,
					createdAt: command.createdAt,
					updatedAt: command.createdAt
				}
			],
			[
				{
					id: '01900000-0000-7000-8000-000000000021',
					email: 'signer@example.com',
					name: 'Signer',
					role: 'signer',
					locale: 'en',
					routingOrder: 1,
					status: 'pending'
				}
			],
			[{ id: '01900000-0000-7000-8000-000000000033' }],
			[
				{
					id: '01900000-0000-7000-8000-000000000022',
					recipientId: '01900000-0000-7000-8000-000000000021',
					documentId: '01900000-0000-7000-8000-000000000021',
					documentPath: null,
					fieldType: 'signature',
					required: true,
					position: 1,
					page: 1,
					x: 0.1,
					y: 0.2,
					width: 0.3,
					height: 0.05
				}
			]
		]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		const detail = await store.readDetail(command.envelopeId);

		expect(detail?.readyAuditEventId).toBe('01900000-0000-7000-8000-000000000033');
		expect(detail?.recipients[0]?.email).toBe('signer@example.com');
		expect(detail?.fields[0]?.geometry).toEqual({
			page: 1,
			x: 0.1,
			y: 0.2,
			width: 0.3,
			height: 0.05
		});
		const sql = database.directQueries.map((query) => query.text).join('\n');
		expect(sql).toContain('FROM recipient');
		expect(sql).toContain("event_type = 'envelope.ready'");
		expect(sql).toContain('FROM envelope_field');
		expect(sql).not.toContain('capability_hash');
		expect(sql).not.toMatch(/\blabel\b/);
	});

	it('lists draft revision locators and finds by generation or commit', async () => {
		const database = new ScriptedPostgres([
			[
				draftCommandRow(),
				{
					...draftCommandRow(),
					resultingGeneration: 2,
					commitSha: '2'.repeat(40),
					archiveSha256: '2'.repeat(64)
				}
			],
			[draftCommandRow()],
			[draftCommandRow()]
		]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		const locators = await store.listDraftRevisionLocators(command.envelopeId, { limit: 10 });
		expect(locators).toHaveLength(2);
		expect(locators[0].generation).toBe(1);
		expect(locators[0].commitSha).toBe(draftCommand.commitSha);
		expect(locators[0].archiveKey).toBe(draftCommand.archiveKey);
		expect(locators[0].archiveSha256).toBe(draftCommand.archiveSha256);

		const byGen = await store.findDraftRevisionLocatorByGeneration(command.envelopeId, 1);
		expect(byGen?.generation).toBe(1);

		const byCommit = await store.findDraftRevisionLocatorByCommit(
			command.envelopeId,
			draftCommand.commitSha
		);
		expect(byCommit?.commitSha).toBe(draftCommand.commitSha);

		const sql = database.directQueries.map((query) => query.text).join('\n');
		expect(sql).toContain('FROM draft_revision_command');
		expect(sql).toContain('ORDER BY resulting_generation DESC');
	});

	it('does not clamp the truncation-detection limit back down to the public max', async () => {
		const database = new ScriptedPostgres([[]]);
		const store = new PostgresEnvelopeApplicationStore(database.client());

		// DraftPersistenceService.listRevisions requests the public max (100)
		// plus one extra row to detect truncation; the store must forward 101,
		// not clamp it back to 100, or truncation at exactly 100 revisions
		// would never be reported.
		await store.listDraftRevisionLocators(command.envelopeId, { limit: 101 });

		expect(database.directQueries[0].values).toContain(101);
	});
});

interface RecordedQuery {
	text: string;
	values: readonly unknown[];
}

type ScriptedResult = readonly object[] | Error;

class ScriptedPostgres {
	readonly directQueries: RecordedQuery[] = [];
	readonly transactionQueries: RecordedQuery[] = [];
	beginCalls = 0;
	private readonly results: ScriptedResult[];

	constructor(results: readonly ScriptedResult[]) {
		this.results = results.map((result: ScriptedResult): ScriptedResult =>
			result instanceof Error ? result : [...result]
		);
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
			if (result instanceof Error) throw result;
			return result;
		};
		return query as ReturnType<typeof postgres>;
	}
}

const command: CreateEnvelopeCommand = {
	actor: { id: 'user_1', type: 'user' },
	auditEventHash: 'b'.repeat(64),
	auditEventId: '01910000-0000-7000-8000-000000000002',
	createdAt: '2026-09-11T00:00:00.000Z',
	createdByUserId: 'user_1',
	envelopeId: '01910000-0000-7000-8000-000000000001',
	idempotencyKey: 'request-1',
	requestFingerprint: 'a'.repeat(64),
	title: 'Agreement'
};

const envelope: Envelope = {
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
};

function envelopeRow(overrides: Partial<Envelope> = {}): Envelope {
	return { ...envelope, ...overrides };
}

function normalizeSql(strings: TemplateStringsArray): string {
	return strings.join('?').replaceAll(/\s+/g, ' ').trim();
}

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
	auditEventId: '01910000-0000-7000-8000-000000000004',
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
		envelopeId: draftCommand.envelopeId,
		actorType: draftCommand.actorType,
		actorId: draftCommand.actorId,
		requestHash: draftCommand.requestFingerprint,
		resultingGeneration: draftCommand.resultingGeneration,
		commitSha: draftCommand.commitSha,
		archiveKey: draftCommand.archiveKey,
		archiveSha256: draftCommand.archiveSha256,
		updatedAt: draftCommand.updatedAt,
		auditEventId: draftCommand.auditEventId,
		auditSequence: draftCommand.expectedAuditSequence + 1,
		previousAuditHash: draftCommand.previousAuditHash,
		auditEventHash: draftCommand.auditEventHash,
		auditPayloadJson: draftCommand.auditPayloadJson,
		evidenceEventId: draftCommand.auditEventId,
		evidenceEnvelopeId: draftCommand.envelopeId,
		evidenceSequence: draftCommand.expectedAuditSequence + 1,
		evidenceEventType: 'draft.revision_created',
		evidenceActorType: draftCommand.actorType,
		evidenceActorId: draftCommand.actorId,
		evidencePayloadJson: draftCommand.auditPayloadJson,
		evidencePreviousHash: draftCommand.previousAuditHash,
		evidenceEventHash: draftCommand.auditEventHash,
		evidenceOccurredAt: draftCommand.updatedAt
	};
}
