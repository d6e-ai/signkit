import type { EnvelopeDocument } from '$lib/domain/envelope';
import { titleFromMarkdownPath } from '$lib/application/documents/envelope-documents';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import type {
	EnvelopeDocumentInput,
	EnvelopeDocumentStore
} from '$lib/ports/envelope-document-store';

interface DocumentRow {
	id: string;
	envelope_id: string;
	markdown_path: string;
	title: string;
	position: number;
}

function toDomain(row: DocumentRow): EnvelopeDocument {
	return {
		id: row.id,
		envelopeId: row.envelope_id,
		markdownPath: row.markdown_path as `documents/${string}.md`,
		title: row.title,
		position: row.position
	};
}

export class D1EnvelopeDocumentStore implements EnvelopeDocumentStore {
	readonly #database: D1Database;
	readonly #newId: UuidV7Generator;

	constructor(database: D1Database, newId: UuidV7Generator = newUuidV7) {
		this.#database = database;
		this.#newId = newId;
	}

	async listForEnvelope(envelopeId: string): Promise<readonly EnvelopeDocument[]> {
		const result = await this.#database
			.prepare(
				`SELECT id, envelope_id, markdown_path, title, position
				 FROM envelope_document
				 WHERE envelope_id = ?
				 ORDER BY position`
			)
			.bind(envelopeId)
			.all<DocumentRow>();
		return result.results.map(toDomain);
	}

	async sync(
		envelopeId: string,
		documents: readonly EnvelopeDocumentInput[]
	): Promise<readonly EnvelopeDocument[]> {
		const existing: readonly EnvelopeDocument[] = await this.listForEnvelope(envelopeId);
		const existingByPath: Map<string, EnvelopeDocument> = new Map(
			existing.map((document: EnvelopeDocument): [string, EnvelopeDocument] => [
				document.markdownPath,
				document
			])
		);
		const now: string = new Date().toISOString();
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

		const statements: D1PreparedStatement[] = [
			this.#database
				.prepare('DELETE FROM envelope_document WHERE envelope_id = ?')
				.bind(envelopeId),
			...next.map((document: EnvelopeDocument): D1PreparedStatement =>
				this.#database
					.prepare(
						`INSERT INTO envelope_document (
							id, envelope_id, markdown_path, title, position, created_at, updated_at
						) VALUES (?, ?, ?, ?, ?, ?, ?)`
					)
					.bind(
						document.id,
						envelopeId,
						document.markdownPath,
						document.title,
						document.position,
						now,
						now
					)
			)
		];
		if (statements.length > 1) await this.#database.batch(statements);
		else await statements[0].run();
		return next;
	}

	async renameDocument(
		envelopeId: string,
		markdownPath: `documents/${string}.md`,
		title: string
	): Promise<EnvelopeDocument | null> {
		const now: string = new Date().toISOString();
		const result = await this.#database
			.prepare(
				`UPDATE envelope_document SET title = ?, updated_at = ?
				 WHERE envelope_id = ? AND markdown_path = ?`
			)
			.bind(title, now, envelopeId, markdownPath)
			.run();
		if (result.meta.changes !== 1) return null;
		const row: DocumentRow | null = await this.#database
			.prepare(
				`SELECT id, envelope_id, markdown_path, title, position
				 FROM envelope_document
				 WHERE envelope_id = ? AND markdown_path = ?`
			)
			.bind(envelopeId, markdownPath)
			.first<DocumentRow>();
		return row === null ? null : toDomain(row);
	}
}
