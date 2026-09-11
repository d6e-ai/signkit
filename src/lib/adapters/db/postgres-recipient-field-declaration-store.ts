import postgres from 'postgres';
import type { FieldType } from '$lib/domain/envelope';
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
				label, required, position
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
				position: row.position
			}))
		};
	}
}
