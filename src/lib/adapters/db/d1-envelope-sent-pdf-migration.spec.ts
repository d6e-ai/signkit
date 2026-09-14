import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1EnvelopeSentPdfStore } from './d1-envelope-sent-pdf-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ORGANIZATION_ID: string = 'org-1';
const ENVELOPE_ID: string = '01920000-0000-7000-8000-000000000001';
const RECIPIENT_ID: string = '01930000-0000-7000-8000-000000000001';
const READY_AUDIT_ID: string = '01960000-0000-7000-8000-0000000000a0';
const SENT_AUDIT_ID: string = '01960000-0000-7000-8000-0000000000a1';
const COMMIT_SHA: string = 'commit-1';
const SENT_PDF_SHA256: string = 'f'.repeat(64);
const SENT_PDF_KEY: string = `sent-documents/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/sha256/${SENT_PDF_SHA256}.pdf`;
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
	overrides: { pdfKey?: string | null; auditSequence?: number; idempotencyKey?: string } = {}
): void {
	const pdfKey: string | null = overrides.pdfKey === undefined ? SENT_PDF_KEY : overrides.pdfKey;
	const auditSequence: number = overrides.auditSequence ?? 4;
	const idempotencyKey: string = overrides.idempotencyKey ?? 'send-1';
	sqlite.exec(`INSERT INTO envelope_send_command (
		organization_id,envelope_id,actor_type,actor_id,idempotency_key,request_hash,
		expected_generation,ready_audit_event_id,commit_sha,initial_routing_order,
		delivery_count,queued_delivery_count,delivery_manifest_hash,delivery_manifest_json,
		initial_capability_expires_at,updated_at,audit_event_id,audit_sequence,
		previous_audit_hash,audit_event_hash,audit_payload_json,
		sent_pdf_object_key,sent_pdf_sha256,sent_pdf_bytes,sent_pdf_page_count,
		sent_pdf_page_width,sent_pdf_page_height,sent_pdf_document_pages_json
	) VALUES ('${ORGANIZATION_ID}','${ENVELOPE_ID}','user','user-1','${idempotencyKey}','request-hash',1,'${READY_AUDIT_ID}','${COMMIT_SHA}',1,
		1,1,'manifest-hash','[]','2026-09-25T00:02:00.000Z','2026-09-11T00:02:00.000Z',
		'${SENT_AUDIT_ID}',${auditSequence},'hash-3','hash-5','{}',
		${pdfKey === null ? 'NULL' : `'${pdfKey}'`},
		${pdfKey === null ? 'NULL' : `'${SENT_PDF_SHA256}'`},
		${pdfKey === null ? 'NULL' : '4096'},
		${pdfKey === null ? 'NULL' : '2'},
		${pdfKey === null ? 'NULL' : '595.28'},
		${pdfKey === null ? 'NULL' : '841.89'},
		${pdfKey === null ? 'NULL' : `'${DOCUMENT_PAGES}'`})`);
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

function counts(sqlite: DatabaseSync): {
	status: string;
	sent_commit_sha: string | null;
	sent_events: number;
	pdf_rows: number;
} {
	return sqlite
		.prepare(
			`SELECT envelope.status, envelope.sent_commit_sha,
				(SELECT COUNT(*) FROM audit_event WHERE event_type='envelope.sent') AS sent_events,
				(SELECT COUNT(*) FROM envelope_sent_pdf) AS pdf_rows
			 FROM envelope WHERE id='${ENVELOPE_ID}'`
		)
		.get() as {
		status: string;
		sent_commit_sha: string | null;
		sent_events: number;
		pdf_rows: number;
	};
}

describe('D1 envelope_sent_pdf publication', () => {
	it('publishes the pinned rendering atomically with the status flip and the audit event', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedReady(sqlite);
			sqlite.exec('BEGIN');
			insertCommand(sqlite);
			reserveDelivery(sqlite);
			publish(sqlite);
			sqlite.exec('COMMIT');

			expect(counts(sqlite)).toEqual({
				status: 'sent',
				sent_commit_sha: COMMIT_SHA,
				sent_events: 1,
				pdf_rows: 1
			});
			const row = sqlite.prepare('SELECT * FROM envelope_sent_pdf').get() as Record<
				string,
				unknown
			>;
			expect(row).toMatchObject({
				organization_id: ORGANIZATION_ID,
				envelope_id: ENVELOPE_ID,
				commit_sha: COMMIT_SHA,
				object_key: SENT_PDF_KEY,
				sha256: SENT_PDF_SHA256,
				byte_size: 4096,
				page_count: 2,
				document_pages_json: DOCUMENT_PAGES
			});
		} finally {
			sqlite.close();
		}
	});

	it('refuses to publish a send command that carries no pinned rendering', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedReady(sqlite);
			sqlite.exec('BEGIN');
			insertCommand(sqlite, { pdfKey: null });
			reserveDelivery(sqlite);
			expect((): void => publish(sqlite)).toThrow(/pdf pointer missing/);
			sqlite.exec('ROLLBACK');

			expect(counts(sqlite)).toEqual({
				status: 'ready',
				sent_commit_sha: null,
				sent_events: 0,
				pdf_rows: 0
			});
		} finally {
			sqlite.close();
		}
	});

	it('rolls the pointer back with everything else when the guard aborts on a stale audit head', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedReady(sqlite);
			sqlite.exec('BEGIN');
			// Sequence 9 does not chain from the current head, so the guard aborts.
			insertCommand(sqlite, { auditSequence: 9 });
			reserveDelivery(sqlite);
			expect((): void => publish(sqlite)).toThrow(/publish conflict/);
			sqlite.exec('ROLLBACK');

			expect(counts(sqlite)).toEqual({
				status: 'ready',
				sent_commit_sha: null,
				sent_events: 0,
				pdf_rows: 0
			});
		} finally {
			sqlite.close();
		}
	});

	it('reads a pointer only for the commit the envelope is actually sent at', async () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedReady(sqlite);
			sqlite.exec('BEGIN');
			insertCommand(sqlite);
			reserveDelivery(sqlite);
			publish(sqlite);
			sqlite.exec('COMMIT');

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
			// Another commit, another organization, another envelope: all invisible.
			await expect(
				store.findSentPdf(ORGANIZATION_ID, ENVELOPE_ID, 'other-commit')
			).resolves.toBeNull();
			await expect(store.findSentPdf('org-2', ENVELOPE_ID, COMMIT_SHA)).resolves.toBeNull();
			await expect(store.findSentPdf(ORGANIZATION_ID, 'env-2', COMMIT_SHA)).resolves.toBeNull();
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
});
