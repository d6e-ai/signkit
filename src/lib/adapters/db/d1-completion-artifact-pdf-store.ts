import type {
	CompletionArtifactPdfRecord,
	CompletionArtifactPdfStore,
	PublishCompletionArtifactPdfCommand,
	PublishCompletionArtifactPdfResult
} from '$lib/ports/completion-artifact-pdf-store';

export class D1CompletionArtifactPdfStore implements CompletionArtifactPdfStore {
	readonly #database: D1Database;

	constructor(database: D1Database) {
		this.#database = database;
	}

	async publishCompletionArtifactPdf(
		command: PublishCompletionArtifactPdfCommand
	): Promise<PublishCompletionArtifactPdfResult> {
		const artifact = await this.#database
			.prepare(
				`SELECT envelope_id FROM completion_artifact
				 WHERE organization_id = ? AND envelope_id = ?`
			)
			.bind(command.organizationId, command.envelopeId)
			.first<{ envelope_id: string }>();
		if (artifact === null) return { outcome: 'artifact_not_found' };

		try {
			await this.#database
				.prepare(
					`INSERT INTO completion_artifact_pdf (
						organization_id, envelope_id, pdf_object_key, pdf_sha256,
						pdf_manifest_object_key, pdf_manifest_sha256, published_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					command.organizationId,
					command.envelopeId,
					command.pdfObjectKey,
					command.pdfSha256,
					command.pdfManifestObjectKey,
					command.pdfManifestSha256,
					command.publishedAt
				)
				.run();
			return { outcome: 'published' };
		} catch {
			const existing: CompletionArtifactPdfRecord | null = await this.readCompletionArtifactPdf(
				command.organizationId,
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
	}

	async readCompletionArtifactPdf(
		organizationId: string,
		envelopeId: string
	): Promise<CompletionArtifactPdfRecord | null> {
		interface Row {
			pdf_object_key: string;
			pdf_sha256: string;
			pdf_manifest_object_key: string;
			pdf_manifest_sha256: string;
			published_at: string;
		}
		const row: Row | null = await this.#database
			.prepare(
				`SELECT pdf_object_key, pdf_sha256, pdf_manifest_object_key, pdf_manifest_sha256, published_at
				 FROM completion_artifact_pdf
				 WHERE organization_id = ? AND envelope_id = ?`
			)
			.bind(organizationId, envelopeId)
			.first<Row>();
		if (row === null) return null;
		return {
			pdfObjectKey: row.pdf_object_key,
			pdfSha256: row.pdf_sha256,
			pdfManifestObjectKey: row.pdf_manifest_object_key,
			pdfManifestSha256: row.pdf_manifest_sha256,
			publishedAt: row.published_at
		};
	}
}
