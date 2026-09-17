import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { EnvelopeVoidApplication } from '$lib/application/envelopes/void';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';
import { hashStoredAuditEvent } from '$lib/domain/audit';
import { createEnvelopeVoidHandler } from '$lib/http/envelope-void';
import { createHttpRequestEvent } from '$lib/http/http-handler-test-support';
import type { VoidableEnvelopeStatus } from '$lib/ports/envelope-void-store';
import { D1EnvelopeVoidStore } from './d1-envelope-void-store';
import { sqliteD1Database } from './sqlite-d1-test-support';

const MIGRATIONS: readonly string[] = readdirSync('migrations/d1')
	.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
	.sort()
	.map((name: string): string => `migrations/d1/${name}`);
const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const VOIDED_AT: string = '2026-09-12T02:00:00.000Z';
const ACTOR: EnvelopeRequestActor = {
	id: 'user-1',
	createdByUserId: 'user-1'
};
const AGENT_ACTOR: EnvelopeRequestActor = {
	id: '01900000-0000-7000-8000-000000000201',
	createdByUserId: 'user-1',
	actorType: 'agent'
};

function database(): { sqlite: DatabaseSync; d1: D1Database } {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	for (const path of MIGRATIONS) sqlite.exec(readFileSync(path, 'utf8'));
	return { sqlite, d1: sqliteD1Database(sqlite) };
}

function seedEnvelope(
	sqlite: DatabaseSync,
	status: VoidableEnvelopeStatus,
	generation: number,
	repositoryHead: string | null = null,
	sentCommitSha: string | null = null
): void {
	sqlite
		.prepare(
			`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			 VALUES ('user-1', 'owner', 'active', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z')`
		)
		.run();
	sqlite
		.prepare(
			`INSERT INTO envelope (
				id, created_by_user_id, title, status, repository_generation, repository_head,
				sent_commit_sha, created_at, updated_at
			 ) VALUES (?, 'user-1', 'Agreement', ?, ?, ?, ?,
				'2026-09-12T00:00:00.000Z', '2026-09-12T01:00:00.000Z')`
		)
		.run(ENVELOPE_ID, status, generation, repositoryHead, sentCommitSha);
	sqlite
		.prepare(
			`INSERT INTO audit_event (
				id, envelope_id, sequence, event_type, actor_type,
				actor_id, payload_json, previous_hash, event_hash, occurred_at
			 ) VALUES ('01960000-0000-7000-8000-0000000000a0', ?, 1, 'envelope.created', 'user',
				'user-1', '{}', 'genesis', 'head-hash', '2026-09-12T01:00:00.000Z')`
		)
		.run(ENVELOPE_ID);
}

function application(d1: D1Database): EnvelopeVoidApplication {
	return new EnvelopeVoidApplication(new D1EnvelopeVoidStore(d1), (): Date => new Date(VOIDED_AT));
}

function voidEnvelope(
	d1: D1Database,
	expectedStatus: VoidableEnvelopeStatus,
	expectedGeneration: number,
	idempotencyKey: string = 'void-1'
) {
	return application(d1).voidEnvelope(ACTOR, ENVELOPE_ID, {
		idempotencyKey,
		expectedStatus,
		expectedGeneration
	});
}

describe('D1 envelope void store integration', () => {
	it.each([
		['draft', 0, null, null],
		['ready', 2, 'head-2', null],
		['sent', 2, 'head-2', 'head-2'],
		['in_progress', 2, 'head-2', 'head-2']
	] as const)('voids %s envelopes with generation CAS', async (status, generation, head, sent) => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite, status, generation, head, sent);
			await expect(voidEnvelope(d1, status, generation)).resolves.toMatchObject({
				outcome: 'published',
				result: { status: 'voided', previousStatus: status, generation }
			});
			expect(sqlite.prepare('SELECT status FROM envelope').get()).toEqual({ status: 'voided' });
		} finally {
			sqlite.close();
		}
	});

	it('atomically scrubs deliveries, revokes exact capabilities, and replays evidence', async () => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite, 'sent', 3, 'head-3', 'head-3');
			sqlite.exec(`
				INSERT INTO recipient (
					id, envelope_id, email, name, role, locale, routing_order,
					status, capability_hash, capability_expires_at, capability_revoked_at,
					created_at, updated_at
				) VALUES
					('01930000-0000-7000-8000-000000000001','${ENVELOPE_ID}','r1@example.com','R1','signer','en',1,'pending','h1','2026-10-01',NULL,'2026-09-12','2026-09-12'),
					('01930000-0000-7000-8000-000000000002','${ENVELOPE_ID}','r2@example.com','R2','approver','ja',2,'pending','h2',NULL,NULL,'2026-09-12','2026-09-12'),
					('01930000-0000-7000-8000-000000000003','${ENVELOPE_ID}','r3@example.com','R3','signer','en',1,'completed','h3','2026-10-01','${VOIDED_AT}','2026-09-12','${VOIDED_AT}'),
					('01930000-0000-7000-8000-000000000004','${ENVELOPE_ID}','r4@example.com','R4','viewer','en',1,'viewed','h4','2026-10-01',NULL,'2026-09-12','2026-09-12'),
					('01930000-0000-7000-8000-000000000005','${ENVELOPE_ID}','r5@example.com','R5','signer','en',1,'completed','h5','2026-10-01','2026-09-12T01:30:00.000Z','2026-09-12','2026-09-12');
				INSERT INTO delivery_outbox (
					id, envelope_id, recipient_id, kind, status, capability_hash,
					reserved_capability_expires_at, sealed_capability, sealing_key_id,
					sealed_capability_sha256, available_at, attempts, created_at, updated_at, retryable
				) VALUES
					('01940000-0000-7000-8000-000000000001','${ENVELOPE_ID}','01930000-0000-7000-8000-000000000001','recipient_invitation','pending','h1','2026-10-01','sealed-1','key','sha-1','2026-09-12',0,'2026-09-12','2026-09-12',1),
					('01940000-0000-7000-8000-000000000002','${ENVELOPE_ID}','01930000-0000-7000-8000-000000000002','recipient_invitation','blocked','h2',NULL,'sealed-2','key','sha-2',NULL,0,'2026-09-12','2026-09-12',1),
					('01940000-0000-7000-8000-000000000003','${ENVELOPE_ID}','01930000-0000-7000-8000-000000000003','recipient_invitation','delivered','h3','2026-10-01',NULL,'key','sha-3','2026-09-12',1,'2026-09-12','2026-09-12',0),
					('01940000-0000-7000-8000-000000000004','${ENVELOPE_ID}','01930000-0000-7000-8000-000000000004','recipient_invitation','failed','h4','2026-10-01','sealed-4','key','sha-4','2026-09-12',2,'2026-09-12','2026-09-12',1),
					('01940000-0000-7000-8000-000000000005','${ENVELOPE_ID}','01930000-0000-7000-8000-000000000005','recipient_invitation','failed','h5','2026-10-01',NULL,'key','sha-5','2026-09-12',3,'2026-09-12','2026-09-12',0);
			`);

			await expect(voidEnvelope(d1, 'sent', 3)).resolves.toMatchObject({
				outcome: 'published',
				result: { revokedCapabilityCount: 3 }
			});
			await expect(voidEnvelope(d1, 'sent', 3)).resolves.toMatchObject({ outcome: 'replayed' });

			const recipients = sqlite
				.prepare('SELECT id, status, capability_revoked_at FROM recipient ORDER BY id')
				.all() as Record<string, unknown>[];
			expect(recipients.map((row) => row.status)).toEqual([
				'pending',
				'pending',
				'completed',
				'viewed',
				'completed'
			]);
			expect(
				recipients.filter((row) => row.capability_revoked_at === VOIDED_AT).map((row) => row.id)
			).toEqual([
				'01930000-0000-7000-8000-000000000001',
				'01930000-0000-7000-8000-000000000002',
				'01930000-0000-7000-8000-000000000003',
				'01930000-0000-7000-8000-000000000004'
			]);
			const deliveries = sqlite
				.prepare(
					'SELECT id, status, retryable, sealed_capability, last_error FROM delivery_outbox ORDER BY id'
				)
				.all() as Record<string, unknown>[];
			expect(deliveries.slice(0, 2).concat(deliveries.slice(3, 4))).toEqual([
				{
					id: '01940000-0000-7000-8000-000000000001',
					status: 'failed',
					retryable: 0,
					sealed_capability: null,
					last_error: 'envelope_terminal'
				},
				{
					id: '01940000-0000-7000-8000-000000000002',
					status: 'failed',
					retryable: 0,
					sealed_capability: null,
					last_error: 'envelope_terminal'
				},
				{
					id: '01940000-0000-7000-8000-000000000004',
					status: 'failed',
					retryable: 0,
					sealed_capability: null,
					last_error: 'envelope_terminal'
				}
			]);
			expect(deliveries[2]).toMatchObject({
				id: '01940000-0000-7000-8000-000000000003',
				status: 'delivered',
				last_error: null
			});
			expect(deliveries[4]).toMatchObject({
				id: '01940000-0000-7000-8000-000000000005',
				status: 'failed',
				last_error: null
			});
			const command = sqlite
				.prepare(
					'SELECT revoked_recipient_ids_json, revoked_recipient_count, audit_payload_json FROM envelope_void_command'
				)
				.get() as Record<string, unknown>;
			expect(command.revoked_recipient_ids_json).toBe(
				JSON.stringify([
					'01930000-0000-7000-8000-000000000001',
					'01930000-0000-7000-8000-000000000002',
					'01930000-0000-7000-8000-000000000004'
				])
			);
			expect(command.revoked_recipient_count).toBe(3);
			expect(JSON.parse(command.audit_payload_json as string)).toMatchObject({
				previousStatus: 'sent',
				generation: 3,
				revokedCapabilities: {
					reason: 'envelope_voided',
					recipientIds: [
						'01930000-0000-7000-8000-000000000001',
						'01930000-0000-7000-8000-000000000002',
						'01930000-0000-7000-8000-000000000004'
					]
				}
			});
		} finally {
			sqlite.close();
		}
	});

	it('fences processing delivery without partial writes and succeeds after release', async () => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite, 'sent', 1, 'head-1', 'head-1');
			sqlite.exec(`
				INSERT INTO recipient (
					id, envelope_id, email, name, role, locale, routing_order, status,
					capability_hash, capability_expires_at, created_at, updated_at
				) VALUES ('01930000-0000-7000-8000-000000000001','${ENVELOPE_ID}','r1@example.com','R1','signer','en',1,'pending',
					'h1','2026-10-01','2026-09-12','2026-09-12');
				INSERT INTO delivery_outbox (
					id, envelope_id, recipient_id, kind, status, capability_hash,
					reserved_capability_expires_at, sealed_capability, sealing_key_id,
					sealed_capability_sha256, available_at, attempts, locked_at, claim_token,
					created_at, updated_at, retryable
				) VALUES ('01940000-0000-7000-8000-000000000001','${ENVELOPE_ID}','01930000-0000-7000-8000-000000000001','recipient_invitation','processing','h1',
					'2026-10-01','sealed','key','sha','2026-09-12',1,'2026-09-12','claim-token-0001',
					'2026-09-12','2026-09-12',1);
			`);
			await expect(voidEnvelope(d1, 'sent', 1)).resolves.toEqual({ outcome: 'delivery_in_flight' });
			expect(sqlite.prepare('SELECT status FROM envelope').get()).toEqual({ status: 'sent' });
			expect(sqlite.prepare('SELECT count(*) AS count FROM envelope_void_command').get()).toEqual({
				count: 0
			});
			sqlite.exec(
				"UPDATE delivery_outbox SET status='pending', claim_token=NULL, locked_at=NULL WHERE id='01940000-0000-7000-8000-000000000001'"
			);
			await expect(voidEnvelope(d1, 'sent', 1)).resolves.toMatchObject({ outcome: 'published' });
		} finally {
			sqlite.close();
		}
	});

	it('scopes tenants and fails stale status, generation, or idempotency reuse closed', async () => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite, 'draft', 0);
			await expect(
				application(d1).voidEnvelope(ACTOR, '01900000-0000-7000-8000-000000000999', {
					idempotencyKey: 'void-1',
					expectedStatus: 'draft',
					expectedGeneration: 0
				})
			).resolves.toEqual({ outcome: 'not_found' });
			await expect(voidEnvelope(d1, 'ready', 0)).resolves.toEqual({ outcome: 'status_conflict' });
			await expect(voidEnvelope(d1, 'draft', 1)).resolves.toEqual({
				outcome: 'generation_conflict'
			});
			await expect(voidEnvelope(d1, 'draft', 0)).resolves.toMatchObject({ outcome: 'published' });
			await expect(voidEnvelope(d1, 'ready', 0)).resolves.toEqual({
				outcome: 'idempotency_conflict'
			});
			await expect(voidEnvelope(d1, 'draft', 0, 'fresh-key')).resolves.toEqual({
				outcome: 'not_voidable'
			});
			expect(sqlite.prepare('SELECT count(*) AS count FROM envelope_void_command').get()).toEqual({
				count: 1
			});
		} finally {
			sqlite.close();
		}
	});

	it('voids as an API-key agent and stamps audit hash v2 with that actor', async () => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite, 'draft', 0);
			await expect(
				application(d1).voidEnvelope(AGENT_ACTOR, ENVELOPE_ID, {
					idempotencyKey: 'void-agent',
					expectedStatus: 'draft',
					expectedGeneration: 0
				})
			).resolves.toMatchObject({ outcome: 'published', result: { status: 'voided' } });
			await expect(
				application(d1).voidEnvelope(AGENT_ACTOR, ENVELOPE_ID, {
					idempotencyKey: 'void-agent',
					expectedStatus: 'draft',
					expectedGeneration: 0
				})
			).resolves.toMatchObject({ outcome: 'replayed' });

			const event = sqlite
				.prepare(
					`SELECT actor_type, actor_id, hash_version, event_hash, payload_json, previous_hash,
						sequence, occurred_at
					 FROM audit_event WHERE event_type = 'envelope.voided'`
				)
				.get() as {
				actor_type: string;
				actor_id: string;
				hash_version: number;
				event_hash: string;
				payload_json: string;
				previous_hash: string;
				sequence: number;
				occurred_at: string;
			};
			expect(event).toMatchObject({
				actor_type: 'agent',
				actor_id: AGENT_ACTOR.id,
				hash_version: 3
			});
			await expect(
				hashStoredAuditEvent(
					{
						hashVersion: event.hash_version,
						sequence: event.sequence,
						eventType: 'envelope.voided',
						actorType: event.actor_type,
						actorId: event.actor_id,
						occurredAt: event.occurred_at,
						payload: JSON.parse(event.payload_json) as unknown,
						previousHash: event.previous_hash
					},
					{ envelopeId: ENVELOPE_ID }
				)
			).resolves.toBe(event.event_hash);
			expect(sqlite.prepare('SELECT actor_type FROM envelope_void_command').get()).toEqual({
				actor_type: 'agent'
			});
		} finally {
			sqlite.close();
		}
	});

	it('round-trips an API-key HTTP void through the D1 store as an agent', async () => {
		const { sqlite, d1 } = database();
		try {
			seedEnvelope(sqlite, 'ready', 1, 'head-1');
			const response: Response = await createEnvelopeVoidHandler(() => application(d1))(
				createHttpRequestEvent({
					pathname: `/api/v1/envelopes/${ENVELOPE_ID}/void`,
					method: 'POST',
					body: JSON.stringify({ expectedStatus: 'ready', expectedGeneration: 1 }),
					headers: { 'idempotency-key': 'void-http-agent' },
					locals: {
						apiKeyAuthentication: {
							state: 'authenticated',
							principal: {
								apiKeyId: AGENT_ACTOR.id,
								keyPrefix: 'signkit_abcdefgh',
								ownerUserId: 'user-1',
								scopes: ['envelopes:send'],
								expiresAt: '2026-12-11T00:00:00.000Z'
							}
						},
						identityState: 'anonymous',
						instanceMembership: null,
						bootstrapped: true,
						principal: null
					},
					params: { envelopeId: ENVELOPE_ID },
					jsonBodyContentType: true
				})
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				voided: { status: 'voided', previousStatus: 'ready', generation: 1 }
			});
			expect(
				sqlite
					.prepare(
						`SELECT command.actor_type AS actor_type, evidence.hash_version AS hash_version
						 FROM envelope_void_command command
						 JOIN audit_event evidence ON evidence.id = command.audit_event_id`
					)
					.get()
			).toEqual({ actor_type: 'agent', hash_version: 3 });
		} finally {
			sqlite.close();
		}
	});
});
