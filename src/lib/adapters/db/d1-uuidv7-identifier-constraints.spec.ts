import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { newUuidV7 } from '$lib/ids/uuid-v7';
import { applyD1Migrations } from './sqlite-d1-test-support';

/**
 * D1 parity evidence for the SignKit identifier policy: every SignKit-minted
 * row identifier must be a canonical lowercase RFC 9562 UUIDv7, while external
 * d6e-auth identifiers and caller-chosen idempotency keys must stay accepted.
 * SQLite has no regular expressions, so the migrations express the rule with
 * length/separator/GLOB checks; these tests prove that shape is equivalent to
 * the PostgreSQL regex in `postgres-migrations.integration.spec.ts`.
 */

const ORGANIZATION_ID: string = 'org_d6e_01K9ZQ';
const ENVELOPE_ID: string = '01920000-0000-7000-8000-000000000001';
const RECIPIENT_ID: string = '01930000-0000-7000-8000-000000000001';
const AUDIT_EVENT_ID: string = '01960000-0000-7000-8000-000000000001';
const NOW: string = '2026-09-12T00:00:00.000Z';
const SHA256: string = 'a'.repeat(64);

/** Values that must never be accepted for a SignKit-owned identifier column. */
const REJECTED_IDENTIFIERS: readonly [string, string][] = [
	['a non-UUID string', 'recipient-1'],
	['a UUIDv4', '9f1c6f8e-0a1d-4f3b-8b0e-7c2f9a4d6e11'],
	['a UUIDv8', '01920000-0000-8000-a000-000000000001'],
	['a non-RFC-9562 variant', '01920000-0000-7000-c000-000000000001'],
	['uppercase hexadecimal', '01920000-0000-7000-8000-0000000000AB'],
	['a truncated UUID', '01920000-0000-7000-8000-00000000000'],
	['the nil UUID', '00000000-0000-0000-0000-000000000000'],
	['an empty string', '']
];

function database(): DatabaseSync {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	sqlite.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${ORGANIZATION_ID}', '${ORGANIZATION_ID}', 'Workspace', '${NOW}');

		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			sent_commit_sha, repository_archive_key, repository_archive_sha256, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}', '${ORGANIZATION_ID}', 'Agreement', 'completed', 1, 'commit-1',
			'commit-1', 'archive-key', '${SHA256}', '${NOW}', '${NOW}'
		);

		INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'${AUDIT_EVENT_ID}', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', 1, 'envelope.completed',
			'system', 'system', '{}', '${'0'.repeat(64)}', '${'e'.repeat(64)}', '${NOW}'
		);

		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES (
			'${RECIPIENT_ID}', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', 'signer@example.com', 'Signer',
			'signer', 'en', 1, 'completed', '${NOW}', '${NOW}'
		);

		INSERT INTO completion_artifact (
			organization_id, envelope_id, schema_version, manifest_sha256,
			json_object_key, json_sha256, markdown_object_key, markdown_sha256,
			sent_commit_sha, field_generation, anchor_audit_event_id,
			audit_head_sequence, audit_head_event_hash, published_at, audit_event_id
		) VALUES (
			'${ORGANIZATION_ID}', '${ENVELOPE_ID}', 1, '${'m'.repeat(64)}',
			'json-key', '${'j'.repeat(64)}', 'markdown-key', '${'d'.repeat(64)}',
			'commit-1', 0, '${AUDIT_EVENT_ID}', 1, '${'e'.repeat(64)}', '${NOW}',
			'01960000-0000-7000-8000-000000000002'
		);
	`);
	return sqlite;
}

function insertEnvelope(sqlite: DatabaseSync, id: string): void {
	sqlite.exec(`
		INSERT INTO envelope (id, organization_id, title, status, repository_generation, created_at, updated_at)
		VALUES ('${id}', '${ORGANIZATION_ID}', 'Agreement', 'draft', 0, '${NOW}', '${NOW}')
	`);
}

function insertAuditEvent(sqlite: DatabaseSync, id: string): void {
	sqlite.exec(`
		INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'${id}', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', 2, 'envelope.voided', 'user', 'user-1',
			'{}', '${'e'.repeat(64)}', '${'f'.repeat(64)}', '${NOW}'
		)
	`);
}

function insertRecipient(sqlite: DatabaseSync, id: string): void {
	sqlite.exec(`
		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES (
			'${id}', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', 'other@example.com', 'Other', 'signer',
			'en', 2, 'pending', '${NOW}', '${NOW}'
		)
	`);
}

function insertDelivery(sqlite: DatabaseSync, id: string): void {
	sqlite.exec(`
		INSERT INTO delivery_outbox (
			id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
			reserved_capability_expires_at, sealed_capability, sealing_key_id,
			sealed_capability_sha256, available_at, attempts, created_at, updated_at, retryable
		) VALUES (
			'${id}', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', '${RECIPIENT_ID}',
			'recipient_invitation', 'pending', '${'c'.repeat(64)}', '2026-09-26T00:00:00.000Z',
			'sealed', 'key-1', '${'s'.repeat(64)}', '${NOW}', 0, '${NOW}', '${NOW}', 1
		)
	`);
}

function insertField(sqlite: DatabaseSync, id: string): void {
	sqlite.exec(`
		INSERT INTO envelope_field (
			id, organization_id, envelope_id, recipient_id, document_path, field_type, label,
			required, position, created_at, updated_at
		) VALUES (
			'${id}', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', '${RECIPIENT_ID}',
			'documents/agreement.md', 'signature', 'Signature', 1, 0, '${NOW}', '${NOW}'
		)
	`);
}

function insertCompletionDelivery(sqlite: DatabaseSync, id: string): void {
	sqlite.exec(`
		INSERT INTO completion_delivery_outbox (
			id, organization_id, envelope_id, recipient_id, status, token_hash, access_expires_at,
			sealed_token, sealing_key_id, sealed_token_sha256, available_at, attempts,
			created_at, updated_at, retryable
		) VALUES (
			'${id}', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', '${RECIPIENT_ID}', 'pending',
			'${'t'.repeat(64)}', '2026-10-12T00:00:00.000Z', 'sealed', 'key-1', '${'u'.repeat(64)}',
			'${NOW}', 0, '${NOW}', '${NOW}', 1
		)
	`);
}

function insertApiKey(sqlite: DatabaseSync, id: string): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, status, created_at, updated_at)
		VALUES ('user_d6e_1', 'active', '${NOW}', '${NOW}')
		ON CONFLICT (user_id) DO NOTHING;
		INSERT INTO api_key (
			id, name, token_hash, key_prefix, scopes_json,
			owner_user_id, created_at, expires_at, rate_window_count
		) VALUES (
			'${id}', 'CI agent', '${'b'.repeat(64)}', 'signkit_abcdefgh',
			'["envelopes:read"]', 'user_d6e_1', '${NOW}', '2026-12-11T00:00:00.000Z', 0
		)
	`);
}

const API_KEY_ID: string = '01970000-0000-7000-8000-000000000001';

function insertApiKeyOrganizationGrant(sqlite: DatabaseSync, id: string): void {
	insertApiKey(sqlite, API_KEY_ID);
	sqlite.exec(`
		INSERT INTO api_key_organization_grant (
			id, api_key_id, organization_id, granted_by_user_id,
			granted_organization_role, granted_at
		) VALUES (
			'${id}', '${API_KEY_ID}', '${ORGANIZATION_ID}', 'user_d6e_1', 'owner', '${NOW}'
		)
	`);
}

function insertEnvelopeDocument(sqlite: DatabaseSync, id: string): void {
	sqlite.exec(`
		INSERT INTO envelope_document (
			id, organization_id, envelope_id, markdown_path, title, position, created_at, updated_at
		) VALUES (
			'${id}', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', 'documents/agreement.md', 'Agreement',
			0, '${NOW}', '${NOW}'
		)
	`);
}

function insertInstanceInvitation(sqlite: DatabaseSync, id: string): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, status, created_at, updated_at)
		VALUES ('user_d6e_1', 'active', '${NOW}', '${NOW}')
		ON CONFLICT (user_id) DO NOTHING;
		INSERT INTO instance_invitation (
			id, role, status, token_hash, email_binding, invited_by_user_id, created_at, expires_at
		) VALUES (
			'${id}', 'member', 'pending', '${SHA256}', '${'b'.repeat(64)}', 'user_d6e_1',
			'${NOW}', '2026-09-15T00:00:00.000Z'
		)
	`);
}

function insertWebhookEndpoint(sqlite: DatabaseSync, id: string): void {
	sqlite.exec(`
		INSERT INTO webhook_endpoint (
			id, organization_id, url, status, events_json,
			secret_hash, signing_secret, secret_prefix, created_at, created_by_user_id
		) VALUES (
			'${id}', '${ORGANIZATION_ID}', 'https://example.com/hooks', 'active',
			'["envelope.completed"]', '${SHA256}', '${'s'.repeat(32)}', 'skwh1_',
			'${NOW}', 'user_d6e_1'
		)
	`);
}

const CONSTRAINED_TABLES: readonly [string, (sqlite: DatabaseSync, id: string) => void, string][] =
	[
		['envelope', insertEnvelope, 'envelope_id_uuidv7'],
		['audit_event', insertAuditEvent, 'audit_event_id_uuidv7'],
		['recipient', insertRecipient, 'recipient_id_uuidv7'],
		['delivery_outbox', insertDelivery, 'delivery_outbox_id_uuidv7'],
		['envelope_field', insertField, 'envelope_field_id_uuidv7'],
		['completion_delivery_outbox', insertCompletionDelivery, 'completion_delivery_id_uuidv7'],
		['api_key', insertApiKey, 'api_key_id_uuidv7'],
		[
			'api_key_organization_grant',
			insertApiKeyOrganizationGrant,
			'api_key_organization_grant_id_uuidv7'
		],
		['webhook_endpoint', insertWebhookEndpoint, 'webhook_endpoint_id_uuidv7'],
		['envelope_document', insertEnvelopeDocument, 'envelope_document_id_uuidv7'],
		['instance_invitation', insertInstanceInvitation, 'instance_invitation_id_uuidv7']
	];

describe('D1 UUIDv7 identifier constraints', () => {
	for (const [table, insert, constraint] of CONSTRAINED_TABLES) {
		it(`accepts a freshly minted UUIDv7 for ${table}`, () => {
			const sqlite: DatabaseSync = database();
			try {
				expect((): void => insert(sqlite, newUuidV7())).not.toThrow();
			} finally {
				sqlite.close();
			}
		});

		it.each(REJECTED_IDENTIFIERS)(`rejects %s for ${table}`, (_name, id) => {
			const sqlite: DatabaseSync = database();
			try {
				expect((): void => insert(sqlite, id)).toThrow(new RegExp(constraint));
			} finally {
				sqlite.close();
			}
		});
	}

	it('keeps external d6e-auth user subjects unconstrained', () => {
		const sqlite: DatabaseSync = database();
		try {
			expect((): void =>
				sqlite.exec(`
					INSERT INTO instance_member (user_id, status, created_at, updated_at)
					VALUES ('user_d6e_not_a_uuid', 'active', '${NOW}', '${NOW}')
				`)
			).not.toThrow();
		} finally {
			sqlite.close();
		}
	});

	it('keeps external d6e-auth organization identifiers unconstrained', () => {
		const sqlite: DatabaseSync = database();
		try {
			expect((): void =>
				sqlite.exec(`
					INSERT INTO organization (id, d6e_organization_id, name, created_at)
					VALUES ('org_2f8c_not_a_uuid', 'org_2f8c_not_a_uuid', 'Other', '${NOW}')
				`)
			).not.toThrow();
		} finally {
			sqlite.close();
		}
	});

	it('keeps arbitrary caller idempotency keys accepted', () => {
		const sqlite: DatabaseSync = database();
		try {
			expect((): void =>
				sqlite.exec(`
					INSERT INTO idempotency_key (
						organization_id, caller_id, idempotency_key, request_hash, envelope_id, created_at
					) VALUES (
						'${ORGANIZATION_ID}', 'user_d6e_1', 'create-agreement#42', '${SHA256}',
						'${ENVELOPE_ID}', '${NOW}'
					)
				`)
			).not.toThrow();
		} finally {
			sqlite.close();
		}
	});

	it('keeps opaque lease and grant material out of the identifier rule', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertCompletionDelivery(sqlite, '01940000-0000-7000-8000-0000000000c1');
			// A claim token is random opaque material, not a UUIDv7 identifier.
			expect((): void =>
				sqlite.exec(`
					UPDATE completion_delivery_outbox
					SET status = 'processing', claim_token = 'n0t-a-uu1d-but-long-enough',
						locked_at = '${NOW}'
					WHERE organization_id = '${ORGANIZATION_ID}'
						AND id = '01940000-0000-7000-8000-0000000000c1'
				`)
			).not.toThrow();
		} finally {
			sqlite.close();
		}
	});
});

describe('D1 API key organization grant identifier policy', () => {
	it('keeps the granted organization an external identifier rather than a UUIDv7', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertApiKey(sqlite, API_KEY_ID);
			expect((): void =>
				sqlite.exec(`
					INSERT INTO api_key_organization_grant (
						id, api_key_id, organization_id, granted_by_user_id,
						granted_organization_role, granted_at
					) VALUES (
						'${newUuidV7()}', '${API_KEY_ID}', '${ORGANIZATION_ID}', 'user_d6e_1',
						'admin', '${NOW}'
					)
				`)
			).not.toThrow();
		} finally {
			sqlite.close();
		}
	});
});
