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
	organization_id: 'org-1',
	envelope_id: 'env-1',
	recipient_id: 'recipient-1',
	recipient_name: 'Recipient',
	recipient_locale: 'ja',
	recipient_role: 'signer',
	recipient_status: 'pending',
	envelope_title: 'Agreement',
	envelope_status: 'sent',
	capability_expires_at: '2026-09-12T00:00:00.000Z'
};

describe('D1RecipientAccessStore', () => {
	it('resolves through the global hash index with tenant-safe joins and fail-closed predicates', async () => {
		const fake = fakeD1(row);
		const store = new D1RecipientAccessStore(fake.database);
		const context: RecipientSigningContext | null = await store.findActiveByTokenHash(
			'hash-1',
			'2026-09-11T00:00:00.000Z'
		);

		expect(context).toEqual({
			organizationId: 'org-1',
			envelopeId: 'env-1',
			recipientId: 'recipient-1',
			recipientName: 'Recipient',
			recipientLocale: 'ja',
			recipientRole: 'signer',
			recipientStatus: 'pending',
			envelopeTitle: 'Agreement',
			envelopeStatus: 'sent',
			expiresAt: '2026-09-12T00:00:00.000Z'
		});
		expect(fake.statement.bindings).toEqual(['hash-1', '2026-09-11T00:00:00.000Z']);
		expect(fake.statement.sql).toContain('ON envelope.organization_id = recipient.organization_id');
		expect(fake.statement.sql).toContain('AND envelope.id = recipient.envelope_id');
		expect(fake.statement.sql).toContain('recipient.capability_revoked_at IS NULL');
		expect(fake.statement.sql).toContain('recipient.capability_expires_at IS NOT NULL');
		expect(fake.statement.sql).toContain(
			'julianday(recipient.capability_expires_at) > julianday(?)'
		);
		expect(fake.statement.sql).toContain("recipient.status IN ('pending', 'viewed')");
		expect(fake.statement.sql).toContain("recipient.role <> 'cc'");
		expect(fake.statement.sql).toContain("envelope.status IN ('sent', 'in_progress')");
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
