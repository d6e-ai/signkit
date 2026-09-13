import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { EnvelopeDocument } from '$lib/domain/envelope';
import { D1EnvelopeDocumentStore } from './d1-envelope-document-store';
import { sqliteD1Database } from './sqlite-d1-test-support';

const MIGRATIONS: readonly string[] = readdirSync('migrations/d1')
	.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
	.sort()
	.map((name: string): string => `migrations/d1/${name}`);
const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const ORG: string = 'org-1';

function database(): { sqlite: DatabaseSync; d1: D1Database } {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	for (const path of MIGRATIONS) sqlite.exec(readFileSync(path, 'utf8'));
	sqlite
		.prepare(
			`INSERT INTO organization (id, d6e_organization_id, name, created_at)
			 VALUES (?, ?, 'Workspace', '2026-09-12T00:00:00.000Z')`
		)
		.run(ORG, ORG);
	sqlite
		.prepare(
			`INSERT INTO envelope (id, organization_id, title, status, created_at, updated_at)
			 VALUES (?, ?, 'Agreement', 'draft', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z')`
		)
		.run(ENVELOPE_ID, ORG);
	return { sqlite, d1: sqliteD1Database(sqlite) };
}

describe('D1EnvelopeDocumentStore', () => {
	it('derives titles for newly observed paths and orders by input order', async () => {
		const { d1 } = database();
		const store = new D1EnvelopeDocumentStore(d1);
		const result = await store.sync(ORG, ENVELOPE_ID, [
			{ markdownPath: 'documents/cover-letter.md' },
			{ markdownPath: 'documents/agreement.md' }
		]);
		expect(result.map((document) => document.title)).toEqual(['Cover Letter', 'Agreement']);
		expect(result.map((document) => document.position)).toEqual([0, 1]);
		expect(result.every((document) => document.organizationId === ORG)).toBe(true);
	});

	it('preserves stable ids and titles across a re-sync that reorders and drops a path', async () => {
		const { d1 } = database();
		const store = new D1EnvelopeDocumentStore(d1);
		const first = await store.sync(ORG, ENVELOPE_ID, [
			{ markdownPath: 'documents/agreement.md' },
			{ markdownPath: 'documents/appendix.md' }
		]);
		const agreementId: string = first[0].id;

		await store.renameDocument(
			ORG,
			ENVELOPE_ID,
			'documents/agreement.md',
			'Master Services Agreement'
		);

		const second = await store.sync(ORG, ENVELOPE_ID, [
			{ markdownPath: 'documents/appendix.md' },
			{ markdownPath: 'documents/agreement.md' }
		]);
		expect(second.map((document: EnvelopeDocument) => document.markdownPath)).toEqual([
			'documents/appendix.md',
			'documents/agreement.md'
		]);
		const agreement: EnvelopeDocument | undefined = second.find(
			(document: EnvelopeDocument) => document.markdownPath === 'documents/agreement.md'
		);
		expect(agreement?.id).toBe(agreementId);
		expect(agreement?.title).toBe('Master Services Agreement');
		expect(agreement?.position).toBe(1);

		const third = await store.sync(ORG, ENVELOPE_ID, [{ markdownPath: 'documents/agreement.md' }]);
		expect(third).toHaveLength(1);
		expect(third[0].id).toBe(agreementId);

		const listed = await store.listForEnvelope(ORG, ENVELOPE_ID);
		expect(listed).toEqual(third);
	});

	it('renameDocument returns null for an untracked path', async () => {
		const { d1 } = database();
		const store = new D1EnvelopeDocumentStore(d1);
		const result = await store.renameDocument(ORG, ENVELOPE_ID, 'documents/missing.md', 'Title');
		expect(result).toBeNull();
	});
});
