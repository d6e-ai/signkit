import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { EnvelopeSendApplication } from '$lib/application/envelopes/send';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';
import type { EnvelopeSendStore, PublishSentEnvelopeCommand } from '$lib/ports/envelope-send-store';
import type {
	CapabilitySealContext,
	RecipientCapabilitySealer
} from '$lib/security/delivery-capability';
import { D1EnvelopeSendStore } from './d1-envelope-send-store';
import { sqliteD1Database } from './sqlite-d1-test-support';

const MIGRATION_PATHS: readonly string[] = readdirSync('migrations/d1')
	.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
	.sort()
	.map((name: string): string => `migrations/d1/${name}`);
const ORGANIZATION_ID: string = 'org-send-integration';
const ENVELOPE_ID: string = 'env-send-integration';
const READY_AUDIT_ID: string = 'audit-ready';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const ACTOR: EnvelopeRequestActor = {
	id: 'user-send-integration',
	organizationId: ORGANIZATION_ID,
	organizationName: 'Integration Workspace'
};

function fixture(): { database: D1Database; sqlite: DatabaseSync } {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	for (const path of MIGRATION_PATHS) sqlite.exec(readFileSync(path, 'utf8'));
	sqlite.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${ORGANIZATION_ID}','${ORGANIZATION_ID}','Workspace','2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			repository_archive_key, repository_archive_sha256, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}','${ORGANIZATION_ID}','Agreement','draft',1,'${COMMIT_SHA}',
			'archives/integration.git.gz','${'a'.repeat(64)}',
			'2026-09-11T00:00:00.000Z','2026-09-11T00:02:00.000Z'
		);
		INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES
			('audit-created','${ORGANIZATION_ID}','${ENVELOPE_ID}',1,'envelope.created','user','${ACTOR.id}','{}',NULL,'hash-1','2026-09-11T00:00:00.000Z'),
			('audit-draft','${ORGANIZATION_ID}','${ENVELOPE_ID}',2,'draft.revision_created','user','${ACTOR.id}','{}','hash-1','hash-2','2026-09-11T00:01:00.000Z');
		INSERT INTO envelope_ready_command (
			organization_id, envelope_id, actor_type, actor_id, idempotency_key, request_hash,
			expected_generation, commit_sha, recipients_json, recipient_count, updated_at,
			audit_event_id, audit_sequence, previous_audit_hash, audit_event_hash, audit_payload_json
		) VALUES (
			'${ORGANIZATION_ID}','${ENVELOPE_ID}','user','${ACTOR.id}','ready-integration',
			'ready-request',1,'${COMMIT_SHA}','[]',4,'2026-09-11T00:02:00.000Z',
			'${READY_AUDIT_ID}',3,'hash-2','hash-3','{}'
		);
		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES
			('signer-a','${ORGANIZATION_ID}','${ENVELOPE_ID}','a@example.com','A','signer','en',1,'pending','2026-09-11T00:02:00.000Z','2026-09-11T00:02:00.000Z'),
			('signer-b','${ORGANIZATION_ID}','${ENVELOPE_ID}','b@example.com','B','signer','ja',1,'pending','2026-09-11T00:02:00.000Z','2026-09-11T00:02:00.000Z'),
			('signer-c','${ORGANIZATION_ID}','${ENVELOPE_ID}','c@example.com','C','signer','en',2,'pending','2026-09-11T00:02:00.000Z','2026-09-11T00:02:00.000Z'),
			('cc-d','${ORGANIZATION_ID}','${ENVELOPE_ID}','d@example.com','D','cc','ja',2,'pending','2026-09-11T00:02:00.000Z','2026-09-11T00:02:00.000Z');
	`);
	return { database: sqliteD1Database(sqlite), sqlite };
}

const sealer: RecipientCapabilitySealer = {
	seal: async (token: string, context: CapabilitySealContext) => {
		const sealedCapability: string = `sealed:${context.deliveryId}:${token}`;
		return {
			sealedCapability,
			sealingKeyId: 'integration-key',
			sealedCapabilitySha256: sha256(sealedCapability)
		};
	}
};

describe('D1EnvelopeSendStore SQLite integration', () => {
	it('publishes parallel initial recipients, blocks later routes, excludes CC, and replays', async () => {
		const { database, sqlite } = fixture();
		try {
			const application = new EnvelopeSendApplication(new D1EnvelopeSendStore(database), sealer);
			const input = {
				idempotencyKey: 'send-integration',
				expectedGeneration: 1,
				expectedReadyAuditEventId: READY_AUDIT_ID
			};
			const first = await application.send(ACTOR, ENVELOPE_ID, input);
			const replay = await application.send(ACTOR, ENVELOPE_ID, input);
			expect(first).toMatchObject({
				outcome: 'published',
				result: { queuedDeliveryCount: 2, reservedCapabilityCount: 3 }
			});
			if (first.outcome !== 'published') throw new Error('Expected the first send to publish');
			expect(replay).toEqual({ outcome: 'replayed', result: first.result });
			const deliveries = sqlite
				.prepare(
					`SELECT recipient_id, status, available_at, reserved_capability_expires_at
					 FROM delivery_outbox ORDER BY recipient_id`
				)
				.all() as Record<string, unknown>[];
			expect(deliveries).toEqual([
				expect.objectContaining({
					recipient_id: 'signer-a',
					status: 'pending',
					available_at: expect.any(String),
					reserved_capability_expires_at: expect.any(String)
				}),
				expect.objectContaining({
					recipient_id: 'signer-b',
					status: 'pending',
					available_at: expect.any(String),
					reserved_capability_expires_at: expect.any(String)
				}),
				{
					recipient_id: 'signer-c',
					status: 'blocked',
					available_at: null,
					reserved_capability_expires_at: null
				}
			]);
			const evidence = sqlite
				.prepare(
					`SELECT
						(SELECT COUNT(*) FROM envelope_send_command) AS commands,
						(SELECT COUNT(*) FROM audit_event WHERE event_type='envelope.sent') AS sent_events,
						(SELECT COUNT(*) FROM delivery_outbox) AS deliveries,
						(SELECT COUNT(*) FROM recipient WHERE role='cc' AND capability_hash IS NOT NULL) AS cc_capabilities`
				)
				.get() as Record<string, unknown>;
			expect(evidence).toEqual({
				commands: 1,
				sent_events: 1,
				deliveries: 3,
				cc_capabilities: 0
			});
			await expect(
				application.send(ACTOR, ENVELOPE_ID, {
					...input,
					expectedReadyAuditEventId: 'different-ready-audit'
				})
			).resolves.toEqual({ outcome: 'idempotency_conflict' });
		} finally {
			sqlite.close();
		}
	});

	it('rolls back every write when a delivery substitutes another envelope recipient', async () => {
		const { database, sqlite } = fixture();
		try {
			sqlite.exec(`
				INSERT INTO envelope (
					id, organization_id, title, status, repository_generation, repository_head,
					sent_commit_sha, created_at, updated_at
				) VALUES (
					'other-envelope','${ORGANIZATION_ID}','Other','sent',1,'other-commit','other-commit',
					'2026-09-11T00:00:00.000Z','2026-09-11T00:02:00.000Z'
				);
				INSERT INTO recipient (
					id, organization_id, envelope_id, email, name, role, locale, routing_order,
					status, created_at, updated_at
				) VALUES (
					'other-recipient','${ORGANIZATION_ID}','other-envelope','other@example.com',
					'Other','signer','en',1,'pending','2026-09-11T00:02:00.000Z',
					'2026-09-11T00:02:00.000Z'
				);
			`);
			const store = new D1EnvelopeSendStore(database);
			let captured: PublishSentEnvelopeCommand | null = null;
			const captureStore: EnvelopeSendStore = {
				prepareSend: store.prepareSend.bind(store),
				publishSend: async (command: PublishSentEnvelopeCommand) => {
					captured = command;
					return { outcome: 'integrity_error' };
				}
			};
			await new EnvelopeSendApplication(captureStore, sealer).send(ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'send-invalid-manifest',
				expectedGeneration: 1,
				expectedReadyAuditEventId: READY_AUDIT_ID
			});
			const command: PublishSentEnvelopeCommand = requiredCommand(captured);
			await expect(
				store.publishSend({
					...command,
					deliveries: command.deliveries.map((delivery, index: number) =>
						index === 0 ? { ...delivery, recipientId: 'other-recipient' } : delivery
					)
				})
			).rejects.toThrow(/invalid delivery recipient scope/);
			const evidence = sqlite
				.prepare(
					`SELECT envelope.status,
						(SELECT COUNT(*) FROM envelope_send_command) AS commands,
						(SELECT COUNT(*) FROM delivery_outbox) AS deliveries,
						(SELECT COUNT(*) FROM audit_event WHERE event_type='envelope.sent') AS sent_events,
						(SELECT COUNT(*) FROM recipient WHERE capability_hash IS NOT NULL) AS reserved_recipients
					 FROM envelope WHERE id='${ENVELOPE_ID}'`
				)
				.get() as Record<string, unknown>;
			expect(evidence).toEqual({
				status: 'ready',
				commands: 0,
				deliveries: 0,
				sent_events: 0,
				reserved_recipients: 0
			});
		} finally {
			sqlite.close();
		}
	});
});

function requiredCommand(command: PublishSentEnvelopeCommand | null): PublishSentEnvelopeCommand {
	if (command === null) throw new Error('Expected the send command to be captured');
	return command;
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}
