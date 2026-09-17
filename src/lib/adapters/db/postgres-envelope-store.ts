import postgres from 'postgres';
import type { Envelope, EnvelopeStatus } from '$lib/domain/envelope';
import type { DraftPointerUpdate, EnvelopeStore } from '$lib/ports/envelope-store';

export class PostgresEnvelopeStore implements EnvelopeStore {
	constructor(private readonly sql: ReturnType<typeof postgres>) {}

	async findEnvelope(envelopeId: string): Promise<Envelope | null> {
		const rows = await this.sql<Envelope[]>`
			SELECT id,
				title,
				status,
				repository_generation AS "repositoryGeneration",
				repository_head AS "repositoryHead",
				repository_archive_key AS "repositoryArchiveKey",
				repository_archive_sha256 AS "repositoryArchiveSha256",
				sent_commit_sha AS "sentCommitSha",
				field_generation AS "fieldGeneration",
				created_at AS "createdAt",
				updated_at AS "updatedAt"
			FROM envelope
			WHERE id = ${envelopeId}
			LIMIT 1
		`;
		return rows[0] ?? null;
	}

	async compareAndSetDraftPointer(
		envelopeId: string,
		update: DraftPointerUpdate
	): Promise<boolean> {
		const rows = await this.sql<{ id: string }[]>`
			UPDATE envelope
			SET repository_generation = ${update.nextGeneration},
				repository_head = ${update.commitSha},
				repository_archive_key = ${update.archiveKey},
				repository_archive_sha256 = ${update.archiveSha256},
				updated_at = ${update.updatedAt}
			WHERE id = ${envelopeId}
				AND status = 'draft'
				AND repository_generation = ${update.expectedGeneration}
			RETURNING id
		`;
		return rows.length === 1;
	}

	async transition(
		envelopeId: string,
		expected: EnvelopeStatus,
		next: EnvelopeStatus,
		at: string
	): Promise<boolean> {
		const rows = await this.sql<{ id: string }[]>`
			UPDATE envelope SET status = ${next}, updated_at = ${at}
			WHERE id = ${envelopeId} AND status = ${expected}
			RETURNING id
		`;
		return rows.length === 1;
	}
}
