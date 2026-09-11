import type { Envelope, EnvelopeStatus } from '$lib/domain/envelope';
import type { DraftPointerUpdate, EnvelopeStore } from '$lib/ports/envelope-store';

interface EnvelopeRow {
	id: string;
	organization_id: string;
	title: string;
	status: EnvelopeStatus;
	repository_generation: number;
	repository_head: string | null;
	repository_archive_key: string | null;
	repository_archive_sha256: string | null;
	sent_commit_sha: string | null;
	created_at: string;
	updated_at: string;
}

export class D1EnvelopeStore implements EnvelopeStore {
	constructor(private readonly database: D1Database) {}

	async findForOrganization(organizationId: string, envelopeId: string): Promise<Envelope | null> {
		const row = await this.database
			.prepare('SELECT * FROM envelope WHERE organization_id = ? AND id = ? LIMIT 1')
			.bind(organizationId, envelopeId)
			.first<EnvelopeRow>();
		return row ? fromRow(row) : null;
	}

	async compareAndSetDraftPointer(
		organizationId: string,
		envelopeId: string,
		update: DraftPointerUpdate
	): Promise<boolean> {
		const result = await this.database
			.prepare(
				`UPDATE envelope SET repository_generation = ?, repository_head = ?, repository_archive_key = ?, repository_archive_sha256 = ?, updated_at = ? WHERE organization_id = ? AND id = ? AND status = 'draft' AND repository_generation = ?`
			)
			.bind(
				update.nextGeneration,
				update.commitSha,
				update.archiveKey,
				update.archiveSha256,
				update.updatedAt,
				organizationId,
				envelopeId,
				update.expectedGeneration
			)
			.run();
		return result.meta.changes === 1;
	}

	async transition(
		organizationId: string,
		envelopeId: string,
		expected: EnvelopeStatus,
		next: EnvelopeStatus,
		at: string
	): Promise<boolean> {
		const result = await this.database
			.prepare(
				'UPDATE envelope SET status = ?, updated_at = ? WHERE organization_id = ? AND id = ? AND status = ?'
			)
			.bind(next, at, organizationId, envelopeId, expected)
			.run();
		return result.meta.changes === 1;
	}
}

function fromRow(row: EnvelopeRow): Envelope {
	return {
		id: row.id,
		organizationId: row.organization_id,
		title: row.title,
		status: row.status,
		repositoryGeneration: row.repository_generation,
		repositoryHead: row.repository_head,
		repositoryArchiveKey: row.repository_archive_key,
		repositoryArchiveSha256: row.repository_archive_sha256,
		sentCommitSha: row.sent_commit_sha,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}
