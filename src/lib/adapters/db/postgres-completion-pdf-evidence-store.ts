import postgres from 'postgres';
import type {
	CompletionPdfEvidenceStore,
	CompletionPdfFieldGeometry
} from '$lib/ports/completion-pdf-evidence-store';

export class PostgresCompletionPdfEvidenceStore implements CompletionPdfEvidenceStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async readFieldGeometry(
		organizationId: string,
		envelopeId: string
	): Promise<readonly CompletionPdfFieldGeometry[]> {
		const rows = await this.#sql<
			{ id: string; documentPath: string; position: number; recipientId: string }[]
		>`
			SELECT id, document_path AS "documentPath", position, recipient_id AS "recipientId"
			FROM envelope_field
			WHERE organization_id = ${organizationId} AND envelope_id = ${envelopeId}
			ORDER BY document_path ASC, position ASC, id ASC`;
		return rows;
	}
}
