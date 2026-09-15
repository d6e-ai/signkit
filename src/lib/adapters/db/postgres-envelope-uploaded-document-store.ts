import type postgres from 'postgres';
import {
	MAX_UPLOADED_DOCUMENTS_PER_ENVELOPE,
	type EnvelopeUploadedDocumentRecord,
	type EnvelopeUploadedDocumentStore,
	type InsertUploadedDocumentResult
} from '$lib/ports/envelope-uploaded-document-store';

type Sql = ReturnType<typeof postgres>;

export class PostgresEnvelopeUploadedDocumentStore implements EnvelopeUploadedDocumentStore {
	readonly #sql: Sql;

	constructor(sql: Sql) {
		this.#sql = sql;
	}

	async insert(record: EnvelopeUploadedDocumentRecord): Promise<InsertUploadedDocumentResult> {
		return await this.#sql.begin(async (sql): Promise<InsertUploadedDocumentResult> => {
			const envelopes = await sql<{ id: string }[]>`
				SELECT id FROM envelope
				WHERE organization_id = ${record.organizationId} AND id = ${record.envelopeId}
				FOR UPDATE
			`;
			if (envelopes.length === 0) return 'not_found';

			const inserted = await sql<{ sha256: string }[]>`
				INSERT INTO envelope_uploaded_document (
					organization_id, envelope_id, sha256, object_key, byte_size,
					page_count, page_width, page_height, created_at
				)
				SELECT
					${record.organizationId}, ${record.envelopeId}, ${record.sha256},
					${record.objectKey}, ${record.byteSize}, ${record.pageCount},
					${record.pageWidth}, ${record.pageHeight}, ${record.createdAt}::timestamptz
				WHERE (
					SELECT count(*) FROM envelope_uploaded_document
					WHERE organization_id = ${record.organizationId}
						AND envelope_id = ${record.envelopeId}
				) < ${MAX_UPLOADED_DOCUMENTS_PER_ENVELOPE}
				ON CONFLICT (organization_id, envelope_id, sha256) DO NOTHING
				RETURNING sha256
			`;
			if (inserted.length === 1) return 'inserted';

			const existing = await sql<{ sha256: string }[]>`
				SELECT sha256 FROM envelope_uploaded_document
				WHERE organization_id = ${record.organizationId}
					AND envelope_id = ${record.envelopeId}
					AND sha256 = ${record.sha256}
				LIMIT 1
			`;
			if (existing.length === 1) return 'duplicate';
			return 'cap_exceeded';
		});
	}

	async find(
		organizationId: string,
		envelopeId: string,
		sha256: string
	): Promise<EnvelopeUploadedDocumentRecord | null> {
		const rows = await this.#sql<EnvelopeUploadedDocumentRecord[]>`
			SELECT organization_id AS "organizationId", envelope_id AS "envelopeId",
				sha256, object_key AS "objectKey", byte_size AS "byteSize",
				page_count AS "pageCount", page_width AS "pageWidth",
				page_height AS "pageHeight", created_at AS "createdAt"
			FROM envelope_uploaded_document
			WHERE organization_id = ${organizationId}
				AND envelope_id = ${envelopeId}
				AND sha256 = ${sha256}
			LIMIT 1
		`;
		if (rows.length === 0) return null;
		return {
			...rows[0],
			byteSize: Number(rows[0].byteSize)
		};
	}
}
