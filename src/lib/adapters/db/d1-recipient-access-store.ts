import type { EnvelopeStatus, RecipientRole, RecipientStatus } from '$lib/domain/envelope';
import type {
	RecipientAccessStore,
	RecipientSigningContext
} from '$lib/ports/recipient-access-store';

interface RecipientAccessRow {
	organization_id: string;
	envelope_id: string;
	recipient_id: string;
	recipient_name: string;
	recipient_locale: 'en' | 'ja';
	recipient_role: RecipientRole;
	recipient_status: RecipientStatus;
	envelope_title: string;
	envelope_status: EnvelopeStatus;
	capability_expires_at: string;
	sent_commit_sha: string;
	archive_key: string;
	archive_sha256: string;
}

export class D1RecipientAccessStore implements RecipientAccessStore {
	constructor(private readonly database: D1Database) {}

	async findActiveByTokenHash(
		tokenHash: string,
		at: string
	): Promise<RecipientSigningContext | null> {
		const row: RecipientAccessRow | null = await this.database
			.prepare(D1_RECIPIENT_ACCESS_QUERY)
			.bind(tokenHash, at)
			.first<RecipientAccessRow>();
		return row === null ? null : fromRow(row);
	}
}

export const D1_RECIPIENT_ACCESS_QUERY: string = `SELECT recipient.organization_id,
					recipient.envelope_id,
					recipient.id AS recipient_id,
					recipient.name AS recipient_name,
					recipient.locale AS recipient_locale,
					recipient.role AS recipient_role,
					recipient.status AS recipient_status,
					envelope.title AS envelope_title,
					envelope.status AS envelope_status,
					recipient.capability_expires_at,
					envelope.sent_commit_sha,
					revision.archive_key,
					revision.archive_sha256
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
				WHERE recipient.capability_hash = ?
					AND recipient.capability_revoked_at IS NULL
					AND recipient.capability_expires_at IS NOT NULL
					AND julianday(recipient.capability_expires_at) > julianday(?)
					AND recipient.status IN ('pending', 'viewed')
					AND recipient.role IN ('signer', 'approver', 'viewer')
					AND envelope.status IN ('sent', 'in_progress')
					AND envelope.sent_commit_sha IS NOT NULL
					AND envelope.sent_commit_sha = envelope.repository_head
				LIMIT 1`;

function fromRow(row: RecipientAccessRow): RecipientSigningContext {
	return {
		organizationId: row.organization_id,
		envelopeId: row.envelope_id,
		recipientId: row.recipient_id,
		recipientName: row.recipient_name,
		recipientLocale: row.recipient_locale,
		recipientRole: row.recipient_role,
		recipientStatus: row.recipient_status,
		envelopeTitle: row.envelope_title,
		envelopeStatus: row.envelope_status,
		expiresAt: row.capability_expires_at,
		sentRevision: {
			commitSha: row.sent_commit_sha,
			archiveKey: row.archive_key,
			archiveSha256: row.archive_sha256
		}
	};
}
