import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AesGcmCompletionTokenSealer } from '$lib/security/completion-token-sealer';
import { issueCompletionToken } from '$lib/security/completion-token';
import { D1CompletionDeliveryStore } from './d1-completion-delivery-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ORGANIZATION_ID: string = 'org-1';
const ENVELOPE_ID: string = '01920000-0000-7000-8000-000000000001';
const ENCRYPTION_KEY: string = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const CLAIMED_AT: string = '2026-09-12T00:00:00.000Z';
const STALE_BEFORE: string = '2026-09-11T23:55:00.000Z';

function createFixture(): { database: D1Database; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	return { database: sqliteD1Database(sqlite), sqlite };
}

function seedCompletedEnvelopeWithArtifact(sqlite: DatabaseSync): {
	signerId: string;
	approverId: string;
	viewerId: string;
	ccId: string;
	prefillId: string;
} {
	const signerId = '01930000-0000-7000-8000-000000000001';
	const approverId = '01930000-0000-7000-8000-000000000003';
	const viewerId = '01930000-0000-7000-8000-000000000002';
	const ccId = '01930000-0000-7000-8000-000000000004';
	const prefillId = '01930000-0000-7000-8000-000000000005';

	sqlite.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${ORGANIZATION_ID}', '${ORGANIZATION_ID}', 'Workspace', '2026-09-11T00:00:00.000Z');

		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			sent_commit_sha, repository_archive_key, repository_archive_sha256, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}', '${ORGANIZATION_ID}', 'Completed Agreement', 'completed', 1, 'commit-1',
			'commit-1', 'archive-key', '${'a'.repeat(64)}', '2026-09-11T00:00:00.000Z', '2026-09-11T00:02:00.000Z'
		);

		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES
			('${signerId}', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', 'signer@example.com', 'Signer', 'signer', 'en', 1, 'completed', '2026-09-11T00:01:00.000Z', '2026-09-11T00:02:00.000Z'),
			('${approverId}', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', 'approver@example.com', 'Approver', 'approver', 'en', 2, 'completed', '2026-09-11T00:01:00.000Z', '2026-09-11T00:02:00.000Z'),
			('${viewerId}', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', 'viewer@example.com', 'Viewer', 'viewer', 'en', 1, 'completed', '2026-09-11T00:01:00.000Z', '2026-09-11T00:02:00.000Z'),
			('${ccId}', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', 'cc@example.com', 'CC', 'cc', 'en', 3, 'pending', '2026-09-11T00:01:00.000Z', '2026-09-11T00:02:00.000Z'),
			('${prefillId}', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', 'prefill@example.com', 'Prefill', 'prefill', 'en', 4, 'completed', '2026-09-11T00:01:00.000Z', '2026-09-11T00:02:00.000Z');

		INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'01960000-0000-7000-8000-000000000001', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', 1, 'envelope.completed', 'system', 'system',
			'{}', '${'0'.repeat(64)}', '${'e'.repeat(64)}', '2026-09-11T00:02:00.000Z'
		);

		INSERT INTO completion_artifact (
			organization_id, envelope_id, schema_version, manifest_sha256,
			json_object_key, json_sha256, markdown_object_key, markdown_sha256,
			sent_commit_sha, field_generation, anchor_audit_event_id,
			audit_head_sequence, audit_head_event_hash, published_at, audit_event_id
		) VALUES (
			'${ORGANIZATION_ID}', '${ENVELOPE_ID}', 1, '${'m'.repeat(64)}',
			'completion-artifacts/v1/org-1/env-1/sha256/${'j'.repeat(64)}.json.gz', '${'j'.repeat(64)}',
			'completion-artifacts/v1/org-1/env-1/sha256/${'d'.repeat(64)}.md.gz', '${'d'.repeat(64)}',
			'commit-1', 0, '01960000-0000-7000-8000-000000000001', 1, '${'e'.repeat(64)}', '2026-09-11T00:03:00.000Z', '01960000-0000-7000-8000-000000000003'
		);
	`);

	return { signerId, approverId, viewerId, ccId, prefillId };
}

describe('D1CompletionDeliveryStore integration', () => {
	it('discovers eligible recipients excluding prefill, unenrolled only, ordered properly', async () => {
		const { database, sqlite } = createFixture();
		const store = new D1CompletionDeliveryStore(database);
		const { signerId, approverId, viewerId, ccId, prefillId } =
			seedCompletedEnvelopeWithArtifact(sqlite);

		const eligible = await store.discoverEligibleRecipients(10);
		expect(eligible).toHaveLength(4);
		const recipientIds = eligible.map((r) => r.recipientId);
		expect(recipientIds).toContain(signerId);
		expect(recipientIds).toContain(approverId);
		expect(recipientIds).toContain(viewerId);
		expect(recipientIds).toContain(ccId);
		expect(recipientIds).not.toContain(prefillId);

		// Order: routing_order ASC, recipient.id ASC
		expect(eligible.map((e) => e.recipientRole)).toEqual(['signer', 'viewer', 'approver', 'cc']);
	});

	it('enrolls deliveries idempotently and rejects prefill or missing artifact', async () => {
		const { database, sqlite } = createFixture();
		const store = new D1CompletionDeliveryStore(database);
		const { signerId, prefillId } = seedCompletedEnvelopeWithArtifact(sqlite);

		const sealer = new AesGcmCompletionTokenSealer(ENCRYPTION_KEY);
		const token = await issueCompletionToken();
		const sealed = await sealer.seal(token.token, {
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			recipientId: signerId,
			deliveryId: '01940000-0000-7000-8000-000000000001'
		});

		const item = {
			id: '01940000-0000-7000-8000-000000000001',
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			recipientId: signerId,
			tokenHash: token.tokenHash,
			accessExpiresAt: '2026-10-12T00:00:00.000Z',
			sealedToken: sealed.sealedToken,
			sealingKeyId: sealed.sealingKeyId,
			sealedTokenSha256: sealed.sealedTokenSha256,
			availableAt: '2026-09-11T00:05:00.000Z',
			createdAt: '2026-09-11T00:05:00.000Z'
		};

		const enrolledCount = await store.enrollDeliveries([item]);
		expect(enrolledCount).toBe(1);

		// Stable unique enrollment: duplicate enrollment is a no-op
		const duplicateCount = await store.enrollDeliveries([item]);
		expect(duplicateCount).toBe(0);

		// Prefill recipient enrollment is rejected by recipient scope trigger
		await expect(
			store.enrollDeliveries([
				{
					...item,
					id: '01940000-0000-7000-8000-0000000000d1',
					recipientId: prefillId,
					tokenHash: 'p'.repeat(64)
				}
			])
		).rejects.toThrow(/invalid completion delivery recipient scope/);

		// Missing artifact envelope is rejected by foreign key
		await expect(
			store.enrollDeliveries([
				{
					...item,
					id: '01940000-0000-7000-8000-0000000000a2',
					envelopeId: '01920000-0000-7000-8000-0000000000f1',
					tokenHash: 'm'.repeat(64)
				}
			])
		).rejects.toThrow();
	});

	it('claims, reclaims, completes with scrub, and resolves artifact locator', async () => {
		const { database, sqlite } = createFixture();
		const store = new D1CompletionDeliveryStore(database);
		const { signerId } = seedCompletedEnvelopeWithArtifact(sqlite);

		const sealer = new AesGcmCompletionTokenSealer(ENCRYPTION_KEY);
		const token = await issueCompletionToken();
		const sealed = await sealer.seal(token.token, {
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			recipientId: signerId,
			deliveryId: '01940000-0000-7000-8000-000000000001'
		});

		await store.enrollDeliveries([
			{
				id: '01940000-0000-7000-8000-000000000001',
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				recipientId: signerId,
				tokenHash: token.tokenHash,
				accessExpiresAt: '2026-10-12T00:00:00.000Z',
				sealedToken: sealed.sealedToken,
				sealingKeyId: sealed.sealingKeyId,
				sealedTokenSha256: sealed.sealedTokenSha256,
				availableAt: '2026-09-11T00:05:00.000Z',
				createdAt: '2026-09-11T00:05:00.000Z'
			}
		]);

		const claimToken = 'claim-token-12345678';
		const claimed = await store.claimPendingDeliveries({
			claimToken,
			claimedAt: CLAIMED_AT,
			staleBefore: STALE_BEFORE,
			limit: 10
		});
		expect(claimed).toHaveLength(1);
		expect(claimed[0]?.status).toBe('processing');
		expect(claimed[0]?.attempts).toBe(1);

		// Read claimed delivery
		const readClaimed = await store.readClaimedDelivery({
			organizationId: ORGANIZATION_ID,
			deliveryId: '01940000-0000-7000-8000-000000000001',
			claimToken
		});
		expect(readClaimed).not.toBeNull();
		expect(readClaimed?.deliveryId).toBe('01940000-0000-7000-8000-000000000001');

		// Complete delivery (success): scrubs sealed_token, keeps access_revoked_at NULL
		const completeRes = await store.completeDelivery({
			organizationId: ORGANIZATION_ID,
			deliveryId: '01940000-0000-7000-8000-000000000001',
			claimToken,
			deliveredAt: '2026-09-12T00:01:00.000Z',
			providerMessageId: 'msg-001'
		});
		expect(completeRes).toEqual({ outcome: 'completed' });

		// Verify outbox row: status = delivered, retryable = 0, sealed_token = NULL, access_revoked_at = NULL
		const row = sqlite
			.prepare(
				'SELECT status, retryable, sealed_token, access_revoked_at FROM completion_delivery_outbox WHERE id = ?'
			)
			.get('01940000-0000-7000-8000-000000000001') as {
			status: string;
			retryable: number;
			sealed_token: string | null;
			access_revoked_at: string | null;
		};
		expect(row).toEqual({
			status: 'delivered',
			retryable: 0,
			sealed_token: null,
			access_revoked_at: null
		});

		// Resolve artifact locator by token hash
		const locator = await store.resolveArtifactLocatorByTokenHash(
			token.tokenHash,
			'2026-09-12T00:02:00.000Z'
		);
		expect(locator).toEqual({
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			jsonObjectKey: `completion-artifacts/v1/org-1/env-1/sha256/${'j'.repeat(64)}.json.gz`,
			jsonSha256: 'j'.repeat(64),
			markdownObjectKey: `completion-artifacts/v1/org-1/env-1/sha256/${'d'.repeat(64)}.md.gz`,
			markdownSha256: 'd'.repeat(64)
		});

		// Expired access returns null
		expect(
			await store.resolveArtifactLocatorByTokenHash(token.tokenHash, '2026-10-13T00:00:00.000Z')
		).toBeNull();
	});

	it('handles retryable failure (keeps sealed_token, keeps access) vs terminal failure (scrubs token, revokes access)', async () => {
		const { database, sqlite } = createFixture();
		const store = new D1CompletionDeliveryStore(database);
		const { signerId, approverId } = seedCompletedEnvelopeWithArtifact(sqlite);

		const sealer = new AesGcmCompletionTokenSealer(ENCRYPTION_KEY);
		const token1 = await issueCompletionToken();
		const token2 = await issueCompletionToken();

		const sealed1 = await sealer.seal(token1.token, {
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			recipientId: signerId,
			deliveryId: '01940000-0000-7000-8000-0000000000a3'
		});
		const sealed2 = await sealer.seal(token2.token, {
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			recipientId: approverId,
			deliveryId: '01940000-0000-7000-8000-0000000000a4'
		});

		await store.enrollDeliveries([
			{
				id: '01940000-0000-7000-8000-0000000000a3',
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				recipientId: signerId,
				tokenHash: token1.tokenHash,
				accessExpiresAt: '2026-10-12T00:00:00.000Z',
				sealedToken: sealed1.sealedToken,
				sealingKeyId: sealed1.sealingKeyId,
				sealedTokenSha256: sealed1.sealedTokenSha256,
				availableAt: '2026-09-11T00:05:00.000Z',
				createdAt: '2026-09-11T00:05:00.000Z'
			},
			{
				id: '01940000-0000-7000-8000-0000000000a4',
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				recipientId: approverId,
				tokenHash: token2.tokenHash,
				accessExpiresAt: '2026-10-12T00:00:00.000Z',
				sealedToken: sealed2.sealedToken,
				sealingKeyId: sealed2.sealingKeyId,
				sealedTokenSha256: sealed2.sealedTokenSha256,
				availableAt: '2026-09-11T00:05:00.000Z',
				createdAt: '2026-09-11T00:05:00.000Z'
			}
		]);

		const claimToken = 'claim-token-99999999';
		await store.claimPendingDeliveries({
			claimToken,
			claimedAt: CLAIMED_AT,
			staleBefore: STALE_BEFORE,
			limit: 10
		});

		// 1. Retryable failure: keeps sealed_token and keeps access_revoked_at NULL
		const retryFailRes = await store.failDelivery({
			organizationId: ORGANIZATION_ID,
			deliveryId: '01940000-0000-7000-8000-0000000000a3',
			claimToken,
			errorCode: 'rate_limited',
			retryable: true,
			nextAvailableAt: '2026-09-12T00:05:00.000Z',
			failedAt: '2026-09-12T00:01:00.000Z'
		});
		expect(retryFailRes).toEqual({ outcome: 'failed' });

		const retryRow = sqlite
			.prepare(
				'SELECT status, retryable, sealed_token, access_revoked_at FROM completion_delivery_outbox WHERE id = ?'
			)
			.get('01940000-0000-7000-8000-0000000000a3') as {
			status: string;
			retryable: number;
			sealed_token: string | null;
			access_revoked_at: string | null;
		};
		expect(retryRow.status).toBe('failed');
		expect(retryRow.retryable).toBe(1);
		expect(retryRow.sealed_token).toBe(sealed1.sealedToken);
		expect(retryRow.access_revoked_at).toBeNull();

		// 2. Terminal failure: scrubs sealed_token to NULL and sets access_revoked_at
		const termFailRes = await store.failDelivery({
			organizationId: ORGANIZATION_ID,
			deliveryId: '01940000-0000-7000-8000-0000000000a4',
			claimToken,
			errorCode: 'recipient_rejected',
			retryable: false,
			nextAvailableAt: '2026-09-12T00:01:00.000Z',
			failedAt: '2026-09-12T00:01:00.000Z'
		});
		expect(termFailRes).toEqual({ outcome: 'failed' });

		const termRow = sqlite
			.prepare(
				'SELECT status, retryable, sealed_token, access_revoked_at FROM completion_delivery_outbox WHERE id = ?'
			)
			.get('01940000-0000-7000-8000-0000000000a4') as {
			status: string;
			retryable: number;
			sealed_token: string | null;
			access_revoked_at: string | null;
		};
		expect(termRow.status).toBe('failed');
		expect(termRow.retryable).toBe(0);
		expect(termRow.sealed_token).toBeNull();
		expect(termRow.access_revoked_at).toBe('2026-09-12T00:01:00.000Z');

		// Terminal failure revokes access: resolving locator returns null
		expect(
			await store.resolveArtifactLocatorByTokenHash(token2.tokenHash, '2026-09-12T00:02:00.000Z')
		).toBeNull();
	});

	it('enforces terminal state trigger guards on invalid insert/update', async () => {
		const { sqlite } = createFixture();
		seedCompletedEnvelopeWithArtifact(sqlite);

		// Cannot insert delivered with sealed_token not null
		expect(() =>
			sqlite.exec(`
				INSERT INTO completion_delivery_outbox (
					id, organization_id, envelope_id, recipient_id, status, token_hash,
					access_expires_at, access_revoked_at, sealed_token, sealing_key_id,
					sealed_token_sha256, available_at, attempts, created_at, updated_at, retryable
				) VALUES (
					'bad-1', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', '01930000-0000-7000-8000-000000000001', 'delivered',
					'${'1'.repeat(64)}', '2026-10-12T00:00:00.000Z', NULL, 'unscrubbed-token', 'key-1',
					'${'s'.repeat(64)}', '2026-09-11T00:00:00.000Z', 1, '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z', 0
				)
			`)
		).toThrow(/invalid completion delivery terminal state/);

		// Cannot insert failed with retryable = 0 but access_revoked_at NULL
		expect(() =>
			sqlite.exec(`
				INSERT INTO completion_delivery_outbox (
					id, organization_id, envelope_id, recipient_id, status, token_hash,
					access_expires_at, access_revoked_at, sealed_token, sealing_key_id,
					sealed_token_sha256, available_at, attempts, created_at, updated_at, retryable
				) VALUES (
					'bad-2', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', '01930000-0000-7000-8000-000000000001', 'failed',
					'${'2'.repeat(64)}', '2026-10-12T00:00:00.000Z', NULL, NULL, 'key-1',
					'${'s'.repeat(64)}', '2026-09-11T00:00:00.000Z', 1, '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z', 0
				)
			`)
		).toThrow(/invalid completion delivery terminal state/);
	});

	it('reclaims abandoned processing rows and performs terminal cleanup for ineligible rows', async () => {
		const { database, sqlite } = createFixture();
		const store = new D1CompletionDeliveryStore(database);
		const { signerId, approverId } = seedCompletedEnvelopeWithArtifact(sqlite);

		const sealer = new AesGcmCompletionTokenSealer(ENCRYPTION_KEY);
		const token1 = await issueCompletionToken();
		const token2 = await issueCompletionToken();

		const sealed1 = await sealer.seal(token1.token, {
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			recipientId: signerId,
			deliveryId: '01940000-0000-7000-8000-0000000000a1'
		});
		const sealed2 = await sealer.seal(token2.token, {
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			recipientId: approverId,
			deliveryId: '01940000-0000-7000-8000-0000000000a5'
		});

		// Insert del-abandoned directly as processing with old locked_at
		sqlite.exec(`
			INSERT INTO completion_delivery_outbox (
				id, organization_id, envelope_id, recipient_id, status, token_hash,
				access_expires_at, access_revoked_at, sealed_token, sealing_key_id,
				sealed_token_sha256, available_at, attempts, locked_at, claim_token,
				created_at, updated_at, retryable
			) VALUES (
				'01940000-0000-7000-8000-0000000000a1', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', '${signerId}', 'processing',
				'${token1.tokenHash}', '2026-10-12T00:00:00.000Z', NULL, '${sealed1.sealedToken}', '${sealed1.sealingKeyId}',
				'${sealed1.sealedTokenSha256}', '2026-09-11T00:00:00.000Z', 1, '2026-09-11T23:50:00.000Z', 'old-claim-token-1234',
				'2026-09-11T00:00:00.000Z', '2026-09-11T23:50:00.000Z', 1
			);
			INSERT INTO completion_delivery_outbox (
				id, organization_id, envelope_id, recipient_id, status, token_hash,
				access_expires_at, access_revoked_at, sealed_token, sealing_key_id,
				sealed_token_sha256, available_at, attempts, locked_at, claim_token,
				created_at, updated_at, retryable
			) VALUES (
				'01940000-0000-7000-8000-0000000000a5', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', '${approverId}', 'processing',
				'${token2.tokenHash}', '2026-10-12T00:00:00.000Z', NULL, '${sealed2.sealedToken}', '${sealed2.sealingKeyId}',
				'${sealed2.sealedTokenSha256}', '2026-09-11T00:00:00.000Z', 1, '2026-09-11T23:50:00.000Z', 'old-claim-token-1234',
				'2026-09-11T00:00:00.000Z', '2026-09-11T23:50:00.000Z', 1
			);
		`);

		// Now change approver's role to 'prefill' so del-voided becomes ineligible
		sqlite.exec(`UPDATE recipient SET role = 'prefill' WHERE id = '${approverId}'`);

		// Claiming should run terminal cleanup on del-voided (converts to failed terminal)
		// and reclaim del-abandoned (claims it with new claimToken and increments attempts)
		const newClaimToken = 'claim-token-reclaim';
		const claimed = await store.claimPendingDeliveries({
			claimToken: newClaimToken,
			claimedAt: CLAIMED_AT,
			staleBefore: STALE_BEFORE,
			limit: 10
		});

		expect(claimed).toHaveLength(1);
		expect(claimed[0]?.deliveryId).toBe('01940000-0000-7000-8000-0000000000a1');
		expect(claimed[0]?.attempts).toBe(2);

		// del-voided should have been converted to terminal failure by cleanup
		const voidedRow = sqlite
			.prepare(
				'SELECT status, retryable, sealed_token, access_revoked_at, last_error FROM completion_delivery_outbox WHERE id = ?'
			)
			.get('01940000-0000-7000-8000-0000000000a5') as {
			status: string;
			retryable: number;
			sealed_token: string | null;
			access_revoked_at: string | null;
			last_error: string | null;
		};
		expect(voidedRow.status).toBe('failed');
		expect(voidedRow.retryable).toBe(0);
		expect(voidedRow.sealed_token).toBeNull();
		expect(voidedRow.access_revoked_at).toBe(CLAIMED_AT);
		expect(voidedRow.last_error).toBe('delivery_not_eligible');
	});

	it('isolates cross-tenant artifact resolution', async () => {
		const { database, sqlite } = createFixture();
		const store = new D1CompletionDeliveryStore(database);
		seedCompletedEnvelopeWithArtifact(sqlite);

		const otherOrgId = 'org-other';
		const otherEnvId = '01920000-0000-7000-8000-0000000000f2';
		const otherRecId = '01930000-0000-7000-8000-0000000000f2';
		const otherTokenHash = '7'.repeat(64);
		const baseTime = '2026-09-12T00:00:00.000Z';

		sqlite.exec(`
			INSERT INTO organization (id, d6e_organization_id, name, created_at)
			VALUES ('${otherOrgId}', '${otherOrgId}', 'Other Org', '2026-09-11T00:00:00.000Z');

			INSERT INTO envelope (
				id, organization_id, title, status, repository_generation, repository_head,
				sent_commit_sha, repository_archive_key, repository_archive_sha256, created_at, updated_at
			) VALUES (
				'${otherEnvId}', '${otherOrgId}', 'Other Agreement', 'completed', 1, 'commit-2',
				'commit-2', 'archive-key-2', '${'2'.repeat(64)}', '2026-09-11T00:00:00.000Z', '2026-09-11T00:02:00.000Z'
			);

			INSERT INTO recipient (
				id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
				created_at, updated_at
			) VALUES
				('${otherRecId}', '${otherOrgId}', '${otherEnvId}', 'other@example.com', 'Other', 'signer', 'en', 1, 'completed', '2026-09-11T00:01:00.000Z', '2026-09-11T00:02:00.000Z');

			INSERT INTO audit_event (
				id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
				payload_json, previous_hash, event_hash, occurred_at
			) VALUES (
				'01960000-0000-7000-8000-000000000002', '${otherOrgId}', '${otherEnvId}', 1, 'envelope.completed', 'system', 'system',
				'{}', '${'0'.repeat(64)}', '${'f'.repeat(64)}', '2026-09-11T00:02:00.000Z'
			);

			INSERT INTO completion_artifact (
				organization_id, envelope_id, schema_version, manifest_sha256,
				json_object_key, json_sha256, markdown_object_key, markdown_sha256,
				sent_commit_sha, field_generation, anchor_audit_event_id,
				audit_head_sequence, audit_head_event_hash, published_at, audit_event_id
			) VALUES (
				'${otherOrgId}', '${otherEnvId}', 1, '${'n'.repeat(64)}',
				'completion-artifacts/v1/${otherOrgId}/${otherEnvId}/sha256/${'8'.repeat(64)}.json.gz', '${'8'.repeat(64)}',
				'completion-artifacts/v1/${otherOrgId}/${otherEnvId}/sha256/${'9'.repeat(64)}.md.gz', '${'9'.repeat(64)}',
				'commit-2', 0, '01960000-0000-7000-8000-000000000002', 1, '${'f'.repeat(64)}', '2026-09-11T00:03:00.000Z', '01960000-0000-7000-8000-000000000004'
			);

			INSERT INTO completion_delivery_outbox (
				id, organization_id, envelope_id, recipient_id, status, token_hash,
				access_expires_at, access_revoked_at, sealed_token, sealing_key_id,
				sealed_token_sha256, available_at, attempts, created_at, updated_at, retryable
			) VALUES (
				'01940000-0000-7000-8000-0000000000f2', '${otherOrgId}', '${otherEnvId}', '${otherRecId}', 'delivered',
				'${otherTokenHash}', '2026-10-12T00:00:00.000Z', NULL, NULL, 'key-1',
				'${'s'.repeat(64)}', '2026-09-11T00:00:00.000Z', 1, '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z', 0
			);
		`);

		const otherLocator = await store.resolveArtifactLocatorByTokenHash(otherTokenHash, baseTime);
		expect(otherLocator?.organizationId).toBe(otherOrgId);
		expect(otherLocator?.envelopeId).toBe(otherEnvId);

		// Unknown token returns null
		expect(await store.resolveArtifactLocatorByTokenHash('0'.repeat(64), baseTime)).toBeNull();
	});

	it('finds and reseals a non-processing completion delivery row sealed under a stale key', async () => {
		const { database, sqlite } = createFixture();
		const { signerId } = seedCompletedEnvelopeWithArtifact(sqlite);
		const store = new D1CompletionDeliveryStore(database);
		const deliveryId = '01940000-0000-7000-8000-0000000000f9';
		sqlite.exec(`
			INSERT INTO completion_delivery_outbox (
				id, organization_id, envelope_id, recipient_id, status, token_hash,
				access_expires_at, access_revoked_at, sealed_token, sealing_key_id,
				sealed_token_sha256, available_at, attempts, created_at, updated_at, retryable
			) VALUES (
				'${deliveryId}', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', '${signerId}', 'pending',
				'${'t'.repeat(64)}', '2026-10-12T00:00:00.000Z', NULL, 'skcd1_ciphertext', 'key-1',
				'${'s'.repeat(64)}', '2026-09-11T00:00:00.000Z', 0, '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z', 1
			);
		`);

		const stale = await store.findStaleSealedCompletionTokens({
			activeSealingKeyId: 'key-2',
			limit: 25
		});
		expect(stale).toEqual([
			{
				deliveryId,
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				recipientId: signerId,
				sealedToken: 'skcd1_ciphertext',
				sealingKeyId: 'key-1'
			}
		]);

		await expect(
			store.resealCompletionToken({
				organizationId: ORGANIZATION_ID,
				deliveryId,
				previousSealingKeyId: 'key-1',
				sealedToken: 'skcd1_resealed',
				sealingKeyId: 'key-2',
				sealedTokenSha256: 'resealed-hash',
				updatedAt: '2026-09-12T00:05:00.000Z'
			})
		).resolves.toEqual({ outcome: 'resealed' });

		const row = sqlite
			.prepare('SELECT sealed_token, sealing_key_id FROM completion_delivery_outbox WHERE id = ?')
			.get(deliveryId);
		expect(row).toEqual({ sealed_token: 'skcd1_resealed', sealing_key_id: 'key-2' });

		await expect(
			store.findStaleSealedCompletionTokens({ activeSealingKeyId: 'key-2', limit: 25 })
		).resolves.toEqual([]);
	});

	it('does not reseal a completion delivery row already claimed for processing', async () => {
		const { database, sqlite } = createFixture();
		const { signerId } = seedCompletedEnvelopeWithArtifact(sqlite);
		const store = new D1CompletionDeliveryStore(database);
		const deliveryId = '01940000-0000-7000-8000-0000000000fa';
		sqlite.exec(`
			INSERT INTO completion_delivery_outbox (
				id, organization_id, envelope_id, recipient_id, status, token_hash,
				access_expires_at, access_revoked_at, sealed_token, sealing_key_id,
				sealed_token_sha256, available_at, attempts, created_at, updated_at, retryable,
				claim_token, locked_at
			) VALUES (
				'${deliveryId}', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', '${signerId}', 'processing',
				'${'t'.repeat(64)}', '2026-10-12T00:00:00.000Z', NULL, 'skcd1_ciphertext', 'key-1',
				'${'s'.repeat(64)}', '2026-09-11T00:00:00.000Z', 1, '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z', 1,
				'lease-token-0001', '2026-09-12T00:00:00.000Z'
			);
		`);

		await expect(
			store.findStaleSealedCompletionTokens({ activeSealingKeyId: 'key-2', limit: 25 })
		).resolves.toEqual([]);
		await expect(
			store.resealCompletionToken({
				organizationId: ORGANIZATION_ID,
				deliveryId,
				previousSealingKeyId: 'key-1',
				sealedToken: 'skcd1_resealed',
				sealingKeyId: 'key-2',
				sealedTokenSha256: 'resealed-hash',
				updatedAt: '2026-09-12T00:05:00.000Z'
			})
		).resolves.toEqual({ outcome: 'stale' });
	});
});
