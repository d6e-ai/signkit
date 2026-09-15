import type postgres from 'postgres';
import type {
	EnvelopeSentDocumentStore,
	SentDocumentPointer,
	SentDocumentSetPointer
} from '$lib/ports/envelope-sent-document-store';

type Sql = ReturnType<typeof postgres>;

interface SentDocumentSetRow {
	organizationId: string;
	envelopeId: string;
	commitSha: string;
	documentSetHash: string;
	documentCount: number;
	createdAt: Date | string;
}

interface SentDocumentRow {
	organizationId: string;
	envelopeId: string;
	commitSha: string;
	documentId: string;
	position: number;
	kind: 'markdown' | 'pdf';
	title: string;
	objectKey: string;
	sha256: string;
	byteSize: number | string;
	pageCount: number;
	pageWidth: number;
	pageHeight: number;
	createdAt: Date | string;
}

export class PostgresEnvelopeSentDocumentStore implements EnvelopeSentDocumentStore {
	readonly #sql: Sql;

	constructor(sql: Sql) {
		this.#sql = sql;
	}

	async findSet(
		organizationId: string,
		envelopeId: string,
		commitSha: string
	): Promise<SentDocumentSetPointer | null> {
		const setRows = await this.#sql<SentDocumentSetRow[]>`
			SELECT document_set.organization_id AS "organizationId",
				document_set.envelope_id AS "envelopeId",
				document_set.commit_sha AS "commitSha",
				document_set.document_set_hash AS "documentSetHash",
				document_set.document_count AS "documentCount",
				document_set.created_at AS "createdAt"
			FROM envelope_sent_document_set document_set
			INNER JOIN envelope
				ON envelope.organization_id = document_set.organization_id
				AND envelope.id = document_set.envelope_id
				AND envelope.sent_commit_sha = document_set.commit_sha
			WHERE document_set.organization_id = ${organizationId}
				AND document_set.envelope_id = ${envelopeId}
				AND document_set.commit_sha = ${commitSha}
			LIMIT 1`;
		const setRow: SentDocumentSetRow | undefined = setRows[0];
		if (setRow === undefined) return null;
		const documentRows = await this.#sql<SentDocumentRow[]>`
			SELECT organization_id AS "organizationId", envelope_id AS "envelopeId",
				commit_sha AS "commitSha", document_id AS "documentId", position, kind, title,
				object_key AS "objectKey", sha256, byte_size AS "byteSize",
				page_count AS "pageCount", page_width AS "pageWidth", page_height AS "pageHeight",
				created_at AS "createdAt"
			FROM envelope_sent_document
			WHERE organization_id = ${organizationId} AND envelope_id = ${envelopeId}
				AND commit_sha = ${commitSha}
			ORDER BY position ASC, document_id ASC`;
		const documents: SentDocumentPointer[] = [];
		for (const row of documentRows) {
			const pointer: SentDocumentPointer | null = toDocumentPointer(row);
			if (pointer === null) return null;
			documents.push(pointer);
		}
		if (documents.length !== Number(setRow.documentCount)) return null;
		for (let index = 0; index < documents.length; index += 1) {
			if (documents[index].position !== index) return null;
		}
		return {
			organizationId: setRow.organizationId,
			envelopeId: setRow.envelopeId,
			commitSha: setRow.commitSha,
			documentSetHash: setRow.documentSetHash,
			documentCount: Number(setRow.documentCount),
			documents,
			createdAt:
				setRow.createdAt instanceof Date ? setRow.createdAt.toISOString() : String(setRow.createdAt)
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
	const byteSize: number = Number(row.byteSize);
	const pageCount: number = Number(row.pageCount);
	const pageWidth: number = Number(row.pageWidth);
	const pageHeight: number = Number(row.pageHeight);
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
		organizationId: row.organizationId,
		envelopeId: row.envelopeId,
		commitSha: row.commitSha,
		documentId: row.documentId,
		position,
		kind: row.kind,
		title: row.title,
		objectKey: row.objectKey,
		sha256: row.sha256,
		byteSize,
		pageCount,
		pageWidth,
		pageHeight,
		createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt)
	};
}
