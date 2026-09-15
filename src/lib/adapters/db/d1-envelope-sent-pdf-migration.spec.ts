import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1EnvelopeSentPdfStore } from './d1-envelope-sent-pdf-store';
import { D1EnvelopeSentDocumentStore } from './d1-envelope-sent-document-store';
import {
	applyD1MigrationInTransaction,
	applyD1Migrations,
	applyD1MigrationsThrough,
	d1MigrationPaths,
	sqliteD1Database
} from './sqlite-d1-test-support';

const ORGANIZATION_ID: string = 'org-1';
const ENVELOPE_ID: string = '01920000-0000-7000-8000-000000000001';
const RECIPIENT_ID: string = '01930000-0000-7000-8000-000000000001';
const READY_AUDIT_ID: string = '01960000-0000-7000-8000-0000000000a0';
const SENT_AUDIT_ID: string = '01960000-0000-7000-8000-0000000000a1';
const COMMIT_SHA: string = 'commit-1';
const SENT_PDF_SHA256: string = 'f'.repeat(64);
const SENT_PDF_KEY: string = `sent-documents/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/sha256/${SENT_PDF_SHA256}.pdf`;
const DOCUMENT_ID: string = '01900000-0000-7000-8000-000000000010';
const DOCUMENT_PAGES: string =
	'[{"path":"documents/agreement.md","title":"agreement","firstPage":1,"lastPage":2}]';

function seedReady(sqlite: DatabaseSync): void {
	sqlite.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${ORGANIZATION_ID}','${ORGANIZATION_ID}','Workspace','2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			field_generation, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}','${ORGANIZATION_ID}','Agreement','draft',1,'${COMMIT_SHA}',0,
			'2026-09-11T00:00:00.000Z','2026-09-11T00:00:30.000Z'
		);
		INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES
			('01960000-0000-7000-8000-00000000009e','${ORGANIZATION_ID}','${ENVELOPE_ID}',1,'envelope.created','user','user-1','{}',NULL,'hash-1','2026-09-11T00:00:00.000Z'),
			('01960000-0000-7000-8000-00000000009f','${ORGANIZATION_ID}','${ENVELOPE_ID}',2,'draft.revision_created','user','user-1','{}','hash-1','hash-2','2026-09-11T00:00:30.000Z');
		INSERT INTO envelope_ready_command (
			organization_id,envelope_id,actor_type,actor_id,idempotency_key,request_hash,
			expected_generation,commit_sha,recipients_json,recipient_count,updated_at,
			audit_event_id,audit_sequence,previous_audit_hash,audit_event_hash,audit_payload_json
		) VALUES (
			'${ORGANIZATION_ID}','${ENVELOPE_ID}','user','user-1','ready-1','ready-request-hash',1,'${COMMIT_SHA}','[]',1,
			'2026-09-11T00:01:00.000Z','${READY_AUDIT_ID}',3,'hash-2','hash-3','{}'
		);
	`);
	sqlite.exec(`
		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES (
			'${RECIPIENT_ID}','${ORGANIZATION_ID}','${ENVELOPE_ID}','a@example.com','A','signer','en',1,'pending',
			'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'
		);
	`);
}

function insertCommand(
	sqlite: DatabaseSync,
	overrides: { documentCount?: number | null; auditSequence?: number; idempotencyKey?: string } = {}
): void {
	const documentCount: number | null =
		overrides.documentCount === undefined ? 1 : overrides.documentCount;
	const auditSequence: number = overrides.auditSequence ?? 4;
	const idempotencyKey: string = overrides.idempotencyKey ?? 'send-1';
	sqlite.exec(`INSERT INTO envelope_send_command (
		organization_id,envelope_id,actor_type,actor_id,idempotency_key,request_hash,
		expected_generation,ready_audit_event_id,commit_sha,initial_routing_order,
		delivery_count,queued_delivery_count,delivery_manifest_hash,delivery_manifest_json,
		initial_capability_expires_at,updated_at,audit_event_id,audit_sequence,
		previous_audit_hash,audit_event_hash,audit_payload_json,
		document_set_hash, document_count, sent_documents_json
	) VALUES ('${ORGANIZATION_ID}','${ENVELOPE_ID}','user','user-1','${idempotencyKey}','request-hash',1,'${READY_AUDIT_ID}','${COMMIT_SHA}',1,
		1,1,'manifest-hash','[]','2026-09-25T00:02:00.000Z','2026-09-11T00:02:00.000Z',
		'${SENT_AUDIT_ID}',${auditSequence},'hash-3','hash-5','{}',
		${documentCount === null ? 'NULL' : `'${SENT_PDF_SHA256}'`},
		${documentCount === null ? 'NULL' : String(documentCount)},
		${documentCount === null ? 'NULL' : `'[{"id":"${DOCUMENT_ID}","sha256":"${SENT_PDF_SHA256}","byteSize":4096,"pageCount":1}]'`})`);
}

type LegacyCommandOverrides = {
	idempotencyKey?: string;
	auditSequence?: number;
	sentPdfObjectKey?: string | null;
	sentPdfSha256?: string | null;
	sentPdfBytes?: number | null;
	sentPdfPageCount?: number | null;
	sentPdfPageWidth?: number | null;
	sentPdfPageHeight?: number | null;
	sentPdfDocumentPagesJson?: string | null;
	documentSetHash?: string | null;
	documentCount?: number | null;
	sentDocumentsJson?: string | null;
};

function insertLegacyCommand(sqlite: DatabaseSync, overrides: LegacyCommandOverrides = {}): void {
	const idempotencyKey: string = overrides.idempotencyKey ?? 'legacy-send';
	const auditSequence: number = overrides.auditSequence ?? 4;
	const sqlValue = (value: string | number | null): string =>
		value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value}'`;
	sqlite.exec(`INSERT INTO envelope_send_command (
		organization_id,envelope_id,actor_type,actor_id,idempotency_key,request_hash,
		expected_generation,ready_audit_event_id,commit_sha,initial_routing_order,
		delivery_count,queued_delivery_count,delivery_manifest_hash,delivery_manifest_json,
		initial_capability_expires_at,updated_at,audit_event_id,audit_sequence,
		previous_audit_hash,audit_event_hash,audit_payload_json,
		sent_pdf_object_key, sent_pdf_sha256, sent_pdf_bytes, sent_pdf_page_count,
		sent_pdf_page_width, sent_pdf_page_height, sent_pdf_document_pages_json,
		document_set_hash, document_count, sent_documents_json
	) VALUES ('${ORGANIZATION_ID}','${ENVELOPE_ID}','user','user-1','${idempotencyKey}','request-hash',1,'${READY_AUDIT_ID}','${COMMIT_SHA}',1,
		1,1,'manifest-hash','[]','2026-09-25T00:02:00.000Z','2026-09-11T00:02:00.000Z',
		'${SENT_AUDIT_ID}',${auditSequence},'hash-3','hash-5','{}',
		${sqlValue(overrides.sentPdfObjectKey === undefined ? SENT_PDF_KEY : overrides.sentPdfObjectKey)},
		${sqlValue(overrides.sentPdfSha256 === undefined ? SENT_PDF_SHA256 : overrides.sentPdfSha256)},
		${sqlValue(overrides.sentPdfBytes === undefined ? 4096 : overrides.sentPdfBytes)},
		${sqlValue(overrides.sentPdfPageCount === undefined ? 2 : overrides.sentPdfPageCount)},
		${sqlValue(overrides.sentPdfPageWidth === undefined ? 595.28 : overrides.sentPdfPageWidth)},
		${sqlValue(overrides.sentPdfPageHeight === undefined ? 841.89 : overrides.sentPdfPageHeight)},
		${sqlValue(overrides.sentPdfDocumentPagesJson === undefined ? DOCUMENT_PAGES : overrides.sentPdfDocumentPagesJson)},
		${sqlValue(overrides.documentSetHash === undefined ? null : overrides.documentSetHash)},
		${sqlValue(overrides.documentCount === undefined ? null : overrides.documentCount)},
		${sqlValue(overrides.sentDocumentsJson === undefined ? null : overrides.sentDocumentsJson)})`);
}

function reserveDelivery(sqlite: DatabaseSync): void {
	sqlite.exec(`
		UPDATE recipient SET capability_hash='cap-hash', capability_expires_at='2026-09-25T00:02:00.000Z',
			updated_at='2026-09-11T00:02:00.000Z'
		WHERE organization_id='${ORGANIZATION_ID}' AND id='${RECIPIENT_ID}';
		INSERT INTO delivery_outbox (
			id,organization_id,envelope_id,recipient_id,kind,status,capability_hash,reserved_capability_expires_at,
			sealed_capability,sealing_key_id,sealed_capability_sha256,available_at,attempts,created_at,updated_at
		) VALUES (
			'01940000-0000-7000-8000-000000000001','${ORGANIZATION_ID}','${ENVELOPE_ID}','${RECIPIENT_ID}','recipient_invitation','pending','cap-hash',
			'2026-09-25T00:02:00.000Z','sealed','key-1','sealed-hash','2026-09-11T00:02:00.000Z',0,'2026-09-11T00:02:00.000Z','2026-09-11T00:02:00.000Z'
		);
	`);
}

function publish(sqlite: DatabaseSync, idempotencyKey: string = 'send-1'): void {
	sqlite.exec(`INSERT INTO envelope_send_publish (organization_id, actor_type, actor_id, idempotency_key)
		VALUES ('${ORGANIZATION_ID}','user','user-1','${idempotencyKey}')`);
}

function insertSentDocument(sqlite: DatabaseSync): void {
	sqlite.exec(`INSERT INTO envelope_sent_document (
		organization_id, envelope_id, commit_sha, document_id, position, kind, title,
		object_key, sha256, byte_size, page_count, page_width, page_height, created_at
	) VALUES (
		'${ORGANIZATION_ID}','${ENVELOPE_ID}','${COMMIT_SHA}','${DOCUMENT_ID}',0,'markdown','agreement',
		'${SENT_PDF_KEY}','${SENT_PDF_SHA256}',4096,1,595.28,841.89,'2026-09-11T00:02:00.000Z'
	)`);
}

describe('D1 envelope sent document set (0045) and frozen envelope_sent_pdf', () => {
	it('still reads a frozen legacy pointer after the multi-document send tables exist', async () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedReady(sqlite);
			sqlite.exec(`
				UPDATE envelope SET status='sent', sent_commit_sha='${COMMIT_SHA}',
					updated_at='2026-09-11T00:02:00.000Z'
				WHERE id='${ENVELOPE_ID}';
				INSERT INTO envelope_sent_pdf (
					organization_id,envelope_id,commit_sha,object_key,sha256,byte_size,
					page_count,page_width,page_height,document_pages_json,created_at
				) VALUES ('${ORGANIZATION_ID}','${ENVELOPE_ID}','${COMMIT_SHA}','${SENT_PDF_KEY}','${SENT_PDF_SHA256}',
					4096,2,595.28,841.89,'${DOCUMENT_PAGES}','2026-09-11T00:02:00.000Z');
			`);

			const store: D1EnvelopeSentPdfStore = new D1EnvelopeSentPdfStore(sqliteD1Database(sqlite));
			await expect(
				store.findSentPdf(ORGANIZATION_ID, ENVELOPE_ID, COMMIT_SHA)
			).resolves.toMatchObject({
				objectKey: SENT_PDF_KEY,
				sha256: SENT_PDF_SHA256,
				byteSize: 4096,
				pageCount: 2,
				documents: [
					{ path: 'documents/agreement.md', title: 'agreement', firstPage: 1, lastPage: 2 }
				]
			});
			await expect(
				store.findSentPdf(ORGANIZATION_ID, ENVELOPE_ID, 'other-commit')
			).resolves.toBeNull();
		} finally {
			sqlite.close();
		}
	});

	it('rejects a stored digest that is not a SHA-256 hex string', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedReady(sqlite);
			expect((): void => {
				sqlite.exec(`INSERT INTO envelope_sent_pdf (
					organization_id,envelope_id,commit_sha,object_key,sha256,byte_size,
					page_count,page_width,page_height,document_pages_json,created_at
				) VALUES ('${ORGANIZATION_ID}','${ENVELOPE_ID}','${COMMIT_SHA}','${SENT_PDF_KEY}','not-a-digest',
					4096,2,595.28,841.89,'${DOCUMENT_PAGES}','2026-09-11T00:02:00.000Z')`);
			}).toThrow(/envelope_sent_pdf_sha256_hex/);
		} finally {
			sqlite.close();
		}
	});

	it('rejects a zero-page or oversized rendering', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedReady(sqlite);
			for (const [pageCount, byteSize] of [
				[0, 4096],
				[401, 4096],
				[2, 0],
				[2, 25_165_825]
			] as const) {
				expect((): void => {
					sqlite.exec(`INSERT INTO envelope_sent_pdf (
						organization_id,envelope_id,commit_sha,object_key,sha256,byte_size,
						page_count,page_width,page_height,document_pages_json,created_at
					) VALUES ('${ORGANIZATION_ID}','${ENVELOPE_ID}','${COMMIT_SHA}','${SENT_PDF_KEY}','${SENT_PDF_SHA256}',
						${byteSize},${pageCount},595.28,841.89,'${DOCUMENT_PAGES}','2026-09-11T00:02:00.000Z')`);
				}).toThrow(/CHECK constraint failed/);
			}
		} finally {
			sqlite.close();
		}
	});

	it('creates both sent tables and refuses a publish whose document count does not match', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedReady(sqlite);
			const tables = sqlite
				.prepare(
					`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('envelope_sent_document','envelope_sent_document_set') ORDER BY name`
				)
				.all() as { name: string }[];
			expect(tables.map((row) => row.name)).toEqual([
				'envelope_sent_document',
				'envelope_sent_document_set'
			]);
			sqlite.exec('BEGIN');
			insertCommand(sqlite, { documentCount: 2 });
			insertSentDocument(sqlite);
			reserveDelivery(sqlite);
			expect((): void => publish(sqlite)).toThrow(/envelope send document set missing/);
			sqlite.exec('ROLLBACK');
			expect(
				(
					sqlite.prepare('SELECT COUNT(*) AS count FROM envelope_sent_document_set').get() as {
						count: number;
					}
				).count
			).toBe(0);
			expect(
				(
					sqlite.prepare(`SELECT status FROM envelope WHERE id='${ENVELOPE_ID}'`).get() as {
						status: string;
					}
				).status
			).toBe('ready');
		} finally {
			sqlite.close();
		}
	});

	it('publishes the set marker when the pre-inserted document count matches', async () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedReady(sqlite);
			sqlite.exec('BEGIN');
			insertCommand(sqlite);
			insertSentDocument(sqlite);
			reserveDelivery(sqlite);
			publish(sqlite);
			sqlite.exec('COMMIT');
			const store: D1EnvelopeSentDocumentStore = new D1EnvelopeSentDocumentStore(
				sqliteD1Database(sqlite)
			);
			await expect(store.findSet(ORGANIZATION_ID, ENVELOPE_ID, COMMIT_SHA)).resolves.toMatchObject({
				documentSetHash: SENT_PDF_SHA256,
				documentCount: 1,
				documents: [{ documentId: DOCUMENT_ID, position: 0, kind: 'markdown' }]
			});
		} finally {
			sqlite.close();
		}
	});

	it('enforces document_id XOR document_path on envelope_field', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedReady(sqlite);
			const fieldSql = (
				documentId: string,
				documentPath: string
			): string => `INSERT INTO envelope_field (
				id, organization_id, envelope_id, recipient_id, document_id, document_path,
				field_type, label, required, position, created_at, updated_at
			) VALUES (
				'01950000-0000-7000-8000-000000000001','${ORGANIZATION_ID}','${ENVELOPE_ID}','${RECIPIENT_ID}',
				${documentId}, ${documentPath}, 'signature', 'Signature', 1, 1,
				'2026-09-11T00:02:00.000Z','2026-09-11T00:02:00.000Z'
			)`;
			expect((): void => sqlite.exec(fieldSql('NULL', 'NULL'))).toThrow(
				/envelope_field_document_scope/
			);
			expect((): void =>
				sqlite.exec(fieldSql(`'${DOCUMENT_ID}'`, `'documents/agreement.md'`))
			).toThrow(/envelope_field_document_scope/);
			sqlite.exec(fieldSql(`'${DOCUMENT_ID}'`, 'NULL'));
		} finally {
			sqlite.close();
		}
	});

	it('rejects out-of-range sent-document rows and document_count', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedReady(sqlite);
			expect((): void => {
				sqlite.exec(`INSERT INTO envelope_sent_document (
					organization_id, envelope_id, commit_sha, document_id, position, kind, title,
					object_key, sha256, byte_size, page_count, page_width, page_height, created_at
				) VALUES (
					'${ORGANIZATION_ID}','${ENVELOPE_ID}','${COMMIT_SHA}','${DOCUMENT_ID}',20,'markdown','agreement',
					'${SENT_PDF_KEY}','${SENT_PDF_SHA256}',4096,1,595.28,841.89,'2026-09-11T00:02:00.000Z'
				)`);
			}).toThrow(/CHECK constraint failed/);
			expect((): void => {
				sqlite.exec(`INSERT INTO envelope_sent_document_set (
					organization_id, envelope_id, commit_sha, document_set_hash, document_count, created_at
				) VALUES (
					'${ORGANIZATION_ID}','${ENVELOPE_ID}','${COMMIT_SHA}','${SENT_PDF_SHA256}',0,'2026-09-11T00:02:00.000Z'
				)`);
			}).toThrow(/CHECK constraint failed/);
		} finally {
			sqlite.close();
		}
	});

	it('keeps sent_pdf_* command columns so a pre-migration receipt can still replay', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1MigrationsThrough(sqlite, 'migrations/d1/0043_envelope_sent_pdf.sql');
			seedReady(sqlite);
			sqlite.exec(`INSERT INTO envelope_send_command (
				organization_id,envelope_id,actor_type,actor_id,idempotency_key,request_hash,
				expected_generation,ready_audit_event_id,commit_sha,initial_routing_order,
				delivery_count,queued_delivery_count,delivery_manifest_hash,delivery_manifest_json,
				initial_capability_expires_at,updated_at,audit_event_id,audit_sequence,
				previous_audit_hash,audit_event_hash,audit_payload_json,
				sent_pdf_object_key, sent_pdf_sha256, sent_pdf_bytes, sent_pdf_page_count,
				sent_pdf_page_width, sent_pdf_page_height, sent_pdf_document_pages_json
			) VALUES ('${ORGANIZATION_ID}','${ENVELOPE_ID}','user','user-1','legacy-send','request-hash',1,'${READY_AUDIT_ID}','${COMMIT_SHA}',1,
				1,1,'manifest-hash','[]','2026-09-25T00:02:00.000Z','2026-09-11T00:02:00.000Z',
				'${SENT_AUDIT_ID}',4,'hash-3','hash-5','{}',
				'${SENT_PDF_KEY}','${SENT_PDF_SHA256}',4096,2,595.28,841.89,'${DOCUMENT_PAGES}')`);
			for (const path of d1MigrationPaths()) {
				if (path <= 'migrations/d1/0043_envelope_sent_pdf.sql') continue;
				sqlite.exec(readFileSync(path, 'utf8'));
			}
			const row = sqlite
				.prepare(
					`SELECT sent_pdf_sha256, sent_pdf_bytes, document_set_hash, sent_documents_json
					 FROM envelope_send_command WHERE idempotency_key='legacy-send'`
				)
				.get() as {
				sent_pdf_sha256: string;
				sent_pdf_bytes: number;
				document_set_hash: string | null;
				sent_documents_json: string | null;
			};
			expect(row).toEqual({
				sent_pdf_sha256: SENT_PDF_SHA256,
				sent_pdf_bytes: 4096,
				document_set_hash: null,
				sent_documents_json: null
			});
		} finally {
			sqlite.close();
		}
	});

	it('rebuilds field_value alongside envelope_field through 0045 with all rows preserved and a clean foreign_key_check', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1MigrationsThrough(sqlite, 'migrations/d1/0044_envelope_uploaded_document.sql');
			seedReady(sqlite);
			const FIELD_ID: string = '01950000-0000-7000-8000-000000000099';
			sqlite.exec(`INSERT INTO envelope_field (
				id, organization_id, envelope_id, recipient_id, document_path,
				field_type, label, required, position, created_at, updated_at
			) VALUES (
				'${FIELD_ID}','${ORGANIZATION_ID}','${ENVELOPE_ID}','${RECIPIENT_ID}','documents/agreement.md',
				'signature','Signature',1,1,'2026-09-11T00:02:00.000Z','2026-09-11T00:02:00.000Z'
			)`);
			sqlite.exec(`INSERT INTO field_value (
				organization_id, field_id, envelope_id, recipient_id, field_type, value_json, value_sha256, created_at
			) VALUES (
				'${ORGANIZATION_ID}','${FIELD_ID}','${ENVELOPE_ID}','${RECIPIENT_ID}','signature','{"signed":true}',
				'${'a'.repeat(64)}','2026-09-11T00:02:05.000Z'
			)`);

			// Mimics Cloudflare D1: the whole migration file runs inside one transaction.
			applyD1MigrationInTransaction(sqlite, 'migrations/d1/0045_envelope_sent_document_set.sql');

			expect(
				sqlite
					.prepare(`SELECT id, document_id, document_path FROM envelope_field WHERE id = ?`)
					.get(FIELD_ID)
			).toEqual({ id: FIELD_ID, document_id: null, document_path: 'documents/agreement.md' });
			expect(
				sqlite
					.prepare(`SELECT field_id, value_json FROM field_value WHERE field_id = ?`)
					.get(FIELD_ID)
			).toEqual({ field_id: FIELD_ID, value_json: '{"signed":true}' });
			expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
		} finally {
			sqlite.close();
		}
	});

	it('publishes a legacy-only send (sent_pdf_* complete, document-set columns null) under the post-0045 trigger', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedReady(sqlite);
			sqlite.exec('BEGIN');
			insertLegacyCommand(sqlite, { idempotencyKey: 'legacy-send' });
			reserveDelivery(sqlite);
			publish(sqlite, 'legacy-send');
			sqlite.exec('COMMIT');
			expect(
				sqlite
					.prepare(`SELECT status, sent_commit_sha FROM envelope WHERE id='${ENVELOPE_ID}'`)
					.get()
			).toEqual({ status: 'sent', sent_commit_sha: COMMIT_SHA });
			expect(
				(
					sqlite.prepare('SELECT COUNT(*) AS count FROM envelope_sent_document_set').get() as {
						count: number;
					}
				).count
			).toBe(0);
		} finally {
			sqlite.close();
		}
	});

	it('rejects a partial legacy or mixed legacy/document-set receipt on publish', () => {
		const cases: { label: string; overrides: LegacyCommandOverrides }[] = [
			{
				label: 'partial legacy (missing sent_pdf_sha256)',
				overrides: { idempotencyKey: 'partial-legacy', sentPdfSha256: null }
			},
			{
				label: 'mixed (complete legacy and complete document-set)',
				overrides: {
					idempotencyKey: 'mixed-shapes',
					documentSetHash: SENT_PDF_SHA256,
					documentCount: 1,
					sentDocumentsJson: `[{"id":"${DOCUMENT_ID}","sha256":"${SENT_PDF_SHA256}","byteSize":4096,"pageCount":1}]`
				}
			}
		];
		for (const { overrides } of cases) {
			const sqlite: DatabaseSync = new DatabaseSync(':memory:');
			try {
				applyD1Migrations(sqlite);
				seedReady(sqlite);
				sqlite.exec('BEGIN');
				insertLegacyCommand(sqlite, overrides);
				reserveDelivery(sqlite);
				expect((): void => publish(sqlite, overrides.idempotencyKey)).toThrow(
					/envelope send document set missing/
				);
				sqlite.exec('ROLLBACK');
			} finally {
				sqlite.close();
			}
		}
	});
});
