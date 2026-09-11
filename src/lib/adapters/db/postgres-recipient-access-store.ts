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
				recipient.capability_expires_at AS "expiresAt"
			FROM recipient
			INNER JOIN envelope
				ON envelope.organization_id = recipient.organization_id
				AND envelope.id = recipient.envelope_id
			WHERE recipient.capability_hash = ${tokenHash}
				AND recipient.capability_revoked_at IS NULL
				AND recipient.capability_expires_at IS NOT NULL
				AND recipient.capability_expires_at > ${at}::timestamptz
				AND recipient.status IN ('pending', 'viewed')
				AND recipient.role <> 'cc'
				AND envelope.status IN ('sent', 'in_progress')
			LIMIT 1
		`;
		const row: RecipientAccessRow | undefined = rows[0];
		if (row === undefined) return null;
		return { ...row, expiresAt: toIsoString(row.expiresAt) };
	}
}

function toIsoString(value: string | Date): string {
	const date: Date = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(date.valueOf()))
		throw new Error('Invalid capability expiry returned by PostgreSQL');
	return date.toISOString();
}
