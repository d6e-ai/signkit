import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresEnvelopeApplicationStore } from './postgres-envelope-application-store';
import { PostgresEnvelopeFieldStore } from './postgres-envelope-field-store';

const TEST_DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const CI_ENABLED: boolean =
	process.env.CI !== undefined &&
	process.env.CI.trim() !== '' &&
	!['0', 'false', 'no'].includes(process.env.CI.toLowerCase());
if (CI_ENABLED && TEST_DATABASE_URL === undefined) {
	throw new Error('POSTGRES_TEST_URL is required when PostgreSQL integration tests run in CI');
}
const postgresDescribe = TEST_DATABASE_URL === undefined ? describe.skip : describe;

const USER_ID: string = 'user-1';
const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const RECIPIENT_ID: string = '01900000-0000-7000-8000-000000000002';
const PDF_DOCUMENT_ID: string = '01900000-0000-7000-8000-000000000021';
const CREATED_AT: string = '2026-09-11T00:00:00.000Z';
const INDEX_MIGRATION: string =
	'migrations/postgres/0053_envelope_field_envelope_coalesce_order.sql';
const PRIOR_MIGRATION: string = 'migrations/postgres/0052_envelope_reopen.sql';

const MIGRATION_PATHS: readonly string[] = readdirSync('migrations/postgres')
	.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
	.sort()
	.map((name: string): string => `migrations/postgres/${name}`);

const DETAIL_SQL: string = `SELECT id, recipient_id, document_id, document_path, field_type, required, position,
				page, x, y, width, height
			 FROM envelope_field
			 WHERE envelope_id = '${ENVELOPE_ID}'
			 ORDER BY COALESCE(document_id, document_path) ASC, position ASC, id ASC`;

const AUTHORING_SQL: string = `SELECT envelope.repository_generation,
				envelope.field_generation,
				envelope.repository_head,
				envelope_field.id
			 FROM envelope
			 LEFT JOIN envelope_field ON envelope_field.envelope_id = envelope.id
			 WHERE envelope.id = '${ENVELOPE_ID}'
			 ORDER BY COALESCE(envelope_field.document_id, envelope_field.document_path) ASC,
				envelope_field.position ASC, envelope_field.id ASC`;

const MIXED_FIELD_IDS: readonly string[] = [
	'01900000-0000-7000-8000-000000000014',
	'01900000-0000-7000-8000-000000000011',
	'01900000-0000-7000-8000-000000000012',
	'01900000-0000-7000-8000-000000000013'
];

let sql: ReturnType<typeof postgres> | null = null;
const schemaName: string = `signkit_field_idx_${process.pid}_${randomUUID().replaceAll('-', '')}`;

async function applyMigrations(
	client: ReturnType<typeof postgres>,
	throughPath?: string
): Promise<void> {
	for (const path of MIGRATION_PATHS) {
		await client.unsafe(readFileSync(path, 'utf8'));
		if (path === throughPath) return;
	}
	if (throughPath !== undefined) throw new Error(`PostgreSQL migration not found: ${throughPath}`);
}

async function seedMixedFields(client: ReturnType<typeof postgres>): Promise<void> {
	await client.unsafe(`
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
	await client.unsafe(`
		INSERT INTO envelope_field (
			id, envelope_id, recipient_id, document_id, document_path, field_type, label,
			required, position, created_at, updated_at
		) VALUES
			('01900000-0000-7000-8000-000000000012', '${ENVELOPE_ID}', '${RECIPIENT_ID}',
			 NULL, 'documents/agreement.md', 'signature', 'Signature', true, 1, '${CREATED_AT}', '${CREATED_AT}'),
			('01900000-0000-7000-8000-000000000011', '${ENVELOPE_ID}', '${RECIPIENT_ID}',
			 '${PDF_DOCUMENT_ID}', NULL, 'signature', 'Signature', true, 1, '${CREATED_AT}', '${CREATED_AT}'),
			('01900000-0000-7000-8000-000000000014', '${ENVELOPE_ID}', '${RECIPIENT_ID}',
			 '${PDF_DOCUMENT_ID}', NULL, 'signature', 'Signature', true, 0, '${CREATED_AT}', '${CREATED_AT}'),
			('01900000-0000-7000-8000-000000000013', '${ENVELOPE_ID}', '${RECIPIENT_ID}',
			 NULL, 'documents/appendix.md', 'signature', 'Signature', true, 0, '${CREATED_AT}', '${CREATED_AT}')
	`);
}

async function explain(client: ReturnType<typeof postgres>, sqlText: string): Promise<string> {
	await client.unsafe('BEGIN');
	try {
		await client.unsafe('SET LOCAL enable_seqscan = off');
		const planRows: Record<string, unknown>[] = await client.unsafe(
			`EXPLAIN (COSTS OFF)\n${sqlText}`
		);
		return planRows
			.flatMap((row: Record<string, unknown>): unknown[] => Object.values(row))
			.map((value: unknown): string => String(value))
			.join('\n');
	} finally {
		await client.unsafe('ROLLBACK');
	}
}

async function indexNames(client: ReturnType<typeof postgres>): Promise<readonly string[]> {
	const rows: { indexname: string }[] = await client.unsafe(
		`SELECT indexname FROM pg_indexes
		 WHERE schemaname = current_schema() AND tablename = 'envelope_field'
		 ORDER BY indexname`
	);
	return rows.map((row: { indexname: string }): string => row.indexname);
}

postgresDescribe('PostgreSQL envelope_field COALESCE read index', () => {
	beforeAll(async () => {
		sql = postgres(TEST_DATABASE_URL as string, {
			max: 1,
			onnotice: (): void => undefined,
			connection: { search_path: schemaName, TimeZone: 'UTC' }
		});
		await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
		await sql.unsafe(`SET search_path TO "${schemaName}"`);
		await applyMigrations(sql);
		await seedMixedFields(sql);
	});

	afterAll(async () => {
		if (sql === null) return;
		await sql.unsafe('SET search_path TO public');
		await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
		await sql.end({ timeout: 5 });
		sql = null;
	});

	it('adds an envelope-leading COALESCE index without casting text document_id', async () => {
		expect(MIGRATION_PATHS).toContain(PRIOR_MIGRATION);
		expect(MIGRATION_PATHS).toContain(INDEX_MIGRATION);
		expect(MIGRATION_PATHS.indexOf(INDEX_MIGRATION)).toBeGreaterThan(
			MIGRATION_PATHS.indexOf(PRIOR_MIGRATION)
		);
		const client: ReturnType<typeof postgres> = sql as ReturnType<typeof postgres>;
		const names: readonly string[] = await indexNames(client);
		expect(names).toContain('envelope_field_envelope_coalesce_order');
		expect(names).toContain('envelope_field_document_order');
		expect(names).toContain('envelope_field_document_path_order');
		const types: { data_type: string }[] = await client.unsafe(
			`SELECT data_type FROM information_schema.columns
			 WHERE table_schema = current_schema()
			   AND table_name = 'envelope_field'
			   AND column_name = 'document_id'`
		);
		expect(types[0]?.data_type).toBe('text');
		const definitions: { indexdef: string }[] = await client.unsafe(
			`SELECT indexdef FROM pg_indexes
			 WHERE schemaname = current_schema()
			   AND indexname = 'envelope_field_envelope_coalesce_order'`
		);
		expect(definitions[0]?.indexdef).toContain('COALESCE(document_id, document_path)');
		expect(definitions[0]?.indexdef).not.toContain('::text');
	});

	it('uses the COALESCE index for detail and authoring reads of mixed Markdown/PDF fields', async () => {
		const client: ReturnType<typeof postgres> = sql as ReturnType<typeof postgres>;
		const detailPlan: string = await explain(client, DETAIL_SQL);
		const authoringPlan: string = await explain(client, AUTHORING_SQL);
		expect(detailPlan).toContain('envelope_field_envelope_coalesce_order');
		expect(authoringPlan).toContain('envelope_field_envelope_coalesce_order');

		const detail = await new PostgresEnvelopeApplicationStore(client).readDetail(ENVELOPE_ID);
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

		const authoring = await new PostgresEnvelopeFieldStore(client).readAuthoringFields(ENVELOPE_ID);
		expect(authoring?.fields.map((field): string => field.id)).toEqual(MIXED_FIELD_IDS);
	});

	it('upgrades a pre-0053 schema to the same index and query plans', async () => {
		const upgradeSchema: string = `signkit_field_idx_up_${process.pid}_${randomUUID().replaceAll('-', '')}`;
		const client: ReturnType<typeof postgres> = postgres(TEST_DATABASE_URL as string, {
			max: 1,
			onnotice: (): void => undefined,
			connection: { search_path: upgradeSchema, TimeZone: 'UTC' }
		});
		try {
			await client.unsafe(`CREATE SCHEMA "${upgradeSchema}"`);
			await client.unsafe(`SET search_path TO "${upgradeSchema}"`);
			await applyMigrations(client, PRIOR_MIGRATION);
			expect(await indexNames(client)).not.toContain('envelope_field_envelope_coalesce_order');
			await client.unsafe(readFileSync(INDEX_MIGRATION, 'utf8'));
			await seedMixedFields(client);
			const names: readonly string[] = await indexNames(client);
			expect(names).toContain('envelope_field_envelope_coalesce_order');
			expect(names).toContain('envelope_field_document_order');
			expect(names).toContain('envelope_field_document_path_order');
			const detailPlan: string = await explain(client, DETAIL_SQL);
			const authoringPlan: string = await explain(client, AUTHORING_SQL);
			expect(detailPlan).toContain('envelope_field_envelope_coalesce_order');
			expect(authoringPlan).toContain('envelope_field_envelope_coalesce_order');
			const detail = await new PostgresEnvelopeApplicationStore(client).readDetail(ENVELOPE_ID);
			expect(detail?.fields.map((field): string => field.id)).toEqual(MIXED_FIELD_IDS);
		} finally {
			await client.unsafe('SET search_path TO public');
			await client.unsafe(`DROP SCHEMA IF EXISTS "${upgradeSchema}" CASCADE`);
			await client.end({ timeout: 5 });
		}
	});
});
