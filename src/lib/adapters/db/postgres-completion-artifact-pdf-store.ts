import postgres from 'postgres';
import type {
	CompletionArtifactPdfRecord,
	CompletionArtifactPdfStore,
	PublishCompletionArtifactPdfCommand,
	PublishCompletionArtifactPdfResult
} from '$lib/ports/completion-artifact-pdf-store';

export class PostgresCompletionArtifactPdfStore implements CompletionArtifactPdfStore {
	readonly #sql: ReturnType<typeof postgres>;

	constructor(sql: ReturnType<typeof postgres>) {
		this.#sql = sql;
	}

	async publishCompletionArtifactPdf(
		command: PublishCompletionArtifactPdfCommand
	): Promise<PublishCompletionArtifactPdfResult> {
		const artifact = await this.#sql<{ envelope_id: string }[]>`
			SELECT envelope_id FROM completion_artifact
			WHERE envelope_id = ${command.envelopeId}`;
		if (artifact.length === 0) return { outcome: 'artifact_not_found' };

		const inserted = await this.#sql<{ envelope_id: string }[]>`
			INSERT INTO completion_artifact_pdf (
				envelope_id, pdf_object_key, pdf_sha256,
				pdf_manifest_object_key, pdf_manifest_sha256, published_at
			) VALUES (${command.envelopeId}, ${command.pdfObjectKey},
				${command.pdfSha256}, ${command.pdfManifestObjectKey}, ${command.pdfManifestSha256},
				${command.publishedAt}::timestamptz)
			ON CONFLICT (envelope_id) DO NOTHING
			RETURNING envelope_id`;
		if (inserted.length === 1) return { outcome: 'published' };

		const existing: CompletionArtifactPdfRecord | null = await this.readCompletionArtifactPdf(
			command.envelopeId
		);
		if (existing === null) return { outcome: 'artifact_not_found' };
		return existing.pdfObjectKey === command.pdfObjectKey &&
			existing.pdfSha256 === command.pdfSha256 &&
			existing.pdfManifestObjectKey === command.pdfManifestObjectKey &&
			existing.pdfManifestSha256 === command.pdfManifestSha256
			? { outcome: 'already_published' }
			: { outcome: 'integrity_error' };
	}

	async readCompletionArtifactPdf(envelopeId: string): Promise<CompletionArtifactPdfRecord | null> {
		const rows = await this.#sql<
			{
				pdfObjectKey: string;
				pdfSha256: string;
				pdfManifestObjectKey: string;
				pdfManifestSha256: string;
				publishedAt: Date | string;
			}[]
		>`
			SELECT pdf_object_key AS "pdfObjectKey", pdf_sha256 AS "pdfSha256",
				pdf_manifest_object_key AS "pdfManifestObjectKey",
				pdf_manifest_sha256 AS "pdfManifestSha256", published_at AS "publishedAt"
			FROM completion_artifact_pdf
			WHERE envelope_id = ${envelopeId}`;
		const row = rows[0];
		if (row === undefined) return null;
		return {
			pdfObjectKey: row.pdfObjectKey,
			pdfSha256: row.pdfSha256,
			pdfManifestObjectKey: row.pdfManifestObjectKey,
			pdfManifestSha256: row.pdfManifestSha256,
			publishedAt: isoTimestamp(row.publishedAt)
		};
	}
}

function isoTimestamp(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
