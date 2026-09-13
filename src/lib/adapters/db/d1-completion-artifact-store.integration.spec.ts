import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { buildVerifiedAuditChain } from '$lib/application/completion-artifacts/audit-chain-test-support';
import { CompletionArtifactPublicationService } from '$lib/application/completion-artifacts/completion-artifact-service';
import { draftArchiveKey } from '$lib/application/drafts/draft-persistence';
import type { DraftDocument, DraftRepository, DraftVersion } from '$lib/ports/draft-repository';
import type { CompletionEvidenceAuditEvent } from '$lib/ports/completion-artifact-store';
import type { ObjectMetadata, ObjectStore, PutObject } from '$lib/ports/object-store';
import { D1CompletionArtifactStore } from './d1-completion-artifact-store';
import { sqliteD1Database } from './sqlite-d1-test-support';

const MIGRATIONS: readonly string[] = [
	'migrations/d1/0001_core.sql',
	'migrations/d1/0002_envelope_commands.sql',
	'migrations/d1/0003_draft_revisions.sql',
	'migrations/d1/0004_envelope_ready.sql',
	'migrations/d1/0005_envelope_send.sql',
	'migrations/d1/0006_recipient_viewed.sql',
	'migrations/d1/0007_recipient_declined.sql',
	'migrations/d1/0008_recipient_approved.sql',
	'migrations/d1/0009_field_placement.sql',
	'migrations/d1/0010_recipient_signed.sql',
	'migrations/d1/0011_delivery_outbox_leases.sql',
	'migrations/d1/0012_delivery_outbox_recipient_scope.sql',
	'migrations/d1/0013_terminal_delivery_cleanup.sql',
	'migrations/d1/0014_envelope_voided.sql',
	'migrations/d1/0015_observer_routing_semantics.sql',
	'migrations/d1/0016_completion_artifacts.sql',
	'migrations/d1/0023_audit_hash_v2.sql'
];

const ORGANIZATION_ID: string = 'org-1';
const ENVELOPE_ID: string = '01920000-0000-7000-8000-000000000001';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const ARCHIVE_BYTES: Uint8Array = new TextEncoder().encode('fake-git-archive');
const ARCHIVE_SHA256: string = createHash('sha256').update(ARCHIVE_BYTES).digest('hex');
const ARCHIVE_KEY: string = draftArchiveKey(ORGANIZATION_ID, ENVELOPE_ID, ARCHIVE_SHA256);
const CLAIMED_AT: string = '2026-09-12T00:00:00.000Z';
const STALE_BEFORE: string = '2026-09-11T23:55:00.000Z';
const FIELD_VALUE_JSON: string = '"Signed"';
const FIELD_VALUE_SHA256: string = createHash('sha256').update(FIELD_VALUE_JSON).digest('hex');
const EXTRA_FIELD_VALUE_JSON: string = '"2026-09-11"';
const EXTRA_FIELD_VALUE_SHA256: string = createHash('sha256')
	.update(EXTRA_FIELD_VALUE_JSON)
	.digest('hex');
const SIGNED_AT: string = '2026-09-11T00:01:30.000Z';
const COMPLETED_AT: string = '2026-09-11T00:02:00.000Z';

/**
 * A real, hash-verified 4-event chain: envelope.created, a mid-chain
 * draft.revision_created (the one event type with the second hash preimage
 * shape), recipient.signed (declaring field-1), and the envelope.completed
 * anchor. Every fixture below inserts these events verbatim so tamper tests
 * can mutate exactly one recorded field and expect the recompute to fail.
 */
async function auditChain(): Promise<CompletionEvidenceAuditEvent[]> {
	return buildVerifiedAuditChain({ organizationId: ORGANIZATION_ID, envelopeId: ENVELOPE_ID }, [
		{
			id: '01960000-0000-7000-8000-000000000001',
			eventType: 'envelope.created',
			actorType: 'user',
			actorId: 'actor-1',
			occurredAt: '2026-09-11T00:00:00.000Z',
			payload: { title: 'Agreement' }
		},
		{
			id: '01960000-0000-7000-8000-0000000000e0',
			eventType: 'envelope.ready',
			actorType: 'user',
			actorId: 'actor-1',
			occurredAt: '2026-09-11T00:00:15.000Z',
			payload: {
				commitSha: COMMIT_SHA,
				generation: 1,
				recipients: [
					{ id: '01930000-0000-7000-8000-000000000001', role: 'signer', routingOrder: 1 }
				]
			}
		},
		{
			id: '01960000-0000-7000-8000-000000000002',
			eventType: 'draft.revision_created',
			actorType: 'user',
			actorId: 'actor-1',
			occurredAt: '2026-09-11T00:00:30.000Z',
			payload: {
				generation: 1,
				commitSha: COMMIT_SHA,
				archiveSha256: ARCHIVE_SHA256,
				changedPaths: ['documents/agreement.md']
			}
		},
		{
			id: '01960000-0000-7000-8000-000000000003',
			eventType: 'recipient.signed',
			actorType: 'recipient',
			actorId: '01930000-0000-7000-8000-000000000001',
			occurredAt: SIGNED_AT,
			payload: {
				recipientId: '01930000-0000-7000-8000-000000000001',
				role: 'signer',
				routingOrder: 1,
				sentCommitSha: COMMIT_SHA,
				fields: [
					{
						id: '01950000-0000-7000-8000-000000000001',
						fieldType: 'signature',
						valueSha256: FIELD_VALUE_SHA256
					}
				],
				signedAt: SIGNED_AT
			}
		},
		{
			id: '01960000-0000-7000-8000-000000000004',
			eventType: 'envelope.completed',
			actorType: 'recipient',
			actorId: '01930000-0000-7000-8000-000000000001',
			occurredAt: COMPLETED_AT,
			payload: { sentCommitSha: COMMIT_SHA, completedAt: COMPLETED_AT }
		}
	]);
}

async function fixture(): Promise<{
	database: D1Database;
	sqlite: DatabaseSync;
	events: CompletionEvidenceAuditEvent[];
}> {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	for (const path of MIGRATIONS) sqlite.exec(readFileSync(path, 'utf8'));
	sqlite.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('org-1','org-1','Workspace','2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			repository_archive_key, repository_archive_sha256, sent_commit_sha, field_generation,
			created_at, updated_at
		) VALUES (
			'01920000-0000-7000-8000-000000000001','org-1','Agreement','completed',1,'${COMMIT_SHA}',
			'${ARCHIVE_KEY}',
			'${ARCHIVE_SHA256}','${COMMIT_SHA}',1,
			'2026-09-11T00:00:00.000Z','2026-09-11T00:02:00.000Z'
		);
		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
		) VALUES (
			'01930000-0000-7000-8000-000000000001','org-1','01920000-0000-7000-8000-000000000001','recipient@example.com','Recipient','signer','en',1,
			'completed','capability-hash','2026-09-25T00:00:00.000Z','2026-09-11T00:02:00.000Z',
			'2026-09-11T00:01:00.000Z','2026-09-11T00:02:00.000Z'
		);
		INSERT INTO envelope_field (
			id, organization_id, envelope_id, recipient_id, document_path, field_type, label,
			required, position, created_at, updated_at
		) VALUES (
			'01950000-0000-7000-8000-000000000001','org-1','01920000-0000-7000-8000-000000000001','01930000-0000-7000-8000-000000000001','documents/agreement.md','signature','Signature',
			1,1,'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'
		);
		INSERT INTO field_value (
			organization_id, field_id, envelope_id, recipient_id, field_type, value_json,
			value_sha256, created_at
		) VALUES (
			'org-1','01950000-0000-7000-8000-000000000001','01920000-0000-7000-8000-000000000001','01930000-0000-7000-8000-000000000001','signature','${FIELD_VALUE_JSON}','${FIELD_VALUE_SHA256}',
			'2026-09-11T00:02:00.000Z'
		);
	`);
	const events: CompletionEvidenceAuditEvent[] = await auditChain();
	const insertEvent = sqlite.prepare(
		`INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at, hash_version
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	for (const event of events) {
		insertEvent.run(
			event.id,
			ORGANIZATION_ID,
			ENVELOPE_ID,
			event.sequence,
			event.eventType,
			event.actorType,
			event.actorId,
			event.payloadJson,
			event.previousHash,
			event.eventHash,
			event.occurredAt,
			event.hashVersion
		);
	}
	return { database: sqliteD1Database(sqlite), sqlite, events };
}

function claim(store: D1CompletionArtifactStore, claimToken: string) {
	return store.claimPendingCompletionArtifacts({
		claimToken,
		claimedAt: CLAIMED_AT,
		staleBefore: STALE_BEFORE,
		discoveryLimit: 25,
		claimLimit: 10
	});
}

function tamperedField(
	fieldId: string,
	columnValue: string,
	sqlite: DatabaseSync,
	column: string
): void {
	sqlite
		.prepare(`UPDATE field_value SET ${column} = ? WHERE field_id = ?`)
		.run(columnValue, fieldId);
}

/** Delegates every call through, except the first `batch()`, which throws once to simulate a transient provider error. */
function transientBatchFailureOnce(database: D1Database): D1Database {
	let shouldFail: boolean = true;
	return {
		prepare: (sql: string): D1PreparedStatement => database.prepare(sql),
		batch: async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
			if (shouldFail) {
				shouldFail = false;
				throw new Error('simulated transient D1 failure');
			}
			return database.batch<T>(statements);
		}
	} as unknown as D1Database;
}

describe('D1CompletionArtifactStore SQLite integration', () => {
	it('discovers a pre-existing completed envelope, claims it, and reads evidence', async () => {
		const { database, sqlite } = await fixture();
		try {
			const store = new D1CompletionArtifactStore(database);
			const claimed = await claim(store, 'claim-token-0001');
			expect(claimed).toHaveLength(1);
			expect(claimed[0]).toMatchObject({
				organizationId: 'org-1',
				envelopeId: '01920000-0000-7000-8000-000000000001',
				attempts: 1,
				sentCommitSha: COMMIT_SHA,
				fieldGeneration: 1
			});

			const evidence = await store.readCompletionEvidence(
				'org-1',
				'01920000-0000-7000-8000-000000000001'
			);
			expect(evidence.recipients).toEqual([
				{
					id: '01930000-0000-7000-8000-000000000001',
					role: 'signer',
					routingOrder: 1,
					status: 'completed',
					decisionEventId: '01960000-0000-7000-8000-000000000003',
					decisionOccurredAt: SIGNED_AT
				}
			]);
			expect(evidence.fields).toEqual([
				{
					id: '01950000-0000-7000-8000-000000000001',
					fieldType: 'signature',
					valueJson: FIELD_VALUE_JSON,
					valueSha256: FIELD_VALUE_SHA256
				}
			]);
			expect(evidence.auditEvents.map((event) => event.eventType)).toEqual([
				'envelope.created',
				'envelope.ready',
				'draft.revision_created',
				'recipient.signed',
				'envelope.completed'
			]);

			const jobRow = sqlite.prepare('SELECT status FROM completion_artifact_job').get() as Record<
				string,
				unknown
			>;
			expect(jobRow).toEqual({ status: 'processing' });
		} finally {
			sqlite.close();
		}
	});

	it('reports the envelope as completed and pending before its job row is discovered', async () => {
		const { database, sqlite } = await fixture();
		try {
			const store = new D1CompletionArtifactStore(database);
			const status = await store.findCompletionArtifactStatus(
				'org-1',
				'01920000-0000-7000-8000-000000000001'
			);
			expect(status).toEqual({
				envelopeId: '01920000-0000-7000-8000-000000000001',
				envelopeCompleted: true,
				jobStatus: null,
				attempts: null,
				lastError: null,
				availableAt: null,
				published: null
			});
		} finally {
			sqlite.close();
		}
	});

	it('does not rediscover an envelope once its job row exists', async () => {
		const { database, sqlite } = await fixture();
		try {
			const store = new D1CompletionArtifactStore(database);
			await claim(store, 'claim-token-0001');
			const second = await claim(store, 'claim-token-0002');
			expect(second).toEqual([]);
			const jobCount = sqlite
				.prepare('SELECT COUNT(*) AS count FROM completion_artifact_job')
				.get() as Record<string, unknown>;
			expect(jobCount.count).toBe(1);
		} finally {
			sqlite.close();
		}
	});

	it('reclaims a stale processing lease after the five-minute window', async () => {
		const { database, sqlite } = await fixture();
		try {
			const store = new D1CompletionArtifactStore(database);
			await claim(store, 'claim-token-0001');
			sqlite.exec(
				"UPDATE completion_artifact_job SET locked_at='2026-09-11T23:54:59.000Z' WHERE envelope_id='01920000-0000-7000-8000-000000000001'"
			);
			const reclaimed = await claim(store, 'claim-token-0002');
			expect(reclaimed).toHaveLength(1);
			expect(reclaimed[0].attempts).toBe(2);
		} finally {
			sqlite.close();
		}
	});

	it('publishes the artifact atomically and appends the chained audit event', async () => {
		const { database, sqlite, events } = await fixture();
		const anchor = events[events.length - 1];
		try {
			const store = new D1CompletionArtifactStore(database);
			await claim(store, 'claim-token-0001');
			const published = await store.publishCompletionArtifact({
				organizationId: 'org-1',
				envelopeId: '01920000-0000-7000-8000-000000000001',
				claimToken: 'claim-token-0001',
				sentCommitSha: COMMIT_SHA,
				fieldGeneration: 1,
				anchorAuditEventId: anchor.id,
				expectedAuditSequence: anchor.sequence,
				previousAuditHash: anchor.eventHash,
				manifestSha256: 'm'.repeat(64),
				jsonObjectKey:
					'completion-artifacts/v1/organizations/org-1/envelopes/01920000-0000-7000-8000-000000000001/sha256/j.json.gz',
				jsonSha256: 'j'.repeat(64),
				markdownObjectKey:
					'completion-artifacts/v1/organizations/org-1/envelopes/01920000-0000-7000-8000-000000000001/sha256/d.md.gz',
				markdownSha256: 'd'.repeat(64),
				updatedAt: '2026-09-12T00:00:00.000Z',
				auditEventId: '01960000-0000-7000-8000-000000000005',
				auditEventHash: 'hash-5',
				auditPayloadJson: '{"manifestSha256":"m"}'
			});
			expect(published).toMatchObject({ outcome: 'published' });
			if (published.outcome !== 'published') throw new Error('Expected a fresh publication');

			const jobRow = sqlite
				.prepare('SELECT status, claim_token, locked_at FROM completion_artifact_job')
				.get() as Record<string, unknown>;
			expect(jobRow).toEqual({ status: 'published', claim_token: null, locked_at: null });

			const artifactRow = sqlite
				.prepare('SELECT manifest_sha256, json_sha256, markdown_sha256 FROM completion_artifact')
				.get() as Record<string, unknown>;
			expect(artifactRow).toEqual({
				manifest_sha256: 'm'.repeat(64),
				json_sha256: 'j'.repeat(64),
				markdown_sha256: 'd'.repeat(64)
			});

			const auditRow = sqlite
				.prepare(
					"SELECT sequence, event_type, previous_hash FROM audit_event WHERE event_type = 'envelope.completion_artifact_published'"
				)
				.get() as Record<string, unknown>;
			expect(auditRow).toEqual({
				sequence: anchor.sequence + 1,
				event_type: 'envelope.completion_artifact_published',
				previous_hash: anchor.eventHash
			});

			const replay = await store.publishCompletionArtifact({
				organizationId: 'org-1',
				envelopeId: '01920000-0000-7000-8000-000000000001',
				claimToken: 'claim-token-0001',
				sentCommitSha: COMMIT_SHA,
				fieldGeneration: 1,
				anchorAuditEventId: anchor.id,
				expectedAuditSequence: anchor.sequence,
				previousAuditHash: anchor.eventHash,
				manifestSha256: 'm'.repeat(64),
				jsonObjectKey:
					'completion-artifacts/v1/organizations/org-1/envelopes/01920000-0000-7000-8000-000000000001/sha256/j.json.gz',
				jsonSha256: 'j'.repeat(64),
				markdownObjectKey:
					'completion-artifacts/v1/organizations/org-1/envelopes/01920000-0000-7000-8000-000000000001/sha256/d.md.gz',
				markdownSha256: 'd'.repeat(64),
				updatedAt: '2026-09-12T00:00:00.000Z',
				auditEventId: '01960000-0000-7000-8000-000000000005',
				auditEventHash: 'hash-5',
				auditPayloadJson: '{"manifestSha256":"m"}'
			});
			expect(replay).toEqual({ outcome: 'replayed', result: published.result });

			const integrityConflict = await store.publishCompletionArtifact({
				organizationId: 'org-1',
				envelopeId: '01920000-0000-7000-8000-000000000001',
				claimToken: 'claim-token-0001',
				sentCommitSha: COMMIT_SHA,
				fieldGeneration: 1,
				anchorAuditEventId: anchor.id,
				expectedAuditSequence: anchor.sequence,
				previousAuditHash: anchor.eventHash,
				manifestSha256: 'different-manifest-sha256'.padEnd(64, '0'),
				jsonObjectKey:
					'completion-artifacts/v1/organizations/org-1/envelopes/01920000-0000-7000-8000-000000000001/sha256/j.json.gz',
				jsonSha256: 'j'.repeat(64),
				markdownObjectKey:
					'completion-artifacts/v1/organizations/org-1/envelopes/01920000-0000-7000-8000-000000000001/sha256/d.md.gz',
				markdownSha256: 'd'.repeat(64),
				updatedAt: '2026-09-12T00:00:00.000Z',
				auditEventId: '01960000-0000-7000-8000-000000000005',
				auditEventHash: 'hash-5',
				auditPayloadJson: '{"manifestSha256":"m"}'
			});
			expect(integrityConflict).toEqual({ outcome: 'integrity_error' });

			const status = await store.findCompletionArtifactStatus(
				'org-1',
				'01920000-0000-7000-8000-000000000001'
			);
			expect(status).toMatchObject({
				jobStatus: 'published',
				published: { manifestSha256: 'm'.repeat(64) }
			});
		} finally {
			sqlite.close();
		}
	});

	it('rejects publication under a lost lease as stale, without mutating state', async () => {
		const { database, sqlite, events } = await fixture();
		const anchor = events[events.length - 1];
		try {
			const store = new D1CompletionArtifactStore(database);
			await claim(store, 'claim-token-0001');
			const result = await store.publishCompletionArtifact({
				organizationId: 'org-1',
				envelopeId: '01920000-0000-7000-8000-000000000001',
				claimToken: 'wrong-claim-token',
				sentCommitSha: COMMIT_SHA,
				fieldGeneration: 1,
				anchorAuditEventId: anchor.id,
				expectedAuditSequence: anchor.sequence,
				previousAuditHash: anchor.eventHash,
				manifestSha256: 'm'.repeat(64),
				jsonObjectKey:
					'completion-artifacts/v1/organizations/org-1/envelopes/01920000-0000-7000-8000-000000000001/sha256/j.json.gz',
				jsonSha256: 'j'.repeat(64),
				markdownObjectKey:
					'completion-artifacts/v1/organizations/org-1/envelopes/01920000-0000-7000-8000-000000000001/sha256/d.md.gz',
				markdownSha256: 'd'.repeat(64),
				updatedAt: '2026-09-12T00:00:00.000Z',
				auditEventId: '01960000-0000-7000-8000-000000000005',
				auditEventHash: 'hash-5',
				auditPayloadJson: '{}'
			});
			expect(result).toEqual({ outcome: 'stale' });
			const artifactCount = sqlite
				.prepare('SELECT COUNT(*) AS count FROM completion_artifact')
				.get() as Record<string, unknown>;
			expect(artifactCount.count).toBe(0);
		} finally {
			sqlite.close();
		}
	});

	it('rethrows an unexplained transient batch failure instead of misclassifying it as integrity', async () => {
		const { database, sqlite, events } = await fixture();
		const anchor = events[events.length - 1];
		try {
			await claim(new D1CompletionArtifactStore(database), 'claim-token-0001');
			const flaky: D1Database = transientBatchFailureOnce(database);
			const store = new D1CompletionArtifactStore(flaky);

			await expect(
				store.publishCompletionArtifact({
					organizationId: 'org-1',
					envelopeId: '01920000-0000-7000-8000-000000000001',
					claimToken: 'claim-token-0001',
					sentCommitSha: COMMIT_SHA,
					fieldGeneration: 1,
					anchorAuditEventId: anchor.id,
					expectedAuditSequence: anchor.sequence,
					previousAuditHash: anchor.eventHash,
					manifestSha256: 'm'.repeat(64),
					jsonObjectKey:
						'completion-artifacts/v1/organizations/org-1/envelopes/01920000-0000-7000-8000-000000000001/sha256/j.json.gz',
					jsonSha256: 'j'.repeat(64),
					markdownObjectKey:
						'completion-artifacts/v1/organizations/org-1/envelopes/01920000-0000-7000-8000-000000000001/sha256/d.md.gz',
					markdownSha256: 'd'.repeat(64),
					updatedAt: '2026-09-12T00:00:00.000Z',
					auditEventId: '01960000-0000-7000-8000-000000000005',
					auditEventHash: 'hash-5',
					auditPayloadJson: '{"manifestSha256":"m"}'
				})
			).rejects.toThrow('simulated transient D1 failure');

			// Every predicate the trigger checks still holds (the lease is still
			// ours, the envelope/anchor state is unchanged), so the failure must
			// have been rethrown rather than misclassified as stale or integrity.
			const artifactCount = sqlite
				.prepare('SELECT COUNT(*) AS count FROM completion_artifact')
				.get() as Record<string, unknown>;
			expect(artifactCount.count).toBe(0);
			const jobRow = sqlite
				.prepare('SELECT status, claim_token FROM completion_artifact_job')
				.get() as Record<string, unknown>;
			expect(jobRow).toEqual({ status: 'processing', claim_token: 'claim-token-0001' });
		} finally {
			sqlite.close();
		}
	});

	it('isolates a corrupt completed envelope from a healthy sibling claimed in the same D1 batch', async () => {
		const { database, sqlite } = await fixture();
		try {
			// A second completed envelope with no repository pointer at all —
			// the row mapping must not throw for it (that would poison the
			// whole discovery/claim batch, leaving env-1's lease stuck), and
			// the service must fail only this envelope closed while env-1
			// still publishes in the same call.
			sqlite.exec(`
				INSERT INTO envelope (
					id, organization_id, title, status, repository_generation, repository_head,
					repository_archive_key, repository_archive_sha256, sent_commit_sha,
					field_generation, created_at, updated_at
				) VALUES (
					'01920000-0000-7000-8000-0000000000c0','org-1','Corrupt Agreement','completed',1,NULL,NULL,NULL,NULL,1,
					'2026-09-11T00:00:00.000Z','2026-09-11T00:02:00.000Z'
				);
			`);

			const store = new D1CompletionArtifactStore(database);
			const objects = new WorkingObjectStore();
			objects.seed(ARCHIVE_KEY, ARCHIVE_BYTES);
			const repository = fixedDraftRepository();
			const service = new CompletionArtifactPublicationService(
				store,
				objects,
				repository,
				(): Date => new Date(CLAIMED_AT),
				(): string => 'claim-token-mixed-batch-0001'
			);

			const result = await service.publishPendingCompletionArtifacts();
			expect(result).toMatchObject({
				claimed: 2,
				published: 1,
				integrityFailed: 1,
				retryableFailed: 0,
				stale: 0
			});

			const corruptJobRow = sqlite
				.prepare(
					`SELECT status, retryable, last_error, claim_token, locked_at
					 FROM completion_artifact_job WHERE envelope_id = '01920000-0000-7000-8000-0000000000c0'`
				)
				.get() as Record<string, unknown>;
			expect(corruptJobRow).toEqual({
				status: 'failed',
				retryable: 0,
				last_error: 'completion_artifact_evidence_invalid',
				claim_token: null,
				locked_at: null
			});

			const healthyJobRow = sqlite
				.prepare(
					"SELECT status FROM completion_artifact_job WHERE envelope_id = '01920000-0000-7000-8000-000000000001'"
				)
				.get() as Record<string, unknown>;
			expect(healthyJobRow).toEqual({ status: 'published' });

			const artifactCounts = sqlite
				.prepare(
					`SELECT
						(SELECT COUNT(*) FROM completion_artifact WHERE envelope_id = '01920000-0000-7000-8000-000000000001') AS healthy,
						(SELECT COUNT(*) FROM completion_artifact WHERE envelope_id = '01920000-0000-7000-8000-0000000000c0') AS corrupt`
				)
				.get() as Record<string, unknown>;
			expect(artifactCounts).toEqual({ healthy: 1, corrupt: 0 });

			// No object access at all for the corrupt row: only the healthy
			// envelope's archive read and its two artifact writes happened.
			expect(objects.getCallCount).toBe(1);
			expect(objects.putCallsByKey.size).toBe(2);
			for (const key of objects.putCallsByKey.keys()) {
				expect(key).toContain('/envelopes/01920000-0000-7000-8000-000000000001/');
			}
		} finally {
			sqlite.close();
		}
	});

	it('fails and reports a stale outcome for a lost lease', async () => {
		const { database, sqlite } = await fixture();
		try {
			const store = new D1CompletionArtifactStore(database);
			await claim(store, 'claim-token-0001');
			const failure = await store.failCompletionArtifact({
				organizationId: 'org-1',
				envelopeId: '01920000-0000-7000-8000-000000000001',
				claimToken: 'claim-token-0001',
				errorCode: 'completion_artifact_build_failed',
				retryable: true,
				nextAvailableAt: '2026-09-12T00:05:00.000Z',
				failedAt: '2026-09-12T00:00:30.000Z'
			});
			expect(failure).toEqual({ outcome: 'failed' });
			const stale = await store.failCompletionArtifact({
				organizationId: 'org-1',
				envelopeId: '01920000-0000-7000-8000-000000000001',
				claimToken: 'claim-token-0001',
				errorCode: 'completion_artifact_build_failed',
				retryable: true,
				nextAvailableAt: '2026-09-12T00:05:00.000Z',
				failedAt: '2026-09-12T00:00:30.000Z'
			});
			expect(stale).toEqual({ outcome: 'stale' });
			const jobRow = sqlite
				.prepare('SELECT status, retryable, last_error FROM completion_artifact_job')
				.get() as Record<string, unknown>;
			expect(jobRow).toEqual({
				status: 'failed',
				retryable: 1,
				last_error: 'completion_artifact_build_failed'
			});
		} finally {
			sqlite.close();
		}
	});

	describe('fail-closed tampering coverage', () => {
		async function expectFailClosed(
			sqlite: DatabaseSync,
			database: D1Database,
			objects: ObjectStore,
			repository: DraftRepository
		): Promise<void> {
			const store = new D1CompletionArtifactStore(database);
			const service = new CompletionArtifactPublicationService(
				store,
				objects,
				repository,
				(): Date => new Date(CLAIMED_AT),
				(): string => 'claim-token-tamper-0001'
			);

			const result = await service.publishPendingCompletionArtifacts();
			expect(result).toMatchObject({ claimed: 1, integrityFailed: 1, published: 0 });

			const artifactCount = sqlite
				.prepare('SELECT COUNT(*) AS count FROM completion_artifact')
				.get() as Record<string, unknown>;
			expect(artifactCount.count).toBe(0);

			const publishedAuditCount = sqlite
				.prepare(
					"SELECT COUNT(*) AS count FROM audit_event WHERE event_type = 'envelope.completion_artifact_published'"
				)
				.get() as Record<string, unknown>;
			expect(publishedAuditCount.count).toBe(0);

			const jobRow = sqlite
				.prepare('SELECT status, retryable, last_error FROM completion_artifact_job')
				.get() as Record<string, unknown>;
			expect(jobRow).toEqual({
				status: 'failed',
				retryable: 0,
				last_error: 'completion_artifact_evidence_invalid'
			});
		}

		it('fails closed when field value_json is tampered but value_sha256 is unchanged', async () => {
			const { database, sqlite } = await fixture();
			try {
				// value_json altered after signing; value_sha256 left at its
				// originally-correct digest. This is caught before the draft
				// repository or object store are ever read, so both doubles
				// here throw if touched.
				tamperedField('01950000-0000-7000-8000-000000000001', '"Tampered"', sqlite, 'value_json');
				await expectFailClosed(
					sqlite,
					database,
					new UnreachableObjectStore(),
					new UnreachableDraftRepository()
				);
			} finally {
				sqlite.close();
			}
		});

		it('fails closed when a field_value row is inserted after signing', async () => {
			const { database, sqlite } = await fixture();
			try {
				sqlite.exec(`
					INSERT INTO envelope_field (
						id, organization_id, envelope_id, recipient_id, document_path, field_type, label,
						required, position, created_at, updated_at
					) VALUES (
						'01950000-0000-7000-8000-000000000002','org-1','01920000-0000-7000-8000-000000000001','01930000-0000-7000-8000-000000000001','documents/agreement.md','date','Signed date',
						1,2,'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'
					);
					INSERT INTO field_value (
						organization_id, field_id, envelope_id, recipient_id, field_type, value_json,
						value_sha256, created_at
					) VALUES (
						'org-1','01950000-0000-7000-8000-000000000002','01920000-0000-7000-8000-000000000001','01930000-0000-7000-8000-000000000001','date','${EXTRA_FIELD_VALUE_JSON}',
						'${EXTRA_FIELD_VALUE_SHA256}','2026-09-11T00:02:00.000Z'
					);
				`);
				await expectFailClosed(sqlite, database, seededObjectStore(), fixedDraftRepository());
			} finally {
				sqlite.close();
			}
		});

		it('fails closed when a field_value row is deleted after signing', async () => {
			const { database, sqlite } = await fixture();
			try {
				sqlite.exec(
					"DELETE FROM field_value WHERE field_id = '01950000-0000-7000-8000-000000000001'"
				);
				await expectFailClosed(sqlite, database, seededObjectStore(), fixedDraftRepository());
			} finally {
				sqlite.close();
			}
		});

		it('fails closed when the terminal envelope.completed payload is altered', async () => {
			const { database, sqlite } = await fixture();
			try {
				sqlite
					.prepare(
						"UPDATE audit_event SET payload_json = ? WHERE id = '01960000-0000-7000-8000-000000000004'"
					)
					.run(
						JSON.stringify({ sentCommitSha: COMMIT_SHA, completedAt: '2099-01-01T00:00:00.000Z' })
					);
				await expectFailClosed(sqlite, database, seededObjectStore(), fixedDraftRepository());
			} finally {
				sqlite.close();
			}
		});

		it('fails closed when the terminal envelope.completed occurred_at is altered', async () => {
			const { database, sqlite } = await fixture();
			try {
				sqlite
					.prepare(
						"UPDATE audit_event SET occurred_at = ? WHERE id = '01960000-0000-7000-8000-000000000004'"
					)
					.run('2026-09-11T00:02:00.001Z');
				await expectFailClosed(sqlite, database, seededObjectStore(), fixedDraftRepository());
			} finally {
				sqlite.close();
			}
		});

		it('fails closed when a mid-chain draft.revision_created event is altered', async () => {
			const { database, sqlite } = await fixture();
			try {
				sqlite
					.prepare(
						"UPDATE audit_event SET payload_json = ? WHERE id = '01960000-0000-7000-8000-000000000002'"
					)
					.run(
						JSON.stringify({
							generation: 1,
							commitSha: COMMIT_SHA,
							archiveSha256: 'f'.repeat(64),
							changedPaths: ['documents/agreement.md']
						})
					);
				await expectFailClosed(sqlite, database, seededObjectStore(), fixedDraftRepository());
			} finally {
				sqlite.close();
			}
		});

		it('fails closed when a recipient row is inserted that the envelope.ready event never declared', async () => {
			const { database, sqlite } = await fixture();
			try {
				sqlite.exec(`
					INSERT INTO recipient (
						id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
						capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
					) VALUES (
						'01930000-0000-7000-8000-0000000000e7','org-1','01920000-0000-7000-8000-000000000001','extra@example.com','Extra','viewer','en',1,
						'pending',NULL,NULL,NULL,'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'
					);
				`);
				await expectFailClosed(sqlite, database, seededObjectStore(), fixedDraftRepository());
			} finally {
				sqlite.close();
			}
		});

		it("fails closed when a recipient's role drifts from the envelope.ready declaration", async () => {
			const { database, sqlite } = await fixture();
			try {
				sqlite
					.prepare(
						"UPDATE recipient SET role = 'approver' WHERE id = '01930000-0000-7000-8000-000000000001'"
					)
					.run();
				await expectFailClosed(sqlite, database, seededObjectStore(), fixedDraftRepository());
			} finally {
				sqlite.close();
			}
		});
	});
});

function seededObjectStore(): ObjectStore {
	const store = new SeededObjectStore();
	store.seed(ARCHIVE_KEY, ARCHIVE_BYTES);
	return store;
}

function fixedDraftRepository(): DraftRepository {
	return new FixedDraftRepository(COMMIT_SHA, [
		{ path: 'documents/agreement.md', content: 'Agreement body' }
	]);
}

class UnreachableObjectStore implements ObjectStore {
	async head(): Promise<ObjectMetadata | null> {
		throw new Error('Object store must not be read before field value integrity is verified');
	}

	async get(): Promise<ReadableStream<Uint8Array> | null> {
		throw new Error('Object store must not be read before field value integrity is verified');
	}

	async putImmutable(): Promise<ObjectMetadata> {
		throw new Error('Object store must not be written before field value integrity is verified');
	}

	async delete(): Promise<void> {
		throw new Error('Object store must not be read before field value integrity is verified');
	}

	async list(): Promise<Awaited<ReturnType<ObjectStore['list']>>> {
		throw new Error('Object store must not be listed before field value integrity is verified');
	}

	async deleteMany(): Promise<void> {
		throw new Error('Object store must not be deleted before field value integrity is verified');
	}
}

class UnreachableDraftRepository implements DraftRepository {
	async read(): Promise<readonly DraftDocument[]> {
		throw new Error('Draft repository must not be read before field value integrity is verified');
	}

	async commit(): Promise<DraftVersion> {
		throw new Error(
			'Draft repository must not be written before field value integrity is verified'
		);
	}
}

interface StoredArchive {
	body: Uint8Array;
}

/** A working object store for tamper scenarios caught later, inside manifest construction. */
class SeededObjectStore implements ObjectStore {
	private readonly objects = new Map<string, StoredArchive>();

	seed(key: string, body: Uint8Array): void {
		this.objects.set(key, { body: Uint8Array.from(body) });
	}

	async head(): Promise<ObjectMetadata | null> {
		throw new Error('unused');
	}

	async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
		const object = this.objects.get(key);
		if (!object) return null;
		const body = Uint8Array.from(object.body);
		return new ReadableStream<Uint8Array>({
			start(controller): void {
				controller.enqueue(body);
				controller.close();
			}
		});
	}

	async putImmutable(): Promise<ObjectMetadata> {
		throw new Error('This tamper scenario must never reach an artifact object write');
	}

	async delete(): Promise<void> {
		throw new Error('unused');
	}

	async list(): Promise<Awaited<ReturnType<ObjectStore['list']>>> {
		throw new Error('unused');
	}

	async deleteMany(): Promise<void> {
		throw new Error('unused');
	}
}

/** A fully functional object store, for scenarios where a healthy sibling must actually publish. */
class WorkingObjectStore implements ObjectStore {
	private readonly objects = new Map<string, StoredArchive>();
	putCallsByKey = new Map<string, number>();
	getCallCount: number = 0;

	seed(key: string, body: Uint8Array): void {
		this.objects.set(key, { body: Uint8Array.from(body) });
	}

	async head(): Promise<ObjectMetadata | null> {
		throw new Error('unused');
	}

	async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
		this.getCallCount += 1;
		const object = this.objects.get(key);
		if (!object) return null;
		const body = Uint8Array.from(object.body);
		return new ReadableStream<Uint8Array>({
			start(controller): void {
				controller.enqueue(body);
				controller.close();
			}
		});
	}

	async putImmutable(key: string, object: PutObject): Promise<ObjectMetadata> {
		this.putCallsByKey.set(key, (this.putCallsByKey.get(key) ?? 0) + 1);
		if (this.objects.has(key)) throw new Error('Object already exists');
		if (!(object.body instanceof Uint8Array)) throw new Error('Test store requires buffered input');
		const stored: StoredArchive = { body: Uint8Array.from(object.body) };
		this.objects.set(key, stored);
		return {
			key,
			contentType: object.contentType,
			size: stored.body.byteLength,
			sha256: object.sha256,
			version: null
		};
	}

	async delete(): Promise<void> {
		throw new Error('unused');
	}

	async list(): Promise<Awaited<ReturnType<ObjectStore['list']>>> {
		throw new Error('unused');
	}

	async deleteMany(): Promise<void> {
		throw new Error('unused');
	}
}

/** A working draft repository for tamper scenarios caught later, inside manifest construction. */
class FixedDraftRepository implements DraftRepository {
	constructor(
		private readonly expectedCommitSha: string,
		private readonly documents: readonly DraftDocument[]
	) {}

	async read(
		_archive: Uint8Array | null,
		expectedCommitSha: string | null
	): Promise<readonly DraftDocument[]> {
		if (expectedCommitSha !== this.expectedCommitSha) throw new Error('Unexpected commit SHA');
		return this.documents;
	}

	async commit(): Promise<DraftVersion> {
		throw new Error('Unexpected repository commit');
	}
}
