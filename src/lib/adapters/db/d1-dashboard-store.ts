import { d1EnvelopeFromRow, type D1EnvelopeRow } from './d1-envelope-store';
import { toPublicEnvelope } from '$lib/application/envelopes/model';
import { encodeDashboardCursor } from '$lib/application/dashboard/cursor';
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

/**
 * True exactly when some recipient sharing the active turn's routing order
 * (the lowest routing order among this envelope's outstanding signer/approver
 * recipients) is the caller. Checking every recipient at that routing order --
 * not merely whichever one happens to be displayed as `nextRecipient` -- is
 * what keeps a parallel co-signer's own turn from being missed.
 *
 * Deliberately a correlated-per-envelope subquery (indexed by
 * `recipient_envelope_role_status`/`recipient_envelope_route`, both leading
 * with `envelope_id`), not a `ROW_NUMBER()` window over the whole recipient
 * table: every caller of this predicate -- the counts query, the page bucket
 * filter, and the final `action_required` column -- only ever evaluates it
 * for one already-identified envelope at a time, so it never windows or
 * groups recipients across envelopes outside whatever set is already being
 * considered.
 */
function activeTurnExistsSql(envelopeAlias: string, callerEmailPlaceholder: string): string {
	return `EXISTS (
		SELECT 1 FROM recipient r
		WHERE r.envelope_id = ${envelopeAlias}.id
			AND r.role IN ('signer','approver')
			AND r.status IN ('pending','viewed')
			AND r.routing_order = (
				SELECT MIN(r2.routing_order) FROM recipient r2
				WHERE r2.envelope_id = ${envelopeAlias}.id
					AND r2.role IN ('signer','approver')
					AND r2.status IN ('pending','viewed')
			)
			AND r.email = ${callerEmailPlaceholder}
	)`;
}

function bucketClause(
	envelopeAlias: string,
	view: DashboardView,
	params: Params,
	callerEmail: string
): string | null {
	switch (view) {
		case 'all':
			return null;
		case 'drafts':
			return `${envelopeAlias}.status IN ('draft','ready')`;
		case 'completed':
			return `${envelopeAlias}.status = 'completed'`;
		case 'action_required':
			return `${envelopeAlias}.status IN ('sent','in_progress') AND ${activeTurnExistsSql(envelopeAlias, params.add(callerEmail))}`;
		case 'waiting':
			return `${envelopeAlias}.status IN ('sent','in_progress') AND NOT ${activeTurnExistsSql(envelopeAlias, params.add(callerEmail))}`;
	}
}

function queryClause(envelopeAlias: string, params: Params, pattern: string | null): string | null {
	if (pattern === null) return null;
	const titlePlaceholder: string = params.add(pattern);
	const namePlaceholder: string = params.add(pattern);
	const emailPlaceholder: string = params.add(pattern);
	return `(LOWER(${envelopeAlias}.title) LIKE LOWER(${titlePlaceholder}) ESCAPE '\\' OR EXISTS (
		SELECT 1 FROM recipient r2
		WHERE r2.envelope_id = ${envelopeAlias}.id
			AND (LOWER(r2.name) LIKE LOWER(${namePlaceholder}) ESCAPE '\\' OR LOWER(r2.email) LIKE LOWER(${emailPlaceholder}) ESCAPE '\\')
	))`;
}

/** Decoded keyset position: never a database lookup, so a mutated or deleted anchor cannot shift the page. */
function cursorClause(
	envelopeAlias: string,
	params: Params,
	cursor: DashboardStoreQuery['cursor']
): string | null {
	if (cursor === null) return null;
	const updatedAtPlaceholder: string = params.add(cursor.updatedAt);
	const idPlaceholder: string = params.add(cursor.id);
	return `(${envelopeAlias}.updated_at < ${updatedAtPlaceholder} OR (${envelopeAlias}.updated_at = ${updatedAtPlaceholder} AND ${envelopeAlias}.id < ${idPlaceholder}))`;
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

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function requireCountsRow(row: unknown): CountsRow {
	if (
		typeof row !== 'object' ||
		row === null ||
		!isFiniteNumber((row as CountsRow).all_count) ||
		!isFiniteNumber((row as CountsRow).drafts_count) ||
		!isFiniteNumber((row as CountsRow).completed_count) ||
		!isFiniteNumber((row as CountsRow).action_required_count) ||
		!isFiniteNumber((row as CountsRow).waiting_count)
	) {
		throw new Error('Dashboard counts query returned a malformed or missing row.');
	}
	return row as CountsRow;
}

export class D1DashboardStore implements DashboardStore {
	constructor(private readonly database: D1Database) {}

	async readDashboard(actor: DashboardActor, query: DashboardStoreQuery): Promise<DashboardPage> {
		const pattern: string | null = query.query === null ? null : `%${escapeLike(query.query)}%`;

		// Whole-instance badge counts are an intentionally independent
		// aggregate: they must reflect every envelope regardless of the
		// current page, search text, or cursor, so this statement always
		// scans the whole `envelope` table once. The active-turn predicate it
		// uses for `action_required`/`waiting` is a correlated per-envelope
		// lookup (see `activeTurnExistsSql`), not a table-wide window, so it
		// never aggregates or windows recipients across envelopes outside the
		// one row currently being summed -- including historical or terminal
		// envelopes, whose recipients this predicate never even reaches since
		// it only runs for rows already matched to `sent`/`in_progress`.
		const countsParams: Params = new Params();
		const countsCallerPlaceholder1: string = countsParams.add(actor.email);
		const countsCallerPlaceholder2: string = countsParams.add(actor.email);
		const countsStatement = this.database
			.prepare(
				`SELECT
					COUNT(*) AS all_count,
					COALESCE(SUM(CASE WHEN e.status IN ('draft','ready') THEN 1 ELSE 0 END), 0) AS drafts_count,
					COALESCE(SUM(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_count,
					COALESCE(SUM(CASE WHEN e.status IN ('sent','in_progress') AND ${activeTurnExistsSql('e', countsCallerPlaceholder1)} THEN 1 ELSE 0 END), 0) AS action_required_count,
					COALESCE(SUM(CASE WHEN e.status IN ('sent','in_progress') AND NOT ${activeTurnExistsSql('e', countsCallerPlaceholder2)} THEN 1 ELSE 0 END), 0) AS waiting_count
				FROM envelope e`
			)
			.bind(...countsParams.bindings());

		// The page of rows is selected first -- ordered, filtered by view,
		// search, and cursor, limited to `limit + 1` -- before any recipient
		// aggregate runs. Every recipient CTE below is then restricted to
		// `envelope_id IN (SELECT id FROM page_envelopes)`, so first-recipient
		// selection, next-actionable-recipient lookup, and progress
		// aggregation only ever window or group over this page's envelopes,
		// never the whole recipient table (including terminal/historical
		// envelopes outside the page).
		const rowsParams: Params = new Params();
		const pageClauses: string[] = [
			bucketClause('e', query.view, rowsParams, actor.email),
			queryClause('e', rowsParams, pattern),
			cursorClause('e', rowsParams, query.cursor)
		].filter((clause): clause is string => clause !== null);
		const pageWhereSql: string =
			pageClauses.length === 0 ? '' : `WHERE ${pageClauses.join(' AND ')}`;
		const fetchLimitPlaceholder: string = rowsParams.add(query.limit + 1);
		const actionRequiredPlaceholder: string = rowsParams.add(actor.email);
		const rowsStatement = this.database
			.prepare(
				`WITH page_envelopes AS (
					SELECT e.id, e.created_by_user_id, e.title, e.status, e.repository_generation,
						e.repository_head, e.repository_archive_key, e.repository_archive_sha256,
						e.sent_commit_sha, e.field_generation, e.created_at, e.updated_at
					FROM envelope e
					${pageWhereSql}
					ORDER BY e.updated_at DESC, e.id DESC
					LIMIT ${fetchLimitPlaceholder}
				),
				next_actionable AS (
					SELECT envelope_id, email, name,
						ROW_NUMBER() OVER (PARTITION BY envelope_id ORDER BY routing_order ASC, id ASC) AS rn
					FROM recipient
					WHERE role IN ('signer','approver') AND status IN ('pending','viewed')
						AND envelope_id IN (SELECT id FROM page_envelopes)
				),
				first_recipient AS (
					SELECT envelope_id, email, name,
						ROW_NUMBER() OVER (PARTITION BY envelope_id ORDER BY routing_order ASC, id ASC) AS rn
					FROM recipient
					WHERE envelope_id IN (SELECT id FROM page_envelopes)
				),
				recipient_agg AS (
					SELECT envelope_id,
						COUNT(*) AS recipient_count,
						SUM(CASE WHEN role IN ('signer','approver') AND status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
						SUM(CASE WHEN role IN ('signer','approver') THEN 1 ELSE 0 END) AS actionable_count
					FROM recipient
					WHERE envelope_id IN (SELECT id FROM page_envelopes)
					GROUP BY envelope_id
				)
				SELECT
					pe.id, pe.created_by_user_id, pe.title, pe.status, pe.repository_generation, pe.repository_head,
					pe.repository_archive_key, pe.repository_archive_sha256, pe.sent_commit_sha, pe.field_generation,
					pe.created_at, pe.updated_at,
					COALESCE(ra.recipient_count, 0) AS recipient_count,
					COALESCE(ra.completed_count, 0) AS completed_count,
					COALESCE(ra.actionable_count, 0) AS actionable_count,
					fr.email AS recipient_email, fr.name AS recipient_name,
					na.email AS next_email, na.name AS next_name,
					CASE WHEN pe.status IN ('sent','in_progress') AND ${activeTurnExistsSql('pe', actionRequiredPlaceholder)} THEN 1 ELSE 0 END AS action_required
				FROM page_envelopes pe
				LEFT JOIN recipient_agg ra ON ra.envelope_id = pe.id
				LEFT JOIN first_recipient fr ON fr.envelope_id = pe.id AND fr.rn = 1
				LEFT JOIN next_actionable na ON na.envelope_id = pe.id AND na.rn = 1
				ORDER BY pe.updated_at DESC, pe.id DESC`
			)
			.bind(...rowsParams.bindings());

		const results = await this.database.batch<CountsRow | DashboardRow>([
			countsStatement,
			rowsStatement
		]);
		if (results.length !== 2 || results[0]?.success !== true || results[1]?.success !== true) {
			throw new Error('Dashboard worklist batch did not complete successfully.');
		}
		const counts: DashboardCounts = {
			all: requireCountsRow(results[0].results[0]).all_count,
			actionRequired: requireCountsRow(results[0].results[0]).action_required_count,
			waiting: requireCountsRow(results[0].results[0]).waiting_count,
			drafts: requireCountsRow(results[0].results[0]).drafts_count,
			completed: requireCountsRow(results[0].results[0]).completed_count
		};
		const allRows: DashboardRow[] = results[1].results as DashboardRow[];
		const hasNextPage: boolean = allRows.length > query.limit;
		const rows: DashboardRow[] = hasNextPage ? allRows.slice(0, query.limit) : allRows;
		const lastRow = rows.at(-1);
		return {
			items: rows.map(fromRow),
			nextCursor:
				hasNextPage && lastRow !== undefined
					? encodeDashboardCursor(query.view, query.query, {
							updatedAt: lastRow.updated_at,
							id: lastRow.id
						})
					: null,
			counts
		};
	}
}
