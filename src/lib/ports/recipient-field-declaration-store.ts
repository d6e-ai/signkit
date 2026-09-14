import type { FieldGeometry, FieldType } from '$lib/domain/envelope';

/**
 * A signer's own field declaration, read for /sign rendering. Unlike
 * PublicEnvelopeField (the sender-facing placement receipt, which never
 * echoes labels), this is scoped to exactly one recipient's own fields and
 * includes the label so the recipient knows what to fill in.
 */
export interface RecipientFieldDeclaration {
	id: string;
	documentPath: `documents/${string}.md`;
	fieldType: FieldType;
	label: string;
	required: boolean;
	position: number;
	/**
	 * Where the field sits on the sent PDF. Null only for placements made
	 * before geometry became mandatory; a recipient surface that cannot place
	 * a field visually must treat that as a fail-closed integrity problem
	 * rather than silently hiding a field the signer is required to complete.
	 */
	geometry: FieldGeometry | null;
}

export interface RecipientOwnFields {
	fieldGeneration: number;
	fields: readonly RecipientFieldDeclaration[];
}

export interface RecipientFieldDeclarationStore {
	listOwnFields(
		organizationId: string,
		envelopeId: string,
		recipientId: string
	): Promise<RecipientOwnFields | null>;
}
