import type {
	EnvelopeSentDocumentStore,
	SentDocumentPointer,
	SentDocumentSetPointer
} from '$lib/ports/envelope-sent-document-store';

interface SentDocumentSetRow {
	organization_id: string;
	envelope_id: string;
	commit_sha: string;
	document_set_hash: string;
	document_count: number;
	created_at: string;
}

interface SentDocumentRow {
	organization_id: string;
	envelope_id: string;
	commit_sha: string;
	document_id: string;
	position: number;
	kind: 'markdown' | 'pdf';
	title: string;
	object_key: string;
	sha256: string;
	byte_size: number;
	page_count: number;
	page_width: number;
	page_height: number;
	created_at: string;
}

export class D1EnvelopeSentDocumentStore implements EnvelopeSentDocumentStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async findSet(
		organizationId: string,
		envelopeId: string,
		commitSha: string
	): Promise<SentDocumentSetPointer | null> {
		const setRow: SentDocumentSetRow | null = await this.#database
			.prepare(
				`SELECT document_set.organization_id, document_set.envelope_id, document_set.commit_sha,
					document_set.document_set_hash, document_set.document_count, document_set.created_at
				 FROM envelope_sent_document_set document_set
				 INNER JOIN envelope
					ON envelope.organization_id = document_set.organization_id
					AND envelope.id = document_set.envelope_id
					AND envelope.sent_commit_sha = document_set.commit_sha
				 WHERE document_set.organization_id = ? AND document_set.envelope_id = ?
					AND document_set.commit_sha = ?
				 LIMIT 1`
			)
			.bind(organizationId, envelopeId, commitSha)
			.first<SentDocumentSetRow>();
		if (setRow === null) return null;
		const result: D1Result<SentDocumentRow> = await this.#database
			.prepare(
				`SELECT organization_id, envelope_id, commit_sha, document_id, position, kind, title,
					object_key, sha256, byte_size, page_count, page_width, page_height, created_at
				 FROM envelope_sent_document
				 WHERE organization_id = ? AND envelope_id = ? AND commit_sha = ?
				 ORDER BY position ASC, document_id ASC`
			)
			.bind(organizationId, envelopeId, commitSha)
			.all<SentDocumentRow>();
		const documents: SentDocumentPointer[] = [];
		for (const row of result.results) {
			const pointer: SentDocumentPointer | null = toDocumentPointer(row);
			if (pointer === null) return null;
			documents.push(pointer);
		}
		if (documents.length !== Number(setRow.document_count)) return null;
		for (let index = 0; index < documents.length; index += 1) {
			if (documents[index].position !== index) return null;
		}
		return {
			organizationId: setRow.organization_id,
			envelopeId: setRow.envelope_id,
			commitSha: setRow.commit_sha,
			documentSetHash: setRow.document_set_hash,
			documentCount: Number(setRow.document_count),
			documents,
			createdAt: setRow.created_at
		};
	}

	async findDocument(
		organizationId: string,
		envelopeId: string,
		commitSha: string,
		documentId: string
	): Promise<SentDocumentPointer | null> {
		const set: SentDocumentSetPointer | null = await this.findSet(
			organizationId,
			envelopeId,
			commitSha
		);
		if (set === null) return null;
		return set.documents.find((document) => document.documentId === documentId) ?? null;
	}
}

function toDocumentPointer(row: SentDocumentRow): SentDocumentPointer | null {
	if (row.kind !== 'markdown' && row.kind !== 'pdf') return null;
	const byteSize: number = Number(row.byte_size);
	const pageCount: number = Number(row.page_count);
	const pageWidth: number = Number(row.page_width);
	const pageHeight: number = Number(row.page_height);
	const position: number = Number(row.position);
	if (
		!Number.isSafeInteger(byteSize) ||
		byteSize <= 0 ||
		!Number.isSafeInteger(pageCount) ||
		pageCount < 1 ||
		!Number.isFinite(pageWidth) ||
		pageWidth <= 0 ||
		!Number.isFinite(pageHeight) ||
		pageHeight <= 0 ||
		!Number.isSafeInteger(position) ||
		position < 0
	) {
		return null;
	}
	return {
		organizationId: row.organization_id,
		envelopeId: row.envelope_id,
		commitSha: row.commit_sha,
		documentId: row.document_id,
		position,
		kind: row.kind,
		title: row.title,
		objectKey: row.object_key,
		sha256: row.sha256,
		byteSize,
		pageCount,
		pageWidth,
		pageHeight,
		createdAt: row.created_at
	};
}
