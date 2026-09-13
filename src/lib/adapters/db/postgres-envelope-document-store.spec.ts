import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnvelopeDocument } from '$lib/domain/envelope';
import { PostgresEnvelopeDocumentStore } from './postgres-envelope-document-store';

const TEST_DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const postgresDescribe = TEST_DATABASE_URL === undefined ? describe.skip : describe;
const ORGANIZATION_ID: string = 'org-1';
const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const MIGRATION_PATHS: readonly string[] = readdirSync('migrations/postgres')
	.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
	.sort()
	.map((name: string): string => `migrations/postgres/${name}`);

let sql: ReturnType<typeof postgres> | null = null;
const schemaName: string = `signkit_doc_${process.pid}_${randomUUID().replaceAll('-', '')}`;

postgresDescribe('PostgresEnvelopeDocumentStore', () => {
	beforeAll(async () => {
		sql = postgres(TEST_DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
		await sql.unsafe(`SET search_path TO "${schemaName}"`);
		for (const path of MIGRATION_PATHS) await sql.unsafe(readFileSync(path, 'utf8'));
		await sql`INSERT INTO organization (id, d6e_organization_id, name, created_at)
			VALUES (${ORGANIZATION_ID}, ${ORGANIZATION_ID}, 'Workspace', now())`;
		await sql`INSERT INTO envelope (id, organization_id, title, status, created_at, updated_at)
			VALUES (${ENVELOPE_ID}, ${ORGANIZATION_ID}, 'Agreement', 'draft', now(), now())`;
	});

	afterAll(async () => {
		if (sql === null) return;
		await sql.unsafe('SET search_path TO public');
		await sql.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
		await sql.end({ timeout: 5 });
		sql = null;
	});

	it('derives titles, preserves stable ids across reordering, and drops removed paths', async () => {
		const store = new PostgresEnvelopeDocumentStore(sql as ReturnType<typeof postgres>);
		const first = await store.sync(ORGANIZATION_ID, ENVELOPE_ID, [
			{ markdownPath: 'documents/agreement.md' },
			{ markdownPath: 'documents/appendix.md' }
		]);
		expect(first.map((document) => document.title)).toEqual(['Agreement', 'Appendix']);
		const agreementId: string = first[0].id;

		const renamed: EnvelopeDocument | null = await store.renameDocument(
			ORGANIZATION_ID,
			ENVELOPE_ID,
			'documents/agreement.md',
			'Master Services Agreement'
		);
		expect(renamed?.title).toBe('Master Services Agreement');

		const second = await store.sync(ORGANIZATION_ID, ENVELOPE_ID, [
			{ markdownPath: 'documents/appendix.md' },
			{ markdownPath: 'documents/agreement.md' }
		]);
		const agreement = second.find(
			(document: EnvelopeDocument): boolean => document.markdownPath === 'documents/agreement.md'
		);
		expect(agreement?.id).toBe(agreementId);
		expect(agreement?.title).toBe('Master Services Agreement');
		expect(agreement?.position).toBe(1);

		const third = await store.sync(ORGANIZATION_ID, ENVELOPE_ID, [
			{ markdownPath: 'documents/agreement.md' }
		]);
		expect(third).toHaveLength(1);
		expect(third[0].id).toBe(agreementId);

		const listed = await store.listForEnvelope(ORGANIZATION_ID, ENVELOPE_ID);
		expect(listed).toEqual(third);
	});

	it('returns null when renaming an untracked path', async () => {
		const store = new PostgresEnvelopeDocumentStore(sql as ReturnType<typeof postgres>);
		await expect(
			store.renameDocument(ORGANIZATION_ID, ENVELOPE_ID, 'documents/missing.md', 'Title')
		).resolves.toBeNull();
	});
});
