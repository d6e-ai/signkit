import {
	attestSentSigningInstruction,
	type SentSigningInstructionEvidenceRow
} from './sent-signing-instruction-evidence';
import type postgres from 'postgres';
import type {
	EnvelopeSentDocumentStore,
	SentDocumentPointer,
	SentDocumentSetPointer
} from '$lib/ports/envelope-sent-document-store';

type Sql = ReturnType<typeof postgres>;

interface SentDocumentSetRow extends SentSigningInstructionEvidenceRow {
	envelopeId: string;
	commitSha: string;
	documentSetHash: string | null;
	documentCount: number;
	createdAt: Date | string;
}

interface SentDocumentRow {
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

	async findSet(envelopeId: string, commitSha: string): Promise<SentDocumentSetPointer | null> {
		const setRows = await this.#sql<SentDocumentSetRow[]>`
			SELECT
				envelope.id AS "envelopeId", envelope.sent_commit_sha AS "commitSha",
				document_set.document_set_hash AS "documentSetHash",
				document_set.document_count AS "documentCount",
				document_set.created_at AS "createdAt",
				command.audit_payload_json AS "commandPayloadJson", event.payload_json AS "payloadJson",
				command.audit_event_id AS "commandEventId", event.id AS "eventId",
				event.event_hash AS "eventHash", event.previous_hash AS "previousHash", event.sequence,
				event.actor_id AS "actorId", event.actor_type AS "actorType",
				to_char(event.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",
				CASE WHEN EXTRACT(MICROSECONDS FROM event.occurred_at)::bigint % 1000 = 0
					THEN event.hash_version ELSE NULL END AS "hashVersion"
			FROM envelope
			LEFT JOIN envelope_sent_document_set document_set
				ON document_set.envelope_id = envelope.id
				AND document_set.commit_sha = envelope.sent_commit_sha
			LEFT JOIN envelope_send_command command ON command.envelope_id = envelope.id
			LEFT JOIN audit_event event ON event.envelope_id = envelope.id AND event.event_type = 'envelope.sent'
			WHERE envelope.id = ${envelopeId} AND envelope.sent_commit_sha = ${commitSha}
			LIMIT 1`;
		const setRow: SentDocumentSetRow | undefined = setRows[0];
		if (setRow === undefined) return null;
		if (setRow.documentSetHash === null) {
			await attestSentSigningInstruction(envelopeId, commitSha, setRow, null);
			return null;
		}
		const documentRows = await this.#sql<SentDocumentRow[]>`
			SELECT envelope_id AS "envelopeId",
				commit_sha AS "commitSha", document_id AS "documentId", position, kind, title,
				object_key AS "objectKey", sha256, byte_size AS "byteSize",
				page_count AS "pageCount", page_width AS "pageWidth", page_height AS "pageHeight",
				created_at AS "createdAt"
			FROM envelope_sent_document
			WHERE envelope_id = ${envelopeId}
				AND commit_sha = ${commitSha}
			ORDER BY position ASC, document_id ASC`;
		const documents: SentDocumentPointer[] = [];
		for (const row of documentRows) {
			const pointer: SentDocumentPointer | null = toDocumentPointer(row);
			if (pointer === null) {
				await attestSentSigningInstruction(envelopeId, commitSha, setRow, null);
				return null;
			}
			documents.push(pointer);
		}
		if (
			documents.length !== Number(setRow.documentCount) ||
			documents.some((document, index) => document.position !== index)
		) {
			await attestSentSigningInstruction(envelopeId, commitSha, setRow, null);
			return null;
		}
		const set: SentDocumentSetPointer = {
			envelopeId: setRow.envelopeId,
			commitSha: setRow.commitSha,
			documentSetHash: setRow.documentSetHash,
			documentCount: Number(setRow.documentCount),
			documents,
			createdAt:
				setRow.createdAt instanceof Date ? setRow.createdAt.toISOString() : String(setRow.createdAt)
		};
		const signingInstructionEventHash = await attestSentSigningInstruction(
			envelopeId,
			commitSha,
			setRow,
			set
		);
		return signingInstructionEventHash === undefined
			? set
			: { ...set, signingInstructionEventHash };
	}

	async findDocument(
		envelopeId: string,
		commitSha: string,
		documentId: string
	): Promise<SentDocumentPointer | null> {
		const set: SentDocumentSetPointer | null = await this.findSet(envelopeId, commitSha);
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
