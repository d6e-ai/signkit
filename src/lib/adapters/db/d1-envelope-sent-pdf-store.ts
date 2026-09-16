import type {
	EnvelopeSentPdfStore,
	SentPdfDocumentPages,
	SentPdfPointer
} from '$lib/ports/envelope-sent-pdf-store';

interface SentPdfRow {
	envelope_id: string;
	commit_sha: string;
	object_key: string;
	sha256: string;
	byte_size: number;
	page_count: number;
	page_width: number;
	page_height: number;
	document_pages_json: string;
	created_at: string;
}

export class D1EnvelopeSentPdfStore implements EnvelopeSentPdfStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async findSentPdf(envelopeId: string, commitSha: string): Promise<SentPdfPointer | null> {
		// The join back to `envelope` is what keeps a pointer from outliving the
		// revision it describes: a row for a commit the envelope is no longer
		// sent at is simply not visible here.
		const row: SentPdfRow | null = await this.#database
			.prepare(
				`SELECT pdf.envelope_id, pdf.commit_sha, pdf.object_key,
					pdf.sha256, pdf.byte_size, pdf.page_count, pdf.page_width, pdf.page_height,
					pdf.document_pages_json, pdf.created_at
				 FROM envelope_sent_pdf pdf
				 INNER JOIN envelope
					ON envelope.id = pdf.envelope_id
					AND envelope.sent_commit_sha = pdf.commit_sha
				 WHERE pdf.envelope_id = ? AND pdf.commit_sha = ?
				 LIMIT 1`
			)
			.bind(envelopeId, commitSha)
			.first<SentPdfRow>();
		return row === null ? null : toPointer(row);
	}
}

export function toPointer(row: SentPdfRow): SentPdfPointer | null {
	const documents: readonly SentPdfDocumentPages[] | null = parseDocumentPages(
		row.document_pages_json,
		row.page_count
	);
	if (documents === null) return null;
	return {
		envelopeId: row.envelope_id,
		commitSha: row.commit_sha,
		objectKey: row.object_key,
		sha256: row.sha256,
		byteSize: Number(row.byte_size),
		pageCount: Number(row.page_count),
		pageWidth: Number(row.page_width),
		pageHeight: Number(row.page_height),
		documents,
		createdAt: row.created_at
	};
}

/**
 * Page maps come out of the same durable row as the digest, but they are JSON
 * rather than columns, so they are re-validated on the way out: a malformed or
 * out-of-range map must not reach a caller that will use it to decide whether
 * a field's page is legitimate.
 */
export function parseDocumentPages(
	json: string,
	pageCount: number
): readonly SentPdfDocumentPages[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json) as unknown;
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length === 0) return null;
	const documents: SentPdfDocumentPages[] = [];
	for (const entry of parsed) {
		if (typeof entry !== 'object' || entry === null) return null;
		const candidate = entry as Record<string, unknown>;
		if (
			typeof candidate.path !== 'string' ||
			typeof candidate.title !== 'string' ||
			!Number.isSafeInteger(candidate.firstPage) ||
			!Number.isSafeInteger(candidate.lastPage)
		) {
			return null;
		}
		const firstPage: number = candidate.firstPage as number;
		const lastPage: number = candidate.lastPage as number;
		if (firstPage < 1 || lastPage < firstPage || lastPage > pageCount) return null;
		documents.push({
			path: candidate.path,
			title: candidate.title,
			firstPage,
			lastPage
		});
	}
	return documents;
}
