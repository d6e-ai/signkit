import postgres from 'postgres';
import type { EnvelopeDocument } from '$lib/domain/envelope';
import { titleFromMarkdownPath } from '$lib/application/documents/envelope-documents';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import type {
	EnvelopeDocumentInput,
	EnvelopeDocumentStore
} from '$lib/ports/envelope-document-store';

interface DocumentRow {
	id: string;
	envelopeId: string;
	markdownPath: string;
	title: string;
	position: number;
}

function toDomain(row: DocumentRow): EnvelopeDocument {
	return {
		id: row.id,
		envelopeId: row.envelopeId,
		markdownPath: row.markdownPath as `documents/${string}.md`,
		title: row.title,
		position: row.position
	};
}

export class PostgresEnvelopeDocumentStore implements EnvelopeDocumentStore {
	readonly #sql: ReturnType<typeof postgres>;
	readonly #newId: UuidV7Generator;

	constructor(sql: ReturnType<typeof postgres>, newId: UuidV7Generator = newUuidV7) {
		this.#sql = sql;
		this.#newId = newId;
	}

	async listForEnvelope(envelopeId: string): Promise<readonly EnvelopeDocument[]> {
		const rows = await this.#sql<DocumentRow[]>`
			SELECT id, envelope_id AS "envelopeId",
				markdown_path AS "markdownPath", title, position
			FROM envelope_document
			WHERE envelope_id = ${envelopeId}
			ORDER BY position
		`;
		return rows.map(toDomain);
	}

	async sync(
		envelopeId: string,
		documents: readonly EnvelopeDocumentInput[]
	): Promise<readonly EnvelopeDocument[]> {
		return this.#sql.begin(async (transaction): Promise<readonly EnvelopeDocument[]> => {
			const existingRows = await transaction<DocumentRow[]>`
				SELECT id, envelope_id AS "envelopeId",
					markdown_path AS "markdownPath", title, position
				FROM envelope_document
				WHERE envelope_id = ${envelopeId}
				FOR UPDATE
			`;
			const existingByPath: Map<string, EnvelopeDocument> = new Map(
				existingRows
					.map(toDomain)
					.map((document): [string, EnvelopeDocument] => [document.markdownPath, document])
			);
			const now: Date = new Date();
			const next: EnvelopeDocument[] = documents.map(
				(input: EnvelopeDocumentInput, index: number): EnvelopeDocument => {
					const current: EnvelopeDocument | undefined = existingByPath.get(input.markdownPath);
					return {
						id: current?.id ?? this.#newId(),
						envelopeId,
						markdownPath: input.markdownPath,
						title: current?.title ?? input.title ?? titleFromMarkdownPath(input.markdownPath),
						position: index
					};
				}
			);

			await transaction`
				DELETE FROM envelope_document
				WHERE envelope_id = ${envelopeId}
			`;
			for (const document of next) {
				await transaction`
					INSERT INTO envelope_document (
						id, envelope_id, markdown_path, title, position, created_at, updated_at
					) VALUES (
						${document.id}, ${envelopeId}, ${document.markdownPath},
						${document.title}, ${document.position}, ${now}, ${now}
					)
				`;
			}
			return next;
		});
	}

	async renameDocument(
		envelopeId: string,
		markdownPath: `documents/${string}.md`,
		title: string
	): Promise<EnvelopeDocument | null> {
		const rows = await this.#sql<DocumentRow[]>`
			UPDATE envelope_document
			SET title = ${title}, updated_at = ${new Date()}
			WHERE envelope_id = ${envelopeId}
				AND markdown_path = ${markdownPath}
			RETURNING id, envelope_id AS "envelopeId",
				markdown_path AS "markdownPath", title, position
		`;
		return rows[0] === undefined ? null : toDomain(rows[0]);
	}
}
