import {
	MAX_UPLOADED_DOCUMENTS_PER_ENVELOPE,
	type EnvelopeUploadedDocumentRecord,
	type EnvelopeUploadedDocumentStore,
	type InsertUploadedDocumentResult
} from '$lib/ports/envelope-uploaded-document-store';

export class D1EnvelopeUploadedDocumentStore implements EnvelopeUploadedDocumentStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async insert(record: EnvelopeUploadedDocumentRecord): Promise<InsertUploadedDocumentResult> {
		const result = await this.#database
			.prepare(
				`INSERT INTO envelope_uploaded_document (
					envelope_id, sha256, object_key, byte_size,
					page_count, page_width, page_height, created_at
				)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?
				WHERE (SELECT count(*) FROM envelope_uploaded_document
					WHERE envelope_id = ?) < ?
				  AND EXISTS (
					SELECT 1 FROM envelope WHERE id = ?
				  )
				ON CONFLICT (envelope_id, sha256) DO NOTHING`
			)
			.bind(
				record.envelopeId,
				record.sha256,
				record.objectKey,
				record.byteSize,
				record.pageCount,
				record.pageWidth,
				record.pageHeight,
				record.createdAt,
				record.envelopeId,
				MAX_UPLOADED_DOCUMENTS_PER_ENVELOPE,
				record.envelopeId
			)
			.run();
		if ((result.meta.changes ?? 0) === 1) return 'inserted';

		const existing = await this.#database
			.prepare(
				`SELECT sha256 FROM envelope_uploaded_document
				 WHERE envelope_id = ? AND sha256 = ?
				 LIMIT 1`
			)
			.bind(record.envelopeId, record.sha256)
			.first<{ sha256: string }>();
		if (existing !== null) return 'duplicate';

		const envelope = await this.#database
			.prepare(`SELECT id FROM envelope WHERE id = ? LIMIT 1`)
			.bind(record.envelopeId)
			.first<{ id: string }>();
		if (envelope === null) return 'not_found';
		return 'cap_exceeded';
	}

	async find(envelopeId: string, sha256: string): Promise<EnvelopeUploadedDocumentRecord | null> {
		const row = await this.#database
			.prepare(
				`SELECT envelope_id, sha256, object_key, byte_size,
					page_count, page_width, page_height, created_at
				 FROM envelope_uploaded_document
				 WHERE envelope_id = ? AND sha256 = ?
				 LIMIT 1`
			)
			.bind(envelopeId, sha256)
			.first<{
				envelope_id: string;
				sha256: string;
				object_key: string;
				byte_size: number;
				page_count: number;
				page_width: number;
				page_height: number;
				created_at: string;
			}>();
		if (row === null) return null;
		return {
			envelopeId: row.envelope_id,
			sha256: row.sha256,
			objectKey: row.object_key,
			byteSize: row.byte_size,
			pageCount: row.page_count,
			pageWidth: row.page_width,
			pageHeight: row.page_height,
			createdAt: row.created_at
		};
	}
}
