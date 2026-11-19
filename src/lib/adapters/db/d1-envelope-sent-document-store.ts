import {
	attestSentSigningInstruction,
	type SentSigningInstructionEvidenceRow
} from './sent-signing-instruction-evidence';
import type {
	EnvelopeSentDocumentStore,
	SentDocumentPointer,
	SentDocumentSetPointer
} from '$lib/ports/envelope-sent-document-store';

interface SentDocumentSetRow extends SentSigningInstructionEvidenceRow {
	envelope_id: string;
	commit_sha: string;
	document_set_hash: string | null;
	document_count: number;
	created_at: string;
}

interface SentDocumentRow {
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

	async findSet(envelopeId: string, commitSha: string): Promise<SentDocumentSetPointer | null> {
		const setRow: SentDocumentSetRow | null = await this.#database
			.prepare(
				`SELECT envelope.id AS envelope_id, envelope.sent_commit_sha AS commit_sha,
					document_set.document_set_hash, document_set.document_count, document_set.created_at,
					command.audit_payload_json AS commandPayloadJson, event.payload_json AS payloadJson,
					command.audit_event_id AS commandEventId, event.id AS eventId,
					event.event_hash AS eventHash, event.previous_hash AS previousHash, event.sequence,
					event.actor_id AS actorId, event.actor_type AS actorType, event.occurred_at AS occurredAt,
					event.hash_version AS hashVersion
				 FROM envelope
				 LEFT JOIN envelope_sent_document_set document_set
					ON document_set.envelope_id = envelope.id
					AND document_set.commit_sha = envelope.sent_commit_sha
				 LEFT JOIN envelope_send_command command ON command.envelope_id = envelope.id
				 LEFT JOIN audit_event event ON event.envelope_id = envelope.id AND event.event_type = 'envelope.sent'
				 WHERE envelope.id = ? AND envelope.sent_commit_sha = ?
				 LIMIT 1`
			)
			.bind(envelopeId, commitSha)
			.first<SentDocumentSetRow>();
		if (setRow === null) return null;
		if (setRow.document_set_hash === null) {
			await attestSentSigningInstruction(envelopeId, commitSha, setRow, null);
			return null;
		}
		const result: D1Result<SentDocumentRow> = await this.#database
			.prepare(
				`SELECT envelope_id, commit_sha, document_id, position, kind, title,
					object_key, sha256, byte_size, page_count, page_width, page_height, created_at
				 FROM envelope_sent_document
				 WHERE envelope_id = ? AND commit_sha = ?
				 ORDER BY position ASC, document_id ASC`
			)
			.bind(envelopeId, commitSha)
			.all<SentDocumentRow>();
		const documents: SentDocumentPointer[] = [];
		for (const row of result.results) {
			const pointer: SentDocumentPointer | null = toDocumentPointer(row);
			if (pointer === null) {
				await attestSentSigningInstruction(envelopeId, commitSha, setRow, null);
				return null;
			}
			documents.push(pointer);
		}
		if (
			documents.length !== Number(setRow.document_count) ||
			documents.some((document, index) => document.position !== index)
		) {
			await attestSentSigningInstruction(envelopeId, commitSha, setRow, null);
			return null;
		}
		const set: SentDocumentSetPointer = {
			envelopeId: setRow.envelope_id,
			commitSha: setRow.commit_sha,
			documentSetHash: setRow.document_set_hash,
			documentCount: Number(setRow.document_count),
			documents,
			createdAt: setRow.created_at
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
