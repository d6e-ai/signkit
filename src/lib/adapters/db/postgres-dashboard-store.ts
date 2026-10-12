import postgres from 'postgres';
import { toPublicEnvelope } from '$lib/application/envelopes/model';
import type { Envelope, EnvelopeStatus } from '$lib/domain/envelope';
import type {
	DashboardCounts,
	DashboardItem,
	DashboardPage,
	DashboardRecipientSummary,
	DashboardView
} from '$lib/application/dashboard/model';
import type {
	DashboardActor,
	DashboardStore,
	DashboardStoreQuery
} from '$lib/ports/dashboard-store';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;
type Fragment = ReturnType<Sql>;

interface DashboardRow {
	id: string;
	createdByUserId: string;
	title: string;
	status: string;
	repositoryGeneration: number;
	repositoryHead: string | null;
	repositoryArchiveSha256: string | null;
	sentCommitSha: string | null;
	fieldGeneration: number;
	createdAt: Date | string;
	updatedAt: Date | string;
	recipientCount: number;
	completedRecipientCount: number;
	actionableRecipientCount: number;
	recipientEmail: string | null;
	recipientName: string | null;
	nextEmail: string | null;
	nextName: string | null;
	actionRequired: boolean;
}

interface CountsRow {
	allCount: number;
	draftsCount: number;
	completedCount: number;
	actionRequiredCount: number;
	waitingCount: number;
}

const NEXT_ACTIONABLE_CTE: string = `next_actionable AS (
	SELECT envelope_id, email, name, routing_order,
		ROW_NUMBER() OVER (PARTITION BY envelope_id ORDER BY routing_order ASC, id ASC) AS rn
	FROM recipient
	WHERE role IN ('signer','approver') AND status IN ('pending','viewed')
)`;

const FIRST_RECIPIENT_CTE: string = `first_recipient AS (
	SELECT envelope_id, email, name,
		ROW_NUMBER() OVER (PARTITION BY envelope_id ORDER BY routing_order ASC, id ASC) AS rn
	FROM recipient
)`;

const RECIPIENT_AGG_CTE: string = `recipient_agg AS (
	SELECT envelope_id,
		COUNT(*) AS recipient_count,
		SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
		SUM(CASE WHEN role IN ('signer','approver') THEN 1 ELSE 0 END) AS actionable_count
	FROM recipient
	GROUP BY envelope_id
)`;

/**
 * True exactly when some recipient sharing the active turn's routing order
 * (the lowest routing order among outstanding signer/approver recipients,
 * surfaced by `na.routing_order`) is the caller. Checking every recipient at
 * that routing order -- not merely the single `na` row, which breaks ties by
 * id for display -- is what keeps a parallel co-signer's own turn from being
 * missed.
 */
function activeTurnExists(sql: Sql, callerEmail: string): Fragment {
	return sql`EXISTS (
		SELECT 1 FROM recipient r
		WHERE r.envelope_id = e.id
			AND r.role IN ('signer','approver')
			AND r.status IN ('pending','viewed')
			AND r.routing_order = na.routing_order
			AND r.email = ${callerEmail}
	)`;
}

function bucketFilter(sql: Sql, view: DashboardView, callerEmail: string): Fragment {
	switch (view) {
		case 'all':
			return sql``;
		case 'drafts':
			return sql`AND e.status IN ('draft','ready')`;
		case 'completed':
			return sql`AND e.status = 'completed'`;
		case 'action_required':
			return sql`AND e.status IN ('sent','in_progress') AND ${activeTurnExists(sql, callerEmail)}`;
		case 'waiting':
			return sql`AND e.status IN ('sent','in_progress') AND NOT ${activeTurnExists(sql, callerEmail)}`;
	}
}

function queryFilter(sql: Sql, pattern: string | null): Fragment {
	if (pattern === null) return sql``;
	return sql`AND (LOWER(e.title) LIKE ${pattern} ESCAPE '\\' OR EXISTS (
		SELECT 1 FROM recipient r2
		WHERE r2.envelope_id = e.id
			AND (LOWER(r2.name) LIKE ${pattern} ESCAPE '\\' OR r2.email LIKE ${pattern} ESCAPE '\\')
	))`;
}

function cursorFilter(sql: Sql, cursor: { updatedAt: Date | string; id: string } | null): Fragment {
	if (cursor === null) return sql``;
	return sql`AND (e.updated_at < ${cursor.updatedAt} OR (e.updated_at = ${cursor.updatedAt} AND e.id < ${cursor.id}))`;
}

function escapeLike(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function toRecipientSummary(
	name: string | null,
	email: string | null
): DashboardRecipientSummary | null {
	return name === null || email === null ? null : { name, email };
}

function toIsoString(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : value;
}

function fromRow(row: DashboardRow): DashboardItem {
	const envelope: Envelope = {
		id: row.id,
		createdByUserId: row.createdByUserId,
		title: row.title,
		status: row.status as EnvelopeStatus,
		repositoryGeneration: row.repositoryGeneration,
		repositoryHead: row.repositoryHead,
		repositoryArchiveKey: null,
		repositoryArchiveSha256: row.repositoryArchiveSha256,
		sentCommitSha: row.sentCommitSha,
		fieldGeneration: row.fieldGeneration,
		createdAt: toIsoString(row.createdAt),
		updatedAt: toIsoString(row.updatedAt)
	};
	return {
		envelope: toPublicEnvelope(envelope),
		recipient: toRecipientSummary(row.recipientName, row.recipientEmail),
		recipientCount: row.recipientCount,
		completedRecipientCount: row.completedRecipientCount,
		actionableRecipientCount: row.actionableRecipientCount,
		nextRecipient: toRecipientSummary(row.nextName, row.nextEmail),
		actionRequired: row.actionRequired
	};
}

function toCounts(row: CountsRow | undefined): DashboardCounts {
	return {
		all: row?.allCount ?? 0,
		actionRequired: row?.actionRequiredCount ?? 0,
		waiting: row?.waitingCount ?? 0,
		drafts: row?.draftsCount ?? 0,
		completed: row?.completedCount ?? 0
	};
}

export class PostgresDashboardStore implements DashboardStore {
	constructor(private readonly sql: ReturnType<typeof postgres>) {}

	async readDashboard(actor: DashboardActor, query: DashboardStoreQuery): Promise<DashboardPage> {
		const pattern: string | null =
			query.query === null ? null : `%${escapeLike(query.query)}%`.toLowerCase();

		return await this.sql.begin(async (tx): Promise<DashboardPage> => {
			const txSql: Sql = tx;
			const [countsRow] = await txSql<CountsRow[]>`
				WITH ${txSql.unsafe(NEXT_ACTIONABLE_CTE)}
				SELECT
					COUNT(*)::int AS "allCount",
					COALESCE(SUM(CASE WHEN e.status IN ('draft','ready') THEN 1 ELSE 0 END), 0)::int AS "draftsCount",
					COALESCE(SUM(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END), 0)::int AS "completedCount",
					COALESCE(SUM(CASE WHEN e.status IN ('sent','in_progress') AND ${activeTurnExists(txSql, actor.email)} THEN 1 ELSE 0 END), 0)::int AS "actionRequiredCount",
					COALESCE(SUM(CASE WHEN e.status IN ('sent','in_progress') AND NOT ${activeTurnExists(txSql, actor.email)} THEN 1 ELSE 0 END), 0)::int AS "waitingCount"
				FROM envelope e
				LEFT JOIN next_actionable na ON na.envelope_id = e.id AND na.rn = 1
			`;

			let cursor: { updatedAt: Date | string; id: string } | null = null;
			if (query.cursor !== null) {
				const cursorRows = await txSql<{ updatedAt: Date | string; id: string }[]>`
					SELECT updated_at AS "updatedAt", id FROM envelope WHERE id = ${query.cursor} LIMIT 1
				`;
				if (cursorRows[0] === undefined) {
					return { items: [], nextCursor: null, counts: toCounts(countsRow) };
				}
				cursor = cursorRows[0];
			}

			const fetchLimit: number = query.limit + 1;
			const rows = await txSql<DashboardRow[]>`
				WITH ${txSql.unsafe(NEXT_ACTIONABLE_CTE)},
					${txSql.unsafe(FIRST_RECIPIENT_CTE)},
					${txSql.unsafe(RECIPIENT_AGG_CTE)}
				SELECT
					e.id,
					e.created_by_user_id AS "createdByUserId",
					e.title,
					e.status,
					e.repository_generation AS "repositoryGeneration",
					e.repository_head AS "repositoryHead",
					e.repository_archive_sha256 AS "repositoryArchiveSha256",
					e.sent_commit_sha AS "sentCommitSha",
					e.field_generation AS "fieldGeneration",
					e.created_at AS "createdAt",
					e.updated_at AS "updatedAt",
					COALESCE(ra.recipient_count, 0)::int AS "recipientCount",
					COALESCE(ra.completed_count, 0)::int AS "completedRecipientCount",
					COALESCE(ra.actionable_count, 0)::int AS "actionableRecipientCount",
					fr.email AS "recipientEmail", fr.name AS "recipientName",
					na.email AS "nextEmail", na.name AS "nextName",
					(e.status IN ('sent','in_progress') AND ${activeTurnExists(txSql, actor.email)}) AS "actionRequired"
				FROM envelope e
				LEFT JOIN recipient_agg ra ON ra.envelope_id = e.id
				LEFT JOIN first_recipient fr ON fr.envelope_id = e.id AND fr.rn = 1
				LEFT JOIN next_actionable na ON na.envelope_id = e.id AND na.rn = 1
				WHERE 1 = 1
					${bucketFilter(txSql, query.view, actor.email)}
					${queryFilter(txSql, pattern)}
					${cursorFilter(txSql, cursor)}
				ORDER BY e.updated_at DESC, e.id DESC
				LIMIT ${fetchLimit}
			`;
			const hasNextPage: boolean = rows.length > query.limit;
			const pageRows: DashboardRow[] = hasNextPage ? rows.slice(0, query.limit) : rows;
			return {
				items: pageRows.map(fromRow),
				nextCursor: hasNextPage ? (pageRows.at(-1)?.id ?? null) : null,
				counts: toCounts(countsRow)
			};
		});
	}
}
