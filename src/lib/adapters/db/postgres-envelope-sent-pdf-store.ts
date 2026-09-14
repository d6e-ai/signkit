import type postgres from 'postgres';
import type { EnvelopeSentPdfStore, SentPdfPointer } from '$lib/ports/envelope-sent-pdf-store';
import { parseDocumentPages } from './d1-envelope-sent-pdf-store';

type Sql = ReturnType<typeof postgres>;

interface SentPdfRow {
	organizationId: string;
	envelopeId: string;
	commitSha: string;
	objectKey: string;
	sha256: string;
	byteSize: number | string;
	pageCount: number;
	pageWidth: number;
	pageHeight: number;
	documentPagesJson: string;
	createdAt: Date | string;
}

export class PostgresEnvelopeSentPdfStore implements EnvelopeSentPdfStore {
	readonly #sql: Sql;

	constructor(sql: Sql) {
		this.#sql = sql;
	}

	async findSentPdf(
		organizationId: string,
		envelopeId: string,
		commitSha: string
	): Promise<SentPdfPointer | null> {
		const rows = await this.#sql<SentPdfRow[]>`
			SELECT pdf.organization_id AS "organizationId", pdf.envelope_id AS "envelopeId",
				pdf.commit_sha AS "commitSha", pdf.object_key AS "objectKey", pdf.sha256,
				pdf.byte_size AS "byteSize", pdf.page_count AS "pageCount",
				pdf.page_width AS "pageWidth", pdf.page_height AS "pageHeight",
				pdf.document_pages_json AS "documentPagesJson", pdf.created_at AS "createdAt"
			FROM envelope_sent_pdf pdf
			INNER JOIN envelope
				ON envelope.organization_id = pdf.organization_id
				AND envelope.id = pdf.envelope_id
				AND envelope.sent_commit_sha = pdf.commit_sha
			WHERE pdf.organization_id = ${organizationId} AND pdf.envelope_id = ${envelopeId}
				AND pdf.commit_sha = ${commitSha}
			LIMIT 1`;
		const row: SentPdfRow | undefined = rows[0];
		if (row === undefined) return null;
		const pageCount: number = Number(row.pageCount);
		const documents = parseDocumentPages(row.documentPagesJson, pageCount);
		if (documents === null) return null;
		return {
			organizationId: row.organizationId,
			envelopeId: row.envelopeId,
			commitSha: row.commitSha,
			objectKey: row.objectKey,
			sha256: row.sha256,
			byteSize: Number(row.byteSize),
			pageCount,
			pageWidth: Number(row.pageWidth),
			pageHeight: Number(row.pageHeight),
			documents,
			createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt)
		};
	}
}
