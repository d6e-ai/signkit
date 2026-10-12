import { envelopeStatuses, type Envelope, type EnvelopeStatus } from '$lib/domain/envelope';
import type { DraftPointerUpdate, EnvelopeStore } from '$lib/ports/envelope-store';

export interface D1EnvelopeRow {
	id: string;
	created_by_user_id: string;
	title: string;
	status: string;
	repository_generation: number;
	repository_head: string | null;
	repository_archive_key: string | null;
	repository_archive_sha256: string | null;
	sent_commit_sha: string | null;
	field_generation: number;
	created_at: string;
	updated_at: string;
}

export const D1_ENVELOPE_BY_ID_SQL: string = 'SELECT * FROM envelope WHERE id = ? LIMIT 1';

export class D1EnvelopeStore implements EnvelopeStore {
	constructor(private readonly database: D1Database) {}

	async findEnvelope(envelopeId: string): Promise<Envelope | null> {
		const row = await this.database
			.prepare(D1_ENVELOPE_BY_ID_SQL)
			.bind(envelopeId)
			.first<D1EnvelopeRow>();
		return row === null ? null : d1EnvelopeFromRow(row);
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

export function d1EnvelopeFromRow(row: D1EnvelopeRow): Envelope {
	const status: EnvelopeStatus | null = envelopeStatusFromRow(row.status);
	if (
		typeof row.id !== 'string' ||
		row.id.length === 0 ||
		typeof row.created_by_user_id !== 'string' ||
		row.created_by_user_id.length === 0 ||
		typeof row.title !== 'string' ||
		typeof row.created_at !== 'string' ||
		row.created_at.length === 0 ||
		typeof row.updated_at !== 'string' ||
		row.updated_at.length === 0 ||
		status === null ||
		!Number.isSafeInteger(row.repository_generation) ||
		row.repository_generation < 0 ||
		!Number.isSafeInteger(row.field_generation) ||
		row.field_generation < 0
	) {
		throw new Error('Stored envelope row is corrupted.');
	}
	return {
		id: row.id,
		createdByUserId: row.created_by_user_id,
		title: row.title,
		status,
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

function envelopeStatusFromRow(value: string): EnvelopeStatus | null {
	for (const status of envelopeStatuses) {
		if (status === value) return status;
	}
	return null;
}
