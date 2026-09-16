import type { FieldGeometry, FieldType } from '$lib/domain/envelope';
import type {
	CompletionPdfEvidenceStore,
	CompletionPdfFieldGeometry
} from '$lib/ports/completion-pdf-evidence-store';

export class D1CompletionPdfEvidenceStore implements CompletionPdfEvidenceStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async readFieldGeometry(envelopeId: string): Promise<readonly CompletionPdfFieldGeometry[]> {
		interface Row {
			id: string;
			document_id: string | null;
			document_path: string | null;
			position: number;
			recipient_id: string;
			field_type: string;
			required: number;
			page: number | null;
			x: number | null;
			y: number | null;
			width: number | null;
			height: number | null;
		}
		const result: D1Result<Row> = await this.#database
			.prepare(
				`SELECT id, document_id, document_path, position, recipient_id, field_type, required,
				        page, x, y, width, height
				 FROM envelope_field
				 WHERE envelope_id = ?
				 ORDER BY document_id ASC, document_path ASC, position ASC, id ASC`
			)
			.bind(envelopeId)
			.all<Row>();
		return result.results.map((row: Row): CompletionPdfFieldGeometry => ({
			id: row.id,
			documentId: row.document_id,
			documentPath: row.document_path,
			position: row.position,
			recipientId: row.recipient_id,
			fieldType: row.field_type as FieldType,
			required: row.required === 1,
			geometry: toGeometry(row)
		}));
	}
}

/**
 * The schema constrains page/x/y/width/height to be present together, so a
 * partially populated row is corruption: it reads as no geometry at all
 * rather than as a box with guessed edges.
 */
function toGeometry(row: {
	page: number | null;
	x: number | null;
	y: number | null;
	width: number | null;
	height: number | null;
}): FieldGeometry | null {
	const { page, x, y, width, height } = row;
	if (
		typeof page !== 'number' ||
		typeof x !== 'number' ||
		typeof y !== 'number' ||
		typeof width !== 'number' ||
		typeof height !== 'number'
	) {
		return null;
	}
	return { page, x, y, width, height };
}
