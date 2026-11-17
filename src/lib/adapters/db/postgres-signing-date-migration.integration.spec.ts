import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresEnvelopeFieldStore } from './postgres-envelope-field-store';
import { PostgresRecipientFieldDeclarationStore } from './postgres-recipient-field-declaration-store';

const TEST_DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const CI_ENABLED: boolean =
	process.env.CI !== undefined &&
	process.env.CI.trim() !== '' &&
	!['0', 'false', 'no'].includes(process.env.CI.toLowerCase());
if (CI_ENABLED && TEST_DATABASE_URL === undefined) {
	throw new Error('POSTGRES_TEST_URL is required when PostgreSQL integration tests run in CI');
}
const postgresDescribe = TEST_DATABASE_URL === undefined ? describe.skip : describe;

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const RECIPIENT_ID: string = '01900000-0000-7000-8000-000000000002';
const TEXT_FIELD_ID: string = '01900000-0000-7000-8000-000000000011';
const DATE_FIELD_ID: string = '01900000-0000-7000-8000-000000000012';
const AUTO_FIELD_ID: string = '01900000-0000-7000-8000-000000000013';
const DOCUMENT_ID: string = '01900000-0000-7000-8000-000000000021';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const AT: string = '2026-09-11T00:00:00.000Z';
const PRIOR_MIGRATION: string = 'migrations/postgres/0055_instance_display.sql';
const MIGRATION: string = 'migrations/postgres/0056_signing_date_mode.sql';

const MIGRATION_PATHS: readonly string[] = readdirSync('migrations/postgres')
	.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
	.sort()
	.map((name: string): string => `migrations/postgres/${name}`);

type Client = ReturnType<typeof postgres>;

async function applyMigrations(client: Client, throughPath?: string): Promise<void> {
	for (const path of MIGRATION_PATHS) {
		await client.unsafe(readFileSync(path, 'utf8'));
		if (path === throughPath) return;
	}
	if (throughPath !== undefined) throw new Error(`PostgreSQL migration not found: ${throughPath}`);
}

async function seed(client: Client, withFields: boolean): Promise<void> {
	await client.unsafe(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('user-1', 'owner', 'active', '${AT}', '${AT}');
		INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, repository_head,
			field_generation, created_at, updated_at
		) VALUES ('${ENVELOPE_ID}', 'user-1', 'Agreement', 'ready', 1, '${COMMIT_SHA}', 1, '${AT}', '${AT}');
		INSERT INTO recipient (
			id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at
		) VALUES ('${RECIPIENT_ID}', '${ENVELOPE_ID}', 'a@example.com', 'A', 'signer', 'en', 1, 'pending', '${AT}', '${AT}');
	`);
	if (!withFields) return;
	await client.unsafe(`
		INSERT INTO envelope_field (
			id, envelope_id, recipient_id, document_id, field_type, label, required, position,
			created_at, updated_at
		) VALUES
			('${TEXT_FIELD_ID}', '${ENVELOPE_ID}', '${RECIPIENT_ID}', '${DOCUMENT_ID}', 'text', 'Name', true, 0, '${AT}', '${AT}'),
			('${DATE_FIELD_ID}', '${ENVELOPE_ID}', '${RECIPIENT_ID}', '${DOCUMENT_ID}', 'date', 'Date', true, 1, '${AT}', '${AT}');
		INSERT INTO field_value (
			field_id, envelope_id, recipient_id, field_type, value_json, value_sha256, created_at
		) VALUES ('${DATE_FIELD_ID}', '${ENVELOPE_ID}', '${RECIPIENT_ID}', 'date', '"2026-09-10"', '${'f'.repeat(64)}', '${AT}');
	`);
}

async function catalog(client: Client): Promise<{
	indexes: string[];
	triggers: string[];
	foreignKeys: string[];
}> {
	const indexes: { definition: string }[] = await client.unsafe(
		`SELECT indexdef AS definition FROM pg_indexes
		 WHERE schemaname = current_schema() AND tablename IN ('envelope_field', 'field_value')
		 ORDER BY indexname`
	);
	const triggers: { definition: string }[] = await client.unsafe(
		`SELECT pg_get_triggerdef(trigger.oid) AS definition FROM pg_trigger trigger
		 JOIN pg_class relation ON relation.oid = trigger.tgrelid
		 WHERE relation.relname IN ('envelope_field', 'field_value') AND NOT trigger.tgisinternal
		 ORDER BY trigger.tgname`
	);
	const foreignKeys: { definition: string }[] = await client.unsafe(
		`SELECT pg_get_constraintdef(constraint_row.oid) AS definition FROM pg_constraint constraint_row
		 JOIN pg_class relation ON relation.oid = constraint_row.conrelid
		 WHERE relation.relname IN ('envelope_field', 'field_value') AND constraint_row.contype = 'f'
		 ORDER BY constraint_row.conname`
	);
	return {
		indexes: indexes.map((row) => row.definition),
		triggers: triggers.map((row) => row.definition),
		foreignKeys: foreignKeys.map((row) => row.definition)
	};
}

async function withSchema<T>(prefix: string, run: (client: Client) => Promise<T>): Promise<T> {
	const schema: string = `${prefix}_${process.pid}_${randomUUID().replaceAll('-', '')}`;
	const client: Client = postgres(TEST_DATABASE_URL as string, {
		max: 1,
		onnotice: (): void => undefined,
		connection: { search_path: schema, TimeZone: 'UTC' }
	});
	try {
		await client.unsafe(`CREATE SCHEMA "${schema}"`);
		await client.unsafe(`SET search_path TO "${schema}"`);
		return await run(client);
	} finally {
		await client.unsafe('SET search_path TO public');
		await client.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
		await client.end({ timeout: 5 });
	}
}

postgresDescribe('PostgreSQL migration 0056 (signing date mode)', () => {
	let root: Client | null = null;
	beforeAll(() => {
		root = postgres(TEST_DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
	});
	afterAll(async () => {
		await root?.end({ timeout: 5 });
	});

	it('is the next forward-only migration and rebuilds nothing', () => {
		expect(MIGRATION_PATHS.indexOf(MIGRATION)).toBe(MIGRATION_PATHS.indexOf(PRIOR_MIGRATION) + 1);
		const sql: string = readFileSync(MIGRATION, 'utf8');
		expect(sql).not.toMatch(/DROP\s+TABLE|RENAME\s+TO|CREATE\s+TABLE/i);
	});

	it('upgrades existing data without touching FKs or indexes and adds only the guards', async () => {
		await withSchema('signkit_sdm_up', async (client) => {
			await applyMigrations(client, PRIOR_MIGRATION);
			await seed(client, true);
			const before = await catalog(client);
			await client.unsafe(readFileSync(MIGRATION, 'utf8'));
			const after = await catalog(client);
			expect(after.indexes).toEqual(before.indexes);
			expect(after.foreignKeys).toEqual(before.foreignKeys);
			for (const trigger of before.triggers) expect(after.triggers).toContain(trigger);
			expect(after.triggers.length - before.triggers.length).toBe(2);
			const rows = await client.unsafe(
				'SELECT id, date_mode, date_time_zone FROM envelope_field ORDER BY id'
			);
			expect(rows.map((row) => [row.date_mode, row.date_time_zone])).toEqual([
				[null, null],
				[null, null]
			]);
			const values = await client.unsafe('SELECT count(*)::int AS n FROM field_value');
			expect(values[0].n).toBe(1);
		});
	});

	it('enforces the shape check, immutability and the automatic-date value guard', async () => {
		await withSchema('signkit_sdm_fresh', async (client) => {
			await applyMigrations(client);
			await seed(client, false);
			let sequence: number = 100;
			const insertField = (type: string, mode: string | null, zone: string | null): string => {
				sequence += 1;
				const id: string = `01900000-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
				return `INSERT INTO envelope_field (
					id, envelope_id, recipient_id, document_id, field_type, label, required, position,
					created_at, updated_at, date_mode, date_time_zone
				) VALUES ('${id}', '${ENVELOPE_ID}', '${RECIPIENT_ID}', '${DOCUMENT_ID}', '${type}', 'L',
					true, ${sequence}, '${AT}', '${AT}',
					${mode === null ? 'NULL' : `'${mode}'`}, ${zone === null ? 'NULL' : `'${zone}'`})`;
			};
			await client.unsafe(insertField('date', null, null));
			await client.unsafe(insertField('text', null, null));
			await client.unsafe(insertField('date', 'signed_at', 'Asia/Tokyo'));
			for (const [type, mode, zone] of [
				['date', 'signed_at', null],
				['date', null, 'Asia/Tokyo'],
				['text', 'signed_at', 'Asia/Tokyo'],
				['date', 'manual', 'Asia/Tokyo'],
				['date', 'signed_at', ''],
				['date', 'signed_at', 'Z'.repeat(65)]
			] as const) {
				await expect(client.unsafe(insertField(type, mode, zone))).rejects.toThrow(
					/envelope_field_date_mode_shape/
				);
			}
			await expect(
				client.unsafe(
					"UPDATE envelope_field SET date_time_zone = 'UTC' WHERE date_mode IS NOT NULL"
				)
			).rejects.toThrow(/immutable/);
			await client.unsafe("UPDATE envelope_field SET label = 'Renamed'");

			await client.unsafe(
				`INSERT INTO envelope_field (
					id, envelope_id, recipient_id, document_id, field_type, label, required, position,
					created_at, updated_at, date_mode, date_time_zone
				) VALUES ('${AUTO_FIELD_ID}', '${ENVELOPE_ID}', '${RECIPIENT_ID}', '${DOCUMENT_ID}', 'date',
					'Signed on', true, 900, '${AT}', '${AT}', 'signed_at', 'Asia/Tokyo')`
			);
			const insertValue = (value: string): string =>
				`INSERT INTO field_value (field_id, envelope_id, recipient_id, field_type, value_json,
					value_sha256, created_at)
				 VALUES ('${AUTO_FIELD_ID}', '${ENVELOPE_ID}', '${RECIPIENT_ID}', 'date', '${value}',
					'${'e'.repeat(64)}', '2026-03-31T15:30:00.000Z')`;
			for (const invalid of ['""', '"free text"', '"2026-02-30"', '"2026-04-04"', '"2026-03-29"']) {
				await expect(client.unsafe(insertValue(invalid))).rejects.toThrow(
					/automatic date value invalid/
				);
			}
			await client.unsafe(insertValue('"2026-04-01"'));
		});
	});

	it('round-trips automatic options through the field and recipient stores', async () => {
		await withSchema('signkit_sdm_rt', async (client) => {
			await applyMigrations(client);
			await seed(client, false);
			await client.unsafe(
				`INSERT INTO envelope_field (
					id, envelope_id, recipient_id, document_id, field_type, label, required, position,
					created_at, updated_at, date_mode, date_time_zone
				) VALUES
					('${TEXT_FIELD_ID}', '${ENVELOPE_ID}', '${RECIPIENT_ID}', '${DOCUMENT_ID}', 'text',
						'Name', true, 0, '${AT}', '${AT}', NULL, NULL),
					('${AUTO_FIELD_ID}', '${ENVELOPE_ID}', '${RECIPIENT_ID}', '${DOCUMENT_ID}', 'date',
						'Signed on', true, 1, '${AT}', '${AT}', 'signed_at', 'Asia/Tokyo')`
			);
			const authoring = await new PostgresEnvelopeFieldStore(client).readAuthoringFields(
				ENVELOPE_ID
			);
			expect(Object.keys(authoring!.fields[0])).not.toContain('dateMode');
			expect(authoring!.fields[1]).toMatchObject({
				dateMode: 'signed_at',
				dateTimeZone: 'Asia/Tokyo'
			});
			const own = await new PostgresRecipientFieldDeclarationStore(client).listOwnFields(
				ENVELOPE_ID,
				RECIPIENT_ID
			);
			expect(Object.keys(own!.fields[0])).not.toContain('dateTimeZone');
			expect(own!.fields[1]).toMatchObject({ dateMode: 'signed_at', dateTimeZone: 'Asia/Tokyo' });
		});
	});
});
