import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1EnvelopeUploadedDocumentStore } from './d1-envelope-uploaded-document-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ORGANIZATION_ID: string = 'org-1';
const ENVELOPE_ID: string = '01920000-0000-7000-8000-000000000001';
const SHA256: string = 'f'.repeat(64);
const OBJECT_KEY: string = `uploaded-documents/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/sha256/${SHA256}.pdf`;

function seedEnvelope(sqlite: DatabaseSync): void {
	sqlite.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${ORGANIZATION_ID}','${ORGANIZATION_ID}','Workspace','2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			field_generation, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}','${ORGANIZATION_ID}','Agreement','draft',0,NULL,0,
			'2026-09-11T00:00:00.000Z','2026-09-11T00:00:00.000Z'
		);
	`);
}

function insertRow(
	sqlite: DatabaseSync,
	overrides: {
		sha256?: string;
		objectKey?: string;
		byteSize?: number;
		pageCount?: number;
		pageWidth?: number;
		pageHeight?: number;
	} = {}
): void {
	const sha256: string = overrides.sha256 ?? SHA256;
	const objectKey: string = overrides.objectKey ?? OBJECT_KEY;
	const byteSize: number = overrides.byteSize ?? 4096;
	const pageCount: number = overrides.pageCount ?? 2;
	const pageWidth: number = overrides.pageWidth ?? 595.28;
	const pageHeight: number = overrides.pageHeight ?? 841.89;
	sqlite.exec(`INSERT INTO envelope_uploaded_document (
		organization_id, envelope_id, sha256, object_key, byte_size,
		page_count, page_width, page_height, created_at
	) VALUES (
		'${ORGANIZATION_ID}','${ENVELOPE_ID}','${sha256}','${objectKey}',${byteSize},
		${pageCount},${pageWidth},${pageHeight},'2026-09-11T00:01:00.000Z'
	)`);
}

describe('D1 envelope_uploaded_document migration', () => {
	it('accepts a well-formed row and enforces the primary key', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedEnvelope(sqlite);
			insertRow(sqlite);
			const row = sqlite.prepare('SELECT * FROM envelope_uploaded_document').get() as Record<
				string,
				unknown
			>;
			expect(row).toMatchObject({
				organization_id: ORGANIZATION_ID,
				envelope_id: ENVELOPE_ID,
				sha256: SHA256,
				object_key: OBJECT_KEY,
				byte_size: 4096,
				page_count: 2
			});
			expect((): void => insertRow(sqlite)).toThrow(/UNIQUE constraint failed/);
		} finally {
			sqlite.close();
		}
	});

	it('rejects a foreign key to a missing envelope', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			sqlite.exec(`PRAGMA foreign_keys = ON`);
			sqlite.exec(`
				INSERT INTO organization (id, d6e_organization_id, name, created_at)
				VALUES ('${ORGANIZATION_ID}','${ORGANIZATION_ID}','Workspace','2026-09-11T00:00:00.000Z');
			`);
			expect((): void => insertRow(sqlite)).toThrow(/FOREIGN KEY constraint failed/);
		} finally {
			sqlite.close();
		}
	});

	it('rejects a stored digest that is not a SHA-256 hex string', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedEnvelope(sqlite);
			expect((): void => insertRow(sqlite, { sha256: 'not-a-digest' })).toThrow(
				/envelope_uploaded_document_sha256_hex/
			);
		} finally {
			sqlite.close();
		}
	});

	it('rejects out-of-range size, page count, and page dimensions', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedEnvelope(sqlite);
			for (const overrides of [
				{ byteSize: 0 },
				{ byteSize: 20_971_521 },
				{ pageCount: 0 },
				{ pageCount: 401 },
				{ pageWidth: 0 },
				{ pageWidth: 20_001 },
				{ pageHeight: 0 },
				{ pageHeight: 20_001 }
			]) {
				expect((): void => insertRow(sqlite, overrides)).toThrow(/CHECK constraint failed/);
			}
		} finally {
			sqlite.close();
		}
	});

	it('inserts through the store, enforces the per-envelope cap, and is idempotent on the digest', async () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedEnvelope(sqlite);
			const store: D1EnvelopeUploadedDocumentStore = new D1EnvelopeUploadedDocumentStore(
				sqliteD1Database(sqlite)
			);
			const record = (sha256: string) => ({
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				sha256,
				objectKey: `uploaded-documents/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/sha256/${sha256}.pdf`,
				byteSize: 4096,
				pageCount: 2,
				pageWidth: 595.28,
				pageHeight: 841.89,
				createdAt: '2026-09-11T00:01:00.000Z'
			});

			await expect(store.insert(record(SHA256))).resolves.toBe('inserted');
			await expect(store.insert(record(SHA256))).resolves.toBe('duplicate');

			for (let index = 1; index < 20; index += 1) {
				await expect(store.insert(record(index.toString(16).padStart(64, '0')))).resolves.toBe(
					'inserted'
				);
			}
			await expect(store.insert(record('e'.repeat(64)))).resolves.toBe('cap_exceeded');

			await expect(store.insert(record('c'.repeat(64)))).resolves.toBe('cap_exceeded');

			const missingEnvelope = record('d'.repeat(64));
			await expect(
				store.insert({ ...missingEnvelope, envelopeId: '01920000-0000-7000-8000-000000000099' })
			).resolves.toBe('not_found');
		} finally {
			sqlite.close();
		}
	});
});
