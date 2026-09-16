import { describe, expect, it, vi } from 'vitest';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import { D1RecipientAccessStore } from './d1-recipient-access-store';

interface StatementRecord {
	sql: string;
	bindings: readonly unknown[];
}

function fakeD1(result: object | null): { database: D1Database; statement: StatementRecord } {
	const record: StatementRecord = { sql: '', bindings: [] };
	const prepare = vi.fn((sql: string): D1PreparedStatement => {
		record.sql = sql;
		const statement = {
			bind: (...bindings: unknown[]): D1PreparedStatement => {
				record.bindings = bindings;
				return statement as unknown as D1PreparedStatement;
			},
			first: async (): Promise<object | null> => result
		};
		return statement as unknown as D1PreparedStatement;
	});
	return { database: { prepare } as unknown as D1Database, statement: record };
}

const row = {
	envelope_id: 'env-1',
	recipient_id: 'recipient-1',
	recipient_name: 'Recipient',
	recipient_locale: 'ja',
	recipient_role: 'signer',
	recipient_status: 'pending',
	envelope_title: 'Agreement',
	envelope_status: 'sent',
	capability_expires_at: '2026-09-12T00:00:00.000Z',
	sent_commit_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	archive_key: 'private/archive.git.gz',
	archive_sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
};

describe('D1RecipientAccessStore', () => {
	it('resolves through the global hash index with envelope-safe joins and fail-closed predicates', async () => {
		const fake = fakeD1(row);
		const store = new D1RecipientAccessStore(fake.database);
		const context: RecipientSigningContext | null = await store.findActiveByTokenHash(
			'hash-1',
			'2026-09-11T00:00:00.000Z'
		);

		expect(context).toEqual({
			envelopeId: 'env-1',
			recipientId: 'recipient-1',
			recipientName: 'Recipient',
			recipientLocale: 'ja',
			recipientRole: 'signer',
			recipientStatus: 'pending',
			envelopeTitle: 'Agreement',
			envelopeStatus: 'sent',
			expiresAt: '2026-09-12T00:00:00.000Z',
			sentRevision: {
				commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				archiveKey: 'private/archive.git.gz',
				archiveSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
			}
		});
		expect(fake.statement.bindings).toEqual(['hash-1', '2026-09-11T00:00:00.000Z']);
		expect(fake.statement.sql).toContain('ON envelope.id = recipient.envelope_id');
		expect(fake.statement.sql).toContain('recipient.capability_revoked_at IS NULL');
		expect(fake.statement.sql).toContain('recipient.capability_expires_at IS NOT NULL');
		expect(fake.statement.sql).toContain(
			'julianday(recipient.capability_expires_at) > julianday(?)'
		);
		expect(fake.statement.sql).toContain("recipient.status IN ('pending', 'viewed')");
		expect(fake.statement.sql).toContain("recipient.role IN ('signer', 'approver', 'viewer')");
		expect(fake.statement.sql).toContain("envelope.status IN ('sent', 'in_progress')");
		expect(fake.statement.sql).toContain('INNER JOIN draft_revision_command revision');
		expect(fake.statement.sql).toContain('envelope.sent_commit_sha = envelope.repository_head');
		expect(fake.statement.sql).toContain('revision.commit_sha = envelope.sent_commit_sha');
		expect(fake.statement.sql).toContain('revision.archive_key = envelope.repository_archive_key');
		expect(fake.statement.sql).toContain(
			'revision.archive_sha256 = envelope.repository_archive_sha256'
		);
	});

	it('returns null without inventing context when no active row matches', async () => {
		const fake = fakeD1(null);
		await expect(
			new D1RecipientAccessStore(fake.database).findActiveByTokenHash(
				'hash-1',
				'2026-09-11T00:00:00.000Z'
			)
		).resolves.toBeNull();
	});
});
