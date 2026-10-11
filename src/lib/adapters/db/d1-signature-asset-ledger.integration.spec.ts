import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { hashAuditEventV3 } from '$lib/domain/audit';
import { D1OrphanReferenceStore } from '$lib/application/maintenance/orphan-collector';
import {
	defineSignatureRetentionScenarios,
	RETENTION_CAPABILITY_EXPIRES_AT,
	RETENTION_ENVELOPE_ID,
	RETENTION_FIELD_GENERATION,
	RETENTION_FIELD_ID,
	RETENTION_OTHER_ENVELOPE_ID,
	RETENTION_OTHER_RECIPIENT_ID,
	RETENTION_SENT_AT,
	RETENTION_SIGNER_ID,
	RETENTION_VIEWED_AT,
	type RetentionFieldType,
	type RetentionHarness
} from '$lib/application/maintenance/signature-asset-retention-test-support';
import type { SignatureAssetScope } from '$lib/ports/signature-asset-ledger';
import { issueRecipientCapability } from '$lib/security/recipient-capability';
import { D1RecipientSignStore } from './d1-recipient-sign-store';
import { D1SignatureAssetLedger } from './d1-signature-asset-ledger';
import { applyD1Migrations, d1MigrationPaths, sqliteD1Database } from './sqlite-d1-test-support';

const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';

/**
 * Seeds the sent-envelope shape the D1 publish triggers require: one viewed
 * signer (routing group 1) with one required field, a delivered invitation,
 * and the sent/viewed audit chain. Also seeds an unrelated envelope and
 * recipient for scoped-owner checks.
 */
async function seedSentEnvelope(
	sqlite: DatabaseSync,
	fieldType: RetentionFieldType
): Promise<string> {
	const capability = await issueRecipientCapability();
	const sentAuditHash: string = await hashAuditEventV3(
		{
			sequence: 1,
			eventType: 'envelope.sent',
			actorType: 'user',
			actorId: 'user-1',
			occurredAt: RETENTION_SENT_AT,
			payload: { sentCommitSha: COMMIT_SHA },
			previousHash: null
		},
		{ envelopeId: RETENTION_ENVELOPE_ID }
	);
	const viewedPayload = {
		recipientId: RETENTION_SIGNER_ID,
		role: 'signer',
		routingOrder: 1,
		sentCommitSha: COMMIT_SHA,
		viewedAt: RETENTION_VIEWED_AT
	};
	const viewedAuditHash: string = await hashAuditEventV3(
		{
			sequence: 2,
			eventType: 'recipient.viewed',
			actorType: 'recipient',
			actorId: RETENTION_SIGNER_ID,
			occurredAt: RETENTION_VIEWED_AT,
			payload: viewedPayload,
			previousHash: sentAuditHash
		},
		{ envelopeId: RETENTION_ENVELOPE_ID }
	);

	sqlite
		.prepare(
			`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			 VALUES ('user-1', 'owner', 'active', ?, ?)`
		)
		.run(RETENTION_SENT_AT, RETENTION_SENT_AT);
	for (const envelopeId of [RETENTION_ENVELOPE_ID, RETENTION_OTHER_ENVELOPE_ID]) {
		sqlite
			.prepare(
				`INSERT INTO envelope (
					id, created_by_user_id, title, status, repository_generation, repository_head,
					repository_archive_key, repository_archive_sha256, sent_commit_sha,
					field_generation, created_at, updated_at
				) VALUES (?, 'user-1', 'Agreement', 'in_progress', 1, ?, 'archives/retention.git.gz', ?, ?, ?, ?, ?)`
			)
			.run(
				envelopeId,
				COMMIT_SHA,
				'a'.repeat(64),
				COMMIT_SHA,
				RETENTION_FIELD_GENERATION,
				RETENTION_SENT_AT,
				RETENTION_VIEWED_AT
			);
	}
	sqlite
		.prepare(
			`INSERT INTO recipient (
				id, envelope_id, email, name, role, locale, routing_order, status,
				capability_hash, capability_expires_at, created_at, updated_at
			) VALUES (?, ?, 'alice@example.test', 'Alice', 'signer', 'en', 1, 'viewed', ?, ?, ?, ?)`
		)
		.run(
			RETENTION_SIGNER_ID,
			RETENTION_ENVELOPE_ID,
			capability.tokenHash,
			RETENTION_CAPABILITY_EXPIRES_AT,
			RETENTION_SENT_AT,
			RETENTION_VIEWED_AT
		);
	sqlite
		.prepare(
			`INSERT INTO recipient (
				id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at
			) VALUES (?, ?, 'bob@example.test', 'Bob', 'signer', 'en', 1, 'pending', ?, ?)`
		)
		.run(
			RETENTION_OTHER_RECIPIENT_ID,
			RETENTION_OTHER_ENVELOPE_ID,
			RETENTION_SENT_AT,
			RETENTION_SENT_AT
		);
	sqlite
		.prepare(
			`INSERT INTO envelope_field (
				id, envelope_id, recipient_id, document_path, field_type, label,
				required, position, created_at, updated_at
			) VALUES (?, ?, ?, 'documents/agreement.md', ?, ?, 1, 0, ?, ?)`
		)
		.run(
			RETENTION_FIELD_ID,
			RETENTION_ENVELOPE_ID,
			RETENTION_SIGNER_ID,
			fieldType,
			fieldType === 'initials' ? 'Initials' : 'Signature',
			RETENTION_SENT_AT,
			RETENTION_SENT_AT
		);
	sqlite
		.prepare(
			`INSERT INTO delivery_outbox (
				id, envelope_id, recipient_id, kind, status, capability_hash,
				reserved_capability_expires_at, sealed_capability, sealing_key_id,
				sealed_capability_sha256, available_at, attempts, delivered_at,
				created_at, updated_at, retryable
			) VALUES ('01920019-0000-7000-8000-000000000020', ?, ?, 'recipient_invitation', 'delivered', ?,
				NULL, NULL, 'key-1', ?, ?, 1, ?, ?, ?, 0)`
		)
		.run(
			RETENTION_ENVELOPE_ID,
			RETENTION_SIGNER_ID,
			capability.tokenHash,
			'c'.repeat(64),
			RETENTION_SENT_AT,
			RETENTION_SENT_AT,
			RETENTION_SENT_AT,
			RETENTION_SENT_AT
		);
	for (const [
		id,
		sequence,
		eventType,
		actorType,
		actorId,
		payload,
		previousHash,
		eventHash,
		at
	] of [
		[
			'01920019-0000-7000-8000-000000000010',
			1,
			'envelope.sent',
			'user',
			'user-1',
			{ sentCommitSha: COMMIT_SHA },
			null,
			sentAuditHash,
			RETENTION_SENT_AT
		],
		[
			'01920019-0000-7000-8000-000000000011',
			2,
			'recipient.viewed',
			'recipient',
			RETENTION_SIGNER_ID,
			viewedPayload,
			sentAuditHash,
			viewedAuditHash,
			RETENTION_VIEWED_AT
		]
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO audit_event (
					id, envelope_id, sequence, event_type, actor_type,
					actor_id, payload_json, previous_hash, event_hash, occurred_at, hash_version
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3)`
			)
			.run(
				id,
				RETENTION_ENVELOPE_ID,
				sequence,
				eventType,
				actorType,
				actorId,
				JSON.stringify(payload),
				previousHash,
				eventHash,
				at
			);
	}
	return capability.token;
}

function d1Harness(): RetentionHarness {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	const database: D1Database = sqliteD1Database(sqlite);
	return {
		ledger: new D1SignatureAssetLedger(database),
		references: new D1OrphanReferenceStore(database),
		signStore: new D1RecipientSignStore(database),
		seed: (fieldType: RetentionFieldType): Promise<string> => seedSentEnvelope(sqlite, fieldType),
		publishedRows: async () => {
			const row = sqlite
				.prepare(
					`SELECT (SELECT count(*) FROM field_value) AS field_values,
						(SELECT count(*) FROM recipient_signed_command) AS receipts`
				)
				.get() as { field_values: number; receipts: number };
			return { fieldValues: Number(row.field_values), receipts: Number(row.receipts) };
		},
		ledgerSnapshot: async (): Promise<string> =>
			JSON.stringify(
				sqlite
					.prepare('SELECT * FROM signature_asset ORDER BY envelope_id, recipient_id, sha256')
					.all()
			),
		forceState: async (scope: SignatureAssetScope, state): Promise<void> => {
			const at: string = '2026-09-24T03:00:00.000Z';
			sqlite
				.prepare(
					`UPDATE signature_asset
					 SET state = ?, pending_touched_at = ?, bound_at = ?, retired_at = ?
					 WHERE envelope_id = ? AND recipient_id = ? AND sha256 = ?`
				)
				.run(
					state,
					state === 'pending' ? at : null,
					state === 'bound' ? at : null,
					state === 'retired' ? at : null,
					scope.envelopeId,
					scope.recipientId,
					scope.sha256
				);
		}
	};
}

// D1 adapter SQL and triggers exercised on node:sqlite (not workerd D1/R2).
describe('D1 signature asset retention (node:sqlite)', () => {
	defineSignatureRetentionScenarios(d1Harness);

	it('backfills legacy signature and initials references as bound during migration', async () => {
		const sqlite = new DatabaseSync(':memory:');
		const paths: readonly string[] = d1MigrationPaths();
		const ledgerPath: string | undefined = paths.find((path: string): boolean =>
			path.includes('/0054_signature_asset_ledger.sql')
		);
		if (ledgerPath === undefined) throw new Error('0054 migration missing');
		for (const path of paths) {
			if (path === ledgerPath) break;
			sqlite.exec(readFileSync(path, 'utf8'));
		}
		await seedSentEnvelope(sqlite, 'signature');
		const initialsFieldId: string = '01920019-0000-7000-8000-00000000000b';
		sqlite
			.prepare(
				`INSERT INTO envelope_field (
					id, envelope_id, recipient_id, document_path, field_type, label,
					required, position, created_at, updated_at
				) VALUES (?, ?, ?, 'documents/agreement.md', 'initials', 'Initials', 1, 1, ?, ?)`
			)
			.run(
				initialsFieldId,
				RETENTION_ENVELOPE_ID,
				RETENTION_SIGNER_ID,
				RETENTION_SENT_AT,
				RETENTION_SENT_AT
			);
		for (const [fieldId, fieldType, sha256] of [
			[RETENTION_FIELD_ID, 'signature', 'a'.repeat(64)],
			[initialsFieldId, 'initials', 'b'.repeat(64)]
		] as const) {
			sqlite
				.prepare(
					`INSERT INTO field_value (
						field_id, envelope_id, recipient_id, field_type, value_json, value_sha256, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					fieldId,
					RETENTION_ENVELOPE_ID,
					RETENTION_SIGNER_ID,
					fieldType,
					JSON.stringify(`sig:sha256:${sha256}`),
					'c'.repeat(64),
					RETENTION_VIEWED_AT
				);
		}

		sqlite.exec(readFileSync(ledgerPath, 'utf8'));

		expect(
			sqlite
				.prepare('SELECT sha256, state, bound_at FROM signature_asset ORDER BY sha256')
				.all()
				.map((row) => ({ ...row }))
		).toEqual([
			{ sha256: 'a'.repeat(64), state: 'bound', bound_at: RETENTION_VIEWED_AT },
			{ sha256: 'b'.repeat(64), state: 'bound', bound_at: RETENTION_VIEWED_AT }
		]);
	});
});
