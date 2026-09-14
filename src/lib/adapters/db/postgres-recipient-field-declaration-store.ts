import postgres from 'postgres';
import type { FieldGeometry, FieldType } from '$lib/domain/envelope';
import type {
	RecipientFieldDeclaration,
	RecipientFieldDeclarationStore,
	RecipientOwnFields
} from '$lib/ports/recipient-field-declaration-store';

interface FieldRow {
	id: string;
	documentPath: string;
	fieldType: FieldType;
	label: string;
	required: boolean;
	position: number;
	page: number | null;
	x: number | null;
	y: number | null;
	width: number | null;
	height: number | null;
}

export class PostgresRecipientFieldDeclarationStore implements RecipientFieldDeclarationStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async listOwnFields(
		organizationId: string,
		envelopeId: string,
		recipientId: string
	): Promise<RecipientOwnFields | null> {
		const envelopes = await this.#sql<{ fieldGeneration: number }[]>`
			SELECT field_generation AS "fieldGeneration"
			FROM envelope
			WHERE organization_id = ${organizationId} AND id = ${envelopeId}
			LIMIT 1`;
		const envelope: { fieldGeneration: number } | undefined = envelopes[0];
		if (envelope === undefined) return null;
		const rows = await this.#sql<FieldRow[]>`
			SELECT id, document_path AS "documentPath", field_type AS "fieldType",
				label, required, position, page, x, y, width, height
			FROM envelope_field
			WHERE organization_id = ${organizationId} AND envelope_id = ${envelopeId}
				AND recipient_id = ${recipientId}
			ORDER BY document_path, position, id`;
		return {
			fieldGeneration: envelope.fieldGeneration,
			fields: rows.map((row: FieldRow): RecipientFieldDeclaration => ({
				id: row.id,
				documentPath: row.documentPath as `documents/${string}.md`,
				fieldType: row.fieldType,
				label: row.label,
				required: row.required,
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
	return {
		page: Number(row.page),
		x: Number(row.x),
		y: Number(row.y),
		width: Number(row.width),
		height: Number(row.height)
	};
}
