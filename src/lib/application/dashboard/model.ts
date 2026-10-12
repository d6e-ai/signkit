import type { PublicEnvelope } from '$lib/application/envelopes/model';

/**
 * The dashboard's one filter axis. `action_required` and `waiting` are
 * mutually exclusive subsets of `sent`/`in_progress` envelopes: an envelope
 * is `action_required` only while the signed-in caller personally holds the
 * active turn, and `waiting` otherwise (out for someone else's turn, or the
 * caller's turn has not arrived yet). `drafts` covers `draft` and `ready`.
 * `completed` covers only `completed`. `all` is unfiltered and is the only
 * view that still surfaces `declined`/`expired`/`voided` envelopes.
 */
export type DashboardView = 'all' | 'action_required' | 'waiting' | 'drafts' | 'completed';

export const DASHBOARD_VIEWS: readonly DashboardView[] = [
	'all',
	'action_required',
	'waiting',
	'drafts',
	'completed'
];

/** A recipient projection narrow enough for a worklist row: no id, no status. */
export interface DashboardRecipientSummary {
	name: string;
	email: string;
}

/**
 * One worklist row. `recipient` is a display-only "who this is with"
 * summary -- the first recipient by routing order, then id, regardless of
 * role or status. `nextRecipient` is the earliest outstanding
 * signer/approver currently holding the active turn (`null` once every
 * actionable recipient has decided). `actionRequired` is the sole authority
 * for whether the signed-in caller personally holds that turn right now; it
 * is computed from every recipient sharing the active turn's routing order,
 * not merely from whichever one happens to be `nextRecipient`, so a parallel
 * co-signer's own turn is never missed.
 */
export interface DashboardItem {
	envelope: PublicEnvelope;
	recipient: DashboardRecipientSummary | null;
	recipientCount: number;
	completedRecipientCount: number;
	actionableRecipientCount: number;
	nextRecipient: DashboardRecipientSummary | null;
	actionRequired: boolean;
}

export interface DashboardCounts {
	all: number;
	actionRequired: number;
	waiting: number;
	drafts: number;
	completed: number;
}

/**
 * `counts` reflects the whole instance for every view, independent of `q`:
 * it is what the view-switcher badges render, and a search in progress must
 * never make those badges look like they dropped to the filtered count.
 */
export interface DashboardPage {
	items: readonly DashboardItem[];
	nextCursor: string | null;
	counts: DashboardCounts;
}

export interface DashboardQuery {
	view: DashboardView;
	query: string;
	cursor: string | null;
	limit: number;
}

export function isDashboardView(value: string): value is DashboardView {
	return (DASHBOARD_VIEWS as readonly string[]).includes(value);
}
