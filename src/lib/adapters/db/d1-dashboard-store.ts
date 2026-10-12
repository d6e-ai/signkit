import { d1EnvelopeFromRow, type D1EnvelopeRow } from './d1-envelope-store';
import { toPublicEnvelope } from '$lib/application/envelopes/model';
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

interface DashboardRow extends D1EnvelopeRow {
	recipient_count: number;
	completed_count: number;
	actionable_count: number;
	recipient_email: string | null;
	recipient_name: string | null;
	next_email: string | null;
	next_name: string | null;
	action_required: number;
}

interface CountsRow {
	all_count: number;
	drafts_count: number;
	completed_count: number;
	action_required_count: number;
	waiting_count: number;
}

/**
 * Positional parameters for one D1 prepared statement. SQLite's numbered
 * `?N` placeholders bind purely by number, independent of where `?N`
 * appears in the text, so a value can be pushed once per logical use (even
 * the same JS value multiple times) without tracking textual order.
 */
class Params {
	private readonly values: unknown[] = [];

	add(value: unknown): string {
		this.values.push(value);
		return `?${this.values.length}`;
	}

	bindings(): readonly unknown[] {
		return this.values;
	}
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
function activeTurnExistsSql(callerEmailPlaceholder: string): string {
	return `EXISTS (
		SELECT 1 FROM recipient r
		WHERE r.envelope_id = e.id
			AND r.role IN ('signer','approver')
			AND r.status IN ('pending','viewed')
			AND r.routing_order = na.routing_order
			AND r.email = ${callerEmailPlaceholder}
	)`;
}

function bucketClause(view: DashboardView, params: Params, callerEmail: string): string | null {
	switch (view) {
		case 'all':
			return null;
		case 'drafts':
			return `e.status IN ('draft','ready')`;
		case 'completed':
			return `e.status = 'completed'`;
		case 'action_required':
			return `e.status IN ('sent','in_progress') AND ${activeTurnExistsSql(params.add(callerEmail))}`;
		case 'waiting':
			return `e.status IN ('sent','in_progress') AND NOT ${activeTurnExistsSql(params.add(callerEmail))}`;
	}
}

function queryClause(params: Params, pattern: string | null): string | null {
	if (pattern === null) return null;
	const titlePlaceholder: string = params.add(pattern);
	const namePlaceholder: string = params.add(pattern);
	const emailPlaceholder: string = params.add(pattern);
	return `(LOWER(e.title) LIKE ${titlePlaceholder} ESCAPE '\\' OR EXISTS (
		SELECT 1 FROM recipient r2
		WHERE r2.envelope_id = e.id
			AND (LOWER(r2.name) LIKE ${namePlaceholder} ESCAPE '\\' OR r2.email LIKE ${emailPlaceholder} ESCAPE '\\')
	))`;
}

function cursorClause(params: Params, cursor: string | null): string | null {
	if (cursor === null) return null;
	const idPlaceholder: string = params.add(cursor);
	return `(e.updated_at < (SELECT updated_at FROM cursor_row) OR (e.updated_at = (SELECT updated_at FROM cursor_row) AND e.id < ${idPlaceholder}))`;
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

function fromRow(row: DashboardRow): DashboardItem {
	return {
		envelope: toPublicEnvelope(d1EnvelopeFromRow(row)),
		recipient: toRecipientSummary(row.recipient_name, row.recipient_email),
		recipientCount: row.recipient_count,
		completedRecipientCount: row.completed_count,
		actionableRecipientCount: row.actionable_count,
		nextRecipient: toRecipientSummary(row.next_name, row.next_email),
		actionRequired: row.action_required === 1
	};
}

export class D1DashboardStore implements DashboardStore {
	constructor(private readonly database: D1Database) {}

	async readDashboard(actor: DashboardActor, query: DashboardStoreQuery): Promise<DashboardPage> {
		const pattern: string | null =
			query.query === null ? null : `%${escapeLike(query.query)}%`.toLowerCase();

		const countsParams: Params = new Params();
		const countsCallerPlaceholder1: string = countsParams.add(actor.email);
		const countsCallerPlaceholder2: string = countsParams.add(actor.email);
		const countsStatement = this.database
			.prepare(
				`WITH ${NEXT_ACTIONABLE_CTE}
				SELECT
					COUNT(*) AS all_count,
					COALESCE(SUM(CASE WHEN e.status IN ('draft','ready') THEN 1 ELSE 0 END), 0) AS drafts_count,
					COALESCE(SUM(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_count,
					COALESCE(SUM(CASE WHEN e.status IN ('sent','in_progress') AND ${activeTurnExistsSql(countsCallerPlaceholder1)} THEN 1 ELSE 0 END), 0) AS action_required_count,
					COALESCE(SUM(CASE WHEN e.status IN ('sent','in_progress') AND NOT ${activeTurnExistsSql(countsCallerPlaceholder2)} THEN 1 ELSE 0 END), 0) AS waiting_count
				FROM envelope e
				LEFT JOIN next_actionable na ON na.envelope_id = e.id AND na.rn = 1`
			)
			.bind(...countsParams.bindings());

		const rowsParams: Params = new Params();
		const clauses: string[] = [
			bucketClause(query.view, rowsParams, actor.email),
			queryClause(rowsParams, pattern),
			cursorClause(rowsParams, query.cursor)
		].filter((clause): clause is string => clause !== null);
		const whereSql: string = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
		const actionRequiredPlaceholder: string = rowsParams.add(actor.email);
		const cursorIdPlaceholder: string = rowsParams.add(query.cursor);
		const fetchLimitPlaceholder: string = rowsParams.add(query.limit + 1);
		const rowsStatement = this.database
			.prepare(
				`WITH cursor_row AS (SELECT updated_at FROM envelope WHERE id = ${cursorIdPlaceholder}),
					${NEXT_ACTIONABLE_CTE},
					${FIRST_RECIPIENT_CTE},
					${RECIPIENT_AGG_CTE}
				SELECT
					e.id, e.created_by_user_id, e.title, e.status, e.repository_generation, e.repository_head,
					e.repository_archive_key, e.repository_archive_sha256, e.sent_commit_sha, e.field_generation,
					e.created_at, e.updated_at,
					COALESCE(ra.recipient_count, 0) AS recipient_count,
					COALESCE(ra.completed_count, 0) AS completed_count,
					COALESCE(ra.actionable_count, 0) AS actionable_count,
					fr.email AS recipient_email, fr.name AS recipient_name,
					na.email AS next_email, na.name AS next_name,
					CASE WHEN e.status IN ('sent','in_progress') AND ${activeTurnExistsSql(actionRequiredPlaceholder)} THEN 1 ELSE 0 END AS action_required
				FROM envelope e
				LEFT JOIN recipient_agg ra ON ra.envelope_id = e.id
				LEFT JOIN first_recipient fr ON fr.envelope_id = e.id AND fr.rn = 1
				LEFT JOIN next_actionable na ON na.envelope_id = e.id AND na.rn = 1
				${whereSql}
				ORDER BY e.updated_at DESC, e.id DESC
				LIMIT ${fetchLimitPlaceholder}`
			)
			.bind(...rowsParams.bindings());

		const results = await this.database.batch<CountsRow | DashboardRow>([
			countsStatement,
			rowsStatement
		]);
		const countsRow = (results[0]?.results[0] ?? null) as CountsRow | null;
		const counts: DashboardCounts = {
			all: countsRow?.all_count ?? 0,
			actionRequired: countsRow?.action_required_count ?? 0,
			waiting: countsRow?.waiting_count ?? 0,
			drafts: countsRow?.drafts_count ?? 0,
			completed: countsRow?.completed_count ?? 0
		};
		const allRows: DashboardRow[] = (results[1]?.results ?? []) as DashboardRow[];
		const hasNextPage: boolean = allRows.length > query.limit;
		const rows: DashboardRow[] = hasNextPage ? allRows.slice(0, query.limit) : allRows;
		return {
			items: rows.map(fromRow),
			nextCursor: hasNextPage ? (rows.at(-1)?.id ?? null) : null,
			counts
		};
	}
}
