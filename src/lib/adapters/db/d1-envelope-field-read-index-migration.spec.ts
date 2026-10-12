import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	D1_ENVELOPE_DETAIL_FIELD_SQL,
	D1EnvelopeApplicationStore
} from './d1-envelope-application-store';
import { D1EnvelopeFieldStore } from './d1-envelope-field-store';
import {
	applyD1MigrationInTransaction,
	applyD1Migrations,
	applyD1MigrationsThrough,
	d1MigrationPaths,
	sqliteD1Database
} from './sqlite-d1-test-support';

const USER_ID: string = 'user-1';
const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const RECIPIENT_ID: string = '01900000-0000-7000-8000-000000000002';
const PDF_DOCUMENT_ID: string = '01900000-0000-7000-8000-000000000021';
const CREATED_AT: string = '2026-09-11T00:00:00.000Z';
const INDEX_MIGRATION: string = 'migrations/d1/0057_envelope_field_envelope_coalesce_order.sql';
const REBUILD_MIGRATION: string = 'migrations/d1/0045_envelope_sent_document_set.sql';

const AUTHORING_SQL: string = `SELECT envelope.repository_generation AS repository_generation,
				        envelope.field_generation AS field_generation,
				        envelope.repository_head AS repository_head,
				        envelope_field.id AS id,
				        envelope_field.recipient_id AS recipient_id,
				        envelope_field.document_id AS document_id,
				        envelope_field.document_path AS document_path,
				        envelope_field.field_type AS field_type,
				        envelope_field.label AS label,
				        envelope_field.required AS required,
				        envelope_field.position AS position,
				        envelope_field.page AS page,
				        envelope_field.x AS x,
				        envelope_field.y AS y,
				        envelope_field.width AS width,
				        envelope_field.height AS height
				 FROM envelope
				 LEFT JOIN envelope_field ON envelope_field.envelope_id = envelope.id
				 WHERE envelope.id = ?
				 ORDER BY COALESCE(envelope_field.document_id, envelope_field.document_path) ASC,
				          envelope_field.position ASC, envelope_field.id ASC`;

function queryPlan(sqlite: DatabaseSync, sql: string): string {
	return (
		sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(ENVELOPE_ID) as {
			detail: string;
		}[]
	)
		.map(({ detail }: { detail: string }): string => detail)
		.join('\n');
}

function indexNames(sqlite: DatabaseSync): readonly string[] {
	return (
		sqlite
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'index' AND tbl_name = 'envelope_field' AND name IS NOT NULL
				 ORDER BY name`
			)
			.all() as { name: string }[]
	).map(({ name }: { name: string }): string => name);
}

function seedMixedFields(sqlite: DatabaseSync): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${USER_ID}', 'owner', 'active', '${CREATED_AT}', '${CREATED_AT}');
		INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, field_generation,
			created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}', '${USER_ID}', 'Agreement', 'ready', 1, 1, '${CREATED_AT}', '${CREATED_AT}'
		);
		INSERT INTO recipient (
			id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at
		) VALUES (
			'${RECIPIENT_ID}', '${ENVELOPE_ID}', 'a@example.com', 'A', 'signer', 'en', 1, 'pending',
			'${CREATED_AT}', '${CREATED_AT}'
		);
	`);
	const insert = sqlite.prepare(
		`INSERT INTO envelope_field (
			id, envelope_id, recipient_id, document_id, document_path, field_type, label,
			required, position, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, 'signature', 'Signature', 1, ?, ?, ?)`
	);
	insert.run(
		'01900000-0000-7000-8000-000000000012',
		ENVELOPE_ID,
		RECIPIENT_ID,
		null,
		'documents/agreement.md',
		1,
		CREATED_AT,
		CREATED_AT
	);
	insert.run(
		'01900000-0000-7000-8000-000000000011',
		ENVELOPE_ID,
		RECIPIENT_ID,
		PDF_DOCUMENT_ID,
		null,
		1,
		CREATED_AT,
		CREATED_AT
	);
	insert.run(
		'01900000-0000-7000-8000-000000000014',
		ENVELOPE_ID,
		RECIPIENT_ID,
		PDF_DOCUMENT_ID,
		null,
		0,
		CREATED_AT,
		CREATED_AT
	);
	insert.run(
		'01900000-0000-7000-8000-000000000013',
		ENVELOPE_ID,
		RECIPIENT_ID,
		null,
		'documents/appendix.md',
		0,
		CREATED_AT,
		CREATED_AT
	);
}

const MIXED_FIELD_IDS: readonly string[] = [
	'01900000-0000-7000-8000-000000000014',
	'01900000-0000-7000-8000-000000000011',
	'01900000-0000-7000-8000-000000000012',
	'01900000-0000-7000-8000-000000000013'
];

describe('D1 envelope_field COALESCE read index migration', () => {
	it('is a new forward migration after the 0045 field rebuild', () => {
		const paths: readonly string[] = d1MigrationPaths();
		expect(paths).toContain(REBUILD_MIGRATION);
		expect(paths).toContain(INDEX_MIGRATION);
		expect(paths.indexOf(INDEX_MIGRATION)).toBeGreaterThan(paths.indexOf(REBUILD_MIGRATION));
	});

	it('scans envelope_field for detail and identity-scans the authoring join before the index', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1MigrationsThrough(sqlite, REBUILD_MIGRATION);
			seedMixedFields(sqlite);
			const detailPlan: string = queryPlan(sqlite, D1_ENVELOPE_DETAIL_FIELD_SQL);
			const authoringPlan: string = queryPlan(sqlite, AUTHORING_SQL);
			expect(detailPlan).toContain('SCAN envelope_field');
			expect(detailPlan).not.toContain('envelope_field_envelope_coalesce_order');
			expect(authoringPlan).toContain('SCAN envelope_field USING INDEX envelope_field_identity');
			expect(authoringPlan).not.toContain('envelope_field_envelope_coalesce_order');
		} finally {
			sqlite.close();
		}
	});

	it('upgrades an existing 0045 schema to indexed SEARCH plans without dropping document indexes', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1MigrationsThrough(sqlite, REBUILD_MIGRATION);
			applyD1MigrationInTransaction(sqlite, INDEX_MIGRATION);
			seedMixedFields(sqlite);
			const names: readonly string[] = indexNames(sqlite);
			expect(names).toContain('envelope_field_envelope_coalesce_order');
			expect(names).toContain('envelope_field_document_order');
			expect(names).toContain('envelope_field_document_path_order');
			const detailPlan: string = queryPlan(sqlite, D1_ENVELOPE_DETAIL_FIELD_SQL);
			const authoringPlan: string = queryPlan(sqlite, AUTHORING_SQL);
			expect(detailPlan).toContain(
				'SEARCH envelope_field USING INDEX envelope_field_envelope_coalesce_order'
			);
			expect(detailPlan).not.toContain('SCAN envelope_field');
			expect(detailPlan).not.toContain('USE TEMP B-TREE FOR ORDER BY');
			expect(authoringPlan).toContain('envelope_field_envelope_coalesce_order');
			expect(authoringPlan).not.toContain(
				'SCAN envelope_field USING INDEX envelope_field_identity'
			);
			expect(authoringPlan).not.toContain('USE TEMP B-TREE FOR ORDER BY');
		} finally {
			sqlite.close();
		}
	});

	it('applies the same index on a fresh schema and orders mixed Markdown/PDF reads', async () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			expect(indexNames(sqlite)).toContain('envelope_field_envelope_coalesce_order');
			seedMixedFields(sqlite);
			const detailPlan: string = queryPlan(sqlite, D1_ENVELOPE_DETAIL_FIELD_SQL);
			const authoringPlan: string = queryPlan(sqlite, AUTHORING_SQL);
			expect(detailPlan).toContain('envelope_field_envelope_coalesce_order');
			expect(authoringPlan).toContain('envelope_field_envelope_coalesce_order');

			const database: D1Database = sqliteD1Database(sqlite);
			const detail = await new D1EnvelopeApplicationStore(database).readDetail(ENVELOPE_ID);
			expect(detail?.fields.map((field): string => field.id)).toEqual(MIXED_FIELD_IDS);
			expect(detail?.fields.map((field): string | null => field.documentId)).toEqual([
				PDF_DOCUMENT_ID,
				PDF_DOCUMENT_ID,
				null,
				null
			]);
			expect(detail?.fields.map((field): string | null => field.documentPath)).toEqual([
				null,
				null,
				'documents/agreement.md',
				'documents/appendix.md'
			]);

			const authoring = await new D1EnvelopeFieldStore(database).readAuthoringFields(ENVELOPE_ID);
			expect(authoring?.fields.map((field): string => field.id)).toEqual(MIXED_FIELD_IDS);
		} finally {
			sqlite.close();
		}
	});
});
