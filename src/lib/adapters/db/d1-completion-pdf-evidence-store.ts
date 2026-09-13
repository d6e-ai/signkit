import type {
	CompletionPdfEvidenceStore,
	CompletionPdfFieldGeometry
} from '$lib/ports/completion-pdf-evidence-store';

export class D1CompletionPdfEvidenceStore implements CompletionPdfEvidenceStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async readFieldGeometry(
		organizationId: string,
		envelopeId: string
	): Promise<readonly CompletionPdfFieldGeometry[]> {
		interface Row {
			id: string;
			document_path: string;
			position: number;
			recipient_id: string;
		}
		const result: D1Result<Row> = await this.#database
			.prepare(
				`SELECT id, document_path, position, recipient_id
				 FROM envelope_field
				 WHERE organization_id = ? AND envelope_id = ?
				 ORDER BY document_path ASC, position ASC, id ASC`
			)
			.bind(organizationId, envelopeId)
			.all<Row>();
		return result.results.map((row: Row): CompletionPdfFieldGeometry => ({
			id: row.id,
			documentPath: row.document_path,
			position: row.position,
			recipientId: row.recipient_id
		}));
	}
}
