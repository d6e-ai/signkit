import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { RecipientDeclinedApplication } from '$lib/application/signing/recipient-declined';
import { RecipientDeclinedReceiptApplication } from '$lib/application/signing/recipient-declined-receipt';
import { issueRecipientCapability } from '$lib/security/recipient-capability';
import { D1RecipientDeclineStore } from './d1-recipient-decline-store';
import { D1RecipientDeclinedReceiptStore } from './d1-recipient-declined-receipt-store';
import { sqliteD1Database } from './sqlite-d1-test-support';

const MIGRATIONS: readonly string[] = readdirSync('migrations/d1')
	.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
	.sort()
	.map((name: string): string => `migrations/d1/${name}`);
const DECLINED_AT: string = '2026-09-12T00:00:00.000Z';
const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000021';
const RECIPIENT_ID: string = '01900000-0000-7000-8000-000000000022';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';

async function fixture(): Promise<{
	sqlite: DatabaseSync;
	database: D1Database;
	token: string;
	capabilityHash: string;
}> {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	for (const path of MIGRATIONS) sqlite.exec(readFileSync(path, 'utf8'));
	const capability = await issueRecipientCapability();
	sqlite
		.prepare(
			`INSERT INTO organization (id, d6e_organization_id, name, created_at)
			 VALUES ('org-1', 'org-1', 'Workspace', ?)`
		)
		.run(DECLINED_AT);
	sqlite
		.prepare(
			`INSERT INTO envelope (
				id, organization_id, title, status, repository_generation, repository_head,
				sent_commit_sha, created_at, updated_at
			 ) VALUES (?, 'org-1', 'Agreement', 'sent', 1, ?, ?, ?, ?)`
		)
		.run(ENVELOPE_ID, COMMIT_SHA, COMMIT_SHA, DECLINED_AT, DECLINED_AT);
	sqlite
		.prepare(
			`INSERT INTO recipient (
				id, organization_id, envelope_id, email, name, role, locale, routing_order,
				status, capability_hash, capability_expires_at, created_at, updated_at
			 ) VALUES (?, 'org-1', ?, 'recipient@example.com', 'Recipient', 'signer', 'ja', 1,
				'pending', ?, '2026-09-20T00:00:00.000Z', ?, ?)`
		)
		.run(RECIPIENT_ID, ENVELOPE_ID, capability.tokenHash, DECLINED_AT, DECLINED_AT);
	sqlite
		.prepare(
			`INSERT INTO audit_event (
				id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
				payload_json, previous_hash, event_hash, occurred_at
			 ) VALUES ('01960000-0000-7000-8000-0000000000a1', 'org-1', ?, 1, 'envelope.sent', 'user', 'user-1',
				'{}', NULL, 'sent-hash', ?)`
		)
		.run(ENVELOPE_ID, DECLINED_AT);
	const database: D1Database = sqliteD1Database(sqlite);
	const declined = await new RecipientDeclinedApplication(
		new D1RecipientDeclineStore(database),
		(): Date => new Date(DECLINED_AT)
	).decline({
		token: capability.token,
		expectedEnvelopeId: ENVELOPE_ID,
		expectedRecipientId: RECIPIENT_ID,
		idempotencyKey: 'decline-1'
	});
	if (declined.outcome !== 'published')
		throw new Error(`Fixture decline failed: ${declined.outcome}`);
	return { sqlite, database, token: capability.token, capabilityHash: capability.tokenHash };
}

describe('D1 declined receipt evidence integration', () => {
	it('uses the existing migrations to recover and exact-resolve a durable receipt', async () => {
		const { sqlite, database, token } = await fixture();
		try {
			const application = new RecipientDeclinedReceiptApplication(
				new D1RecipientDeclinedReceiptStore(database)
			);
			const recovered = await application.recoverByToken(
				token,
				new Date('2026-10-11T23:59:59.999Z')
			);
			expect(recovered).toEqual({
				receipt: {
					envelopeId: ENVELOPE_ID,
					recipientId: RECIPIENT_ID,
					recipientStatus: 'declined',
					envelopeStatus: 'declined',
					declinedAt: DECLINED_AT,
					locale: 'ja'
				},
				locator: expect.objectContaining({
					organizationId: 'org-1',
					idempotencyKey: 'decline-1',
					expiresAt: '2026-10-12T00:00:00.000Z'
				})
			});
			await expect(
				application.resolveLocator(
					recovered?.locator as NonNullable<typeof recovered>['locator'],
					new Date('2026-09-13T00:00:00.000Z')
				)
			).resolves.toEqual(recovered);
		} finally {
			sqlite.close();
		}
	});

	it.each([
		['request fingerprint', "UPDATE recipient_declined_command SET request_hash='tampered'"],
		['recipient status', "UPDATE recipient SET status='pending'"],
		['recipient revocation', 'UPDATE recipient SET capability_revoked_at=NULL'],
		['envelope terminal status', "UPDATE envelope SET status='completed'"],
		['audit evidence', "UPDATE audit_event SET event_hash='tampered' WHERE sequence=2"],
		['audit predecessor', "UPDATE audit_event SET event_hash='tampered' WHERE sequence=1"]
	])('fails closed when %s is no longer intact', async (_name, mutation) => {
		const { sqlite, database, token } = await fixture();
		try {
			sqlite.exec(mutation);
			await expect(
				new RecipientDeclinedReceiptApplication(
					new D1RecipientDeclinedReceiptStore(database)
				).recoverByToken(token, new Date('2026-09-13T00:00:00.000Z'))
			).resolves.toBeNull();
		} finally {
			sqlite.close();
		}
	});

	it('fails closed when a capability or deliverable invitation reappears after decline', async () => {
		const { sqlite, database, token } = await fixture();
		try {
			sqlite.exec(`
				INSERT INTO recipient (
					id, organization_id, envelope_id, email, name, role, locale, routing_order,
					status, capability_hash, capability_expires_at, created_at, updated_at
				) VALUES (
					'01930000-0000-7000-8000-0000000000f5', 'org-1', '${ENVELOPE_ID}', 'sibling@example.com', 'Sibling',
					'viewer', 'en', 1, 'pending', '${'b'.repeat(64)}', '2026-10-01',
					'${DECLINED_AT}', '${DECLINED_AT}'
				);
			`);
			const application = new RecipientDeclinedReceiptApplication(
				new D1RecipientDeclinedReceiptStore(database)
			);
			await expect(
				application.recoverByToken(token, new Date('2026-09-13T00:00:00.000Z'))
			).resolves.toBeNull();

			sqlite.exec("DELETE FROM recipient WHERE id='01930000-0000-7000-8000-0000000000f5'");
			await expect(
				application.recoverByToken(token, new Date('2026-09-13T00:00:00.000Z'))
			).resolves.not.toBeNull();
			sqlite.exec(`
				INSERT INTO delivery_outbox (
					id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
					reserved_capability_expires_at, sealed_capability, sealing_key_id,
					sealed_capability_sha256, available_at, attempts, created_at, updated_at, retryable
				) VALUES (
					'01940000-0000-7000-8000-000000000001', 'org-1', '${ENVELOPE_ID}', '${RECIPIENT_ID}', 'recipient_invitation',
					'pending', '${'b'.repeat(64)}', '2026-10-01', 'sealed', 'key-1',
					'${'c'.repeat(64)}', '2026-09-13', 0, '2026-09-13', '2026-09-13', 1
				)
			`);
			await expect(
				application.recoverByToken(token, new Date('2026-09-13T00:00:00.000Z'))
			).resolves.toBeNull();
		} finally {
			sqlite.close();
		}
	});

	it('returns no row for any stale locator identity field', async () => {
		const { sqlite, database, capabilityHash } = await fixture();
		try {
			const store = new D1RecipientDeclinedReceiptStore(database);
			const identity = {
				organizationId: 'org-1',
				envelopeId: ENVELOPE_ID,
				recipientId: RECIPIENT_ID,
				idempotencyKey: 'decline-1',
				capabilityHash
			};
			for (const changed of [
				{ ...identity, organizationId: 'org-2' },
				{ ...identity, envelopeId: 'other' },
				{ ...identity, recipientId: 'other' },
				{ ...identity, idempotencyKey: 'other' },
				{ ...identity, capabilityHash: 'd'.repeat(64) }
			]) {
				await expect(store.findByIdentity(changed)).resolves.toBeNull();
			}
		} finally {
			sqlite.close();
		}
	});
});
