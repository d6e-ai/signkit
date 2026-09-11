import type { FieldType } from '$lib/domain/envelope';
import type {
	RecipientFieldDeclaration,
	RecipientFieldDeclarationStore,
	RecipientOwnFields
} from '$lib/ports/recipient-field-declaration-store';

interface FieldRow {
	id: string;
	document_path: string;
	field_type: FieldType;
	label: string;
	required: number;
	position: number;
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
				`SELECT id, document_path, field_type, label, required, position
				 FROM envelope_field
				 WHERE organization_id = ? AND envelope_id = ? AND recipient_id = ?
				 ORDER BY document_path, position, id`
			)
			.bind(organizationId, envelopeId, recipientId)
			.all<FieldRow>();
		return {
			fieldGeneration: envelope.field_generation,
			fields: result.results.map((row: FieldRow): RecipientFieldDeclaration => ({
				id: row.id,
				documentPath: row.document_path as `documents/${string}.md`,
				fieldType: row.field_type,
				label: row.label,
				required: row.required === 1,
				position: row.position
			}))
		};
	}
}
