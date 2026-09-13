import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1CompletionPdfEvidenceStore } from './d1-completion-pdf-evidence-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ORGANIZATION_ID: string = 'org-1';
const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const RECIPIENT_ID: string = '01930000-0000-7000-8000-000000000001';

function database(): { sqlite: DatabaseSync; d1: D1Database } {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	sqlite.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${ORGANIZATION_ID}', '${ORGANIZATION_ID}', 'Workspace', '2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			sent_commit_sha, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}', '${ORGANIZATION_ID}', 'Agreement', 'ready', 1, 'commit-1', NULL,
			'2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
		);
		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES (
			'${RECIPIENT_ID}', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', 'r@example.com', 'R', 'signer',
			'en', 1, 'pending', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
		);
		INSERT INTO envelope_field (
			id, organization_id, envelope_id, recipient_id, document_path, field_type, label,
			required, position, created_at, updated_at
		) VALUES
			('01940000-0000-7000-8000-000000000002', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', '${RECIPIENT_ID}',
				'documents/b.md', 'signature', 'Sign', 1, 0, '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'),
			('01940000-0000-7000-8000-000000000001', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', '${RECIPIENT_ID}',
				'documents/a.md', 'initials', 'Initial', 0, 1, '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z');
	`);
	return { sqlite, d1: sqliteD1Database(sqlite) };
}

describe('D1CompletionPdfEvidenceStore integration', () => {
	it('reads field geometry sorted by document path, position, then id', async () => {
		const { sqlite, d1 } = database();
		try {
			const store = new D1CompletionPdfEvidenceStore(d1);
			await expect(store.readFieldGeometry(ORGANIZATION_ID, ENVELOPE_ID)).resolves.toEqual([
				{
					id: '01940000-0000-7000-8000-000000000001',
					documentPath: 'documents/a.md',
					position: 1,
					recipientId: RECIPIENT_ID
				},
				{
					id: '01940000-0000-7000-8000-000000000002',
					documentPath: 'documents/b.md',
					position: 0,
					recipientId: RECIPIENT_ID
				}
			]);
		} finally {
			sqlite.close();
		}
	});

	it('returns an empty array for an envelope with no placed fields', async () => {
		const { sqlite, d1 } = database();
		try {
			sqlite.exec(`
				INSERT INTO envelope (
					id, organization_id, title, status, repository_generation, repository_head,
					sent_commit_sha, created_at, updated_at
				) VALUES (
					'01900000-0000-7000-8000-000000000002', '${ORGANIZATION_ID}', 'Other', 'ready', 0, NULL, NULL,
					'2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
				);
			`);
			const store = new D1CompletionPdfEvidenceStore(d1);
			await expect(
				store.readFieldGeometry(ORGANIZATION_ID, '01900000-0000-7000-8000-000000000002')
			).resolves.toEqual([]);
		} finally {
			sqlite.close();
		}
	});
});
