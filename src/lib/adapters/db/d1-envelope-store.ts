import type { Envelope, EnvelopeStatus } from '$lib/domain/envelope';
import type { DraftPointerUpdate, EnvelopeStore } from '$lib/ports/envelope-store';

interface EnvelopeRow {
	id: string;
	created_by_user_id: string;
	title: string;
	status: EnvelopeStatus;
	repository_generation: number;
	repository_head: string | null;
	repository_archive_key: string | null;
	repository_archive_sha256: string | null;
	sent_commit_sha: string | null;
	field_generation: number;
	created_at: string;
	updated_at: string;
}

export class D1EnvelopeStore implements EnvelopeStore {
	constructor(private readonly database: D1Database) {}

	async findEnvelope(envelopeId: string): Promise<Envelope | null> {
		const row = await this.database
			.prepare('SELECT * FROM envelope WHERE id = ? LIMIT 1')
			.bind(envelopeId)
			.first<EnvelopeRow>();
		return row ? fromRow(row) : null;
	}

	async compareAndSetDraftPointer(
		envelopeId: string,
		update: DraftPointerUpdate
	): Promise<boolean> {
		const result = await this.database
			.prepare(
				`UPDATE envelope SET repository_generation = ?, repository_head = ?, repository_archive_key = ?, repository_archive_sha256 = ?, updated_at = ? WHERE id = ? AND status = 'draft' AND repository_generation = ?`
			)
			.bind(
				update.nextGeneration,
				update.commitSha,
				update.archiveKey,
				update.archiveSha256,
				update.updatedAt,
				envelopeId,
				update.expectedGeneration
			)
			.run();
		return result.meta.changes === 1;
	}

	async transition(
		envelopeId: string,
		expected: EnvelopeStatus,
		next: EnvelopeStatus,
		at: string
	): Promise<boolean> {
		const result = await this.database
			.prepare('UPDATE envelope SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
			.bind(next, at, envelopeId, expected)
			.run();
		return result.meta.changes === 1;
	}
}

function fromRow(row: EnvelopeRow): Envelope {
	return {
		id: row.id,
		createdByUserId: row.created_by_user_id,
		title: row.title,
		status: row.status,
		repositoryGeneration: row.repository_generation,
		repositoryHead: row.repository_head,
		repositoryArchiveKey: row.repository_archive_key,
		repositoryArchiveSha256: row.repository_archive_sha256,
		sentCommitSha: row.sent_commit_sha,
		fieldGeneration: row.field_generation,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}
