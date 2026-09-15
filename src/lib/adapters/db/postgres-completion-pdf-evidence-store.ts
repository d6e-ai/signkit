import postgres from 'postgres';
import type { FieldGeometry, FieldType } from '$lib/domain/envelope';
import type {
	CompletionPdfEvidenceStore,
	CompletionPdfFieldGeometry
} from '$lib/ports/completion-pdf-evidence-store';

interface GeometryRow {
	id: string;
	documentId: string | null;
	documentPath: string | null;
	position: number;
	recipientId: string;
	fieldType: string;
	page: number | null;
	x: number | null;
	y: number | null;
	width: number | null;
	height: number | null;
}

export class PostgresCompletionPdfEvidenceStore implements CompletionPdfEvidenceStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async readFieldGeometry(
		organizationId: string,
		envelopeId: string
	): Promise<readonly CompletionPdfFieldGeometry[]> {
		const rows = await this.#sql<GeometryRow[]>`
			SELECT id, document_id AS "documentId", document_path AS "documentPath", position,
			       recipient_id AS "recipientId", field_type AS "fieldType",
			       page, x, y, width, height
			FROM envelope_field
			WHERE organization_id = ${organizationId} AND envelope_id = ${envelopeId}
			ORDER BY document_id ASC, document_path ASC, position ASC, id ASC`;
		return rows.map((row: GeometryRow): CompletionPdfFieldGeometry => ({
			id: row.id,
			documentId: row.documentId,
			documentPath: row.documentPath,
			position: row.position,
			recipientId: row.recipientId,
			fieldType: row.fieldType as FieldType,
			geometry: toGeometry(row)
		}));
	}
}

/**
 * The schema constrains page/x/y/width/height to be present together, so a
 * partially populated row is corruption: it reads as no geometry at all
 * rather than as a box with guessed edges.
 */
function toGeometry(row: GeometryRow): FieldGeometry | null {
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
