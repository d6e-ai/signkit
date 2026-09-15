import type { FieldGeometry, FieldType, MarkdownPath } from '$lib/domain/envelope';
import type {
	RecipientFieldDeclaration,
	RecipientFieldDeclarationStore,
	RecipientOwnFields
} from '$lib/ports/recipient-field-declaration-store';

interface FieldRow {
	id: string;
	document_id: string | null;
	document_path: string | null;
	field_type: FieldType;
	label: string;
	required: number;
	position: number;
	page: number | null;
	x: number | null;
	y: number | null;
	width: number | null;
	height: number | null;
}

export class D1RecipientFieldDeclarationStore implements RecipientFieldDeclarationStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async listOwnFields(
		organizationId: string,
		envelopeId: string,
		recipientId: string
	): Promise<RecipientOwnFields | null> {
		const envelope: { field_generation: number } | null = await this.#database
			.prepare(
				`SELECT field_generation FROM envelope
				 WHERE organization_id = ? AND id = ? LIMIT 1`
			)
			.bind(organizationId, envelopeId)
			.first<{ field_generation: number }>();
		if (envelope === null) return null;
		const result: D1Result<FieldRow> = await this.#database
			.prepare(
				`SELECT id, document_id, document_path, field_type, label, required, position,
					page, x, y, width, height
				 FROM envelope_field
				 WHERE organization_id = ? AND envelope_id = ? AND recipient_id = ?
				 ORDER BY COALESCE(document_id, document_path), position, id`
			)
			.bind(organizationId, envelopeId, recipientId)
			.all<FieldRow>();
		return {
			fieldGeneration: envelope.field_generation,
			fields: result.results.map((row: FieldRow): RecipientFieldDeclaration => ({
				id: row.id,
				documentId: row.document_id,
				documentPath: (row.document_path as MarkdownPath | null) ?? null,
				fieldType: row.field_type,
				label: row.label,
				required: row.required === 1,
				position: row.position,
				geometry: toGeometry(row)
			}))
		};
	}
}

/**
 * Geometry is all-or-nothing. A row with a partial or absent placement is
 * reported as having none, rather than as a half-built box a caller might
 * treat as real.
 */
function toGeometry(row: {
	page: number | null;
	x: number | null;
	y: number | null;
	width: number | null;
	height: number | null;
}): FieldGeometry | null {
	if (
		typeof row.page !== 'number' ||
		typeof row.x !== 'number' ||
		typeof row.y !== 'number' ||
		typeof row.width !== 'number' ||
		typeof row.height !== 'number'
	) {
		return null;
	}
	return { page: row.page, x: row.x, y: row.y, width: row.width, height: row.height };
}
