import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1CompletionPdfEvidenceStore } from './d1-completion-pdf-evidence-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const USER_ID: string = 'user-1';
const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const RECIPIENT_ID: string = '01930000-0000-7000-8000-000000000001';
const DOCUMENT_ID: string = '01920000-0000-7000-8000-000000000001';

function database(): { sqlite: DatabaseSync; d1: D1Database } {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${USER_ID}', 'owner', 'active', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, repository_head,
			sent_commit_sha, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}', '${USER_ID}', 'Agreement', 'ready', 1, 'commit-1', NULL,
			'2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
		);
		INSERT INTO recipient (
			id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES (
			'${RECIPIENT_ID}', '${ENVELOPE_ID}', 'r@example.com', 'R', 'signer',
			'en', 1, 'pending', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
		);
		INSERT INTO envelope_field (
			id, envelope_id, recipient_id, document_id, document_path, field_type, label,
			required, position, page, x, y, width, height, created_at, updated_at
		) VALUES
			('01940000-0000-7000-8000-000000000002', '${ENVELOPE_ID}', '${RECIPIENT_ID}',
				'${DOCUMENT_ID}', NULL, 'signature', 'Sign', 1, 0, 2, 0.25, 0.5, 0.3, 0.05,
				'2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'),
			('01940000-0000-7000-8000-000000000001', '${ENVELOPE_ID}', '${RECIPIENT_ID}',
				NULL, 'documents/a.md', 'initials', 'Initial', 0, 1, NULL, NULL, NULL, NULL, NULL,
				'2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z');
	`);
	return { sqlite, d1: sqliteD1Database(sqlite) };
}

describe('D1CompletionPdfEvidenceStore integration', () => {
	it('reads document-scoped geometry and legacy path-scoped fields in a stable order', async () => {
		const { sqlite, d1 } = database();
		try {
			const store = new D1CompletionPdfEvidenceStore(d1);
			await expect(store.readFieldGeometry(ENVELOPE_ID)).resolves.toEqual([
				{
					id: '01940000-0000-7000-8000-000000000001',
					documentId: null,
					documentPath: 'documents/a.md',
					position: 1,
					recipientId: RECIPIENT_ID,
					fieldType: 'initials',
					required: false,
					// Placed before per-document sends: no frozen geometry exists,
					// and none is invented here.
					geometry: null
				},
				{
					id: '01940000-0000-7000-8000-000000000002',
					documentId: DOCUMENT_ID,
					documentPath: null,
					position: 0,
					recipientId: RECIPIENT_ID,
					fieldType: 'signature',
					required: true,
					geometry: { page: 2, x: 0.25, y: 0.5, width: 0.3, height: 0.05 }
				}
			]);
		} finally {
			sqlite.close();
		}
	});

	it('reads a row with partial geometry columns as having none', async () => {
		const { sqlite, d1 } = database();
		try {
			// The schema forbids this combination; the adapter still refuses to
			// reconstruct a box from an incomplete row.
			sqlite.exec(
				`UPDATE envelope_field SET width = NULL
				 WHERE id = '01940000-0000-7000-8000-000000000002'`
			);
			const store = new D1CompletionPdfEvidenceStore(d1);
			const rows = await store.readFieldGeometry(ENVELOPE_ID);

			expect(rows.map((row) => row.geometry)).toEqual([null, null]);
		} finally {
			sqlite.close();
		}
	});

	it('returns an empty array for an envelope with no placed fields', async () => {
		const { sqlite, d1 } = database();
		try {
			sqlite.exec(`
				INSERT INTO envelope (
					id, created_by_user_id, title, status, repository_generation, repository_head,
					sent_commit_sha, created_at, updated_at
				) VALUES (
					'01900000-0000-7000-8000-000000000002', '${USER_ID}', 'Other', 'ready', 0, NULL, NULL,
					'2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
				);
			`);
			const store = new D1CompletionPdfEvidenceStore(d1);
			await expect(
				store.readFieldGeometry('01900000-0000-7000-8000-000000000002')
			).resolves.toEqual([]);
		} finally {
			sqlite.close();
		}
	});
});
