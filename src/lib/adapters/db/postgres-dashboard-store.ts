import postgres from 'postgres';
import { toPublicEnvelope } from '$lib/application/envelopes/model';
import type { Envelope, EnvelopeStatus } from '$lib/domain/envelope';
import {
	encodeDashboardCursor,
	type DashboardCursorPosition
} from '$lib/application/dashboard/cursor';
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
	/**
	 * Microsecond-precision UTC ordering key, formatted in SQL
	 * (`to_char(... AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`),
	 * never derived from `updatedAt` in JS: the `postgres` driver maps
	 * `timestamptz` to a JS `Date`, and `Date#toISOString()` truncates to
	 * millisecond precision. Two distinct rows sharing a millisecond but
	 * differing only in sub-millisecond precision would otherwise collapse
	 * to the same cursor tie-break value, letting the keyset cursor skip a
	 * row. This field is used only to mint the opaque cursor; the public
	 * `updatedAt` field above is unaffected and keeps its existing display
	 * precision.
	 */
	updatedAtOrdering: string;
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

/**
 * True exactly when some recipient sharing the active turn's routing order
 * (the lowest routing order among this envelope's outstanding signer/approver
 * recipients) is the caller. Checking every recipient at that routing order --
 * not merely whichever one happens to be displayed as `nextRecipient` -- is
 * what keeps a parallel co-signer's own turn from being missed.
 *
 * Deliberately a correlated-per-envelope subquery, not a `ROW_NUMBER()`
 * window over the whole recipient table: every caller of this predicate --
 * the counts query, the page bucket filter, and the final `actionRequired`
 * column -- only ever evaluates it for one already-identified envelope at a
 * time, so it never windows or groups recipients across envelopes outside
 * whatever set is already being considered.
 */
function activeTurnExists(sql: Sql, envelopeAlias: string, callerEmail: string): Fragment {
	return sql`EXISTS (
		SELECT 1 FROM recipient r
		WHERE r.envelope_id = ${sql.unsafe(`${envelopeAlias}.id`)}
			AND r.role IN ('signer','approver')
			AND r.status IN ('pending','viewed')
			AND r.routing_order = (
				SELECT MIN(r2.routing_order) FROM recipient r2
				WHERE r2.envelope_id = ${sql.unsafe(`${envelopeAlias}.id`)}
					AND r2.role IN ('signer','approver')
					AND r2.status IN ('pending','viewed')
			)
			AND r.email = ${callerEmail}
	)`;
}

function bucketFilter(
	sql: Sql,
	envelopeAlias: string,
	view: DashboardView,
	callerEmail: string
): Fragment {
	switch (view) {
		case 'all':
			return sql``;
		case 'drafts':
			return sql`AND ${sql.unsafe(`${envelopeAlias}.status`)} IN ('draft','ready')`;
		case 'completed':
			return sql`AND ${sql.unsafe(`${envelopeAlias}.status`)} = 'completed'`;
		case 'action_required':
			return sql`AND ${sql.unsafe(`${envelopeAlias}.status`)} IN ('sent','in_progress') AND ${activeTurnExists(sql, envelopeAlias, callerEmail)}`;
		case 'waiting':
			return sql`AND ${sql.unsafe(`${envelopeAlias}.status`)} IN ('sent','in_progress') AND NOT ${activeTurnExists(sql, envelopeAlias, callerEmail)}`;
	}
}

function queryFilter(sql: Sql, envelopeAlias: string, pattern: string | null): Fragment {
	if (pattern === null) return sql``;
	return sql`AND (LOWER(${sql.unsafe(`${envelopeAlias}.title`)}) LIKE LOWER(${pattern}) ESCAPE '\\' OR EXISTS (
		SELECT 1 FROM recipient r2
		WHERE r2.envelope_id = ${sql.unsafe(`${envelopeAlias}.id`)}
			AND (LOWER(r2.name) LIKE LOWER(${pattern}) ESCAPE '\\' OR LOWER(r2.email) LIKE LOWER(${pattern}) ESCAPE '\\')
	))`;
}

/** Decoded keyset position: never a database lookup, so a mutated or deleted anchor cannot shift the page. */
function cursorFilter(
	sql: Sql,
	envelopeAlias: string,
	cursor: DashboardCursorPosition | null
): Fragment {
	if (cursor === null) return sql``;
	// Bind as text first so the driver's Date serializer cannot truncate
	// microseconds. PostgreSQL parses the validated UTC `Z` timestamp itself,
	// independently of the connection's TimeZone setting.
	const boundary: Fragment = sql`${cursor.updatedAt}::text::timestamptz`;
	return sql`AND (${sql.unsafe(`${envelopeAlias}.updated_at`)} < ${boundary} OR (${sql.unsafe(`${envelopeAlias}.updated_at`)} = ${boundary} AND ${sql.unsafe(`${envelopeAlias}.id`)} < ${cursor.id}))`;
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

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function requireCounts(row: CountsRow | undefined): DashboardCounts {
	if (
		row === undefined ||
		!isFiniteNumber(row.allCount) ||
		!isFiniteNumber(row.draftsCount) ||
		!isFiniteNumber(row.completedCount) ||
		!isFiniteNumber(row.actionRequiredCount) ||
		!isFiniteNumber(row.waitingCount)
	) {
		throw new Error('Dashboard counts query returned a malformed or missing row.');
	}
	return {
		all: row.allCount,
		actionRequired: row.actionRequiredCount,
		waiting: row.waitingCount,
		drafts: row.draftsCount,
		completed: row.completedCount
	};
}

export class PostgresDashboardStore implements DashboardStore {
	constructor(private readonly sql: ReturnType<typeof postgres>) {}

	async readDashboard(actor: DashboardActor, query: DashboardStoreQuery): Promise<DashboardPage> {
		const pattern: string | null = query.query === null ? null : `%${escapeLike(query.query)}%`;

		return await this.sql.begin(async (tx): Promise<DashboardPage> => {
			const txSql: Sql = tx;
			// Plain `BEGIN` is READ COMMITTED: each statement in this
			// transaction would otherwise see its own fresh snapshot, so a
			// concurrent write landing between the counts query and the rows
			// query could make them disagree about which envelopes exist.
			// REPEATABLE READ takes one snapshot for the whole transaction, and
			// READ ONLY documents (and enforces) that this transaction never
			// writes.
			await txSql.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');

			// Whole-instance badge counts are an intentionally independent
			// aggregate: they must reflect every envelope regardless of the
			// current page, search text, or cursor, so this statement always
			// scans the whole `envelope` table once. The active-turn predicate
			// it uses for `action_required`/`waiting` is a correlated
			// per-envelope lookup (`activeTurnExists`), not a table-wide
			// window, so it never aggregates or windows recipients across
			// envelopes outside the one row currently being summed --
			// including historical or terminal envelopes, whose recipients
			// this predicate never even reaches since it only runs for rows
			// already matched to `sent`/`in_progress`.
			const [countsRow] = await txSql<CountsRow[]>`
				SELECT
					COUNT(*)::int AS "allCount",
					COALESCE(SUM(CASE WHEN e.status IN ('draft','ready') THEN 1 ELSE 0 END), 0)::int AS "draftsCount",
					COALESCE(SUM(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END), 0)::int AS "completedCount",
					COALESCE(SUM(CASE WHEN e.status IN ('sent','in_progress') AND ${activeTurnExists(txSql, 'e', actor.email)} THEN 1 ELSE 0 END), 0)::int AS "actionRequiredCount",
					COALESCE(SUM(CASE WHEN e.status IN ('sent','in_progress') AND NOT ${activeTurnExists(txSql, 'e', actor.email)} THEN 1 ELSE 0 END), 0)::int AS "waitingCount"
				FROM envelope e
			`;
			const counts: DashboardCounts = requireCounts(countsRow);

			// The page of rows is selected first -- ordered, filtered by view,
			// search, and cursor, limited to `limit + 1` -- before any
			// recipient aggregate runs. Every recipient lookup below is a
			// `LATERAL` join correlated to one `page_envelopes` row at a time
			// (never an `envelope_id IN (SELECT ...)` form): PostgreSQL's
			// planner is free to execute an `IN (subquery)` as a hash join
			// that still sequentially scans the *whole* recipient table, even
			// though the result is correctly filtered afterward, so this is
			// what actually bounds execution -- not merely the result set --
			// to this page's envelopes, confirmed by `EXPLAIN` in
			// `postgres-dashboard-store.integration.spec.ts`. Each `LATERAL`
			// subquery is itself `WHERE recipient.envelope_id = pe.id`, which
			// the existing `recipient_envelope_route`/`recipient_envelope_role_status`
			// indexes (both leading with `envelope_id`) answer directly, so
			// this never touches a terminal/historical envelope's recipients
			// outside the page.
			const fetchLimit: number = query.limit + 1;
			const rows = await txSql<DashboardRow[]>`
				WITH page_envelopes AS (
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
						to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z' AS "updatedAtOrdering"
					FROM envelope e
					WHERE 1 = 1
						${bucketFilter(txSql, 'e', query.view, actor.email)}
						${queryFilter(txSql, 'e', pattern)}
						${cursorFilter(txSql, 'e', query.cursor)}
					ORDER BY e.updated_at DESC, e.id DESC
					LIMIT ${fetchLimit}
				)
				SELECT
					pe.id,
					pe."createdByUserId",
					pe.title,
					pe.status,
					pe."repositoryGeneration",
					pe."repositoryHead",
					pe."repositoryArchiveSha256",
					pe."sentCommitSha",
					pe."fieldGeneration",
					pe."createdAt",
					pe."updatedAt",
					pe."updatedAtOrdering",
					COALESCE(agg.recipient_count, 0)::int AS "recipientCount",
					COALESCE(agg.completed_count, 0)::int AS "completedRecipientCount",
					COALESCE(agg.actionable_count, 0)::int AS "actionableRecipientCount",
					fr.email AS "recipientEmail", fr.name AS "recipientName",
					na.email AS "nextEmail", na.name AS "nextName",
					(pe.status IN ('sent','in_progress') AND ${activeTurnExists(txSql, 'pe', actor.email)}) AS "actionRequired"
				FROM page_envelopes pe
				LEFT JOIN LATERAL (
					SELECT
						COUNT(*) AS recipient_count,
						SUM(CASE WHEN role IN ('signer','approver') AND status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
						SUM(CASE WHEN role IN ('signer','approver') THEN 1 ELSE 0 END) AS actionable_count
					FROM recipient r
					WHERE r.envelope_id = pe.id
				) agg ON true
				LEFT JOIN LATERAL (
					SELECT email, name FROM recipient r2
					WHERE r2.envelope_id = pe.id
					ORDER BY r2.routing_order ASC, r2.id ASC
					LIMIT 1
				) fr ON true
				LEFT JOIN LATERAL (
					SELECT email, name FROM recipient r3
					WHERE r3.envelope_id = pe.id
						AND r3.role IN ('signer','approver') AND r3.status IN ('pending','viewed')
					ORDER BY r3.routing_order ASC, r3.id ASC
					LIMIT 1
				) na ON true
				ORDER BY pe."updatedAt" DESC, pe.id DESC
			`;
			const hasNextPage: boolean = rows.length > query.limit;
			const pageRows: DashboardRow[] = hasNextPage ? rows.slice(0, query.limit) : rows;
			const lastRow = pageRows.at(-1);
			return {
				items: pageRows.map(fromRow),
				nextCursor:
					hasNextPage && lastRow !== undefined
						? encodeDashboardCursor(query.view, query.query, {
								updatedAt: lastRow.updatedAtOrdering,
								id: lastRow.id
							})
						: null,
				counts
			};
		});
	}
}
