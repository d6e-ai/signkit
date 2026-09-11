import postgres from 'postgres';
import type { EnvelopeStatus, RecipientRole, RecipientStatus } from '$lib/domain/envelope';
import type {
	RecipientAccessStore,
	RecipientSigningContext
} from '$lib/ports/recipient-access-store';

interface RecipientAccessRow {
	organizationId: string;
	envelopeId: string;
	recipientId: string;
	recipientName: string;
	recipientLocale: 'en' | 'ja';
	recipientRole: RecipientRole;
	recipientStatus: RecipientStatus;
	envelopeTitle: string;
	envelopeStatus: EnvelopeStatus;
	expiresAt: string | Date;
	sentCommitSha: string;
	archiveKey: string;
	archiveSha256: string;
}

export class PostgresRecipientAccessStore implements RecipientAccessStore {
	constructor(private readonly sql: ReturnType<typeof postgres>) {}

	async findActiveByTokenHash(
		tokenHash: string,
		at: string
	): Promise<RecipientSigningContext | null> {
		const rows = await this.sql<RecipientAccessRow[]>`
			SELECT recipient.organization_id AS "organizationId",
				recipient.envelope_id AS "envelopeId",
				recipient.id AS "recipientId",
				recipient.name AS "recipientName",
				recipient.locale AS "recipientLocale",
				recipient.role AS "recipientRole",
				recipient.status AS "recipientStatus",
				envelope.title AS "envelopeTitle",
				envelope.status AS "envelopeStatus",
				recipient.capability_expires_at AS "expiresAt",
				envelope.sent_commit_sha AS "sentCommitSha",
				revision.archive_key AS "archiveKey",
				revision.archive_sha256 AS "archiveSha256"
			FROM recipient
			INNER JOIN envelope
				ON envelope.organization_id = recipient.organization_id
				AND envelope.id = recipient.envelope_id
			INNER JOIN draft_revision_command revision
				ON revision.organization_id = envelope.organization_id
				AND revision.envelope_id = envelope.id
				AND revision.commit_sha = envelope.sent_commit_sha
				AND revision.archive_key = envelope.repository_archive_key
				AND revision.archive_sha256 = envelope.repository_archive_sha256
			WHERE recipient.capability_hash = ${tokenHash}
				AND recipient.capability_revoked_at IS NULL
				AND recipient.capability_expires_at IS NOT NULL
				AND recipient.capability_expires_at > ${at}::timestamptz
				AND recipient.status IN ('pending', 'viewed')
				AND recipient.role <> 'cc'
				AND envelope.status IN ('sent', 'in_progress')
				AND envelope.sent_commit_sha IS NOT NULL
				AND envelope.sent_commit_sha = envelope.repository_head
			LIMIT 1
		`;
		const row: RecipientAccessRow | undefined = rows[0];
		if (row === undefined) return null;
		return {
			organizationId: row.organizationId,
			envelopeId: row.envelopeId,
			recipientId: row.recipientId,
			recipientName: row.recipientName,
			recipientLocale: row.recipientLocale,
			recipientRole: row.recipientRole,
			recipientStatus: row.recipientStatus,
			envelopeTitle: row.envelopeTitle,
			envelopeStatus: row.envelopeStatus,
			expiresAt: toIsoString(row.expiresAt),
			sentRevision: {
				commitSha: row.sentCommitSha,
				archiveKey: row.archiveKey,
				archiveSha256: row.archiveSha256
			}
		};
	}
}

function toIsoString(value: string | Date): string {
	const date: Date = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(date.valueOf()))
		throw new Error('Invalid capability expiry returned by PostgreSQL');
	return date.toISOString();
}
