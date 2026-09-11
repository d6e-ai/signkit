import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { PostgresRecipientAccessStore } from './postgres-recipient-access-store';

interface RecordedQuery {
	text: string;
	values: readonly unknown[];
}

class ScriptedPostgres {
	readonly queries: RecordedQuery[] = [];
	constructor(private readonly rows: readonly object[]) {}

	client(): ReturnType<typeof postgres> {
		const query = async (
			strings: TemplateStringsArray,
			...values: readonly unknown[]
		): Promise<readonly object[]> => {
			this.queries.push({ text: normalizeSql(strings), values });
			return this.rows;
		};
		return query as ReturnType<typeof postgres>;
	}
}

describe('PostgresRecipientAccessStore', () => {
	it('uses a tenant-safe join and rejects revoked, blocked, CC, and inactive state in SQL', async () => {
		const database = new ScriptedPostgres([
			{
				organizationId: 'org-1',
				envelopeId: 'env-1',
				recipientId: 'recipient-1',
				recipientName: 'Recipient',
				recipientLocale: 'en',
				recipientRole: 'approver',
				recipientStatus: 'viewed',
				envelopeTitle: 'Agreement',
				envelopeStatus: 'in_progress',
				expiresAt: new Date('2026-09-12T00:00:00.000Z'),
				sentCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				archiveKey: 'private/archive.git.gz',
				archiveSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
			}
		]);
		const store = new PostgresRecipientAccessStore(database.client());

		await expect(
			store.findActiveByTokenHash('hash-1', '2026-09-11T00:00:00.000Z')
		).resolves.toMatchObject({
			organizationId: 'org-1',
			recipientRole: 'approver',
			expiresAt: '2026-09-12T00:00:00.000Z',
			sentRevision: {
				commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				archiveKey: 'private/archive.git.gz',
				archiveSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
			}
		});
		const query: RecordedQuery = database.queries[0];
		expect(query.values).toEqual(['hash-1', '2026-09-11T00:00:00.000Z']);
		expect(query.text).toContain('envelope.organization_id = recipient.organization_id');
		expect(query.text).toContain('envelope.id = recipient.envelope_id');
		expect(query.text).toContain('recipient.capability_revoked_at IS NULL');
		expect(query.text).toContain('recipient.capability_expires_at IS NOT NULL');
		expect(query.text).toContain("recipient.status IN ('pending', 'viewed')");
		expect(query.text).toContain("recipient.role <> 'cc'");
		expect(query.text).toContain("envelope.status IN ('sent', 'in_progress')");
		expect(query.text).toContain('INNER JOIN draft_revision_command revision');
		expect(query.text).toContain('envelope.sent_commit_sha = envelope.repository_head');
		expect(query.text).toContain('revision.commit_sha = envelope.sent_commit_sha');
		expect(query.text).toContain('revision.archive_key = envelope.repository_archive_key');
		expect(query.text).toContain('revision.archive_sha256 = envelope.repository_archive_sha256');
	});

	it('returns null when the query has no active row', async () => {
		const database = new ScriptedPostgres([]);
		await expect(
			new PostgresRecipientAccessStore(database.client()).findActiveByTokenHash(
				'hash-1',
				'2026-09-11T00:00:00.000Z'
			)
		).resolves.toBeNull();
	});
});

function normalizeSql(strings: TemplateStringsArray): string {
	let text: string = strings[0];
	for (let index: number = 1; index < strings.length; index += 1) {
		text += `$${index}${strings[index]}`;
	}
	return text.replaceAll(/\s+/g, ' ').trim();
}
