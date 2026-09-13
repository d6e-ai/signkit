import { createHash, randomUUID } from 'node:crypto';
import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	DraftPersistenceService,
	draftArchiveKey
} from '$lib/application/drafts/draft-persistence';
import { buildVerifiedAuditChain } from '$lib/application/completion-artifacts/audit-chain-test-support';
import { auditEventHashPreimage } from '$lib/application/completion-artifacts/audit-event-integrity';
import { CompletionArtifactPublicationService } from '$lib/application/completion-artifacts/completion-artifact-service';
import { sha256TextHex } from '$lib/application/completion-artifacts/completion-manifest';
import { EnvelopeApplication } from '$lib/application/envelopes/service';
import { EnvelopeFieldApplication } from '$lib/application/envelopes/fields';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';
import {
	EnvelopeReadyApplication,
	type ReadyRecipientInput
} from '$lib/application/envelopes/ready';
import { EnvelopeSendApplication } from '$lib/application/envelopes/send';
import { EnvelopeVoidApplication } from '$lib/application/envelopes/void';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';
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
import type { CompletionEvidenceAuditEvent } from '$lib/ports/completion-artifact-store';
import type { DraftDocument, DraftRepository, DraftVersion } from '$lib/ports/draft-repository';
import type { PublishFieldPlacementCommand } from '$lib/ports/envelope-field-store';
import type { PublishReadyEnvelopeCommand } from '$lib/ports/envelope-ready-store';
import type { EnvelopeSendStore, PublishSentEnvelopeCommand } from '$lib/ports/envelope-send-store';
import type { ObjectMetadata, ObjectStore, PutObject } from '$lib/ports/object-store';
import type {
	CreateApiKeyCommand,
	CreateApiKeyStoreResult,
	ListApiKeyStoreResult,
	RevokeApiKeyCommand,
	RevokeApiKeyStoreResult,
	ApiKeyMetadata
} from '$lib/ports/api-key-store';
import {
	AesGcmRecipientCapabilitySealer,
	type RecipientCapabilitySealer
} from '$lib/security/delivery-capability';
import {
	computeCompletionAccessExpiry,
	issueCompletionToken
} from '$lib/security/completion-token';
import {
	canonicalizeApiKeyScopesJson,
	issueApiKey,
	type IssuedApiKey
} from '$lib/security/api-key';
import { AesGcmCompletionTokenSealer } from '$lib/security/completion-token-sealer';
import { PostgresCompletionArtifactStore } from './postgres-completion-artifact-store';
import { PostgresCompletionDeliveryStore } from './postgres-completion-delivery-store';
import { PostgresDeliveryOutboxStore } from './postgres-delivery-outbox-store';
import { PostgresEnvelopeApplicationStore } from './postgres-envelope-application-store';
import { PostgresEnvelopeFieldStore } from './postgres-envelope-field-store';
import { PostgresEnvelopeReadyStore } from './postgres-envelope-ready-store';
import { PostgresEnvelopeSendStore } from './postgres-envelope-send-store';
import { PostgresEnvelopeVoidStore } from './postgres-envelope-void-store';
import { PostgresRecipientApproveStore } from './postgres-recipient-approve-store';
import { PostgresRecipientDeclineStore } from './postgres-recipient-decline-store';
import { PostgresRecipientDeclinedReceiptStore } from './postgres-recipient-declined-receipt-store';
import { PostgresRecipientSignStore } from './postgres-recipient-sign-store';
import { PostgresApiKeyStore } from './postgres-api-key-store';

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
		await database().unsafe('TRUNCATE organization, instance_member CASCADE');
	});

	afterAll(async () => {
		if (sql === null) return;
		await sql.unsafe('SET search_path TO public');
		await sql.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
		await sql.end({ timeout: 5 });
		sql = null;
	});

	it('applies every migration and enforces tenant, signer, and int32 field bounds', async () => {
		expect(MIGRATION_PATHS).toContain('migrations/postgres/0017_api_keys.sql');
		expect(MIGRATION_PATHS).toContain('migrations/postgres/0018_instance_bootstrap.sql');
		expect(MIGRATION_PATHS).toContain('migrations/postgres/0019_instance_invitations.sql');
		expect(MIGRATION_PATHS).toContain('migrations/postgres/0020_instance_member_command.sql');
		const relations = await database()<
			{ name: string }[]
		>`SELECT table_name AS name FROM information_schema.tables
			WHERE table_schema = ${schemaName} ORDER BY table_name`;
		expect(relations.map((row: { name: string }): string => row.name)).toEqual(
			expect.arrayContaining([
				'audit_event',
				'completion_artifact',
				'completion_artifact_job',
				'completion_artifact_publish_command',
				'completion_delivery_outbox',
				'delivery_outbox',
				'envelope',
				'envelope_field',
				'envelope_send_command',
				'envelope_void_command',
				'field_value',
				'recipient',
				'instance_member',
				'instance_bootstrap',
				'instance_bootstrap_command',
				'instance_invitation',
				'instance_invitation_command',
				'instance_member_command',
				'api_key',
				'api_key_create_command',
				'api_key_revoke_command'
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
			'01920000-0000-7000-8000-0000000000f2', 'other-org', 'Other Agreement', 'ready', 1, ${COMMIT_SHA},
			'other/archive', ${ARCHIVE_SHA256}, now(), now()
		)`;
		await database()`INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES (
			'01930000-0000-7000-8000-0000000000f2', 'other-org', '01920000-0000-7000-8000-0000000000f2', 'other@example.com', 'Other',
			'signer', 'en', 1, 'pending', now(), now()
		)`;
		await expect(
			database()`INSERT INTO envelope_field (
				id, organization_id, envelope_id, recipient_id, document_path, field_type,
				label, required, position, created_at, updated_at
			) VALUES (
				'01950000-0000-7000-8000-0000000000f2', ${ORGANIZATION_ID}, ${ENVELOPE_ID}, '01930000-0000-7000-8000-0000000000f2',
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
				'01940000-0000-7000-8000-0000000000f2', ${ORGANIZATION_ID}, ${ENVELOPE_ID}, '01930000-0000-7000-8000-0000000000f2',
				'recipient_invitation', 'blocked', 'capability-hash', NULL,
				'sealed-capability', 'key-1', ${'e'.repeat(64)}, NULL, 0, now(), now(), NULL, true
			)`
		).rejects.toMatchObject({ code: '23503' });

		await database()`INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			repository_archive_key, repository_archive_sha256, created_at, updated_at
		) VALUES (
			'01920000-0000-7000-8000-0000000000f3', ${ORGANIZATION_ID}, 'Other Agreement', 'ready', 1,
			${COMMIT_SHA}, 'other/archive', ${ARCHIVE_SHA256}, now(), now()
		)`;
		await database()`INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES (
			'01930000-0000-7000-8000-0000000000f3', ${ORGANIZATION_ID}, '01920000-0000-7000-8000-0000000000f3',
			'same-org-other@example.com', 'Other signer', 'signer', 'en', 1, 'pending', now(), now()
		)`;
		await expect(
			database()`INSERT INTO delivery_outbox (
				id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
				reserved_capability_expires_at, sealed_capability, sealing_key_id,
				sealed_capability_sha256, available_at, attempts, created_at, updated_at,
				claim_token, retryable
			) VALUES (
				'01940000-0000-7000-8000-0000000000f3', ${ORGANIZATION_ID}, ${ENVELOPE_ID},
				'01930000-0000-7000-8000-0000000000f3', 'recipient_invitation', 'blocked', 'capability-hash',
				NULL, 'sealed-capability', 'key-1', ${'e'.repeat(64)}, NULL, 0, now(), now(),
				NULL, true
			)`
		).rejects.toMatchObject({ code: '23503' });
		await expect(
			database()`INSERT INTO envelope_field (
				id, organization_id, envelope_id, recipient_id, document_path, field_type,
				label, required, position, created_at, updated_at
			) VALUES (
				'01950000-0000-7000-8000-0000000000f3', ${ORGANIZATION_ID}, ${ENVELOPE_ID},
				'01930000-0000-7000-8000-0000000000f3', 'documents/agreement.md', 'signature', 'Signature',
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

	/**
	 * PostgreSQL 18 evidence for the SignKit identifier policy. The equivalent
	 * D1 assertions live in `d1-uuidv7-identifier-constraints.spec.ts`; both must
	 * accept the same canonical UUIDv7 values and reject the same non-UUIDv7
	 * ones, while leaving external d6e-auth identifiers and caller-chosen
	 * idempotency keys unconstrained.
	 */
	it('constrains every SignKit-owned identifier to a canonical UUIDv7', async () => {
		const version = await database()<
			{ setting: string }[]
		>`SELECT current_setting('server_version_num') AS setting`;
		expect(Number(version[0].setting)).toBeGreaterThanOrEqual(180_000);

		await seedDraftEnvelope();
		const ready = await readyEnvelope();
		const recipientId: string = ready.recipients[0].id;
		expect(recipientId).toMatch(UUID_V7_PATTERN);
		expect(ready.auditEventId).toMatch(UUID_V7_PATTERN);

		await database()`INSERT INTO instance_member (user_id, status, created_at, updated_at)
			VALUES (${ACTOR.id}, 'active', now(), now())`;
		const rejected: readonly string[] = [
			'recipient-1',
			'9f1c6f8e-0a1d-4f3b-8b0e-7c2f9a4d6e11',
			'01920000-0000-8000-a000-000000000001',
			'01920000-0000-7000-c000-000000000001',
			'01920000-0000-7000-8000-0000000000AB',
			'01920000-0000-7000-8000-00000000000',
			'00000000-0000-0000-0000-000000000000',
			''
		];
		for (const id of rejected) {
			await expect(
				database()`INSERT INTO envelope (
					id, organization_id, title, status, repository_generation, created_at, updated_at
				) VALUES (${id}, ${ORGANIZATION_ID}, 'Agreement', 'draft', 0, now(), now())`
			).rejects.toMatchObject({ code: '23514', constraint_name: 'envelope_id_uuidv7' });
			await expect(
				database()`INSERT INTO audit_event (
					id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
					payload_json, previous_hash, event_hash, occurred_at
				) VALUES (
					${id}, ${ORGANIZATION_ID}, ${ENVELOPE_ID}, 99, 'envelope.voided', 'user',
					${ACTOR.id}, '{}', ${'e'.repeat(64)}, ${'f'.repeat(64)}, now()
				)`
			).rejects.toMatchObject({ code: '23514', constraint_name: 'audit_event_id_uuidv7' });
			await expect(
				database()`INSERT INTO recipient (
					id, organization_id, envelope_id, email, name, role, locale, routing_order,
					status, created_at, updated_at
				) VALUES (
					${id}, ${ORGANIZATION_ID}, ${ENVELOPE_ID}, 'rejected@example.com', 'Rejected',
					'signer', 'en', 9, 'pending', now(), now()
				)`
			).rejects.toMatchObject({ code: '23514', constraint_name: 'recipient_id_uuidv7' });
			await expect(
				database()`INSERT INTO delivery_outbox (
					id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
					reserved_capability_expires_at, sealed_capability, sealing_key_id,
					sealed_capability_sha256, available_at, attempts, created_at, updated_at,
					claim_token, retryable
				) VALUES (
					${id}, ${ORGANIZATION_ID}, ${ENVELOPE_ID}, ${recipientId}, 'recipient_invitation',
					'blocked', ${'9'.repeat(64)}, NULL, 'sealed-capability', 'key-1',
					${'e'.repeat(64)}, NULL, 0, now(), now(), NULL, true
				)`
			).rejects.toMatchObject({ code: '23514', constraint_name: 'delivery_outbox_id_uuidv7' });
			await expect(
				database()`INSERT INTO envelope_field (
					id, organization_id, envelope_id, recipient_id, document_path, field_type,
					label, required, position, created_at, updated_at
				) VALUES (
					${id}, ${ORGANIZATION_ID}, ${ENVELOPE_ID}, ${recipientId},
					'documents/agreement.md', 'signature', 'Signature', true, 9, now(), now()
				)`
			).rejects.toMatchObject({ code: '23514', constraint_name: 'envelope_field_id_uuidv7' });
			await expect(
				database()`INSERT INTO api_key (
					id, name, token_hash, key_prefix, scopes_json,
					owner_user_id, created_at, expires_at
				) VALUES (
					${id}, 'CI agent', ${'7'.repeat(64)}, 'signkit_abcdefgh',
					'["envelopes:read"]', ${ACTOR.id}, now(), now() + INTERVAL '30 days'
				)`
			).rejects.toMatchObject({ code: '23514', constraint_name: 'api_key_id_uuidv7' });
		}

		// External d6e-auth identifiers and caller-chosen idempotency keys are
		// deliberately outside the rule.
		await database()`INSERT INTO organization (id, d6e_organization_id, name, created_at)
			VALUES ('org_2f8c_not_a_uuid', 'org_2f8c_not_a_uuid', 'External', now())`;
		await database()`INSERT INTO instance_member (user_id, status, created_at, updated_at)
			VALUES ('user_d6e_not_a_uuid', 'active', now(), now())`;
		await database()`INSERT INTO idempotency_key (
			organization_id, caller_id, idempotency_key, request_hash, envelope_id, created_at
		) VALUES (
			${ORGANIZATION_ID}, 'user_d6e_not_a_uuid', 'create-agreement#42', ${'a'.repeat(64)},
			${ENVELOPE_ID}, now()
		)`;
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
			'01930000-0000-7000-8000-0000000000d1', ${ORGANIZATION_ID}, ${ENVELOPE_ID}, 'prefill@example.com', 'Prefill',
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
					'01920000-0000-7000-8000-0000000000f4','upgrade-org','Agreement','sent',1,'commit-1','commit-1',
					'2026-09-11T00:00:00.000Z','2026-09-11T00:01:00.000Z'
				);
				INSERT INTO recipient (
					id, organization_id, envelope_id, email, name, role, locale, routing_order,
					status, capability_hash, capability_expires_at, created_at, updated_at
				) VALUES
					('01930000-0000-7000-8000-0000000000e5','upgrade-org','01920000-0000-7000-8000-0000000000f4','pending@example.com','Pending','signer','en',1,'pending','hash-pending','2026-09-25T00:00:00.000Z','2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'),
					('01930000-0000-7000-8000-0000000000e4','upgrade-org','01920000-0000-7000-8000-0000000000f4','processing@example.com','Processing','signer','en',2,'pending','hash-processing','2026-09-25T00:00:00.000Z','2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'),
					('01930000-0000-7000-8000-0000000000e3','upgrade-org','01920000-0000-7000-8000-0000000000f4','failed@example.com','Failed','signer','en',3,'pending','hash-failed','2026-09-25T00:00:00.000Z','2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'),
					('01930000-0000-7000-8000-0000000000e2','upgrade-org','01920000-0000-7000-8000-0000000000f4','delivered@example.com','Delivered','signer','en',4,'pending','hash-delivered','2026-09-25T00:00:00.000Z','2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'),
					('01930000-0000-7000-8000-0000000000e1','upgrade-org','01920000-0000-7000-8000-0000000000f4','blocked@example.com','Blocked','signer','en',5,'pending','hash-blocked','2026-09-25T00:00:00.000Z','2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z');
				INSERT INTO delivery_outbox (
					id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
					reserved_capability_expires_at, sealed_capability, sealing_key_id,
					sealed_capability_sha256, available_at, attempts, locked_at, delivered_at,
					provider_message_id, last_error, created_at, updated_at
				) VALUES
					('01940000-0000-7000-8000-0000000000e5','upgrade-org','01920000-0000-7000-8000-0000000000f4','01930000-0000-7000-8000-0000000000e5','recipient_invitation','pending','hash-pending','2026-09-25T00:00:00.000Z','sealed-pending','key-1','sealed-hash-pending','2026-09-11T00:01:00.000Z',0,NULL,NULL,NULL,NULL,'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'),
					('01940000-0000-7000-8000-0000000000e4','upgrade-org','01920000-0000-7000-8000-0000000000f4','01930000-0000-7000-8000-0000000000e4','recipient_invitation','processing','hash-processing','2026-09-25T00:00:00.000Z','sealed-processing','key-1','sealed-hash-processing','2026-09-11T00:01:00.000Z',1,'2026-09-11T00:02:00.000Z',NULL,NULL,NULL,'2026-09-11T00:01:00.000Z','2026-09-11T00:02:00.000Z'),
					('01940000-0000-7000-8000-0000000000e3','upgrade-org','01920000-0000-7000-8000-0000000000f4','01930000-0000-7000-8000-0000000000e3','recipient_invitation','failed','hash-failed','2026-09-25T00:00:00.000Z','sealed-failed','key-1','sealed-hash-failed','2026-09-11T00:01:00.000Z',1,NULL,NULL,NULL,'transient','2026-09-11T00:01:00.000Z','2026-09-11T00:02:00.000Z'),
					('01940000-0000-7000-8000-0000000000e2','upgrade-org','01920000-0000-7000-8000-0000000000f4','01930000-0000-7000-8000-0000000000e2','recipient_invitation','delivered','hash-delivered','2026-09-25T00:00:00.000Z','sealed-delivered','key-1','sealed-hash-delivered','2026-09-11T00:01:00.000Z',1,NULL,'2026-09-11T00:03:00.000Z','provider-id',NULL,'2026-09-11T00:01:00.000Z','2026-09-11T00:03:00.000Z'),
					('01940000-0000-7000-8000-0000000000e1','upgrade-org','01920000-0000-7000-8000-0000000000f4','01930000-0000-7000-8000-0000000000e1','recipient_invitation','blocked','hash-blocked','2026-09-25T00:00:00.000Z','sealed-blocked','key-1','sealed-hash-blocked',NULL,0,NULL,NULL,NULL,NULL,'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z');
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
					id: '01940000-0000-7000-8000-0000000000e1',
					status: 'blocked',
					claimToken: null,
					lockedAt: null,
					sealedCapability: 'sealed-blocked',
					retryable: true,
					lastError: null
				},
				{
					id: '01940000-0000-7000-8000-0000000000e2',
					status: 'delivered',
					claimToken: null,
					lockedAt: null,
					sealedCapability: null,
					retryable: false,
					lastError: null
				},
				{
					id: '01940000-0000-7000-8000-0000000000e3',
					status: 'failed',
					claimToken: null,
					lockedAt: null,
					sealedCapability: 'sealed-failed',
					retryable: true,
					lastError: 'transient'
				},
				{
					id: '01940000-0000-7000-8000-0000000000e4',
					status: 'failed',
					claimToken: null,
					lockedAt: null,
					sealedCapability: 'sealed-processing',
					retryable: true,
					lastError: 'worker_restarted'
				},
				{
					id: '01940000-0000-7000-8000-0000000000e5',
					status: 'pending',
					claimToken: null,
					lockedAt: null,
					sealedCapability: 'sealed-pending',
					retryable: true,
					lastError: null
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

	it('discovers, claims, and atomically publishes a completion artifact under PostgreSQL locks', async () => {
		await seedDraftEnvelope();
		const ready = await readyEnvelope([
			{
				email: 'signer@example.com',
				name: 'Signer',
				role: 'signer',
				locale: 'en',
				routingOrder: 1
			}
		]);
		const signerId: string = ready.recipients.find(
			(recipient): boolean => recipient.role === 'signer'
		)?.id as string;
		const sealer: AesGcmRecipientCapabilitySealer = new AesGcmRecipientCapabilitySealer(
			TEST_DELIVERY_ENCRYPTION_KEY
		);
		await new EnvelopeSendApplication(new PostgresEnvelopeSendStore(database()), sealer).send(
			ACTOR,
			ENVELOPE_ID,
			{
				idempotencyKey: 'send-before-completion-artifact',
				expectedGeneration: 1,
				expectedReadyAuditEventId: ready.auditEventId
			}
		);
		const completedAt: string = new Date(Date.now() + 1_000).toISOString();
		await database()`UPDATE recipient SET status = 'viewed', updated_at = ${completedAt}
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
				AND id = ${signerId}`;
		const delivery = await database()<
			{ deliveryId: string; sealedCapability: string }[]
		>`SELECT id AS "deliveryId", sealed_capability AS "sealedCapability" FROM delivery_outbox
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
				AND recipient_id = ${signerId}`;
		const token: string = await sealer.open(delivery[0].sealedCapability, {
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			recipientId: signerId,
			deliveryId: delivery[0].deliveryId
		});
		const signResult = await new RecipientSignedApplication(
			new PostgresRecipientSignStore(database()),
			(): Date => new Date(completedAt)
		).sign({
			token,
			expectedEnvelopeId: ENVELOPE_ID,
			expectedRecipientId: signerId,
			expectedFieldGeneration: 0,
			idempotencyKey: 'sign-completion-artifact',
			values: []
		});
		expect(signResult).toMatchObject({
			outcome: 'published',
			result: { envelopeStatus: 'completed' }
		});

		const store = new PostgresCompletionArtifactStore(database());
		// Regression: a completed envelope queried before the reconciliation
		// job is discovered must read as pending with zero attempts, not
		// not_completed.
		const statusBeforeDiscovery = await store.findCompletionArtifactStatus(
			ORGANIZATION_ID,
			ENVELOPE_ID
		);
		expect(statusBeforeDiscovery).toEqual({
			envelopeId: ENVELOPE_ID,
			envelopeCompleted: true,
			jobStatus: null,
			attempts: null,
			lastError: null,
			availableAt: null,
			published: null
		});

		const claimToken: string = 'completion-artifact-claim-0001';
		const claimedAt: string = new Date(Date.now() + 2_000).toISOString();
		const claims = await store.claimPendingCompletionArtifacts({
			claimToken,
			claimedAt,
			staleBefore: new Date(Date.parse(claimedAt) - 300_000).toISOString(),
			discoveryLimit: 25,
			claimLimit: 10
		});
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({ envelopeId: ENVELOPE_ID, sentCommitSha: COMMIT_SHA });

		const evidence = await store.readCompletionEvidence(ORGANIZATION_ID, ENVELOPE_ID);
		expect(evidence.recipients).toEqual([
			expect.objectContaining({
				id: signerId,
				status: 'completed',
				decisionEventId: expect.any(String)
			})
		]);
		const anchor = evidence.auditEvents[evidence.auditEvents.length - 1];
		expect(anchor.eventType).toBe('envelope.completed');

		const publishCommand = {
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			claimToken,
			sentCommitSha: COMMIT_SHA,
			fieldGeneration: 0,
			anchorAuditEventId: anchor.id,
			expectedAuditSequence: anchor.sequence,
			previousAuditHash: anchor.eventHash,
			manifestSha256: 'm'.repeat(64),
			jsonObjectKey: `completion-artifacts/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/sha256/${'j'.repeat(64)}.json.gz`,
			jsonSha256: 'j'.repeat(64),
			markdownObjectKey: `completion-artifacts/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/sha256/${'d'.repeat(64)}.md.gz`,
			markdownSha256: 'd'.repeat(64),
			updatedAt: new Date(Date.now() + 3_000).toISOString(),
			auditEventId: '01900000-0000-7000-8000-000000000091',
			auditEventHash: 'e'.repeat(64),
			auditPayloadJson: '{}'
		};
		const published = await store.publishCompletionArtifact(publishCommand);
		expect(published).toMatchObject({ outcome: 'published' });
		const replayed = await store.publishCompletionArtifact(publishCommand);
		expect(replayed).toMatchObject({ outcome: 'replayed' });
		const conflicting = await store.publishCompletionArtifact({
			...publishCommand,
			manifestSha256: 'f'.repeat(64)
		});
		expect(conflicting).toEqual({ outcome: 'integrity_error' });

		const status = await store.findCompletionArtifactStatus(ORGANIZATION_ID, ENVELOPE_ID);
		expect(status).toMatchObject({
			jobStatus: 'published',
			published: { manifestSha256: 'm'.repeat(64) }
		});
		const jobRow = await database()<
			{ status: string; claimToken: string | null }[]
		>`SELECT status, claim_token AS "claimToken" FROM completion_artifact_job
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}`;
		expect(jobRow).toEqual([{ status: 'published', claimToken: null }]);
	});

	it('discovers, enrolls, claims, and completes completion delivery under PostgreSQL locks', async () => {
		await seedDraftEnvelope();
		const ready = await readyEnvelope([
			{
				email: 'signer@example.com',
				name: 'Signer',
				role: 'signer',
				locale: 'en',
				routingOrder: 1
			}
		]);
		const signerId: string = ready.recipients.find(
			(recipient): boolean => recipient.role === 'signer'
		)?.id as string;
		const invitationSealer = new AesGcmRecipientCapabilitySealer(TEST_DELIVERY_ENCRYPTION_KEY);
		await new EnvelopeSendApplication(
			new PostgresEnvelopeSendStore(database()),
			invitationSealer
		).send(ACTOR, ENVELOPE_ID, {
			idempotencyKey: 'send-before-completion-delivery',
			expectedGeneration: 1,
			expectedReadyAuditEventId: ready.auditEventId
		});
		const completedAt: string = new Date(Date.now() + 1_000).toISOString();
		await database()`UPDATE recipient SET status = 'viewed', updated_at = ${completedAt}
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
				AND id = ${signerId}`;
		const delivery = await database()<
			{ deliveryId: string; sealedCapability: string }[]
		>`SELECT id AS "deliveryId", sealed_capability AS "sealedCapability" FROM delivery_outbox
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
				AND recipient_id = ${signerId}`;
		const token: string = await invitationSealer.open(delivery[0].sealedCapability, {
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			recipientId: signerId,
			deliveryId: delivery[0].deliveryId
		});
		await new RecipientSignedApplication(
			new PostgresRecipientSignStore(database()),
			(): Date => new Date(completedAt)
		).sign({
			token,
			expectedEnvelopeId: ENVELOPE_ID,
			expectedRecipientId: signerId,
			expectedFieldGeneration: 0,
			idempotencyKey: 'sign-for-completion-delivery',
			values: []
		});

		const artifactStore = new PostgresCompletionArtifactStore(database());
		const deliveryStore = new PostgresCompletionDeliveryStore(database());

		const discoveredBeforeArtifact = await deliveryStore.discoverEligibleRecipients(10);
		expect(discoveredBeforeArtifact).toEqual([]);

		const claimToken: string = 'completion-artifact-claim-0002';
		const claimedAt: string = new Date(Date.now() + 2_000).toISOString();
		await artifactStore.claimPendingCompletionArtifacts({
			claimToken,
			claimedAt,
			staleBefore: new Date(Date.parse(claimedAt) - 300_000).toISOString(),
			discoveryLimit: 25,
			claimLimit: 10
		});
		const evidence = await artifactStore.readCompletionEvidence(ORGANIZATION_ID, ENVELOPE_ID);
		const anchor = evidence.auditEvents[evidence.auditEvents.length - 1];
		await artifactStore.publishCompletionArtifact({
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			claimToken,
			sentCommitSha: COMMIT_SHA,
			fieldGeneration: 0,
			anchorAuditEventId: anchor.id,
			expectedAuditSequence: anchor.sequence,
			previousAuditHash: anchor.eventHash,
			manifestSha256: 'm'.repeat(64),
			jsonObjectKey: `completion-artifacts/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/sha256/${'j'.repeat(64)}.json.gz`,
			jsonSha256: 'j'.repeat(64),
			markdownObjectKey: `completion-artifacts/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/sha256/${'d'.repeat(64)}.md.gz`,
			markdownSha256: 'd'.repeat(64),
			updatedAt: new Date(Date.now() + 3_000).toISOString(),
			auditEventId: '01900000-0000-7000-8000-000000000092',
			auditEventHash: 'e'.repeat(64),
			auditPayloadJson: '{}'
		});

		const discovered = await deliveryStore.discoverEligibleRecipients(10);
		expect(discovered).toEqual([
			{
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				recipientId: signerId,
				recipientEmail: 'signer@example.com',
				recipientName: 'Signer',
				recipientLocale: 'en',
				recipientRole: 'signer',
				envelopeTitle: 'Agreement'
			}
		]);

		const deliveryId: string = '01900000-0000-7000-8000-000000000093';
		const completionSealer = new AesGcmCompletionTokenSealer(TEST_DELIVERY_ENCRYPTION_KEY);
		const issuedToken = await issueCompletionToken();
		const sealed = await completionSealer.seal(issuedToken.token, {
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			recipientId: signerId,
			deliveryId
		});
		const enrolledAt: string = new Date(Date.now() + 4_000).toISOString();
		const accessExpiresAt: string = computeCompletionAccessExpiry(new Date(enrolledAt));

		const enrolledCount = await deliveryStore.enrollDeliveries([
			{
				id: deliveryId,
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				recipientId: signerId,
				tokenHash: issuedToken.tokenHash,
				accessExpiresAt,
				sealedToken: sealed.sealedToken,
				sealingKeyId: sealed.sealingKeyId,
				sealedTokenSha256: sealed.sealedTokenSha256,
				availableAt: enrolledAt,
				createdAt: enrolledAt
			}
		]);
		expect(enrolledCount).toBe(1);
		expect(await deliveryStore.discoverEligibleRecipients(10)).toEqual([]);

		const deliveryClaimToken: string = 'completion-delivery-claim-0001';
		const deliveryClaimedAt: string = new Date(Date.now() + 5_000).toISOString();
		const claimedDeliveries = await deliveryStore.claimPendingDeliveries({
			claimToken: deliveryClaimToken,
			claimedAt: deliveryClaimedAt,
			staleBefore: new Date(Date.parse(deliveryClaimedAt) - 300_000).toISOString(),
			limit: 10
		});
		expect(claimedDeliveries).toHaveLength(1);
		expect(claimedDeliveries[0]).toMatchObject({
			deliveryId,
			status: 'processing',
			attempts: 1,
			lockedAt: deliveryClaimedAt
		});

		const readClaim = await deliveryStore.readClaimedDelivery({
			organizationId: ORGANIZATION_ID,
			deliveryId,
			claimToken: deliveryClaimToken
		});
		expect(readClaim).toMatchObject({
			deliveryId,
			status: 'processing',
			attempts: 1,
			lockedAt: deliveryClaimedAt
		});

		expect(
			await deliveryStore.readClaimedDelivery({
				organizationId: ORGANIZATION_ID,
				deliveryId,
				claimToken: 'wrong-token'
			})
		).toBeNull();

		const deliveredAt: string = new Date(Date.now() + 6_000).toISOString();
		const completeResult = await deliveryStore.completeDelivery({
			organizationId: ORGANIZATION_ID,
			deliveryId,
			claimToken: deliveryClaimToken,
			deliveredAt,
			providerMessageId: 'provider-completion-msg-001'
		});
		expect(completeResult).toEqual({ outcome: 'completed' });

		expect(
			await deliveryStore.completeDelivery({
				organizationId: ORGANIZATION_ID,
				deliveryId,
				claimToken: deliveryClaimToken,
				deliveredAt,
				providerMessageId: 'provider-completion-msg-002'
			})
		).toEqual({ outcome: 'stale' });

		const outboxRows = await database()<
			{
				status: string;
				sealedToken: string | null;
				retryable: boolean;
				providerMessageId: string | null;
			}[]
		>`SELECT status, sealed_token AS "sealedToken", retryable,
			provider_message_id AS "providerMessageId"
			FROM completion_delivery_outbox
			WHERE organization_id = ${ORGANIZATION_ID} AND id = ${deliveryId}`;
		expect(outboxRows).toEqual([
			{
				status: 'delivered',
				sealedToken: null,
				retryable: false,
				providerMessageId: 'provider-completion-msg-001'
			}
		]);

		const resolvedDelivered = await deliveryStore.resolveArtifactLocatorByTokenHash(
			issuedToken.tokenHash,
			deliveredAt
		);
		expect(resolvedDelivered).toEqual({
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			jsonObjectKey: `completion-artifacts/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/sha256/${'j'.repeat(64)}.json.gz`,
			jsonSha256: 'j'.repeat(64),
			markdownObjectKey: `completion-artifacts/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/sha256/${'d'.repeat(64)}.md.gz`,
			markdownSha256: 'd'.repeat(64)
		});
	});

	it('enforces schema constraints, retryable failure keeping access, and terminal failure revoking access', async () => {
		await database()`INSERT INTO organization (id, d6e_organization_id, name, created_at)
			VALUES (${ORGANIZATION_ID}, ${ORGANIZATION_ID}, 'Workspace', now())`;
		await database()`INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			repository_archive_key, repository_archive_sha256, created_at, updated_at
		) VALUES (
			${ENVELOPE_ID}, ${ORGANIZATION_ID}, 'Completed Agreement', 'completed', 1, ${COMMIT_SHA},
			'archive/key', ${ARCHIVE_SHA256}, now(), now()
		)`;
		const recipientId: string = '01900000-0000-7000-8000-000000000071';
		await database()`INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES (
			${recipientId}, ${ORGANIZATION_ID}, ${ENVELOPE_ID}, 'recipient@example.com', 'Signer',
			'signer', 'en', 1, 'completed', now(), now()
		)`;
		const anchorEventId: string = '01900000-0000-7000-8000-000000000072';
		await database()`INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			${anchorEventId}, ${ORGANIZATION_ID}, ${ENVELOPE_ID}, 1,
			'envelope.completed', 'system', 'system', '{}', ${'0'.repeat(64)}, ${'c'.repeat(64)}, now()
		)`;
		const artifactPublishEventId: string = '01900000-0000-7000-8000-000000000073';
		await database()`INSERT INTO completion_artifact (
			organization_id, envelope_id, schema_version, manifest_sha256,
			json_object_key, json_sha256, markdown_object_key, markdown_sha256,
			sent_commit_sha, field_generation, anchor_audit_event_id,
			audit_head_sequence, audit_head_event_hash, published_at, audit_event_id
		) VALUES (
			${ORGANIZATION_ID}, ${ENVELOPE_ID}, 1, ${'m'.repeat(64)},
			${`completion-artifacts/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/artifact.json.gz`},
			${'j'.repeat(64)},
			${`completion-artifacts/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/artifact.md.gz`},
			${'d'.repeat(64)},
			${COMMIT_SHA}, 0, ${anchorEventId},
			1, ${'c'.repeat(64)}, now(), ${artifactPublishEventId}
		)`;

		const deliveryStore = new PostgresCompletionDeliveryStore(database());
		const sealer = new AesGcmCompletionTokenSealer(TEST_DELIVERY_ENCRYPTION_KEY);
		const token = await issueCompletionToken();
		const deliveryId = '01900000-0000-7000-8000-000000000074';
		const sealed = await sealer.seal(token.token, {
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			recipientId,
			deliveryId
		});

		const baseTime = new Date('2026-09-12T12:00:00.000Z');
		const accessExpiresAt = new Date(baseTime.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

		await deliveryStore.enrollDeliveries([
			{
				id: deliveryId,
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				recipientId,
				tokenHash: token.tokenHash,
				accessExpiresAt,
				sealedToken: sealed.sealedToken,
				sealingKeyId: sealed.sealingKeyId,
				sealedTokenSha256: sealed.sealedTokenSha256,
				availableAt: baseTime.toISOString(),
				createdAt: baseTime.toISOString()
			}
		]);

		const claimToken = 'claim-token-failure-test-01';
		await deliveryStore.claimPendingDeliveries({
			claimToken,
			claimedAt: baseTime.toISOString(),
			staleBefore: new Date(baseTime.getTime() - 300_000).toISOString(),
			limit: 10
		});

		// 1. Retryable failure: keeps sealed_token and leaves access_revoked_at NULL
		const retryFailResult = await deliveryStore.failDelivery({
			organizationId: ORGANIZATION_ID,
			deliveryId,
			claimToken,
			errorCode: 'smtp_temporary_error',
			retryable: true,
			nextAvailableAt: new Date(baseTime.getTime() + 30_000).toISOString(),
			failedAt: baseTime.toISOString()
		});
		expect(retryFailResult).toEqual({ outcome: 'failed' });

		const [retryRow] = await database()<
			{
				status: string;
				retryable: boolean;
				sealedToken: string | null;
				accessRevokedAt: Date | null;
			}[]
		>`SELECT status, retryable, sealed_token AS "sealedToken", access_revoked_at AS "accessRevokedAt"
			FROM completion_delivery_outbox WHERE organization_id = ${ORGANIZATION_ID} AND id = ${deliveryId}`;
		expect(retryRow.status).toBe('failed');
		expect(retryRow.retryable).toBe(true);
		expect(retryRow.sealedToken).toBe(sealed.sealedToken);
		expect(retryRow.accessRevokedAt).toBeNull();

		// Retryable keeps access: locator resolves
		const retryLocator = await deliveryStore.resolveArtifactLocatorByTokenHash(
			token.tokenHash,
			baseTime.toISOString()
		);
		expect(retryLocator).not.toBeNull();

		// Claim again for terminal failure test
		const claimToken2 = 'claim-token-failure-test-02';
		await deliveryStore.claimPendingDeliveries({
			claimToken: claimToken2,
			claimedAt: new Date(baseTime.getTime() + 60_000).toISOString(),
			staleBefore: baseTime.toISOString(),
			limit: 10
		});

		// 2. Terminal failure: scrubs sealed_token to NULL and sets access_revoked_at
		const termFailResult = await deliveryStore.failDelivery({
			organizationId: ORGANIZATION_ID,
			deliveryId,
			claimToken: claimToken2,
			errorCode: 'recipient_mailbox_not_found',
			retryable: false,
			nextAvailableAt: new Date(baseTime.getTime() + 60_000).toISOString(),
			failedAt: new Date(baseTime.getTime() + 60_000).toISOString()
		});
		expect(termFailResult).toEqual({ outcome: 'failed' });

		const [termRow] = await database()<
			{
				status: string;
				retryable: boolean;
				sealedToken: string | null;
				accessRevokedAt: Date | null;
			}[]
		>`SELECT status, retryable, sealed_token AS "sealedToken", access_revoked_at AS "accessRevokedAt"
			FROM completion_delivery_outbox WHERE organization_id = ${ORGANIZATION_ID} AND id = ${deliveryId}`;
		expect(termRow.status).toBe('failed');
		expect(termRow.retryable).toBe(false);
		expect(termRow.sealedToken).toBeNull();
		expect(termRow.accessRevokedAt).not.toBeNull();

		// Terminal failure revokes access: locator returns null
		const termLocator = await deliveryStore.resolveArtifactLocatorByTokenHash(
			token.tokenHash,
			baseTime.toISOString()
		);
		expect(termLocator).toBeNull();

		// 3. Check constraint: inserting delivered with unscrubbed sealed_token fails
		await expect(
			database()`INSERT INTO completion_delivery_outbox (
				id, organization_id, envelope_id, recipient_id, status, token_hash,
				access_expires_at, access_revoked_at, sealed_token, sealing_key_id,
				sealed_token_sha256, available_at, attempts, created_at, updated_at, retryable
			) VALUES (
				'01940000-0000-7000-8000-0000000000b1', ${ORGANIZATION_ID}, ${ENVELOPE_ID}, ${recipientId}, 'delivered',
				${'5'.repeat(64)}, ${accessExpiresAt}::timestamptz, NULL, 'unscrubbed', 'key-1',
				${'s'.repeat(64)}, now(), 1, now(), now(), false
			)`
		).rejects.toThrow();

		// 4. Check constraint: inserting failed non-retryable without access_revoked_at fails
		await expect(
			database()`INSERT INTO completion_delivery_outbox (
				id, organization_id, envelope_id, recipient_id, status, token_hash,
				access_expires_at, access_revoked_at, sealed_token, sealing_key_id,
				sealed_token_sha256, available_at, attempts, created_at, updated_at, retryable
			) VALUES (
				'01940000-0000-7000-8000-0000000000b2', ${ORGANIZATION_ID}, ${ENVELOPE_ID}, ${recipientId}, 'failed',
				${'6'.repeat(64)}, ${accessExpiresAt}::timestamptz, NULL, NULL, 'key-1',
				${'s'.repeat(64)}, now(), 1, now(), now(), false
			)`
		).rejects.toThrow();
	});

	it('resolves artifact locator by token hash for valid, expired, revoked, cross-tenant/nonexistent, and no-artifact cases', async () => {
		await database()`INSERT INTO organization (id, d6e_organization_id, name, created_at)
			VALUES (${ORGANIZATION_ID}, ${ORGANIZATION_ID}, 'Workspace', now())`;
		await database()`INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			repository_archive_key, repository_archive_sha256, created_at, updated_at
		) VALUES (
			${ENVELOPE_ID}, ${ORGANIZATION_ID}, 'Completed Agreement', 'completed', 1, ${COMMIT_SHA},
			'archive/key', ${ARCHIVE_SHA256}, now(), now()
		)`;
		const recipientId: string = '01900000-0000-7000-8000-000000000081';
		await database()`INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES (
			${recipientId}, ${ORGANIZATION_ID}, ${ENVELOPE_ID}, 'signer@example.com', 'Signer',
			'signer', 'en', 1, 'completed', now(), now()
		)`;
		const anchorEventId: string = '01900000-0000-7000-8000-000000000082';
		await database()`INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			${anchorEventId}, ${ORGANIZATION_ID}, ${ENVELOPE_ID}, 1,
			'envelope.completed', 'system', 'system', '{}', ${'0'.repeat(64)}, ${'a'.repeat(64)}, now()
		)`;
		const artifactPublishEventId: string = '01900000-0000-7000-8000-000000000083';
		await database()`INSERT INTO completion_artifact (
			organization_id, envelope_id, schema_version, manifest_sha256,
			json_object_key, json_sha256, markdown_object_key, markdown_sha256,
			sent_commit_sha, field_generation, anchor_audit_event_id,
			audit_head_sequence, audit_head_event_hash, published_at, audit_event_id
		) VALUES (
			${ORGANIZATION_ID}, ${ENVELOPE_ID}, 1, ${'m'.repeat(64)},
			${`completion-artifacts/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/artifact.json.gz`},
			${'j'.repeat(64)},
			${`completion-artifacts/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/artifact.md.gz`},
			${'d'.repeat(64)},
			${COMMIT_SHA}, 0, ${anchorEventId},
			1, ${'a'.repeat(64)}, now(), ${artifactPublishEventId}
		)`;
		const deliveryId: string = '01900000-0000-7000-8000-000000000084';
		const validTokenHash: string = 't'.repeat(64);
		const baseTime = new Date('2026-09-12T12:00:00.000Z');
		const accessExpiresAt = new Date(baseTime.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
		await database()`INSERT INTO completion_delivery_outbox (
			id, organization_id, envelope_id, recipient_id, status, token_hash,
			access_expires_at, access_revoked_at, sealed_token, sealing_key_id,
			sealed_token_sha256, available_at, attempts, created_at, updated_at, retryable
		) VALUES (
			${deliveryId}, ${ORGANIZATION_ID}, ${ENVELOPE_ID}, ${recipientId}, 'delivered',
			${validTokenHash}, ${accessExpiresAt}::timestamptz, NULL, NULL, 'key-1',
			${'s'.repeat(64)}, ${baseTime.toISOString()}::timestamptz, 1,
			${baseTime.toISOString()}::timestamptz, ${baseTime.toISOString()}::timestamptz, false
		)`;

		const deliveryStore = new PostgresCompletionDeliveryStore(database());

		// 1. Valid: unrevoked, unexpired, completed envelope with published artifact
		const validLocator = await deliveryStore.resolveArtifactLocatorByTokenHash(
			validTokenHash,
			baseTime.toISOString()
		);
		expect(validLocator).toEqual({
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			jsonObjectKey: `completion-artifacts/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/artifact.json.gz`,
			jsonSha256: 'j'.repeat(64),
			markdownObjectKey: `completion-artifacts/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/artifact.md.gz`,
			markdownSha256: 'd'.repeat(64)
		});

		// 2. Expired: query timestamp equal to or after accessExpiresAt
		const expiredAt = new Date(Date.parse(accessExpiresAt) + 1_000).toISOString();
		const expiredLocator = await deliveryStore.resolveArtifactLocatorByTokenHash(
			validTokenHash,
			expiredAt
		);
		expect(expiredLocator).toBeNull();

		// 3. Revoked: access_revoked_at set
		const revokedAt = new Date(baseTime.getTime() + 10_000).toISOString();
		await database()`UPDATE completion_delivery_outbox
			SET access_revoked_at = ${revokedAt}::timestamptz
			WHERE organization_id = ${ORGANIZATION_ID} AND id = ${deliveryId}`;
		const revokedLocator = await deliveryStore.resolveArtifactLocatorByTokenHash(
			validTokenHash,
			baseTime.toISOString()
		);
		expect(revokedLocator).toBeNull();

		// Restore access_revoked_at to null for subsequent tests
		await database()`UPDATE completion_delivery_outbox
			SET access_revoked_at = NULL
			WHERE organization_id = ${ORGANIZATION_ID} AND id = ${deliveryId}`;

		// 4a. Nonexistent: unknown token hash returns null
		const nonexistentLocator = await deliveryStore.resolveArtifactLocatorByTokenHash(
			'0'.repeat(64),
			baseTime.toISOString()
		);
		expect(nonexistentLocator).toBeNull();

		// 4b. Cross-tenant: seed second tenant with its own completed envelope and artifact
		const otherOrgId = 'other-org';
		const otherEnvelopeId = '01900000-0000-7000-8000-000000000085';
		const otherRecipientId = '01900000-0000-7000-8000-000000000086';
		const otherAnchorEventId = '01900000-0000-7000-8000-000000000087';
		const otherArtifactEventId = '01900000-0000-7000-8000-000000000088';
		const otherDeliveryId = '01900000-0000-7000-8000-000000000089';
		const otherTokenHash = '1'.repeat(64);

		await database()`INSERT INTO organization (id, d6e_organization_id, name, created_at)
			VALUES (${otherOrgId}, ${otherOrgId}, 'Other Workspace', now())`;
		await database()`INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			repository_archive_key, repository_archive_sha256, created_at, updated_at
		) VALUES (
			${otherEnvelopeId}, ${otherOrgId}, 'Other Agreement', 'completed', 1, ${COMMIT_SHA},
			'archive/other', ${ARCHIVE_SHA256}, now(), now()
		)`;
		await database()`INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES (
			${otherRecipientId}, ${otherOrgId}, ${otherEnvelopeId}, 'other@example.com', 'Other',
			'signer', 'en', 1, 'completed', now(), now()
		)`;
		await database()`INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			${otherAnchorEventId}, ${otherOrgId}, ${otherEnvelopeId}, 1,
			'envelope.completed', 'system', 'system', '{}', ${'0'.repeat(64)}, ${'b'.repeat(64)}, now()
		)`;
		await database()`INSERT INTO completion_artifact (
			organization_id, envelope_id, schema_version, manifest_sha256,
			json_object_key, json_sha256, markdown_object_key, markdown_sha256,
			sent_commit_sha, field_generation, anchor_audit_event_id,
			audit_head_sequence, audit_head_event_hash, published_at, audit_event_id
		) VALUES (
			${otherOrgId}, ${otherEnvelopeId}, 1, ${'m'.repeat(64)},
			${`completion-artifacts/v1/organizations/${otherOrgId}/envelopes/${otherEnvelopeId}/artifact.json.gz`},
			${'2'.repeat(64)},
			${`completion-artifacts/v1/organizations/${otherOrgId}/envelopes/${otherEnvelopeId}/artifact.md.gz`},
			${'3'.repeat(64)},
			${COMMIT_SHA}, 0, ${otherAnchorEventId},
			1, ${'b'.repeat(64)}, now(), ${otherArtifactEventId}
		)`;
		await database()`INSERT INTO completion_delivery_outbox (
			id, organization_id, envelope_id, recipient_id, status, token_hash,
			access_expires_at, access_revoked_at, sealed_token, sealing_key_id,
			sealed_token_sha256, available_at, attempts, created_at, updated_at, retryable
		) VALUES (
			${otherDeliveryId}, ${otherOrgId}, ${otherEnvelopeId}, ${otherRecipientId}, 'delivered',
			${otherTokenHash}, ${accessExpiresAt}::timestamptz, NULL, NULL, 'key-1',
			${'s'.repeat(64)}, ${baseTime.toISOString()}::timestamptz, 1,
			${baseTime.toISOString()}::timestamptz, ${baseTime.toISOString()}::timestamptz, false
		)`;

		// Resolving with otherTokenHash resolves only to other-org
		const otherLocator = await deliveryStore.resolveArtifactLocatorByTokenHash(
			otherTokenHash,
			baseTime.toISOString()
		);
		expect(otherLocator).toEqual({
			organizationId: otherOrgId,
			envelopeId: otherEnvelopeId,
			jsonObjectKey: `completion-artifacts/v1/organizations/${otherOrgId}/envelopes/${otherEnvelopeId}/artifact.json.gz`,
			jsonSha256: '2'.repeat(64),
			markdownObjectKey: `completion-artifacts/v1/organizations/${otherOrgId}/envelopes/${otherEnvelopeId}/artifact.md.gz`,
			markdownSha256: '3'.repeat(64)
		});

		// And resolving validTokenHash still resolves to ORGANIZATION_ID, never other-org
		const firstTenantLocator = await deliveryStore.resolveArtifactLocatorByTokenHash(
			validTokenHash,
			baseTime.toISOString()
		);
		expect(firstTenantLocator?.organizationId).toBe(ORGANIZATION_ID);

		// 5. No-artifact cases:
		// 5a. Completed envelope without a completion_artifact or delivery grant returns null
		const noArtifactEnvelopeId = '01900000-0000-7000-8000-000000000090';
		await database()`INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			repository_archive_key, repository_archive_sha256, created_at, updated_at
		) VALUES (
			${noArtifactEnvelopeId}, ${ORGANIZATION_ID}, 'No Artifact Agreement', 'completed', 1, ${COMMIT_SHA},
			'archive/no-artifact', ${ARCHIVE_SHA256}, now(), now()
		)`;
		expect(
			await deliveryStore.resolveArtifactLocatorByTokenHash(
				'unregistered-no-artifact-token',
				baseTime.toISOString()
			)
		).toBeNull();

		// 5b. Dangling delivery grant pointing to an envelope with no completion_artifact
		// (inserted bypassing foreign key constraints via replica session)
		const danglingTokenHash = 'd'.repeat(64);
		await database().unsafe("SET session_replication_role = 'replica'");
		try {
			await database()`INSERT INTO completion_delivery_outbox (
				id, organization_id, envelope_id, recipient_id, status, token_hash,
				access_expires_at, access_revoked_at, sealed_token, sealing_key_id,
				sealed_token_sha256, available_at, attempts, created_at, updated_at, retryable
			) VALUES (
				'01940000-0000-7000-8000-0000000000f4', ${ORGANIZATION_ID}, ${noArtifactEnvelopeId}, ${recipientId}, 'delivered',
				${danglingTokenHash}, ${accessExpiresAt}::timestamptz, NULL, NULL, 'key-1',
				${'s'.repeat(64)}, ${baseTime.toISOString()}::timestamptz, 1,
				${baseTime.toISOString()}::timestamptz, ${baseTime.toISOString()}::timestamptz, false
			)`;
		} finally {
			await database().unsafe("SET session_replication_role = 'origin'");
		}
		expect(
			await deliveryStore.resolveArtifactLocatorByTokenHash(
				danglingTokenHash,
				baseTime.toISOString()
			)
		).toBeNull();

		// 5c. Delivery grant whose envelope status is not 'completed' returns null
		await database()`UPDATE envelope SET status = 'voided'
			WHERE organization_id = ${ORGANIZATION_ID} AND id = ${ENVELOPE_ID}`;
		expect(
			await deliveryStore.resolveArtifactLocatorByTokenHash(validTokenHash, baseTime.toISOString())
		).toBeNull();
	});

	it('publishes a completion artifact end to end from an audit chain written entirely by real writer paths', async () => {
		// Positive control: every audit event here — envelope.created,
		// draft.revision_created, envelope.ready, envelope.sent,
		// recipient.signed, envelope.completed — is produced by the real
		// application classes, not seeded SQL. This proves the recompute in
		// verifyCompletionAuditChain matches what real writers actually hash,
		// not just what a test fixture was built to satisfy.
		await database()`INSERT INTO organization (id, d6e_organization_id, name, created_at)
			VALUES (${ORGANIZATION_ID}, ${ORGANIZATION_ID}, 'Workspace', '2026-09-11T00:00:00.000Z')`;

		const created = await new EnvelopeApplication(
			new PostgresEnvelopeApplicationStore(database())
		).create(ACTOR, { idempotencyKey: 'real-writer-create', title: 'Agreement' });
		if (created.outcome === 'conflict') throw new Error('Expected envelope creation to succeed');
		const envelopeId: string = created.envelope.id;

		const objects = new RealMemoryObjectStore();
		const repository = new IsomorphicGitDraftRepository();
		const drafts = new DraftPersistenceService(
			new PostgresEnvelopeApplicationStore(database()),
			objects,
			repository
		);
		const commit = await drafts.commit({
			organizationId: ORGANIZATION_ID,
			envelopeId,
			expectedGeneration: 0,
			edits: [{ path: 'documents/agreement.md', content: '# Agreement\n' }],
			message: 'Create agreement',
			actor: { id: ACTOR.id, name: 'Actor', email: 'actor@example.com', type: 'user' },
			idempotencyKey: 'real-writer-draft'
		});
		if (commit.outcome !== 'committed') throw new Error('Expected the draft commit to succeed');

		const ready = await new EnvelopeReadyApplication(
			new PostgresEnvelopeReadyStore(database())
		).ready(ACTOR, envelopeId, {
			idempotencyKey: 'real-writer-ready',
			expectedGeneration: 1,
			recipients: [
				{
					email: 'signer@example.com',
					name: 'Signer',
					role: 'signer',
					locale: 'en',
					routingOrder: 1
				}
			]
		});
		if (ready.outcome !== 'published') throw new Error('Expected ready to succeed');
		const signerId: string = ready.result.recipients[0].id;

		const sealer: AesGcmRecipientCapabilitySealer = new AesGcmRecipientCapabilitySealer(
			TEST_DELIVERY_ENCRYPTION_KEY
		);
		const sent = await new EnvelopeSendApplication(
			new PostgresEnvelopeSendStore(database()),
			sealer
		).send(ACTOR, envelopeId, {
			idempotencyKey: 'real-writer-send',
			expectedGeneration: 1,
			expectedReadyAuditEventId: ready.result.auditEventId
		});
		if (sent.outcome !== 'published') throw new Error('Expected send to succeed');

		const completedAt: string = new Date(Date.now() + 1_000).toISOString();
		await database()`UPDATE recipient SET status = 'viewed', updated_at = ${completedAt}
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${envelopeId}
				AND id = ${signerId}`;
		const delivery = await database()<
			{ deliveryId: string; sealedCapability: string }[]
		>`SELECT id AS "deliveryId", sealed_capability AS "sealedCapability" FROM delivery_outbox
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${envelopeId}
				AND recipient_id = ${signerId}`;
		const token: string = await sealer.open(delivery[0].sealedCapability, {
			organizationId: ORGANIZATION_ID,
			envelopeId,
			recipientId: signerId,
			deliveryId: delivery[0].deliveryId
		});
		const signResult = await new RecipientSignedApplication(
			new PostgresRecipientSignStore(database()),
			(): Date => new Date(completedAt)
		).sign({
			token,
			expectedEnvelopeId: envelopeId,
			expectedRecipientId: signerId,
			expectedFieldGeneration: 0,
			idempotencyKey: 'real-writer-sign',
			values: []
		});
		expect(signResult).toMatchObject({
			outcome: 'published',
			result: { envelopeStatus: 'completed' }
		});

		// Independently recompute every stored event_hash before ever handing
		// the chain to the publication service, so a failure here points
		// specifically at the recompute rather than the service's plumbing.
		const store = new PostgresCompletionArtifactStore(database());
		const evidence = await store.readCompletionEvidence(ORGANIZATION_ID, envelopeId);
		expect(evidence.auditEvents.map((event) => event.eventType)).toEqual([
			'envelope.created',
			'draft.revision_created',
			'envelope.ready',
			'envelope.sent',
			'recipient.signed',
			'envelope.completed'
		]);
		for (const event of evidence.auditEvents) {
			const payload: unknown = JSON.parse(event.payloadJson);
			const preimage: string = auditEventHashPreimage(event, payload, {
				organizationId: ORGANIZATION_ID,
				envelopeId
			});
			expect(await sha256TextHex(preimage)).toBe(event.eventHash);
		}

		const service = new CompletionArtifactPublicationService(
			store,
			objects,
			repository,
			(): Date => new Date(Date.now() + 2_000)
		);
		const result = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({
			claimed: 1,
			published: 1,
			integrityFailed: 0,
			retryableFailed: 0
		});
	});

	it('isolates a corrupt completed envelope from a healthy sibling claimed in the same PostgreSQL batch', async () => {
		await seedVerifiedCompletionEnvelope();
		// A second completed envelope with no repository pointer at all — the
		// row mapping must not throw for it (that would abort the whole claim
		// transaction, taking the healthy envelope's claim down with it), and
		// the service must fail only this envelope closed while the healthy
		// sibling still publishes in the same call.
		const corruptEnvelopeId: string = '01900000-0000-7000-8000-000000000199';
		await database()`INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			repository_archive_key, repository_archive_sha256, sent_commit_sha, field_generation,
			created_at, updated_at
		) VALUES (
			${corruptEnvelopeId}, ${ORGANIZATION_ID}, 'Corrupt Agreement', 'completed', 1, NULL,
			NULL, NULL, NULL, 1,
			'2026-09-11T00:00:00.000Z', '2026-09-11T00:02:00.000Z'
		)`;

		const store = new PostgresCompletionArtifactStore(database());
		const objects = new RealMemoryObjectStore();
		objects.seed(
			draftArchiveKey(ORGANIZATION_ID, ENVELOPE_ID, VERIFIED_ARCHIVE_SHA256),
			VERIFIED_ARCHIVE_BYTES
		);
		const repository = new FixedPostgresDraftRepository(COMMIT_SHA, [
			{ path: 'documents/agreement.md', content: 'Agreement body' }
		]);
		const service = new CompletionArtifactPublicationService(
			store,
			objects,
			repository,
			(): Date => new Date(Date.now()),
			(): string => 'completion-artifact-mixed-batch-0001'
		);

		const result = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({
			claimed: 2,
			published: 1,
			integrityFailed: 1,
			retryableFailed: 0,
			stale: 0
		});

		const corruptJobRow = await database()<
			{ status: string; retryable: boolean; lastError: string | null; claimToken: string | null }[]
		>`SELECT status, retryable, last_error AS "lastError", claim_token AS "claimToken"
			FROM completion_artifact_job
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${corruptEnvelopeId}`;
		expect(corruptJobRow).toEqual([
			{
				status: 'failed',
				retryable: false,
				lastError: 'completion_artifact_evidence_invalid',
				claimToken: null
			}
		]);

		const healthyJobRow = await database()<
			{ status: string }[]
		>`SELECT status FROM completion_artifact_job
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}`;
		expect(healthyJobRow).toEqual([{ status: 'published' }]);

		const artifactCounts = await database()<
			{ envelopeId: string; count: string }[]
		>`SELECT envelope_id AS "envelopeId", COUNT(*) AS count FROM completion_artifact
			WHERE organization_id = ${ORGANIZATION_ID}
			GROUP BY envelope_id`;
		expect(artifactCounts).toEqual([{ envelopeId: ENVELOPE_ID, count: '1' }]);

		// No object access at all for the corrupt row: only the healthy
		// envelope's archive read and its two artifact writes happened.
		expect(objects.getCallCount).toBe(1);
		expect(objects.putCallsByKey.size).toBe(2);
		for (const key of objects.putCallsByKey.keys()) {
			expect(key).toContain(`/envelopes/${ENVELOPE_ID}/`);
		}
	});

	it('fails closed and publishes no artifact or audit event when value_json is tampered but value_sha256 is unchanged', async () => {
		await seedDraftEnvelope();
		const ready = await readyEnvelope([
			{
				email: 'signer@example.com',
				name: 'Signer',
				role: 'signer',
				locale: 'en',
				routingOrder: 1
			}
		]);
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
		const fieldResult = await new EnvelopeFieldApplication(
			new PostgresEnvelopeFieldStore(database()),
			drafts
		).place(ACTOR, ENVELOPE_ID, {
			idempotencyKey: 'fields-tamper-integration',
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
		if (fieldResult.outcome !== 'published') throw new Error('Expected field placement to publish');
		const fieldId: string = fieldResult.result.fields[0].id;

		const sealer: AesGcmRecipientCapabilitySealer = new AesGcmRecipientCapabilitySealer(
			TEST_DELIVERY_ENCRYPTION_KEY
		);
		await new EnvelopeSendApplication(new PostgresEnvelopeSendStore(database()), sealer).send(
			ACTOR,
			ENVELOPE_ID,
			{
				idempotencyKey: 'send-before-tamper',
				expectedGeneration: 1,
				expectedReadyAuditEventId: ready.auditEventId
			}
		);
		const completedAt: string = new Date(Date.now() + 1_000).toISOString();
		await database()`UPDATE recipient SET status = 'viewed', updated_at = ${completedAt}
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
				AND id = ${signerId}`;
		const delivery = await database()<
			{ deliveryId: string; sealedCapability: string }[]
		>`SELECT id AS "deliveryId", sealed_capability AS "sealedCapability" FROM delivery_outbox
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
				AND recipient_id = ${signerId}`;
		const token: string = await sealer.open(delivery[0].sealedCapability, {
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			recipientId: signerId,
			deliveryId: delivery[0].deliveryId
		});
		const signResult = await new RecipientSignedApplication(
			new PostgresRecipientSignStore(database()),
			(): Date => new Date(completedAt)
		).sign({
			token,
			expectedEnvelopeId: ENVELOPE_ID,
			expectedRecipientId: signerId,
			expectedFieldGeneration: 1,
			idempotencyKey: 'sign-tamper-integration',
			values: [{ fieldId, value: 'Jane Doe' }]
		});
		expect(signResult).toMatchObject({
			outcome: 'published',
			result: { envelopeStatus: 'completed' }
		});

		// Tampering: the signed value_json is altered after the fact while
		// value_sha256 is left at its originally-correct digest. The
		// integrity check must reject this before touching Git or object
		// storage, so both doubles below throw if ever invoked.
		await database()`UPDATE field_value SET value_json = '"Tampered"'
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
				AND field_id = ${fieldId}`;

		const store = new PostgresCompletionArtifactStore(database());
		const objects = new UnreachablePostgresObjectStore();
		const repository = new UnreachablePostgresDraftRepository();
		const claimedAt: string = new Date(Date.now() + 2_000).toISOString();
		const service = new CompletionArtifactPublicationService(
			store,
			objects,
			repository,
			(): Date => new Date(claimedAt),
			(): string => 'completion-artifact-tamper-claim-0001'
		);

		const result = await service.publishPendingCompletionArtifacts();
		expect(result).toMatchObject({ claimed: 1, integrityFailed: 1, published: 0 });

		const artifactCount = await database()<
			{ count: string }[]
		>`SELECT COUNT(*) AS count FROM completion_artifact
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}`;
		expect(Number(artifactCount[0].count)).toBe(0);

		const publishedAuditCount = await database()<
			{ count: string }[]
		>`SELECT COUNT(*) AS count FROM audit_event
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
				AND event_type = 'envelope.completion_artifact_published'`;
		expect(Number(publishedAuditCount[0].count)).toBe(0);

		const jobRow = await database()<
			{ status: string; retryable: boolean; lastError: string | null }[]
		>`SELECT status, retryable, last_error AS "lastError" FROM completion_artifact_job
			WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}`;
		expect(jobRow).toEqual([
			{ status: 'failed', retryable: false, lastError: 'completion_artifact_evidence_invalid' }
		]);
	});

	describe('completion audit chain integrity (real Postgres)', () => {
		it('fails closed when the terminal envelope.completed payload is altered', async () => {
			const { anchor } = await seedVerifiedCompletionEnvelope();
			await database()`UPDATE audit_event SET payload_json = ${JSON.stringify({
				sentCommitSha: COMMIT_SHA,
				completedAt: '2099-01-01T00:00:00.000Z'
			})} WHERE organization_id = ${ORGANIZATION_ID} AND id = ${anchor.id}`;
			await expectCompletionArtifactFailClosed();
		});

		it('fails closed when the terminal envelope.completed occurred_at is altered', async () => {
			const { anchor } = await seedVerifiedCompletionEnvelope();
			await database()`UPDATE audit_event SET occurred_at = occurred_at + interval '1 millisecond'
				WHERE organization_id = ${ORGANIZATION_ID} AND id = ${anchor.id}`;
			await expectCompletionArtifactFailClosed();
		});

		it('fails closed when a mid-chain draft.revision_created event is altered', async () => {
			const { events } = await seedVerifiedCompletionEnvelope();
			const draftEvent = events.find(
				(event) => event.eventType === 'draft.revision_created'
			) as CompletionEvidenceAuditEvent;
			await database()`UPDATE audit_event SET payload_json = ${JSON.stringify({
				generation: 1,
				commitSha: COMMIT_SHA,
				archiveSha256: 'f'.repeat(64),
				changedPaths: ['documents/agreement.md']
			})} WHERE organization_id = ${ORGANIZATION_ID} AND id = ${draftEvent.id}`;
			await expectCompletionArtifactFailClosed();
		});

		it('fails closed when a recipient row is inserted that the envelope.ready event never declared', async () => {
			await seedVerifiedCompletionEnvelope();
			await database()`INSERT INTO recipient (
				id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
				capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
			) VALUES (
				'01930000-0000-7000-8000-0000000000e7', ${ORGANIZATION_ID}, ${ENVELOPE_ID}, 'extra@example.com', 'Extra',
				'viewer', 'en', 1, 'pending', NULL, NULL, NULL,
				'2026-09-11T00:01:00.000Z', '2026-09-11T00:01:00.000Z'
			)`;
			await expectCompletionArtifactFailClosed();
		});

		it("fails closed when a recipient's role drifts from the envelope.ready declaration", async () => {
			await seedVerifiedCompletionEnvelope();
			await database()`UPDATE recipient SET role = 'approver'
				WHERE organization_id = ${ORGANIZATION_ID} AND id = '01930000-0000-7000-8000-000000000001'`;
			await expectCompletionArtifactFailClosed();
		});

		it('fails closed when a field_value row is inserted after signing', async () => {
			await seedVerifiedCompletionEnvelope();
			await database()`INSERT INTO envelope_field (
				id, organization_id, envelope_id, recipient_id, document_path, field_type, label,
				required, position, created_at, updated_at
			) VALUES (
				'01950000-0000-7000-8000-0000000000e7', ${ORGANIZATION_ID}, ${ENVELOPE_ID}, '01930000-0000-7000-8000-000000000001', 'documents/agreement.md',
				'date', 'Signed date', true, 2, '2026-09-11T00:01:00.000Z', '2026-09-11T00:01:00.000Z'
			)`;
			await database()`INSERT INTO field_value (
				organization_id, field_id, envelope_id, recipient_id, field_type, value_json,
				value_sha256, created_at
			) VALUES (
				${ORGANIZATION_ID}, '01950000-0000-7000-8000-0000000000e7', ${ENVELOPE_ID}, '01930000-0000-7000-8000-000000000001', 'date',
				${EXTRA_FIELD_VALUE_JSON}, ${EXTRA_FIELD_VALUE_SHA256}, '2026-09-11T00:02:00.000Z'
			)`;
			await expectCompletionArtifactFailClosed();
		});

		it('fails closed when a field_value row is deleted after signing', async () => {
			await seedVerifiedCompletionEnvelope();
			await database()`DELETE FROM field_value
				WHERE organization_id = ${ORGANIZATION_ID} AND field_id = '01950000-0000-7000-8000-000000000001'`;
			await expectCompletionArtifactFailClosed();
		});

		it('fails closed when occurred_at is altered below millisecond precision', async () => {
			const { anchor } = await seedVerifiedCompletionEnvelope();
			await database()`UPDATE audit_event SET occurred_at = occurred_at + interval '400 microseconds'
				WHERE organization_id = ${ORGANIZATION_ID} AND id = ${anchor.id}`;
			await expectCompletionArtifactFailClosed();
		});
	});

	it('enforces API key owner membership, hashed credentials, and already-issued create receipts', async () => {
		const createdAt: string = '2026-09-12T12:00:00.000Z';
		const expiresAt: string = '2026-12-11T12:00:00.000Z';
		const keyId: string = '01900000-0000-7000-8000-000000000201';
		const issued: IssuedApiKey = await issueApiKey();
		const scopesJson: string = canonicalizeApiKeyScopesJson(['envelopes:send', 'drafts:write']);
		const secretColumns: { columnName: string }[] = await database()<
			{ columnName: string }[]
		>`SELECT column_name AS "columnName" FROM information_schema.columns
			WHERE table_schema = ${schemaName}
				AND table_name IN (
					'api_key',
					'api_key_create_command',
					'api_key_revoke_command',
					'instance_member',
					'instance_bootstrap',
					'instance_bootstrap_command'
				)
				AND column_name IN ('token', 'secret', 'plaintext', 'credential', 'email', 'organization_id', 'instance_id')`;
		expect(secretColumns).toEqual([]);

		await database()`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES (${ACTOR.id}, 'owner', 'active', ${createdAt}::timestamptz, ${createdAt}::timestamptz)`;
		await database()`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES ('user-2', 'admin', 'active', ${createdAt}::timestamptz, ${createdAt}::timestamptz)`;
		await database()`INSERT INTO instance_member (user_id, status, created_at, updated_at)
			VALUES ('user-3', 'suspended', ${createdAt}::timestamptz, ${createdAt}::timestamptz)`;
		const defaultedRole = await database()<
			{ role: string }[]
		>`SELECT role FROM instance_member WHERE user_id = 'user-3'`;
		expect(defaultedRole[0]?.role).toBe('member');
		await expect(
			database()`INSERT INTO instance_member (user_id, status, created_at, updated_at)
				VALUES ('user-4', 'invited', ${createdAt}::timestamptz, ${createdAt}::timestamptz)`
		).rejects.toMatchObject({ code: '23514' });
		await expect(
			database()`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
				VALUES ('user-5', 'superadmin', 'active', ${createdAt}::timestamptz, ${createdAt}::timestamptz)`
		).rejects.toMatchObject({ code: '23514' });

		await database()`INSERT INTO api_key (
			id, name, token_hash, key_prefix, scopes_json,
			owner_user_id, created_at, expires_at
		) VALUES (
			${keyId}, 'CI agent', ${issued.tokenHash}, ${issued.keyPrefix},
			${scopesJson}, ${ACTOR.id}, ${createdAt}::timestamptz, ${expiresAt}::timestamptz
		)`;
		await database()`INSERT INTO api_key_create_command (
			actor_type, actor_id, idempotency_key, request_hash,
			api_key_id, name, scopes_json, key_prefix, expires_at, created_at
		) VALUES (
			'user', ${ACTOR.id}, 'create-1', ${'a'.repeat(64)},
			${keyId}, 'CI agent', ${scopesJson}, ${issued.keyPrefix},
			${expiresAt}::timestamptz, ${createdAt}::timestamptz
		)`;

		const [stored] = await database()<
			{ tokenHash: string; keyPrefix: string; ownerUserId: string }[]
		>`SELECT token_hash AS "tokenHash", key_prefix AS "keyPrefix",
				owner_user_id AS "ownerUserId"
			FROM api_key WHERE id = ${keyId}`;
		expect(stored.tokenHash).toBe(issued.tokenHash);
		expect(stored.keyPrefix).toBe(issued.keyPrefix);
		expect(stored.ownerUserId).toBe(ACTOR.id);
		expect(stored.keyPrefix).not.toBe(issued.token);

		await expect(
			database()`INSERT INTO api_key_create_command (
				actor_type, actor_id, idempotency_key, request_hash,
				api_key_id, name, scopes_json, key_prefix, expires_at, created_at
			) VALUES (
				'user', ${ACTOR.id}, 'create-1', ${'e'.repeat(64)},
				${keyId}, 'CI agent', ${scopesJson}, ${issued.keyPrefix},
				${expiresAt}::timestamptz, ${createdAt}::timestamptz
			)`
		).rejects.toMatchObject({ code: '23505' });

		await expect(
			database()`INSERT INTO api_key (
				id, name, token_hash, key_prefix, scopes_json,
				owner_user_id, created_at, expires_at
			) VALUES (
				'not-a-uuid', 'CI agent', ${'b'.repeat(64)}, 'signkit_abcdefgh',
				${scopesJson}, ${ACTOR.id}, ${createdAt}::timestamptz, ${expiresAt}::timestamptz
			)`
		).rejects.toMatchObject({ code: '23514' });
		await expect(
			database()`INSERT INTO api_key (
				id, name, token_hash, key_prefix, scopes_json,
				owner_user_id, created_at, expires_at
			) VALUES (
				'01900000-0000-7000-8000-000000000202', ' padded ',
				${'c'.repeat(64)}, 'signkit_ijklmnop', ${scopesJson}, ${ACTOR.id},
				${createdAt}::timestamptz, ${expiresAt}::timestamptz
			)`
		).rejects.toMatchObject({ code: '23514' });
		await database()`INSERT INTO api_key (
			id, name, token_hash, key_prefix, scopes_json,
			owner_user_id, created_at, expires_at
		) VALUES (
			'01900000-0000-7000-8000-000000000206', 'signkitX',
			${'2'.repeat(64)}, 'signkit_ijklmnop', ${scopesJson}, ${ACTOR.id},
			${createdAt}::timestamptz, ${expiresAt}::timestamptz
		)`;
		await expect(
			database()`INSERT INTO api_key (
				id, name, token_hash, key_prefix, scopes_json,
				owner_user_id, created_at, expires_at
			) VALUES (
				'01900000-0000-7000-8000-000000000207', 'signkit_name',
				${'3'.repeat(64)}, 'signkit_qrstuvwx', ${scopesJson}, ${ACTOR.id},
				${createdAt}::timestamptz, ${expiresAt}::timestamptz
			)`
		).rejects.toMatchObject({ code: '23514' });
		await expect(
			database()`INSERT INTO api_key (
				id, name, token_hash, key_prefix, scopes_json,
				owner_user_id, created_at, expires_at
			) VALUES (
				'01900000-0000-7000-8000-000000000203', 'CI agent',
				${'d'.repeat(64)}, 'signkit_qrstuvwx', '["envelopes:send","drafts:write"]', ${ACTOR.id},
				${createdAt}::timestamptz, ${expiresAt}::timestamptz
			)`
		).rejects.toMatchObject({ code: '23514' });
		await expect(
			database()`INSERT INTO api_key (
				id, name, token_hash, key_prefix, scopes_json,
				owner_user_id, created_at, expires_at
			) VALUES (
				'01900000-0000-7000-8000-000000000204', 'CI agent',
				${'e'.repeat(64)}, 'signkit_yzABCDEF', ${scopesJson}, ${ACTOR.id},
				${createdAt}::timestamptz, '2028-09-12T12:00:00.000Z'::timestamptz
			)`
		).rejects.toMatchObject({ code: '23514' });
		await expect(
			database()`INSERT INTO api_key (
				id, name, token_hash, key_prefix, scopes_json,
				owner_user_id, created_at, expires_at
			) VALUES (
				'01900000-0000-7000-8000-000000000205', 'CI agent',
				${issued.tokenHash}, 'signkit_GHJKLMNO', ${scopesJson}, 'user-2',
				${createdAt}::timestamptz, ${expiresAt}::timestamptz
			)`
		).rejects.toMatchObject({ code: '23505' });
		await expect(
			database()`INSERT INTO api_key (
				id, name, token_hash, key_prefix, scopes_json,
				owner_user_id, created_at, expires_at
			) VALUES (
				'01900000-0000-7000-8000-000000000208', 'CI agent',
				${'4'.repeat(64)}, 'signkit_ABCDEFGH', ${scopesJson}, 'missing-user',
				${createdAt}::timestamptz, ${expiresAt}::timestamptz
			)`
		).rejects.toMatchObject({ code: '23503' });

		await database()`INSERT INTO api_key_revoke_command (
			actor_type, actor_id, idempotency_key, request_hash,
			api_key_id, key_prefix, revoked_at
		) VALUES (
			'user', ${ACTOR.id}, 'revoke-1', ${'9'.repeat(64)},
			${keyId}, ${issued.keyPrefix}, ${createdAt}::timestamptz
		)`;
		await expect(
			database()`INSERT INTO api_key_revoke_command (
				actor_type, actor_id, idempotency_key, request_hash,
				api_key_id, key_prefix, revoked_at
			) VALUES (
				'user', ${ACTOR.id}, 'revoke-2', ${'8'.repeat(64)},
				${keyId}, ${issued.keyPrefix}, ${createdAt}::timestamptz
			)`
		).rejects.toMatchObject({ code: '23505' });
	});

	it('keeps instance invitations zero-PII and enforces terminal exclusivity and receipt uniqueness', async () => {
		const createdAt: string = '2026-09-12T12:00:00.000Z';
		const expiresAt: string = '2026-09-19T12:00:00.000Z';
		const invitationId: string = '01900000-0000-7000-8000-000000000401';
		const otherInvitationId: string = '01900000-0000-7000-8000-000000000402';
		const tokenHash: string = 'a'.repeat(64);
		const emailBinding: string = 'b'.repeat(64);

		const piiColumns = await database()<
			{ columnName: string }[]
		>`SELECT column_name AS "columnName" FROM information_schema.columns
			WHERE table_schema = ${schemaName}
				AND table_name IN ('instance_invitation', 'instance_invitation_command')
				AND column_name IN ('email', 'name', 'token', 'secret', 'plaintext', 'credential')`;
		expect(piiColumns).toEqual([]);

		await database()`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES (${ACTOR.id}, 'owner', 'active', ${createdAt}::timestamptz, ${createdAt}::timestamptz)`;

		await database()`INSERT INTO instance_invitation (
				id, role, status, token_hash, email_binding, invited_by_user_id, created_at, expires_at
			) VALUES (
				${invitationId}, 'member', 'pending', ${tokenHash}, ${emailBinding}, ${ACTOR.id},
				${createdAt}::timestamptz, ${expiresAt}::timestamptz
			)`;

		await expect(
			database()`INSERT INTO instance_invitation (
					id, role, status, token_hash, email_binding, invited_by_user_id, created_at, expires_at
				) VALUES (
					${otherInvitationId}, 'member', 'pending', ${tokenHash}, ${'c'.repeat(64)},
					${ACTOR.id}, ${createdAt}::timestamptz, ${expiresAt}::timestamptz
				)`
		).rejects.toMatchObject({ code: '23505' });

		await expect(
			database()`INSERT INTO instance_invitation (
					id, role, status, token_hash, email_binding, invited_by_user_id, created_at, expires_at
				) VALUES (
					${otherInvitationId}, 'member', 'accepted', ${'d'.repeat(64)}, ${'e'.repeat(64)},
					${ACTOR.id}, ${createdAt}::timestamptz, ${expiresAt}::timestamptz
				)`
		).rejects.toMatchObject({ code: '23514' });

		await expect(
			database()`INSERT INTO instance_invitation (
					id, role, status, token_hash, email_binding, invited_by_user_id, created_at, expires_at
				) VALUES (
					${otherInvitationId}, 'member', 'pending', ${'f'.repeat(64)}, ${'0'.repeat(64)},
					${ACTOR.id}, ${createdAt}::timestamptz, '2026-09-20T12:00:00.000Z'::timestamptz
				)`
		).rejects.toMatchObject({ code: '23514' });

		await database()`INSERT INTO instance_invitation_command (
				actor_type, actor_id, idempotency_key, command_type, request_hash,
				invitation_id, role, result_status, occurred_at
			) VALUES (
				'user', ${ACTOR.id}, 'invite-create-1', 'create', ${'1'.repeat(64)},
				${invitationId}, 'member', 'pending', ${createdAt}::timestamptz
			)`;

		// Same (actor_type, actor_id, idempotency_key): primary key conflict.
		await expect(
			database()`INSERT INTO instance_invitation_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					invitation_id, role, result_status, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, 'invite-create-1', 'accept', ${'2'.repeat(64)},
					${invitationId}, 'member', 'accepted', ${createdAt}::timestamptz
				)`
		).rejects.toMatchObject({ code: '23505' });

		// Fresh idempotency key but the same (invitation_id, command_type) pair.
		await expect(
			database()`INSERT INTO instance_invitation_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					invitation_id, role, result_status, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, 'invite-create-2', 'create', ${'3'.repeat(64)},
					${invitationId}, 'member', 'pending', ${createdAt}::timestamptz
				)`
		).rejects.toMatchObject({ code: '23505' });

		await database()`INSERT INTO instance_invitation (
				id, role, status, token_hash, email_binding, invited_by_user_id, created_at, expires_at
			) VALUES (
				${otherInvitationId}, 'member', 'pending', ${'4'.repeat(64)}, ${'5'.repeat(64)},
				${ACTOR.id}, ${createdAt}::timestamptz, ${expiresAt}::timestamptz
			)`;

		// Fresh idempotency key and invitation, but command_type/result_status disagree.
		await expect(
			database()`INSERT INTO instance_invitation_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					invitation_id, role, result_status, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, 'invite-accept-mismatch', 'accept', ${'6'.repeat(64)},
					${otherInvitationId}, 'member', 'revoked', ${createdAt}::timestamptz
				)`
		).rejects.toMatchObject({ code: '23514' });
	});

	it('keeps instance member command receipts zero-PII and enforces their structural invariants', async () => {
		const createdAt: string = '2026-09-12T12:00:00.000Z';
		const otherUserId: string = 'user-member-other';

		const piiColumns = await database()<
			{ columnName: string }[]
		>`SELECT column_name AS "columnName" FROM information_schema.columns
			WHERE table_schema = ${schemaName}
				AND table_name = 'instance_member_command'
				AND column_name IN ('email', 'name', 'token', 'secret', 'plaintext', 'credential')`;
		expect(piiColumns).toEqual([]);

		await database()`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES (${ACTOR.id}, 'owner', 'active', ${createdAt}::timestamptz, ${createdAt}::timestamptz)`;
		await database()`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES (${otherUserId}, 'member', 'active', ${createdAt}::timestamptz, ${createdAt}::timestamptz)`;

		await database()`INSERT INTO instance_member_command (
				actor_type, actor_id, idempotency_key, command_type, request_hash,
				target_user_id, previous_role, previous_status, result_role, result_status,
				revoked_invitation_count, occurred_at
			) VALUES (
				'user', ${ACTOR.id}, 'member-cmd-1', 'set_role', ${'1'.repeat(64)},
				${otherUserId}, 'member', 'active', 'admin', 'active', 0, ${createdAt}::timestamptz
			)`;

		// Same (actor_type, actor_id, idempotency_key): primary key conflict.
		await expect(
			database()`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, 'member-cmd-1', 'set_status', ${'2'.repeat(64)},
					${otherUserId}, 'admin', 'active', 'admin', 'suspended', 0, ${createdAt}::timestamptz
				)`
		).rejects.toMatchObject({ code: '23505' });

		// set_role must not also change status.
		await expect(
			database()`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, 'member-cmd-2', 'set_role', ${'3'.repeat(64)},
					${otherUserId}, 'member', 'active', 'admin', 'suspended', 0, ${createdAt}::timestamptz
				)`
		).rejects.toMatchObject({ code: '23514' });

		// set_status must not also change role.
		await expect(
			database()`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, 'member-cmd-3', 'set_status', ${'4'.repeat(64)},
					${otherUserId}, 'member', 'active', 'admin', 'suspended', 0, ${createdAt}::timestamptz
				)`
		).rejects.toMatchObject({ code: '23514' });

		// set_status may never self-target.
		await expect(
			database()`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, 'member-cmd-4', 'set_status', ${'5'.repeat(64)},
					${ACTOR.id}, 'owner', 'active', 'owner', 'suspended', 0, ${createdAt}::timestamptz
				)`
		).rejects.toMatchObject({ code: '23514' });

		// Unknown command_type/role/status enums.
		await expect(
			database()`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, 'member-cmd-5', 'delete', ${'6'.repeat(64)},
					${otherUserId}, 'member', 'active', 'admin', 'active', 0, ${createdAt}::timestamptz
				)`
		).rejects.toMatchObject({ code: '23514' });
		await expect(
			database()`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, 'member-cmd-6', 'set_role', ${'7'.repeat(64)},
					${otherUserId}, 'superadmin', 'active', 'admin', 'active', 0, ${createdAt}::timestamptz
				)`
		).rejects.toMatchObject({ code: '23514' });

		// Malformed request hash and idempotency key.
		await expect(
			database()`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, 'member-cmd-7', 'set_role', 'not-sha256',
					${otherUserId}, 'member', 'active', 'admin', 'active', 0, ${createdAt}::timestamptz
				)`
		).rejects.toMatchObject({ code: '23514' });
		await expect(
			database()`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, '', 'set_role', ${'8'.repeat(64)},
					${otherUserId}, 'member', 'active', 'admin', 'active', 0, ${createdAt}::timestamptz
				)`
		).rejects.toMatchObject({ code: '23514' });

		// Negative revoked invitation counts are rejected.
		await expect(
			database()`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, 'member-cmd-8', 'set_role', ${'9'.repeat(64)},
					${otherUserId}, 'member', 'active', 'admin', 'active', -1, ${createdAt}::timestamptz
				)`
		).rejects.toMatchObject({ code: '23514' });

		// Actor and target must each reference an existing instance member.
		await expect(
			database()`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES (
					'user', 'missing-actor', 'member-cmd-9', 'set_role', ${'a'.repeat(64)},
					${otherUserId}, 'member', 'active', 'admin', 'active', 0, ${createdAt}::timestamptz
				)`
		).rejects.toMatchObject({ code: '23503' });
		await expect(
			database()`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, 'member-cmd-10', 'set_role', ${'b'.repeat(64)},
					'missing-target', 'member', 'active', 'admin', 'active', 0, ${createdAt}::timestamptz
				)`
		).rejects.toMatchObject({ code: '23503' });

		// Whitespace is outside the printable-ASCII Idempotency-Key charset.
		await expect(
			database()`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, 'member cmd 11', 'set_role', ${'c'.repeat(64)},
					${otherUserId}, 'member', 'active', 'admin', 'active', 0, ${createdAt}::timestamptz
				)`
		).rejects.toMatchObject({ code: '23514' });
	});

	it('mirrors the D1 member command row-local evidence constraints', async () => {
		const createdAt: string = '2026-09-12T12:00:00.000Z';
		const appliedAt: string = '2026-09-12T13:00:00.000Z';
		const otherUserId: string = 'user-member-other';

		await database()`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES (${ACTOR.id}, 'owner', 'active', ${createdAt}::timestamptz, ${createdAt}::timestamptz)`;
		await database()`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES (${otherUserId}, 'member', 'active', ${createdAt}::timestamptz, ${createdAt}::timestamptz)`;

		// A self-targeting receipt may only ever claim an active owner: set_status
		// can never self-target, and an admin may only administer a current
		// member-role target, which its own row never is.
		await expect(
			database()`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, 'self-admin', 'set_role', ${'1'.repeat(64)},
					${ACTOR.id}, 'admin', 'active', 'member', 'active', 0, ${appliedAt}::timestamptz
				)`
		).rejects.toMatchObject({
			code: '23514',
			constraint_name: 'instance_member_command_self_target_active_owner'
		});
		await expect(
			database()`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, 'self-suspended', 'set_role', ${'2'.repeat(64)},
					${ACTOR.id}, 'owner', 'suspended', 'admin', 'suspended', 0, ${appliedAt}::timestamptz
				)`
		).rejects.toMatchObject({
			code: '23514',
			constraint_name: 'instance_member_command_self_target_active_owner'
		});

		// Only a suspension or a demotion can cascade-revoke the target's pending
		// invitations; a promotion or a reactivation revokes nothing.
		await expect(
			database()`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, 'promotion-cascade', 'set_role', ${'3'.repeat(64)},
					${otherUserId}, 'member', 'active', 'admin', 'active', 1, ${appliedAt}::timestamptz
				)`
		).rejects.toMatchObject({
			code: '23514',
			constraint_name: 'instance_member_command_cascade_requires_demotion'
		});
		await expect(
			database()`INSERT INTO instance_member_command (
					actor_type, actor_id, idempotency_key, command_type, request_hash,
					target_user_id, previous_role, previous_status, result_role, result_status,
					revoked_invitation_count, occurred_at
				) VALUES (
					'user', ${ACTOR.id}, 'reactivation-cascade', 'set_status', ${'4'.repeat(64)},
					${otherUserId}, 'member', 'suspended', 'member', 'active', 1, ${appliedAt}::timestamptz
				)`
		).rejects.toMatchObject({
			code: '23514',
			constraint_name: 'instance_member_command_cascade_requires_demotion'
		});

		// A self-demotion by an active owner, a demotion carrying a cascade count,
		// and a suspension carrying one are all accepted.
		await database()`INSERT INTO instance_member_command (
				actor_type, actor_id, idempotency_key, command_type, request_hash,
				target_user_id, previous_role, previous_status, result_role, result_status,
				revoked_invitation_count, occurred_at
			) VALUES (
				'user', ${ACTOR.id}, 'self-demote', 'set_role', ${'5'.repeat(64)},
				${ACTOR.id}, 'owner', 'active', 'admin', 'active', 2, ${appliedAt}::timestamptz
			)`;
		await database()`INSERT INTO instance_member_command (
				actor_type, actor_id, idempotency_key, command_type, request_hash,
				target_user_id, previous_role, previous_status, result_role, result_status,
				revoked_invitation_count, occurred_at
			) VALUES (
				'user', ${ACTOR.id}, 'suspend-member', 'set_status', ${'6'.repeat(64)},
				${otherUserId}, 'member', 'active', 'member', 'suspended', 3, ${appliedAt}::timestamptz
			)`;

		const receipts = await database()<
			{ idempotencyKey: string; revokedInvitationCount: number }[]
		>`SELECT idempotency_key AS "idempotencyKey",
				revoked_invitation_count AS "revokedInvitationCount"
			FROM instance_member_command ORDER BY idempotency_key`;
		expect(receipts).toEqual([
			{ idempotencyKey: 'self-demote', revokedInvitationCount: 2 },
			{ idempotencyKey: 'suspend-member', revokedInvitationCount: 3 }
		]);
	});

	describe('PostgresApiKeyStore', () => {
		const API_CREATED_AT: string = '2026-09-12T12:00:00.000Z';
		const API_EXPIRES_AT: string = '2026-12-11T12:00:00.000Z';
		const API_REVOKED_AT: string = '2026-09-12T13:00:00.000Z';
		const API_KEY_ROW_ID: string = '01900000-0000-7000-8000-000000000301';
		const OTHER_API_KEY_ID: string = '01900000-0000-7000-8000-000000000302';
		const THIRD_API_KEY_ID: string = '01900000-0000-7000-8000-000000000303';
		const OTHER_OWNER_ID: string = 'user-api-other';
		const API_REQUEST_HASH: string = '1'.repeat(64);
		const OTHER_API_REQUEST_HASH: string = '2'.repeat(64);

		function apiKeyStore(sql: ReturnType<typeof postgres> = database()): PostgresApiKeyStore {
			return new PostgresApiKeyStore(sql);
		}

		async function seedActiveOwner(userId: string = ACTOR.id): Promise<void> {
			await database()`INSERT INTO instance_member (user_id, status, created_at, updated_at)
				VALUES (${userId}, 'active', ${API_CREATED_AT}::timestamptz, ${API_CREATED_AT}::timestamptz)
				ON CONFLICT (user_id) DO UPDATE SET status = 'active'`;
		}

		async function apiKeyCreateCommand(
			overrides: Partial<CreateApiKeyCommand> = {}
		): Promise<CreateApiKeyCommand> {
			const credential: IssuedApiKey = await issueApiKey();
			return {
				actor: { type: 'user', id: ACTOR.id },
				idempotencyKey: 'api-create-1',
				requestFingerprint: API_REQUEST_HASH,
				apiKeyId: API_KEY_ROW_ID,
				name: 'CI agent',
				scopes: ['audit:read', 'envelopes:send'],
				tokenHash: credential.tokenHash,
				keyPrefix: credential.keyPrefix,
				createdAt: API_CREATED_AT,
				expiresAt: API_EXPIRES_AT,
				...overrides
			};
		}

		function apiKeyRevokeCommand(
			overrides: Partial<RevokeApiKeyCommand> = {}
		): RevokeApiKeyCommand {
			return {
				actor: { type: 'user', id: ACTOR.id },
				idempotencyKey: 'api-revoke-1',
				requestFingerprint: API_REQUEST_HASH,
				apiKeyId: API_KEY_ROW_ID,
				revokedAt: API_REVOKED_AT,
				...overrides
			};
		}

		async function countRows(table: string): Promise<number> {
			const rows: { value: number }[] = await database().unsafe<{ value: number }[]>(
				`SELECT count(*)::int AS value FROM ${table}`
			);
			return Number(rows[0].value);
		}

		async function withSecondConnection<T>(
			use: (sql: ReturnType<typeof postgres>) => Promise<T>
		): Promise<T> {
			const other: ReturnType<typeof postgres> = postgres(TEST_DATABASE_URL as string, {
				max: 1,
				onnotice: (): void => undefined
			});
			try {
				await other.unsafe(`SET search_path TO "${schemaName}"`);
				await other.unsafe(`SET TIME ZONE 'UTC'`);
				return await use(other);
			} finally {
				await other.end({ timeout: 5 });
			}
		}

		it('creates the owner-scoped key and receipt atomically without plaintext', async () => {
			await seedActiveOwner();
			const credential: IssuedApiKey = await issueApiKey();
			const command: CreateApiKeyCommand = await apiKeyCreateCommand({
				tokenHash: credential.tokenHash,
				keyPrefix: credential.keyPrefix
			});

			const created: CreateApiKeyStoreResult = await apiKeyStore().createApiKey(command);

			expect(created).toEqual({
				outcome: 'created',
				key: {
					id: API_KEY_ROW_ID,
					name: 'CI agent',
					keyPrefix: credential.keyPrefix,
					scopes: ['audit:read', 'envelopes:send'],
					createdAt: API_CREATED_AT,
					expiresAt: API_EXPIRES_AT,
					lastUsedAt: null,
					revokedAt: null
				}
			});
			const stored = await database()<
				{ tokenHash: string; keyPrefix: string; ownerUserId: string; scopesJson: string }[]
			>`SELECT token_hash AS "tokenHash", key_prefix AS "keyPrefix",
					owner_user_id AS "ownerUserId", scopes_json AS "scopesJson"
				FROM api_key WHERE owner_user_id = ${ACTOR.id}`;
			expect(stored).toEqual([
				{
					tokenHash: credential.tokenHash,
					keyPrefix: credential.keyPrefix,
					ownerUserId: ACTOR.id,
					scopesJson: '["audit:read","envelopes:send"]'
				}
			]);
			const plaintext = await database()<
				{ value: number }[]
			>`SELECT count(*)::int AS value FROM api_key WHERE token_hash = ${credential.token}`;
			expect(Number(plaintext[0].value)).toBe(0);
			expect(await countRows('api_key_create_command')).toBe(1);
		});

		it('replays an exact create and fails closed for suspended owners', async () => {
			await seedActiveOwner();
			await apiKeyStore().createApiKey(await apiKeyCreateCommand());

			const replay: CreateApiKeyStoreResult = await apiKeyStore().createApiKey(
				await apiKeyCreateCommand({ apiKeyId: OTHER_API_KEY_ID })
			);
			expect(replay.outcome).toBe('already_issued');
			if (replay.outcome !== 'already_issued') {
				expect.unreachable('replay should be already_issued');
			}
			expect(replay.key.id).toBe(API_KEY_ROW_ID);
			expect(await countRows('api_key')).toBe(1);

			await database()`UPDATE instance_member SET status = 'suspended' WHERE user_id = ${ACTOR.id}`;
			await expect(
				apiKeyStore().createApiKey(
					await apiKeyCreateCommand({
						idempotencyKey: 'api-create-remap',
						requestFingerprint: OTHER_API_REQUEST_HASH,
						apiKeyId: OTHER_API_KEY_ID
					})
				)
			).resolves.toEqual({ outcome: 'owner_not_active' });
			expect(await countRows('api_key')).toBe(1);
		});

		it('classifies reused idempotency keys, drifted receipts, and credential collisions', async () => {
			await seedActiveOwner();
			const first: CreateApiKeyCommand = await apiKeyCreateCommand();
			await apiKeyStore().createApiKey(first);

			await expect(
				apiKeyStore().createApiKey(
					await apiKeyCreateCommand({
						requestFingerprint: OTHER_API_REQUEST_HASH,
						apiKeyId: OTHER_API_KEY_ID
					})
				)
			).resolves.toEqual({ outcome: 'idempotency_conflict' });

			await expect(
				apiKeyStore().createApiKey(
					await apiKeyCreateCommand({
						idempotencyKey: 'api-create-2',
						requestFingerprint: OTHER_API_REQUEST_HASH,
						apiKeyId: OTHER_API_KEY_ID,
						tokenHash: first.tokenHash
					})
				)
			).resolves.toEqual({ outcome: 'token_hash_conflict' });

			await expect(
				apiKeyStore().createApiKey(
					await apiKeyCreateCommand({
						idempotencyKey: 'api-create-3',
						requestFingerprint: OTHER_API_REQUEST_HASH
					})
				)
			).resolves.toEqual({ outcome: 'key_id_conflict' });

			await database()`UPDATE api_key SET name = 'Renamed agent'
				WHERE owner_user_id = ${ACTOR.id} AND id = ${API_KEY_ROW_ID}`;
			await expect(
				apiKeyStore().createApiKey(await apiKeyCreateCommand({ apiKeyId: OTHER_API_KEY_ID }))
			).resolves.toEqual({ outcome: 'idempotency_conflict' });
			expect(await countRows('api_key')).toBe(1);
		});

		it('lists owner-scoped keys newest first and fails a cross-owner cursor closed', async () => {
			await seedActiveOwner();
			await seedActiveOwner(OTHER_OWNER_ID);
			await apiKeyStore().createApiKey(
				await apiKeyCreateCommand({
					idempotencyKey: 'api-create-a',
					apiKeyId: API_KEY_ROW_ID,
					name: 'Oldest',
					createdAt: '2026-09-10T12:00:00.000Z',
					expiresAt: '2026-12-09T12:00:00.000Z'
				})
			);
			await apiKeyStore().createApiKey(
				await apiKeyCreateCommand({
					idempotencyKey: 'api-create-b',
					requestFingerprint: OTHER_API_REQUEST_HASH,
					apiKeyId: OTHER_API_KEY_ID,
					name: 'Tied lower id'
				})
			);
			await apiKeyStore().createApiKey(
				await apiKeyCreateCommand({
					idempotencyKey: 'api-create-c',
					requestFingerprint: '3'.repeat(64),
					apiKeyId: THIRD_API_KEY_ID,
					name: 'Tied higher id'
				})
			);
			await apiKeyStore().createApiKey(
				await apiKeyCreateCommand({
					actor: { type: 'user', id: OTHER_OWNER_ID },
					idempotencyKey: 'api-create-a',
					apiKeyId: '01900000-0000-7000-8000-000000000399',
					name: 'Other owner key'
				})
			);

			const first: ListApiKeyStoreResult = await apiKeyStore().listApiKeys(
				{ type: 'user', id: ACTOR.id },
				{ cursor: null, limit: 2 }
			);
			expect(first.outcome).toBe('listed');
			if (first.outcome !== 'listed') expect.unreachable('list should succeed');
			expect(first.page.items.map((item: ApiKeyMetadata): string => item.id)).toEqual([
				THIRD_API_KEY_ID,
				OTHER_API_KEY_ID
			]);
			expect(first.page.nextCursor).toBe(OTHER_API_KEY_ID);

			const second: ListApiKeyStoreResult = await apiKeyStore().listApiKeys(
				{ type: 'user', id: ACTOR.id },
				{ cursor: first.page.nextCursor, limit: 2 }
			);
			expect(second.outcome).toBe('listed');
			if (second.outcome !== 'listed') expect.unreachable('list should succeed');
			expect(second.page.items.map((item: ApiKeyMetadata): string => item.id)).toEqual([
				API_KEY_ROW_ID
			]);
			expect(second.page.nextCursor).toBeNull();
			expect(Object.keys(second.page.items[0]).sort()).toEqual([
				'createdAt',
				'expiresAt',
				'id',
				'keyPrefix',
				'lastUsedAt',
				'name',
				'revokedAt',
				'scopes'
			]);

			await expect(
				apiKeyStore().listApiKeys(
					{ type: 'user', id: ACTOR.id },
					{ cursor: '01900000-0000-7000-8000-000000000399', limit: 10 }
				)
			).resolves.toEqual({ outcome: 'listed', page: { items: [], nextCursor: null } });
			await expect(
				apiKeyStore().listApiKeys(
					{ type: 'user', id: ACTOR.id },
					{ cursor: '01900000-0000-7000-8000-000000000998', limit: 10 }
				)
			).resolves.toEqual({ outcome: 'listed', page: { items: [], nextCursor: null } });
			// The service no longer answers a malformed cursor on its own, so the
			// store receives it: it is bound as a parameter against a text id column
			// and matches nothing, which is the same opaque empty page.
			await expect(
				apiKeyStore().listApiKeys(
					{ type: 'user', id: ACTOR.id },
					{ cursor: 'not-a-uuid', limit: 10 }
				)
			).resolves.toEqual({ outcome: 'listed', page: { items: [], nextCursor: null } });
		});

		it('revokes once, replays the original key, and reports already_revoked for a fresh key', async () => {
			await seedActiveOwner();
			await apiKeyStore().createApiKey(await apiKeyCreateCommand());

			const revoked: RevokeApiKeyStoreResult =
				await apiKeyStore().revokeApiKey(apiKeyRevokeCommand());
			expect(revoked.outcome).toBe('revoked');
			if (revoked.outcome !== 'revoked') expect.unreachable('first revoke should succeed');
			expect(revoked.key.revokedAt).toBe(API_REVOKED_AT);

			await expect(apiKeyStore().revokeApiKey(apiKeyRevokeCommand())).resolves.toEqual({
				outcome: 'replayed',
				key: revoked.key
			});
			await expect(
				apiKeyStore().revokeApiKey(
					apiKeyRevokeCommand({ requestFingerprint: OTHER_API_REQUEST_HASH })
				)
			).resolves.toEqual({ outcome: 'idempotency_conflict' });

			const again: RevokeApiKeyStoreResult = await apiKeyStore().revokeApiKey(
				apiKeyRevokeCommand({
					idempotencyKey: 'api-revoke-2',
					revokedAt: '2026-09-12T14:00:00.000Z'
				})
			);
			expect(again).toEqual({ outcome: 'already_revoked', key: revoked.key });
			expect(await countRows('api_key_revoke_command')).toBe(1);
		});

		it('answers unknown and cross-owner revocations with not_found', async () => {
			await seedActiveOwner();
			await seedActiveOwner(OTHER_OWNER_ID);
			await apiKeyStore().createApiKey(await apiKeyCreateCommand());

			await expect(
				apiKeyStore().revokeApiKey(apiKeyRevokeCommand({ apiKeyId: OTHER_API_KEY_ID }))
			).resolves.toEqual({ outcome: 'not_found' });
			await expect(
				apiKeyStore().revokeApiKey(
					apiKeyRevokeCommand({ actor: { type: 'user', id: OTHER_OWNER_ID } })
				)
			).resolves.toEqual({ outcome: 'not_found' });
			expect(await countRows('api_key_revoke_command')).toBe(0);
		});

		it('fails a drifted revoke receipt closed', async () => {
			await seedActiveOwner();
			await apiKeyStore().createApiKey(await apiKeyCreateCommand());
			await apiKeyStore().revokeApiKey(apiKeyRevokeCommand());
			await database()`UPDATE api_key
				SET revoked_at = '2026-09-12T15:00:00.000Z'::timestamptz
				WHERE owner_user_id = ${ACTOR.id} AND id = ${API_KEY_ROW_ID}`;

			await expect(apiKeyStore().revokeApiKey(apiKeyRevokeCommand())).resolves.toEqual({
				outcome: 'integrity_error'
			});
		});

		it('serializes two connections racing the same create idempotency key', async () => {
			await seedActiveOwner();
			const firstCommand: CreateApiKeyCommand = await apiKeyCreateCommand();
			const secondCommand: CreateApiKeyCommand = await apiKeyCreateCommand({
				apiKeyId: OTHER_API_KEY_ID
			});

			const outcomes: readonly CreateApiKeyStoreResult[] = await withSecondConnection(
				async (other: ReturnType<typeof postgres>): Promise<CreateApiKeyStoreResult[]> =>
					await Promise.all([
						apiKeyStore().createApiKey(firstCommand),
						apiKeyStore(other).createApiKey(secondCommand)
					])
			);

			const kinds: readonly string[] = outcomes.map(
				(outcome: CreateApiKeyStoreResult): string => outcome.outcome
			);
			expect(kinds.filter((kind: string): boolean => kind === 'created')).toHaveLength(1);
			expect(kinds.filter((kind: string): boolean => kind === 'already_issued')).toHaveLength(1);
			expect(await countRows('api_key')).toBe(1);
			expect(await countRows('api_key_create_command')).toBe(1);
		});

		it('serializes two connections racing a revocation of the same key onto one receipt', async () => {
			await seedActiveOwner();
			await apiKeyStore().createApiKey(await apiKeyCreateCommand());

			const outcomes: readonly RevokeApiKeyStoreResult[] = await withSecondConnection(
				async (other: ReturnType<typeof postgres>): Promise<RevokeApiKeyStoreResult[]> =>
					await Promise.all([
						apiKeyStore().revokeApiKey(apiKeyRevokeCommand({ idempotencyKey: 'api-revoke-a' })),
						apiKeyStore(other).revokeApiKey(
							apiKeyRevokeCommand({
								idempotencyKey: 'api-revoke-b',
								revokedAt: '2026-09-12T13:30:00.000Z'
							})
						)
					])
			);

			const kinds: readonly string[] = outcomes.map(
				(outcome: RevokeApiKeyStoreResult): string => outcome.outcome
			);
			expect(kinds.filter((kind: string): boolean => kind === 'revoked')).toHaveLength(1);
			expect(kinds.filter((kind: string): boolean => kind === 'already_revoked')).toHaveLength(1);
			expect(await countRows('api_key_revoke_command')).toBe(1);
			const revoked = await database()<
				{ value: number }[]
			>`SELECT count(*)::int AS value FROM api_key WHERE revoked_at IS NOT NULL`;
			expect(Number(revoked[0].value)).toBe(1);
		});

		it('fails closed for suspended and missing owners', async () => {
			await expect(
				apiKeyStore().createApiKey(
					await apiKeyCreateCommand({ actor: { type: 'user', id: 'missing-owner' } })
				)
			).resolves.toEqual({ outcome: 'owner_not_active' });
			await database()`INSERT INTO instance_member (user_id, status, created_at, updated_at)
				VALUES (${ACTOR.id}, 'suspended', now(), now())`;
			await expect(apiKeyStore().createApiKey(await apiKeyCreateCommand())).resolves.toEqual({
				outcome: 'owner_not_active'
			});
			await expect(
				apiKeyStore().listApiKeys({ type: 'user', id: ACTOR.id }, { cursor: null, limit: 10 })
			).resolves.toEqual({ outcome: 'owner_not_active' });
			// A malformed cursor must not short-circuit that authorization.
			await expect(
				apiKeyStore().listApiKeys(
					{ type: 'user', id: ACTOR.id },
					{ cursor: 'not-a-uuid', limit: 10 }
				)
			).resolves.toEqual({ outcome: 'owner_not_active' });
			await database()`UPDATE instance_member SET status = 'suspended' WHERE user_id = ${ACTOR.id}`;
			await expect(apiKeyStore().revokeApiKey(apiKeyRevokeCommand())).resolves.toEqual({
				outcome: 'owner_not_active'
			});
			expect(await countRows('api_key')).toBe(0);
		});
	});
});

const VERIFIED_ARCHIVE_BYTES: Uint8Array = new TextEncoder().encode('fake-git-archive-postgres');
const VERIFIED_ARCHIVE_SHA256: string = createHash('sha256')
	.update(VERIFIED_ARCHIVE_BYTES)
	.digest('hex');
const VERIFIED_FIELD_VALUE_JSON: string = '"Signed"';
const VERIFIED_FIELD_VALUE_SHA256: string = createHash('sha256')
	.update(VERIFIED_FIELD_VALUE_JSON)
	.digest('hex');
const VERIFIED_SIGNED_AT: string = '2026-09-11T00:01:30.000Z';
const VERIFIED_COMPLETED_AT: string = '2026-09-11T00:02:00.000Z';
const EXTRA_FIELD_VALUE_JSON: string = '"2026-09-11"';
const EXTRA_FIELD_VALUE_SHA256: string = createHash('sha256')
	.update(EXTRA_FIELD_VALUE_JSON)
	.digest('hex');

/**
 * A self-contained, real hash-verified 4-event completion audit chain
 * (envelope.created, a mid-chain draft.revision_created, recipient.signed
 * declaring field-1, and the envelope.completed anchor) inserted directly —
 * bypassing the wider recipient state-machine fixtures, which seed their own
 * early events with placeholder (non-cryptographic) hashes that are fine for
 * store-level tests but would make every chain-hash tamper test below fail
 * for the wrong reason.
 */
async function seedVerifiedCompletionEnvelope(): Promise<{
	events: CompletionEvidenceAuditEvent[];
	anchor: CompletionEvidenceAuditEvent;
}> {
	const events = await buildVerifiedAuditChain(
		{ organizationId: ORGANIZATION_ID, envelopeId: ENVELOPE_ID },
		[
			{
				id: '01900000-0000-7000-8000-000000000101',
				eventType: 'envelope.created',
				actorType: 'user',
				actorId: ACTOR.id,
				occurredAt: '2026-09-11T00:00:00.000Z',
				payload: { title: 'Agreement' }
			},
			{
				id: '01900000-0000-7000-8000-000000000105',
				eventType: 'envelope.ready',
				actorType: 'user',
				actorId: ACTOR.id,
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
				id: '01900000-0000-7000-8000-000000000102',
				eventType: 'draft.revision_created',
				actorType: 'user',
				actorId: ACTOR.id,
				occurredAt: '2026-09-11T00:00:30.000Z',
				payload: {
					generation: 1,
					commitSha: COMMIT_SHA,
					archiveSha256: VERIFIED_ARCHIVE_SHA256,
					changedPaths: ['documents/agreement.md']
				}
			},
			{
				id: '01900000-0000-7000-8000-000000000103',
				eventType: 'recipient.signed',
				actorType: 'recipient',
				actorId: '01930000-0000-7000-8000-000000000001',
				occurredAt: VERIFIED_SIGNED_AT,
				payload: {
					recipientId: '01930000-0000-7000-8000-000000000001',
					role: 'signer',
					routingOrder: 1,
					sentCommitSha: COMMIT_SHA,
					fields: [
						{
							id: '01950000-0000-7000-8000-000000000001',
							fieldType: 'signature',
							valueSha256: VERIFIED_FIELD_VALUE_SHA256
						}
					],
					signedAt: VERIFIED_SIGNED_AT
				}
			},
			{
				id: '01900000-0000-7000-8000-000000000104',
				eventType: 'envelope.completed',
				actorType: 'recipient',
				actorId: '01930000-0000-7000-8000-000000000001',
				occurredAt: VERIFIED_COMPLETED_AT,
				payload: { sentCommitSha: COMMIT_SHA, completedAt: VERIFIED_COMPLETED_AT }
			}
		]
	);

	await database()`INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES (${ORGANIZATION_ID}, ${ORGANIZATION_ID}, 'Workspace', '2026-09-11T00:00:00.000Z')`;
	await database()`INSERT INTO envelope (
		id, organization_id, title, status, repository_generation, repository_head,
		repository_archive_key, repository_archive_sha256, sent_commit_sha, field_generation,
		created_at, updated_at
	) VALUES (
		${ENVELOPE_ID}, ${ORGANIZATION_ID}, 'Agreement', 'completed', 1, ${COMMIT_SHA},
		${draftArchiveKey(ORGANIZATION_ID, ENVELOPE_ID, VERIFIED_ARCHIVE_SHA256)},
		${VERIFIED_ARCHIVE_SHA256}, ${COMMIT_SHA}, 1,
		'2026-09-11T00:00:00.000Z', ${VERIFIED_COMPLETED_AT}
	)`;
	await database()`INSERT INTO recipient (
		id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
		capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
	) VALUES (
		'01930000-0000-7000-8000-000000000001', ${ORGANIZATION_ID}, ${ENVELOPE_ID}, 'signer@example.com', 'Signer', 'signer',
		'en', 1, 'completed', 'capability-hash-verified', '2026-09-25T00:00:00.000Z',
		${VERIFIED_SIGNED_AT}, '2026-09-11T00:00:30.000Z', ${VERIFIED_SIGNED_AT}
	)`;
	await database()`INSERT INTO envelope_field (
		id, organization_id, envelope_id, recipient_id, document_path, field_type, label,
		required, position, created_at, updated_at
	) VALUES (
		'01950000-0000-7000-8000-000000000001', ${ORGANIZATION_ID}, ${ENVELOPE_ID}, '01930000-0000-7000-8000-000000000001', 'documents/agreement.md',
		'signature', 'Signature', true, 1, '2026-09-11T00:00:30.000Z', '2026-09-11T00:00:30.000Z'
	)`;
	await database()`INSERT INTO field_value (
		organization_id, field_id, envelope_id, recipient_id, field_type, value_json, value_sha256,
		created_at
	) VALUES (
		${ORGANIZATION_ID}, '01950000-0000-7000-8000-000000000001', ${ENVELOPE_ID}, '01930000-0000-7000-8000-000000000001', 'signature',
		${VERIFIED_FIELD_VALUE_JSON}, ${VERIFIED_FIELD_VALUE_SHA256}, ${VERIFIED_SIGNED_AT}
	)`;
	for (const event of events) {
		await database()`INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			${event.id}, ${ORGANIZATION_ID}, ${ENVELOPE_ID}, ${event.sequence}, ${event.eventType},
			${event.actorType}, ${event.actorId}, ${event.payloadJson}, ${event.previousHash},
			${event.eventHash}, ${event.occurredAt}::timestamptz
		)`;
	}

	return { events, anchor: events[events.length - 1] };
}

async function expectCompletionArtifactFailClosed(): Promise<void> {
	const store = new PostgresCompletionArtifactStore(database());
	const objects = new SeededPostgresObjectStore();
	objects.seed(
		draftArchiveKey(ORGANIZATION_ID, ENVELOPE_ID, VERIFIED_ARCHIVE_SHA256),
		VERIFIED_ARCHIVE_BYTES
	);
	const repository = new FixedPostgresDraftRepository(COMMIT_SHA, [
		{ path: 'documents/agreement.md', content: 'Agreement body' }
	]);
	const service = new CompletionArtifactPublicationService(
		store,
		objects,
		repository,
		(): Date => new Date(Date.now()),
		(): string => 'completion-artifact-integrity-claim-0001'
	);

	const result = await service.publishPendingCompletionArtifacts();
	expect(result).toMatchObject({ claimed: 1, integrityFailed: 1, published: 0 });

	const artifactCount = await database()<
		{ count: string }[]
	>`SELECT COUNT(*) AS count FROM completion_artifact
		WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}`;
	expect(Number(artifactCount[0].count)).toBe(0);

	const publishedAuditCount = await database()<
		{ count: string }[]
	>`SELECT COUNT(*) AS count FROM audit_event
		WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}
			AND event_type = 'envelope.completion_artifact_published'`;
	expect(Number(publishedAuditCount[0].count)).toBe(0);

	const jobRow = await database()<
		{ status: string; retryable: boolean; lastError: string | null }[]
	>`SELECT status, retryable, last_error AS "lastError" FROM completion_artifact_job
		WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}`;
	expect(jobRow).toEqual([
		{ status: 'failed', retryable: false, lastError: 'completion_artifact_evidence_invalid' }
	]);
}

interface StoredVerifiedArchive {
	body: Uint8Array;
}

/** A genuinely working in-memory object store, for tests that drive a real DraftPersistenceService.commit(). */
class RealMemoryObjectStore implements ObjectStore {
	private readonly objects = new Map<string, StoredVerifiedArchive>();
	putCallsByKey = new Map<string, number>();
	getCallCount: number = 0;

	seed(key: string, body: Uint8Array): void {
		this.objects.set(key, { body: Uint8Array.from(body) });
	}

	async head(key: string): Promise<ObjectMetadata | null> {
		const object = this.objects.get(key);
		if (!object) return null;
		return { key, contentType: 'test', size: object.body.byteLength, sha256: '', version: null };
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
		const stored: StoredVerifiedArchive = { body: Uint8Array.from(object.body) };
		this.objects.set(key, stored);
		return {
			key,
			contentType: object.contentType,
			size: stored.body.byteLength,
			sha256: object.sha256,
			version: null
		};
	}

	async delete(key: string): Promise<void> {
		this.objects.delete(key);
	}
}

class SeededPostgresObjectStore implements ObjectStore {
	private readonly objects = new Map<string, StoredVerifiedArchive>();

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
}

class FixedPostgresDraftRepository implements DraftRepository {
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

class UnreachablePostgresObjectStore implements ObjectStore {
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
}

class UnreachablePostgresDraftRepository implements DraftRepository {
	async read(): Promise<readonly DraftDocument[]> {
		throw new Error('Draft repository must not be read before field value integrity is verified');
	}

	async commit(): Promise<DraftVersion> {
		throw new Error(
			'Draft repository must not be written before field value integrity is verified'
		);
	}
}

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
