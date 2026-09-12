import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DraftPersistenceService } from '$lib/application/drafts/draft-persistence';
import { EnvelopeFieldApplication } from '$lib/application/envelopes/fields';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';
import {
	EnvelopeReadyApplication,
	type ReadyRecipientInput
} from '$lib/application/envelopes/ready';
import { EnvelopeSendApplication } from '$lib/application/envelopes/send';
import { EnvelopeVoidApplication } from '$lib/application/envelopes/void';
import {
	RecipientApprovedApplication,
	type RecipientApprovedResult
} from '$lib/application/signing/recipient-approved';
import { RecipientDeclinedApplication } from '$lib/application/signing/recipient-declined';
import { RecipientDeclinedReceiptApplication } from '$lib/application/signing/recipient-declined-receipt';
import {
	RecipientSignedApplication,
	type RecipientSignedResult
} from '$lib/application/signing/recipient-signed';
import type { EnvelopeField } from '$lib/domain/envelope';
import type { PublishFieldPlacementCommand } from '$lib/ports/envelope-field-store';
import type { PublishReadyEnvelopeCommand } from '$lib/ports/envelope-ready-store';
import type { EnvelopeSendStore, PublishSentEnvelopeCommand } from '$lib/ports/envelope-send-store';
import {
	AesGcmRecipientCapabilitySealer,
	type RecipientCapabilitySealer
} from '$lib/security/delivery-capability';
import { PostgresDeliveryOutboxStore } from './postgres-delivery-outbox-store';
import { PostgresEnvelopeFieldStore } from './postgres-envelope-field-store';
import { PostgresEnvelopeReadyStore } from './postgres-envelope-ready-store';
import { PostgresEnvelopeSendStore } from './postgres-envelope-send-store';
import { PostgresEnvelopeVoidStore } from './postgres-envelope-void-store';
import { PostgresRecipientApproveStore } from './postgres-recipient-approve-store';
import { PostgresRecipientDeclineStore } from './postgres-recipient-decline-store';
import { PostgresRecipientDeclinedReceiptStore } from './postgres-recipient-declined-receipt-store';
import { PostgresRecipientSignStore } from './postgres-recipient-sign-store';

const TEST_DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const CI_ENABLED: boolean =
	process.env.CI !== undefined &&
	process.env.CI.trim() !== '' &&
	!['0', 'false', 'no'].includes(process.env.CI.toLowerCase());
if (CI_ENABLED && TEST_DATABASE_URL === undefined) {
	throw new Error('POSTGRES_TEST_URL is required when PostgreSQL integration tests run in CI');
}
const postgresDescribe = TEST_DATABASE_URL === undefined ? describe.skip : describe;
const ORGANIZATION_ID: string = 'org-integration';
const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const ARCHIVE_SHA256: string = 'a'.repeat(64);
const TEST_DELIVERY_ENCRYPTION_KEY: string = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const ACTOR: EnvelopeRequestActor = {
	id: 'user-integration',
	organizationId: ORGANIZATION_ID,
	organizationName: 'Integration Workspace'
};
const MIGRATION_PATHS: readonly string[] = readdirSync('migrations/postgres')
	.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
	.sort()
	.map((name: string): string => `migrations/postgres/${name}`);

let sql: ReturnType<typeof postgres> | null = null;
const schemaName: string = `signkit_${process.pid}_${randomUUID().replaceAll('-', '')}`;

postgresDescribe('PostgreSQL migration and adapter integration', () => {
	beforeAll(async () => {
		const databaseUrl: string = TEST_DATABASE_URL as string;
		sql = postgres(databaseUrl, { max: 1, onnotice: (): void => undefined });
		await database().unsafe(`CREATE SCHEMA "${schemaName}"`);
		await database().unsafe(`SET search_path TO "${schemaName}"`);
		await database().unsafe(`SET TIME ZONE 'UTC'`);
		for (const path of MIGRATION_PATHS) {
			await database().unsafe(readFileSync(path, 'utf8'));
		}
	});

	beforeEach(async () => {
		await database().unsafe('TRUNCATE organization CASCADE');
	});

	afterAll(async () => {
		if (sql === null) return;
		await sql.unsafe('SET search_path TO public');
		await sql.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
		await sql.end({ timeout: 5 });
		sql = null;
	});

	it('applies every migration and enforces tenant, signer, and int32 field bounds', async () => {
		expect(MIGRATION_PATHS.at(-1)).toBe('migrations/postgres/0014_envelope_voided.sql');
		const relations = await database()<
			{ name: string }[]
		>`SELECT table_name AS name FROM information_schema.tables
			WHERE table_schema = ${schemaName} ORDER BY table_name`;
		expect(relations.map((row: { name: string }): string => row.name)).toEqual(
			expect.arrayContaining([
				'audit_event',
				'delivery_outbox',
				'envelope',
				'envelope_field',
				'envelope_send_command',
				'envelope_void_command',
				'field_value',
				'recipient'
			])
		);

		await seedDraftEnvelope();
		const ready = await readyEnvelope();
		const approverId: string = ready.recipients.find(
			(recipient): boolean => recipient.role === 'approver'
		)?.id as string;
		const fields = new PostgresEnvelopeFieldStore(database());
		const rejected = await fields.publishFieldPlacement(
			fieldCommand({
				recipientId: approverId,
				fieldId: '01900000-0000-7000-8000-000000000031',
				idempotencyKey: 'approver-field',
				auditEventId: '01900000-0000-7000-8000-000000000032',
				previousAuditHash: ready.auditEventHash
			})
		);
		expect(rejected).toEqual({ outcome: 'invalid_recipient' });

		await database()`INSERT INTO organization (id, d6e_organization_id, name, created_at)
			VALUES ('other-org', 'other-org', 'Other', now())`;
		await database()`INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			repository_archive_key, repository_archive_sha256, created_at, updated_at
		) VALUES (
			'other-envelope', 'other-org', 'Other Agreement', 'ready', 1, ${COMMIT_SHA},
			'other/archive', ${ARCHIVE_SHA256}, now(), now()
		)`;
		await database()`INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES (
			'other-recipient', 'other-org', 'other-envelope', 'other@example.com', 'Other',
			'signer', 'en', 1, 'pending', now(), now()
		)`;
		await expect(
			database()`INSERT INTO envelope_field (
				id, organization_id, envelope_id, recipient_id, document_path, field_type,
				label, required, position, created_at, updated_at
			) VALUES (
				'cross-tenant-field', ${ORGANIZATION_ID}, ${ENVELOPE_ID}, 'other-recipient',
				'documents/agreement.md', 'signature', 'Signature', true, 1, now(), now()
			)`
		).rejects.toMatchObject({ code: '23503' });
		await expect(
			database()`INSERT INTO delivery_outbox (
				id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
				reserved_capability_expires_at, sealed_capability, sealing_key_id,
				sealed_capability_sha256, available_at, attempts, created_at, updated_at,
				claim_token, retryable
			) VALUES (
				'cross-tenant-delivery', ${ORGANIZATION_ID}, ${ENVELOPE_ID}, 'other-recipient',
				'recipient_invitation', 'blocked', 'capability-hash', NULL,
				'sealed-capability', 'key-1', ${'e'.repeat(64)}, NULL, 0, now(), now(), NULL, true
			)`
		).rejects.toMatchObject({ code: '23503' });

		await database()`INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			repository_archive_key, repository_archive_sha256, created_at, updated_at
		) VALUES (
			'same-org-other-envelope', ${ORGANIZATION_ID}, 'Other Agreement', 'ready', 1,
			${COMMIT_SHA}, 'other/archive', ${ARCHIVE_SHA256}, now(), now()
		)`;
		await database()`INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES (
			'same-org-other-recipient', ${ORGANIZATION_ID}, 'same-org-other-envelope',
			'same-org-other@example.com', 'Other signer', 'signer', 'en', 1, 'pending', now(), now()
		)`;
		await expect(
			database()`INSERT INTO delivery_outbox (
				id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
				reserved_capability_expires_at, sealed_capability, sealing_key_id,
				sealed_capability_sha256, available_at, attempts, created_at, updated_at,
				claim_token, retryable
			) VALUES (
				'cross-envelope-delivery', ${ORGANIZATION_ID}, ${ENVELOPE_ID},
				'same-org-other-recipient', 'recipient_invitation', 'blocked', 'capability-hash',
				NULL, 'sealed-capability', 'key-1', ${'e'.repeat(64)}, NULL, 0, now(), now(),
				NULL, true
			)`
		).rejects.toMatchObject({ code: '23503' });
		await expect(
			database()`INSERT INTO envelope_field (
				id, organization_id, envelope_id, recipient_id, document_path, field_type,
				label, required, position, created_at, updated_at
			) VALUES (
				'same-org-cross-envelope-field', ${ORGANIZATION_ID}, ${ENVELOPE_ID},
				'same-org-other-recipient', 'documents/agreement.md', 'signature', 'Signature',
				true, 1, now(), now()
			)`
		).rejects.toMatchObject({ code: '23503' });

		await expect(
			database()`UPDATE envelope SET field_generation = ${2_147_483_648}
				WHERE organization_id = ${ORGANIZATION_ID} AND id = ${ENVELOPE_ID}`
		).rejects.toMatchObject({ code: '22003' });
		await expect(
			database()`INSERT INTO envelope_field_placement_command (
				organization_id, envelope_id, actor_type, actor_id, idempotency_key,
				request_hash, expected_generation, expected_field_generation, commit_sha,
				fields_json, field_count, updated_at, audit_event_id, audit_sequence,
				previous_audit_hash, audit_event_hash, audit_payload_json
			) VALUES (
				${ORGANIZATION_ID}, ${ENVELOPE_ID}, 'user', ${ACTOR.id}, 'overflow-command',
				${'c'.repeat(64)}, 1, ${2_147_483_647}, ${COMMIT_SHA}, '[]', 1, now(),
				'01900000-0000-7000-8000-000000000033', 4, ${ready.auditEventHash},
				${'d'.repeat(64)}, '{}'
			)`
		).rejects.toMatchObject({ code: '23514' });
		const generation = await database()<
			{ fieldGeneration: number }[]
		>`SELECT field_generation AS "fieldGeneration" FROM envelope
			WHERE organization_id = ${ORGANIZATION_ID} AND id = ${ENVELOPE_ID}`;
		expect(generation[0].fieldGeneration).toBe(0);
	});

	it('runs ready through field placement and send, then claims the delivery lease', async () => {
		await seedDraftEnvelope();
		const ready = await readyEnvelope();
		const signerId: string = ready.recipients.find(
			(recipient): boolean => recipient.role === 'signer'
		)?.id as string;
		const drafts = {
			readWorkspace: async () => ({
				generation: 1,
				commitSha: COMMIT_SHA,
				archiveKey: 'archives/integration.git.gz',
				archiveSha256: ARCHIVE_SHA256,
				documents: [{ path: 'documents/agreement.md', content: '# Agreement\n' }]
			})
		} as unknown as DraftPersistenceService;
		const fieldApplication = new EnvelopeFieldApplication(
			new PostgresEnvelopeFieldStore(database()),
			drafts
		);
		const fieldResult = await fieldApplication.place(ACTOR, ENVELOPE_ID, {
			idempotencyKey: 'fields-integration',
			expectedGeneration: 1,
			expectedFieldGeneration: 0,
			fields: [
				{
					recipientId: signerId,
					documentPath: 'documents/agreement.md',
					fieldType: 'signature',
					label: 'Signature',
					required: true,
					position: 1
				}
			]
		});
		expect(fieldResult).toMatchObject({
			outcome: 'published',
			result: { fieldGeneration: 1 }
		});
		const replacementResult = await fieldApplication.place(ACTOR, ENVELOPE_ID, {
			idempotencyKey: 'fields-replacement-integration',
			expectedGeneration: 1,
			expectedFieldGeneration: 1,
			fields: [
				{
					recipientId: signerId,
					documentPath: 'documents/agreement.md',
					fieldType: 'signature',
					label: 'Updated signature',
					required: true,
					position: 2
				},
				{
					recipientId: signerId,
					documentPath: 'documents/agreement.md',
					fieldType: 'date',
					label: 'Signed date',
					required: true,
					position: 3
				}
			]
		});
		expect(replacementResult).toMatchObject({
			outcome: 'published',
			result: { fieldGeneration: 2, fields: [{ position: 2 }, { position: 3 }] }
		});
		const replacedFields = await database()<
			{ label: string; position: number }[]
		>`SELECT label, position FROM envelope_field
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
			ORDER BY position`;
		expect(replacedFields).toEqual([
			{ label: 'Updated signature', position: 2 },
			{ label: 'Signed date', position: 3 }
		]);

		const sealer: RecipientCapabilitySealer = capabilitySealer();
		const sent = await new EnvelopeSendApplication(
			new PostgresEnvelopeSendStore(database()),
			sealer
		).send(ACTOR, ENVELOPE_ID, {
			idempotencyKey: 'send-integration',
			expectedGeneration: 1,
			expectedReadyAuditEventId: ready.auditEventId
		});
		expect(sent).toMatchObject({
			outcome: 'published',
			result: { status: 'sent', queuedDeliveryCount: 1, reservedCapabilityCount: 2 }
		});

		const envelopeRows = await database()<
			{ status: string; fieldGeneration: number; sentCommitSha: string | null }[]
		>`SELECT status, field_generation AS "fieldGeneration", sent_commit_sha AS "sentCommitSha"
			FROM envelope WHERE organization_id = ${ORGANIZATION_ID} AND id = ${ENVELOPE_ID}`;
		expect(envelopeRows[0]).toEqual({
			status: 'sent',
			fieldGeneration: 2,
			sentCommitSha: COMMIT_SHA
		});
		const auditTypes = await database()<
			{ eventType: string }[]
		>`SELECT event_type AS "eventType" FROM audit_event
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
			ORDER BY sequence`;
		expect(auditTypes.map((row: { eventType: string }): string => row.eventType)).toEqual([
			'envelope.created',
			'draft.revision_created',
			'envelope.ready',
			'envelope.fields_placed',
			'envelope.fields_placed',
			'envelope.sent'
		]);
		const outbox = await database()<
			{ status: string; availableAt: Date | null }[]
		>`SELECT status, available_at AS "availableAt" FROM delivery_outbox
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
			ORDER BY status`;
		expect(outbox).toHaveLength(2);
		expect(outbox.map((row: { status: string }): string => row.status).sort()).toEqual([
			'blocked',
			'pending'
		]);

		const claimedAt: string = new Date(Date.now() + 1_000).toISOString();
		const deliveryStore = new PostgresDeliveryOutboxStore(database());
		const claimed = await deliveryStore.claimPendingInvitations({
			claimToken: 'integration-claim-token',
			claimedAt,
			staleBefore: new Date(Date.parse(claimedAt) - 300_000).toISOString(),
			limit: 25
		});
		expect(claimed).toHaveLength(1);
		expect(claimed[0]).toMatchObject({ status: 'processing', attempts: 1 });
		await expect(
			deliveryStore.completeInvitationDelivery({
				organizationId: ORGANIZATION_ID,
				deliveryId: claimed[0].deliveryId,
				claimToken: 'integration-claim-token',
				deliveredAt: claimedAt,
				providerMessageId: '<integration@email.cloudflare.net>'
			})
		).resolves.toEqual({ outcome: 'completed' });
		const delivered = await database()<
			{ status: string; sealedCapability: string | null; retryable: boolean }[]
		>`SELECT status, sealed_capability AS "sealedCapability", retryable
			FROM delivery_outbox WHERE organization_id = ${ORGANIZATION_ID} AND id = ${claimed[0].deliveryId}`;
		expect(delivered[0]).toEqual({
			status: 'delivered',
			sealedCapability: null,
			retryable: false
		});
	});

	it('sends a legacy ready projection with prefill without issuing prefill authority', async () => {
		await seedDraftEnvelope();
		const ready = await readyEnvelope([
			{
				email: 'signer@example.com',
				name: 'Signer',
				role: 'signer',
				locale: 'en',
				routingOrder: 2
			}
		]);
		await database()`INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES (
			'legacy-prefill', ${ORGANIZATION_ID}, ${ENVELOPE_ID}, 'prefill@example.com', 'Prefill',
			'prefill', 'en', 1, 'pending', now(), now()
		)`;

		const application = new EnvelopeSendApplication(
			new PostgresEnvelopeSendStore(database()),
			capabilitySealer()
		);
		const input = {
			idempotencyKey: 'send-legacy-prefill',
			expectedGeneration: 1,
			expectedReadyAuditEventId: ready.auditEventId
		};
		const first = await application.send(ACTOR, ENVELOPE_ID, input);

		expect(first).toMatchObject({
			outcome: 'published',
			result: { queuedDeliveryCount: 1, reservedCapabilityCount: 1 }
		});
		if (first.outcome !== 'published') throw new Error('Expected legacy prefill send publication');
		await expect(application.send(ACTOR, ENVELOPE_ID, input)).resolves.toEqual({
			outcome: 'replayed',
			result: first.result
		});
		const projection = await database()<
			{ role: string; capabilityHash: string | null; deliveries: number }[]
		>`SELECT recipient.role, recipient.capability_hash AS "capabilityHash",
			COUNT(delivery.id)::int AS deliveries
			FROM recipient LEFT JOIN delivery_outbox AS delivery
				ON delivery.organization_id = recipient.organization_id
				AND delivery.envelope_id = recipient.envelope_id
				AND delivery.recipient_id = recipient.id
			WHERE recipient.organization_id = ${ORGANIZATION_ID}
				AND recipient.envelope_id = ${ENVELOPE_ID}
			GROUP BY recipient.role, recipient.capability_hash
			ORDER BY recipient.role`;
		expect(projection).toEqual([
			{ role: 'prefill', capabilityHash: null, deliveries: 0 },
			{ role: 'signer', capabilityHash: expect.any(String), deliveries: 1 }
		]);
	});

	it('replays after routing release and a permanent delivery failure', async () => {
		await seedDraftEnvelope();
		const ready = await readyEnvelope();
		const application = new EnvelopeSendApplication(
			new PostgresEnvelopeSendStore(database()),
			capabilitySealer()
		);
		const input = {
			idempotencyKey: 'send-lifecycle-replay',
			expectedGeneration: 1,
			expectedReadyAuditEventId: ready.auditEventId
		};
		const first = await application.send(ACTOR, ENVELOPE_ID, input);
		expect(first).toMatchObject({ outcome: 'published' });
		if (first.outcome !== 'published') throw new Error('Expected send publication');

		const releasedAt: string = new Date(Date.now() + 1_000).toISOString();
		const releasedExpiry: string = new Date(Date.now() + 13 * 24 * 60 * 60 * 1_000).toISOString();
		const blockedRows = await database()<
			{ recipientId: string }[]
		>`SELECT recipient_id AS "recipientId" FROM delivery_outbox
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
				AND status = 'blocked'`;
		expect(blockedRows).toHaveLength(1);
		await database().begin(async (transaction): Promise<void> => {
			await transaction`UPDATE recipient SET capability_expires_at = ${releasedExpiry},
				updated_at = ${releasedAt}
				WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
					AND id = ${blockedRows[0].recipientId}`;
			await transaction`UPDATE delivery_outbox SET status = 'pending',
				reserved_capability_expires_at = ${releasedExpiry}, available_at = ${releasedAt},
				updated_at = ${releasedAt}
				WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
					AND recipient_id = ${blockedRows[0].recipientId} AND status = 'blocked'`;
		});
		await expect(application.send(ACTOR, ENVELOPE_ID, input)).resolves.toEqual({
			outcome: 'replayed',
			result: first.result
		});

		const claimToken: string = 'postgres-lifecycle-claim';
		const claimedAt: string = new Date(Date.now() + 2_000).toISOString();
		const deliveryStore = new PostgresDeliveryOutboxStore(database());
		const claimed = await deliveryStore.claimPendingInvitations({
			claimToken,
			claimedAt,
			staleBefore: new Date(Date.parse(claimedAt) - 300_000).toISOString(),
			limit: 1
		});
		expect(claimed).toHaveLength(1);
		await expect(
			deliveryStore.failInvitationDelivery({
				organizationId: ORGANIZATION_ID,
				deliveryId: claimed[0].deliveryId,
				claimToken,
				errorCode: 'recipient_rejected',
				retryable: false,
				nextAvailableAt: claimedAt,
				failedAt: claimedAt
			})
		).resolves.toEqual({ outcome: 'failed' });
		await expect(application.send(ACTOR, ENVELOPE_ID, input)).resolves.toEqual({
			outcome: 'replayed',
			result: first.result
		});
		const mismatchedExpiry: string = new Date(
			Date.parse(claimed[0].capabilityExpiresAt as string) + 1_000
		).toISOString();
		await database()`UPDATE recipient SET capability_expires_at = ${mismatchedExpiry}
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
				AND id = ${claimed[0].recipientId}`;
		await expect(application.send(ACTOR, ENVELOPE_ID, input)).resolves.toEqual({
			outcome: 'integrity_error'
		});
	});

	it('fences in-flight invitation delivery and atomically scrubs terminal-envelope work', async () => {
		await seedDraftEnvelope();
		const ready = await readyEnvelope();
		const sealer = new AesGcmRecipientCapabilitySealer(TEST_DELIVERY_ENCRYPTION_KEY);
		const sent = await new EnvelopeSendApplication(
			new PostgresEnvelopeSendStore(database()),
			sealer
		).send(ACTOR, ENVELOPE_ID, {
			idempotencyKey: 'send-before-decline',
			expectedGeneration: 1,
			expectedReadyAuditEventId: ready.auditEventId
		});
		expect(sent).toMatchObject({ outcome: 'published' });

		const pending = await database()<
			{
				deliveryId: string;
				recipientId: string;
				sealedCapability: string;
			}[]
		>`SELECT id AS "deliveryId", recipient_id AS "recipientId",
			sealed_capability AS "sealedCapability"
			FROM delivery_outbox
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
				AND status = 'pending'`;
		expect(pending).toHaveLength(1);
		const token: string = await sealer.open(pending[0].sealedCapability, {
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			recipientId: pending[0].recipientId,
			deliveryId: pending[0].deliveryId
		});
		const declinedAt: string = new Date(Date.now() + 2_000).toISOString();
		const application = new RecipientDeclinedApplication(
			new PostgresRecipientDeclineStore(database()),
			() => new Date(declinedAt)
		);
		const input = {
			token,
			expectedEnvelopeId: ENVELOPE_ID,
			expectedRecipientId: pending[0].recipientId,
			idempotencyKey: 'decline-after-send'
		};

		await database()`UPDATE delivery_outbox
			SET status = 'processing', claim_token = 'postgres-claim-0001',
				locked_at = ${declinedAt}, updated_at = ${declinedAt}
			WHERE organization_id = ${ORGANIZATION_ID} AND id = ${pending[0].deliveryId}`;
		await expect(application.decline(input)).resolves.toEqual({ outcome: 'delivery_in_flight' });
		const unchanged = await database()<
			{ envelopeStatus: string; declinedCommands: number; declinedEvents: number }[]
		>`SELECT
			(SELECT status FROM envelope WHERE organization_id = ${ORGANIZATION_ID}
				AND id = ${ENVELOPE_ID}) AS "envelopeStatus",
			(SELECT COUNT(*)::int FROM recipient_declined_command) AS "declinedCommands",
			(SELECT COUNT(*)::int FROM audit_event WHERE event_type = 'recipient.declined') AS "declinedEvents"`;
		expect(unchanged[0]).toEqual({
			envelopeStatus: 'sent',
			declinedCommands: 0,
			declinedEvents: 0
		});

		await database()`UPDATE delivery_outbox
			SET status = 'pending', claim_token = NULL, locked_at = NULL
			WHERE organization_id = ${ORGANIZATION_ID} AND id = ${pending[0].deliveryId}`;
		await expect(application.decline(input)).resolves.toMatchObject({ outcome: 'published' });

		const deliveries = await database()<
			{
				status: string;
				retryable: boolean;
				sealedCapability: string | null;
				lastError: string | null;
			}[]
		>`SELECT status, retryable, sealed_capability AS "sealedCapability",
			last_error AS "lastError"
			FROM delivery_outbox
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
			ORDER BY id`;
		expect(deliveries).toHaveLength(2);
		for (const delivery of deliveries) {
			expect(delivery).toEqual({
				status: 'failed',
				retryable: false,
				sealedCapability: null,
				lastError: 'envelope_terminal'
			});
		}
		const evidence = await database()<
			{ version: number; ids: string; count: number; payload: string }[]
		>`SELECT revocation_evidence_version AS version,
			revoked_recipient_ids_json AS ids, revoked_recipient_count AS count,
			audit_payload_json AS payload
			FROM recipient_declined_command`;
		expect(evidence[0]).toMatchObject({ version: 2, count: 1 });
		const ids = JSON.parse(evidence[0].ids) as string[];
		expect(ids).toHaveLength(1);
		expect(JSON.parse(evidence[0].payload)).toMatchObject({
			revokedCapabilities: { reason: 'envelope_declined', recipientIds: ids }
		});

		const receiptApplication = new RecipientDeclinedReceiptApplication(
			new PostgresRecipientDeclinedReceiptStore(database())
		);
		const recovered = await receiptApplication.recoverByToken(
			token,
			new Date(Date.parse(declinedAt) + 24 * 60 * 60 * 1000)
		);
		expect(recovered).toMatchObject({
			receipt: {
				envelopeId: ENVELOPE_ID,
				recipientId: pending[0].recipientId,
				recipientStatus: 'declined',
				envelopeStatus: 'declined',
				declinedAt,
				locale: 'en'
			},
			locator: {
				organizationId: ORGANIZATION_ID,
				idempotencyKey: 'decline-after-send'
			}
		});
		if (recovered === null) throw new Error('Expected a durable declined receipt');
		await expect(
			receiptApplication.resolveLocator(
				recovered.locator,
				new Date(Date.parse(declinedAt) + 24 * 60 * 60 * 1000)
			)
		).resolves.toEqual(recovered);
		await expect(
			receiptApplication.resolveLocator(
				{ ...recovered.locator, idempotencyKey: 'different-decline' },
				new Date(Date.parse(declinedAt) + 24 * 60 * 60 * 1000)
			)
		).resolves.toBeNull();

		await database()`UPDATE recipient SET capability_revoked_at = NULL
				WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
					AND id <> ${pending[0].recipientId} AND status <> 'completed'`;
		await expect(
			receiptApplication.recoverByToken(
				token,
				new Date(Date.parse(declinedAt) + 24 * 60 * 60 * 1000)
			)
		).resolves.toBeNull();

		await database()`UPDATE recipient SET capability_revoked_at = ${declinedAt}
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
				AND id <> ${pending[0].recipientId} AND status <> 'completed'`;
		await expect(
			receiptApplication.recoverByToken(
				token,
				new Date(Date.parse(declinedAt) + 24 * 60 * 60 * 1000)
			)
		).resolves.not.toBeNull();
		await database()`UPDATE delivery_outbox
			SET status = 'pending', retryable = true, sealed_capability = 'restored-capability'
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
				AND recipient_id = ${pending[0].recipientId}`;
		await expect(
			receiptApplication.recoverByToken(
				token,
				new Date(Date.parse(declinedAt) + 24 * 60 * 60 * 1000)
			)
		).resolves.toBeNull();
	});

	it.each(['approver', 'signer'] as const)(
		'fences delivery and scrubs observer access when the final %s completes the envelope',
		async (role: 'approver' | 'signer') => {
			await seedDraftEnvelope();
			const ready = await readyEnvelope([
				{
					email: `${role}@example.com`,
					name: role === 'approver' ? 'Approver' : 'Signer',
					role,
					locale: 'en',
					routingOrder: 1
				},
				{
					email: 'viewer@example.com',
					name: 'Viewer',
					role: 'viewer',
					locale: 'ja',
					routingOrder: 1
				}
			]);
			const sealer = new AesGcmRecipientCapabilitySealer(TEST_DELIVERY_ENCRYPTION_KEY);
			await expect(
				new EnvelopeSendApplication(new PostgresEnvelopeSendStore(database()), sealer).send(
					ACTOR,
					ENVELOPE_ID,
					{
						idempotencyKey: `send-before-${role}-completion`,
						expectedGeneration: 1,
						expectedReadyAuditEventId: ready.auditEventId
					}
				)
			).resolves.toMatchObject({
				outcome: 'published',
				result: { queuedDeliveryCount: 2, reservedCapabilityCount: 2 }
			});

			const deliveryRows = await database()<
				{
					deliveryId: string;
					recipientId: string;
					role: string;
					sealedCapability: string;
				}[]
			>`SELECT delivery.id AS "deliveryId", delivery.recipient_id AS "recipientId",
				recipient.role, delivery.sealed_capability AS "sealedCapability"
			FROM delivery_outbox AS delivery
			JOIN recipient ON recipient.organization_id = delivery.organization_id
				AND recipient.envelope_id = delivery.envelope_id
				AND recipient.id = delivery.recipient_id
			WHERE delivery.organization_id = ${ORGANIZATION_ID}
				AND delivery.envelope_id = ${ENVELOPE_ID}
			ORDER BY delivery.id`;
			expect(deliveryRows).toHaveLength(2);
			const actorDelivery = deliveryRows.find(
				(row: { role: string }): boolean => row.role === role
			);
			if (actorDelivery === undefined) throw new Error(`Missing ${role} delivery`);
			const token: string = await sealer.open(actorDelivery.sealedCapability, {
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				recipientId: actorDelivery.recipientId,
				deliveryId: actorDelivery.deliveryId
			});
			const completedAt: string = new Date(Date.now() + 3_000).toISOString();
			await database()`UPDATE recipient SET status = 'viewed', updated_at = ${completedAt}
				WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
					AND id = ${actorDelivery.recipientId}`;
			const approveApplication = new RecipientApprovedApplication(
				new PostgresRecipientApproveStore(database()),
				(): Date => new Date(completedAt)
			);
			const signApplication = new RecipientSignedApplication(
				new PostgresRecipientSignStore(database()),
				(): Date => new Date(completedAt)
			);
			const invoke = async (): Promise<RecipientApprovedResult | RecipientSignedResult> =>
				role === 'approver'
					? approveApplication.approve({
							token,
							expectedEnvelopeId: ENVELOPE_ID,
							expectedRecipientId: actorDelivery.recipientId,
							idempotencyKey: `${role}-completion`
						})
					: signApplication.sign({
							token,
							expectedEnvelopeId: ENVELOPE_ID,
							expectedRecipientId: actorDelivery.recipientId,
							expectedFieldGeneration: 0,
							idempotencyKey: `${role}-completion`,
							values: []
						});

			await database()`UPDATE delivery_outbox
				SET status = 'processing', claim_token = ${`claim-${role}-0000000000000000`}, locked_at = ${completedAt},
					updated_at = ${completedAt}
				WHERE organization_id = ${ORGANIZATION_ID} AND id = ${actorDelivery.deliveryId}`;
			await expect(invoke()).resolves.toEqual({ outcome: 'delivery_in_flight' });
			const fenced = await database()<
				{ envelopeStatus: string; approvedCommands: number; signedCommands: number }[]
			>`SELECT
				(SELECT status FROM envelope WHERE organization_id = ${ORGANIZATION_ID}
					AND id = ${ENVELOPE_ID}) AS "envelopeStatus",
				(SELECT COUNT(*)::int FROM recipient_approved_command) AS "approvedCommands",
				(SELECT COUNT(*)::int FROM recipient_signed_command) AS "signedCommands"`;
			expect(fenced[0]).toEqual({
				envelopeStatus: 'sent',
				approvedCommands: 0,
				signedCommands: 0
			});

			await database()`UPDATE delivery_outbox
				SET status = 'pending', claim_token = NULL, locked_at = NULL
				WHERE organization_id = ${ORGANIZATION_ID} AND id = ${actorDelivery.deliveryId}`;
			await expect(invoke()).resolves.toMatchObject({
				outcome: 'published',
				result: { envelopeStatus: 'completed' }
			});
			await expect(invoke()).resolves.toMatchObject({ outcome: 'replayed' });

			const recipientRows = await database()<
				{ role: string; status: string; revokedAt: Date | null }[]
			>`SELECT role, status, capability_revoked_at AS "revokedAt"
				FROM recipient WHERE organization_id = ${ORGANIZATION_ID}
					AND envelope_id = ${ENVELOPE_ID} ORDER BY role`;
			expect(recipientRows).toHaveLength(2);
			expect(
				recipientRows.find((row: { role: string }): boolean => row.role === role)
			).toMatchObject({ status: 'completed', revokedAt: expect.any(Date) });
			expect(
				recipientRows.find((row: { role: string }): boolean => row.role === 'viewer')
			).toMatchObject({ status: 'pending', revokedAt: expect.any(Date) });
			const terminal = await database()<
				{
					envelopeStatus: string;
					unsafeDeliveries: number;
					terminalDeliveries: number;
					completedEvents: number;
				}[]
			>`SELECT envelope.status AS "envelopeStatus",
				(SELECT COUNT(*)::int FROM delivery_outbox AS delivery
				 WHERE delivery.organization_id = envelope.organization_id
					AND delivery.envelope_id = envelope.id
					AND (delivery.status IN ('blocked', 'pending', 'processing')
						OR delivery.retryable OR delivery.sealed_capability IS NOT NULL))
					AS "unsafeDeliveries",
				(SELECT COUNT(*)::int FROM delivery_outbox AS delivery
				 WHERE delivery.organization_id = envelope.organization_id
					AND delivery.envelope_id = envelope.id AND delivery.status = 'failed'
					AND NOT delivery.retryable AND delivery.sealed_capability IS NULL
					AND delivery.claim_token IS NULL AND delivery.locked_at IS NULL
					AND delivery.last_error = 'envelope_terminal') AS "terminalDeliveries",
				(SELECT COUNT(*)::int FROM audit_event AS audit
				 WHERE audit.organization_id = envelope.organization_id
					AND audit.envelope_id = envelope.id
					AND audit.event_type = 'envelope.completed') AS "completedEvents"
			FROM envelope WHERE organization_id = ${ORGANIZATION_ID} AND id = ${ENVELOPE_ID}`;
			expect(terminal[0]).toEqual({
				envelopeStatus: 'completed',
				unsafeDeliveries: 0,
				terminalDeliveries: 2,
				completedEvents: 1
			});
		}
	);

	it('voids under PostgreSQL locks, fences delivery, and replays terminal evidence', async () => {
		await seedDraftEnvelope();
		const ready = await readyEnvelope();
		await expect(
			new EnvelopeSendApplication(
				new PostgresEnvelopeSendStore(database()),
				capabilitySealer()
			).send(ACTOR, ENVELOPE_ID, {
				idempotencyKey: 'send-before-void',
				expectedGeneration: 1,
				expectedReadyAuditEventId: ready.auditEventId
			})
		).resolves.toMatchObject({ outcome: 'published' });
		const voidedAt: string = new Date(Date.now() + 4_000).toISOString();
		const application = new EnvelopeVoidApplication(
			new PostgresEnvelopeVoidStore(database()),
			(): Date => new Date(voidedAt)
		);
		const input = {
			idempotencyKey: 'void-after-send',
			expectedStatus: 'sent' as const,
			expectedGeneration: 1
		};
		const pending = await database()<{ id: string }[]>`
			SELECT id FROM delivery_outbox WHERE organization_id = ${ORGANIZATION_ID}
				AND envelope_id = ${ENVELOPE_ID} AND status = 'pending'`;
		expect(pending).toHaveLength(1);
		await database()`UPDATE delivery_outbox SET status = 'processing',
			claim_token = 'postgres-void-claim', locked_at = ${voidedAt}
			WHERE organization_id = ${ORGANIZATION_ID} AND id = ${pending[0].id}`;
		await expect(application.voidEnvelope(ACTOR, ENVELOPE_ID, input)).resolves.toEqual({
			outcome: 'delivery_in_flight'
		});
		const beforeRelease = await database()<{ status: string; commands: number }[]>`
			SELECT status, (SELECT COUNT(*)::int FROM envelope_void_command) AS commands
			FROM envelope WHERE organization_id = ${ORGANIZATION_ID} AND id = ${ENVELOPE_ID}`;
		expect(beforeRelease).toEqual([{ status: 'sent', commands: 0 }]);

		await database()`UPDATE delivery_outbox SET status = 'pending', claim_token = NULL,
			locked_at = NULL WHERE organization_id = ${ORGANIZATION_ID} AND id = ${pending[0].id}`;
		await expect(application.voidEnvelope(ACTOR, ENVELOPE_ID, input)).resolves.toMatchObject({
			outcome: 'published',
			result: { status: 'voided', previousStatus: 'sent', generation: 1 }
		});
		await expect(application.voidEnvelope(ACTOR, ENVELOPE_ID, input)).resolves.toMatchObject({
			outcome: 'replayed'
		});
		const evidence = await database()<
			{
				status: string;
				unsafeDeliveries: number;
				commands: number;
				voidedEvents: number;
				ids: string;
				payload: string;
			}[]
		>`SELECT envelope.status,
			(SELECT COUNT(*)::int FROM delivery_outbox delivery
			 WHERE delivery.organization_id = envelope.organization_id
				AND delivery.envelope_id = envelope.id
				AND (delivery.retryable OR delivery.sealed_capability IS NOT NULL
					OR delivery.status IN ('blocked','pending','processing'))) AS "unsafeDeliveries",
			(SELECT COUNT(*)::int FROM envelope_void_command) AS commands,
			(SELECT COUNT(*)::int FROM audit_event WHERE event_type = 'envelope.voided') AS "voidedEvents",
			command.revoked_recipient_ids_json AS ids, command.audit_payload_json AS payload
		FROM envelope JOIN envelope_void_command command
			ON command.organization_id = envelope.organization_id AND command.envelope_id = envelope.id
		WHERE envelope.organization_id = ${ORGANIZATION_ID} AND envelope.id = ${ENVELOPE_ID}`;
		expect(evidence[0]).toMatchObject({
			status: 'voided',
			unsafeDeliveries: 0,
			commands: 1,
			voidedEvents: 1
		});
		const ids = JSON.parse(evidence[0].ids) as string[];
		expect(JSON.parse(evidence[0].payload)).toMatchObject({
			previousStatus: 'sent',
			generation: 1,
			revokedCapabilities: { reason: 'envelope_voided', recipientIds: ids }
		});
	});

	it('serializes two real concurrent sends into one publication and one replay', async () => {
		await seedDraftEnvelope();
		const ready = await readyEnvelope();
		const concurrentSql = postgres(TEST_DATABASE_URL as string, {
			max: 2,
			onnotice: (): void => undefined,
			connection: { search_path: schemaName, TimeZone: 'UTC' }
		});
		try {
			const stores: readonly EnvelopeSendStore[] = synchronizePublish([
				new PostgresEnvelopeSendStore(concurrentSql),
				new PostgresEnvelopeSendStore(concurrentSql)
			]);
			const input = {
				idempotencyKey: 'send-concurrent',
				expectedGeneration: 1,
				expectedReadyAuditEventId: ready.auditEventId
			};
			const results = await Promise.all(
				stores.map((store: EnvelopeSendStore) =>
					new EnvelopeSendApplication(store, capabilitySealer()).send(ACTOR, ENVELOPE_ID, input)
				)
			);
			expect(results.map((result): string => result.outcome).sort()).toEqual([
				'published',
				'replayed'
			]);
			const evidence = await database()<
				{ commands: number; sentEvents: number; deliveries: number }[]
			>`SELECT
				(SELECT COUNT(*)::int FROM envelope_send_command) AS commands,
				(SELECT COUNT(*)::int FROM audit_event WHERE event_type = 'envelope.sent') AS "sentEvents",
				(SELECT COUNT(*)::int FROM delivery_outbox) AS deliveries`;
			expect(evidence).toEqual([{ commands: 1, sentEvents: 1, deliveries: 2 }]);
		} finally {
			await concurrentSql.end({ timeout: 5 });
		}
	});

	it('upgrades every pre-lease delivery state without losing retryable work', async () => {
		const upgradeSchema: string = `${schemaName}_upgrade`;
		const leaseMigrationIndex: number = MIGRATION_PATHS.indexOf(
			'migrations/postgres/0011_delivery_outbox_leases.sql'
		);
		expect(leaseMigrationIndex).toBeGreaterThan(0);
		await database().unsafe(`CREATE SCHEMA "${upgradeSchema}"`);
		try {
			await database().unsafe(`SET search_path TO "${upgradeSchema}"`);
			for (const path of MIGRATION_PATHS.slice(0, leaseMigrationIndex)) {
				await database().unsafe(readFileSync(path, 'utf8'));
			}
			await database().unsafe(`
				INSERT INTO organization (id, d6e_organization_id, name, created_at)
				VALUES ('upgrade-org','upgrade-org','Upgrade Workspace','2026-09-11T00:00:00.000Z');
				INSERT INTO envelope (
					id, organization_id, title, status, repository_generation, repository_head,
					sent_commit_sha, created_at, updated_at
				) VALUES (
					'upgrade-envelope','upgrade-org','Agreement','sent',1,'commit-1','commit-1',
					'2026-09-11T00:00:00.000Z','2026-09-11T00:01:00.000Z'
				);
				INSERT INTO recipient (
					id, organization_id, envelope_id, email, name, role, locale, routing_order,
					status, capability_hash, capability_expires_at, created_at, updated_at
				) VALUES
					('recipient-pending','upgrade-org','upgrade-envelope','pending@example.com','Pending','signer','en',1,'pending','hash-pending','2026-09-25T00:00:00.000Z','2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'),
					('recipient-processing','upgrade-org','upgrade-envelope','processing@example.com','Processing','signer','en',2,'pending','hash-processing','2026-09-25T00:00:00.000Z','2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'),
					('recipient-failed','upgrade-org','upgrade-envelope','failed@example.com','Failed','signer','en',3,'pending','hash-failed','2026-09-25T00:00:00.000Z','2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'),
					('recipient-delivered','upgrade-org','upgrade-envelope','delivered@example.com','Delivered','signer','en',4,'pending','hash-delivered','2026-09-25T00:00:00.000Z','2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'),
					('recipient-blocked','upgrade-org','upgrade-envelope','blocked@example.com','Blocked','signer','en',5,'pending','hash-blocked','2026-09-25T00:00:00.000Z','2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z');
				INSERT INTO delivery_outbox (
					id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
					reserved_capability_expires_at, sealed_capability, sealing_key_id,
					sealed_capability_sha256, available_at, attempts, locked_at, delivered_at,
					provider_message_id, last_error, created_at, updated_at
				) VALUES
					('delivery-pending','upgrade-org','upgrade-envelope','recipient-pending','recipient_invitation','pending','hash-pending','2026-09-25T00:00:00.000Z','sealed-pending','key-1','sealed-hash-pending','2026-09-11T00:01:00.000Z',0,NULL,NULL,NULL,NULL,'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'),
					('delivery-processing','upgrade-org','upgrade-envelope','recipient-processing','recipient_invitation','processing','hash-processing','2026-09-25T00:00:00.000Z','sealed-processing','key-1','sealed-hash-processing','2026-09-11T00:01:00.000Z',1,'2026-09-11T00:02:00.000Z',NULL,NULL,NULL,'2026-09-11T00:01:00.000Z','2026-09-11T00:02:00.000Z'),
					('delivery-failed','upgrade-org','upgrade-envelope','recipient-failed','recipient_invitation','failed','hash-failed','2026-09-25T00:00:00.000Z','sealed-failed','key-1','sealed-hash-failed','2026-09-11T00:01:00.000Z',1,NULL,NULL,NULL,'transient','2026-09-11T00:01:00.000Z','2026-09-11T00:02:00.000Z'),
					('delivery-delivered','upgrade-org','upgrade-envelope','recipient-delivered','recipient_invitation','delivered','hash-delivered','2026-09-25T00:00:00.000Z','sealed-delivered','key-1','sealed-hash-delivered','2026-09-11T00:01:00.000Z',1,NULL,'2026-09-11T00:03:00.000Z','provider-id',NULL,'2026-09-11T00:01:00.000Z','2026-09-11T00:03:00.000Z'),
					('delivery-blocked','upgrade-org','upgrade-envelope','recipient-blocked','recipient_invitation','blocked','hash-blocked','2026-09-25T00:00:00.000Z','sealed-blocked','key-1','sealed-hash-blocked',NULL,0,NULL,NULL,NULL,NULL,'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z');
			`);

			for (const path of MIGRATION_PATHS.slice(leaseMigrationIndex)) {
				await database().unsafe(readFileSync(path, 'utf8'));
			}
			const rows = await database()<
				{
					id: string;
					status: string;
					claimToken: string | null;
					lockedAt: Date | null;
					sealedCapability: string | null;
					retryable: boolean;
					lastError: string | null;
				}[]
			>`SELECT id, status, claim_token AS "claimToken", locked_at AS "lockedAt",
				sealed_capability AS "sealedCapability", retryable, last_error AS "lastError"
			FROM delivery_outbox ORDER BY id`;
			expect(rows).toEqual([
				{
					id: 'delivery-blocked',
					status: 'blocked',
					claimToken: null,
					lockedAt: null,
					sealedCapability: 'sealed-blocked',
					retryable: true,
					lastError: null
				},
				{
					id: 'delivery-delivered',
					status: 'delivered',
					claimToken: null,
					lockedAt: null,
					sealedCapability: null,
					retryable: false,
					lastError: null
				},
				{
					id: 'delivery-failed',
					status: 'failed',
					claimToken: null,
					lockedAt: null,
					sealedCapability: 'sealed-failed',
					retryable: true,
					lastError: 'transient'
				},
				{
					id: 'delivery-pending',
					status: 'pending',
					claimToken: null,
					lockedAt: null,
					sealedCapability: 'sealed-pending',
					retryable: true,
					lastError: null
				},
				{
					id: 'delivery-processing',
					status: 'failed',
					claimToken: null,
					lockedAt: null,
					sealedCapability: 'sealed-processing',
					retryable: true,
					lastError: 'worker_restarted'
				}
			]);
		} finally {
			await database().unsafe(`SET search_path TO "${schemaName}"`);
			await database().unsafe(`DROP SCHEMA IF EXISTS "${upgradeSchema}" CASCADE`);
		}
	});

	it('rolls back invalid ready evidence and a failed replace-all field insert', async () => {
		await seedDraftEnvelope();
		const invalidReady: PublishReadyEnvelopeCommand = {
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			actorType: 'user',
			actorId: ACTOR.id,
			idempotencyKey: 'invalid-ready-anchor',
			requestFingerprint: '1'.repeat(64),
			expectedGeneration: 1,
			expectedCommitSha: COMMIT_SHA,
			recipients: [
				{
					id: '01900000-0000-7000-8000-000000000041',
					organizationId: ORGANIZATION_ID,
					envelopeId: ENVELOPE_ID,
					email: 'invalid@example.com',
					name: 'Invalid',
					role: 'signer',
					locale: 'en',
					routingOrder: 1,
					status: 'pending'
				}
			],
			updatedAt: new Date().toISOString(),
			expectedAuditSequence: 2,
			previousAuditHash: 'wrong-audit-head',
			auditEventId: '01900000-0000-7000-8000-000000000042',
			auditEventHash: '2'.repeat(64),
			auditPayloadJson: '{}'
		};
		await expect(
			new PostgresEnvelopeReadyStore(database()).publishReady(invalidReady)
		).resolves.toEqual({ outcome: 'audit_conflict' });
		const unchanged = await database()<
			{ status: string; commands: number; recipients: number }[]
		>`SELECT envelope.status,
			(SELECT COUNT(*)::int FROM envelope_ready_command) AS commands,
			(SELECT COUNT(*)::int FROM recipient) AS recipients
			FROM envelope WHERE organization_id = ${ORGANIZATION_ID} AND id = ${ENVELOPE_ID}`;
		expect(unchanged[0]).toEqual({ status: 'draft', commands: 0, recipients: 0 });

		const ready = await readyEnvelope();
		const signerId: string = ready.recipients.find(
			(recipient): boolean => recipient.role === 'signer'
		)?.id as string;
		const store = new PostgresEnvelopeFieldStore(database());
		const initialCommand = fieldCommand({
			recipientId: signerId,
			fieldId: '01900000-0000-7000-8000-000000000051',
			idempotencyKey: 'initial-fields',
			auditEventId: '01900000-0000-7000-8000-000000000052',
			previousAuditHash: ready.auditEventHash
		});
		await expect(store.publishFieldPlacement(initialCommand)).resolves.toMatchObject({
			outcome: 'published'
		});
		const sendStore = new PostgresEnvelopeSendStore(database());
		let capturedSend: PublishSentEnvelopeCommand | null = null;
		const captureStore: EnvelopeSendStore = {
			prepareSend: sendStore.prepareSend.bind(sendStore),
			publishSend: async (command: PublishSentEnvelopeCommand) => {
				capturedSend = command;
				return { outcome: 'integrity_error' };
			}
		};
		await new EnvelopeSendApplication(captureStore, capabilitySealer()).send(ACTOR, ENVELOPE_ID, {
			idempotencyKey: 'capture-invalid-ready-anchor-send',
			expectedGeneration: 1,
			expectedReadyAuditEventId: ready.auditEventId
		});
		const sendCommand: PublishSentEnvelopeCommand = requiredSendCommand(capturedSend);
		const rejectedSend = await sendStore.publishSend({
			...sendCommand,
			expectedReadyAuditEventId: initialCommand.auditEventId
		});
		expect(rejectedSend).toEqual({ outcome: 'audit_conflict' });
		const rejectedSendEvidence = await database()<
			{ status: string; commands: number; deliveries: number; sentEvents: number }[]
		>`SELECT envelope.status,
			(SELECT COUNT(*)::int FROM envelope_send_command) AS commands,
			(SELECT COUNT(*)::int FROM delivery_outbox) AS deliveries,
			(SELECT COUNT(*)::int FROM audit_event WHERE event_type = 'envelope.sent') AS "sentEvents"
			FROM envelope WHERE organization_id = ${ORGANIZATION_ID} AND id = ${ENVELOPE_ID}`;
		expect(rejectedSendEvidence).toEqual([
			{ status: 'ready', commands: 0, deliveries: 0, sentEvents: 0 }
		]);
		const replacement: PublishFieldPlacementCommand = {
			...fieldCommand({
				recipientId: signerId,
				fieldId: '01900000-0000-7000-8000-000000000053',
				idempotencyKey: 'replacement-fields',
				auditEventId: '01900000-0000-7000-8000-000000000054',
				expectedFieldGeneration: 1,
				expectedAuditSequence: 4,
				previousAuditHash: initialCommand.auditEventHash
			}),
			fields: [
				{
					...initialCommand.fields[0],
					id: '01900000-0000-7000-8000-000000000053',
					position: 2
				},
				{
					...initialCommand.fields[0],
					id: '01900000-0000-7000-8000-000000000055',
					position: 100_001
				}
			]
		};
		await expect(store.publishFieldPlacement(replacement)).rejects.toMatchObject({
			code: '23514'
		});
		const afterRollback = await database()<
			{
				fieldGeneration: number;
				fieldId: string;
				failedCommandCount: number;
				failedAuditCount: number;
			}[]
		>`SELECT envelope.field_generation AS "fieldGeneration", field.id AS "fieldId",
			(SELECT COUNT(*)::int FROM envelope_field_placement_command
				WHERE idempotency_key = 'replacement-fields') AS "failedCommandCount",
			(SELECT COUNT(*)::int FROM audit_event
				WHERE id = '01900000-0000-7000-8000-000000000054') AS "failedAuditCount"
			FROM envelope JOIN envelope_field field
				ON field.organization_id = envelope.organization_id AND field.envelope_id = envelope.id
			WHERE envelope.organization_id = ${ORGANIZATION_ID} AND envelope.id = ${ENVELOPE_ID}`;
		expect(afterRollback).toEqual([
			{
				fieldGeneration: 1,
				fieldId: initialCommand.fields[0].id,
				failedCommandCount: 0,
				failedAuditCount: 0
			}
		]);
	});
});

function database(): ReturnType<typeof postgres> {
	if (sql === null) throw new Error('PostgreSQL integration database is unavailable');
	return sql;
}

function requiredSendCommand(
	command: PublishSentEnvelopeCommand | null
): PublishSentEnvelopeCommand {
	if (command === null) throw new Error('Expected the send command to be captured');
	return command;
}

function synchronizePublish(delegates: readonly EnvelopeSendStore[]): readonly EnvelopeSendStore[] {
	let arrivals: number = 0;
	let release: (() => void) | null = null;
	const gate: Promise<void> = new Promise<void>((resolve: () => void): void => {
		release = resolve;
	});
	return delegates.map((delegate: EnvelopeSendStore): EnvelopeSendStore => ({
		prepareSend: delegate.prepareSend.bind(delegate),
		publishSend: async (command: PublishSentEnvelopeCommand) => {
			arrivals += 1;
			if (arrivals === delegates.length) release?.();
			await gate;
			return await delegate.publishSend(command);
		}
	}));
}

async function seedDraftEnvelope(): Promise<void> {
	await database()`INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES (${ORGANIZATION_ID}, ${ORGANIZATION_ID}, 'Workspace', '2026-09-11T00:00:00.000Z')`;
	await database()`INSERT INTO envelope (
		id, organization_id, title, status, repository_generation, repository_head,
		repository_archive_key, repository_archive_sha256, created_at, updated_at
	) VALUES (
		${ENVELOPE_ID}, ${ORGANIZATION_ID}, 'Agreement', 'draft', 1, ${COMMIT_SHA},
		'archives/integration.git.gz', ${ARCHIVE_SHA256},
		'2026-09-11T00:00:00.000Z', '2026-09-11T00:01:00.000Z'
	)`;
	await database()`INSERT INTO audit_event (
		id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
		payload_json, previous_hash, event_hash, occurred_at
	) VALUES
		('01900000-0000-7000-8000-000000000011', ${ORGANIZATION_ID}, ${ENVELOPE_ID}, 1,
		 'envelope.created', 'user', ${ACTOR.id}, '{}', NULL, ${'a'.repeat(64)},
		 '2026-09-11T00:00:00.000Z'),
		('01900000-0000-7000-8000-000000000012', ${ORGANIZATION_ID}, ${ENVELOPE_ID}, 2,
		 'draft.revision_created', 'user', ${ACTOR.id}, '{}', ${'a'.repeat(64)}, ${'b'.repeat(64)},
		 '2026-09-11T00:01:00.000Z')`;
}

async function readyEnvelope(
	recipients: readonly ReadyRecipientInput[] = [
		{
			email: 'signer@example.com',
			name: 'Signer',
			role: 'signer',
			locale: 'en',
			routingOrder: 1
		},
		{
			email: 'approver@example.com',
			name: 'Approver',
			role: 'approver',
			locale: 'ja',
			routingOrder: 2
		}
	]
): Promise<{
	recipients: readonly { id: string; role: string }[];
	auditEventId: string;
	auditEventHash: string;
}> {
	const result = await new EnvelopeReadyApplication(
		new PostgresEnvelopeReadyStore(database())
	).ready(ACTOR, ENVELOPE_ID, {
		idempotencyKey: 'ready-integration',
		expectedGeneration: 1,
		recipients
	});
	if (result.outcome !== 'published') {
		throw new Error(`Ready integration failed with ${result.outcome}`);
	}
	const audit = await database()<
		{ eventHash: string }[]
	>`SELECT event_hash AS "eventHash" FROM audit_event
		WHERE organization_id = ${ORGANIZATION_ID} AND id = ${result.result.auditEventId}`;
	return {
		recipients: result.result.recipients,
		auditEventId: result.result.auditEventId,
		auditEventHash: audit[0].eventHash
	};
}

function fieldCommand(options: {
	recipientId: string;
	fieldId: string;
	idempotencyKey: string;
	auditEventId: string;
	expectedFieldGeneration?: number;
	expectedAuditSequence?: number;
	previousAuditHash?: string;
}): PublishFieldPlacementCommand {
	const field: EnvelopeField = {
		id: options.fieldId,
		organizationId: ORGANIZATION_ID,
		envelopeId: ENVELOPE_ID,
		recipientId: options.recipientId,
		documentPath: 'documents/agreement.md',
		fieldType: 'signature',
		label: 'Signature',
		required: true,
		position: 1
	};
	return {
		organizationId: ORGANIZATION_ID,
		envelopeId: ENVELOPE_ID,
		actorType: 'user',
		actorId: ACTOR.id,
		idempotencyKey: options.idempotencyKey,
		requestFingerprint: sha256(options.idempotencyKey),
		expectedGeneration: 1,
		expectedFieldGeneration: options.expectedFieldGeneration ?? 0,
		expectedCommitSha: COMMIT_SHA,
		fields: [field],
		updatedAt: new Date().toISOString(),
		expectedAuditSequence: options.expectedAuditSequence ?? 3,
		previousAuditHash: options.previousAuditHash ?? 'missing-audit-head',
		auditEventId: options.auditEventId,
		auditEventHash: sha256(`audit:${options.idempotencyKey}`),
		auditPayloadJson: JSON.stringify({
			fieldGeneration: (options.expectedFieldGeneration ?? 0) + 1
		})
	};
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function capabilitySealer(): RecipientCapabilitySealer {
	return new AesGcmRecipientCapabilitySealer(TEST_DELIVERY_ENCRYPTION_KEY);
}
