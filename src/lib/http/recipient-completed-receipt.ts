import type { Cookies } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type {
	AuthorizedRecipientCompletedReceipt,
	RecipientCompletedReceiptApplicationPort
} from '$lib/application/signing/recipient-completed-receipt';
import type { RecipientCompletedReceiptAction } from '$lib/ports/recipient-completed-receipt-store';
import {
	COMPLETED_RECEIPT_COOKIE_MAX_AGE_SECONDS,
	COMPLETED_RECEIPT_COOKIE_OPTIONS,
	type CompletedReceiptSessionLocator,
	completedReceiptCookieName,
	sealCompletedReceiptSession
} from '$lib/server/completed-receipt-session';
import { deleteRecipientSessionCookie } from '$lib/server/recipient-session';

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type RecipientCompletedReceiptApplicationResolver = (
	context: ResolverContext
) =>
	| RecipientCompletedReceiptApplicationPort
	| null
	| Promise<RecipientCompletedReceiptApplicationPort | null>;

export type CompletedReceiptSessionSealer = (
	locator: CompletedReceiptSessionLocator
) => Promise<string>;

export interface RecipientCompletedReceiptHandlerOptions {
	resolveReceiptApplication: RecipientCompletedReceiptApplicationResolver;
	sealReceiptSession?: CompletedReceiptSessionSealer;
	now?: () => Date;
	allowInsecureLocalDevelopment?: boolean;
}

/**
 * The terminal command this response already committed. Every field is
 * re-proven against durable receipt evidence before any read-only authority is
 * granted; nothing here is trusted on its own.
 */
export interface CommittedRecipientAction {
	envelopeId: string;
	recipientId: string;
	action: RecipientCompletedReceiptAction;
	idempotencyKey: string;
	completedAt: string;
}

export interface CompletedReceiptExchange {
	token: string;
	committed: CommittedRecipientAction;
	url: URL;
	platform?: Readonly<App.Platform>;
	cookies: Cookies;
	options?: RecipientCompletedReceiptHandlerOptions;
}

/**
 * Browser-only tail of a durable sign or approve. The recipient's own command
 * revokes the capability their live session cookie still holds, so that cookie
 * has to go; without a replacement the very next tokenless page load falls
 * through to the generic invalid page until the recipient digs out the original
 * invitation email. Recover the authoritative receipt by the capability that
 * was just used, seal the bounded envelope-bound read-only locator, and only
 * then drop the live cookie.
 *
 * Returns whether read-only authority was granted. Callers must not turn a
 * false into a failed-command response: the command is already durable and
 * reporting failure would invite an irreversible retry.
 */
export async function exchangeCompletedReceiptCookie(
	exchange: CompletedReceiptExchange
): Promise<boolean> {
	const granted: boolean =
		exchange.options === undefined ? false : await sealReceiptCookie(exchange, exchange.options);
	// Ordered same-envelope exchange: the read-only cookie above is already set
	// when it could be proven. The live capability is never kept as a substitute
	// for a receipt, so this deletion runs whether or not the exchange succeeded.
	retireActiveSessionCookie(exchange);
	return granted;
}

/**
 * Only ever reached after the command is durable, so a failure to emit the
 * deletion must not escape: the outer handler would turn it into a 503 for a
 * sign or approve that actually succeeded, and prompt an irreversible retry.
 * Uncommitted outcomes never call the exchange, so no error is hidden for an
 * action that did not happen.
 *
 * Swallowing it grants nothing. The command already revoked the capability this
 * cookie seals, so a value left in the browser carries no live authority and
 * the next request fails closed on it exactly as it would on any stale cookie.
 */
function retireActiveSessionCookie(exchange: CompletedReceiptExchange): void {
	try {
		deleteRecipientSessionCookie(exchange.cookies, exchange.committed.envelopeId);
	} catch {
		console.error(
			JSON.stringify({
				event: 'recipient_completed_receipt_session_retirement_failed',
				action: exchange.committed.action
			})
		);
	}
}

async function sealReceiptCookie(
	exchange: CompletedReceiptExchange,
	options: RecipientCompletedReceiptHandlerOptions
): Promise<boolean> {
	const action: RecipientCompletedReceiptAction = exchange.committed.action;
	try {
		const application: RecipientCompletedReceiptApplicationPort | null =
			await options.resolveReceiptApplication({ platform: exchange.platform });
		if (application === null) return exchangeFailed(action);
		const now: Date = options.now?.() ?? new Date();
		const authorized: AuthorizedRecipientCompletedReceipt | null = await application.recoverByToken(
			exchange.token,
			now
		);
		if (authorized === null || !provesCommittedAction(authorized, exchange.committed)) {
			return exchangeFailed(action);
		}
		const remainingSeconds: number = remainingReceiptSeconds(authorized.locator.expiresAt, now);
		if (remainingSeconds <= 0) return exchangeFailed(action);
		const cookieName: string | null = completedReceiptCookieName(exchange.committed.envelopeId);
		if (cookieName === null) return exchangeFailed(action);
		const locator: CompletedReceiptSessionLocator = { ...authorized.locator, version: 1 };
		const seal: CompletedReceiptSessionSealer =
			options.sealReceiptSession ?? sealCompletedReceiptSession;
		const sealed: string = await seal(locator);
		exchange.cookies.set(cookieName, sealed, {
			...COMPLETED_RECEIPT_COOKIE_OPTIONS,
			secure: !isInsecureLocalDevelopment(
				exchange.url,
				options.allowInsecureLocalDevelopment ?? dev
			),
			maxAge: remainingSeconds
		});
		return true;
	} catch {
		return exchangeFailed(action);
	}
}

/**
 * One fixed, non-sensitive line. The capability and the thrown object stay out
 * of it: this runs on a path a recipient can reach with a revoked or replayed
 * token.
 */
function exchangeFailed(action: RecipientCompletedReceiptAction): false {
	console.error(JSON.stringify({ event: 'recipient_completed_receipt_exchange_failed', action }));
	return false;
}

function provesCommittedAction(
	authorized: AuthorizedRecipientCompletedReceipt,
	committed: CommittedRecipientAction
): boolean {
	// `receipt.envelopeStatus` is deliberately not compared with the status the
	// command returned: it is whole-envelope progress, and another recipient may
	// legitimately advance the envelope between this publication or replay and
	// this read. Valid evidence for this recipient's own action must not be
	// rejected over that race.
	return (
		authorized.receipt.envelopeId === committed.envelopeId &&
		authorized.locator.envelopeId === committed.envelopeId &&
		authorized.receipt.recipientId === committed.recipientId &&
		authorized.locator.recipientId === committed.recipientId &&
		authorized.receipt.action === committed.action &&
		authorized.locator.action === committed.action &&
		authorized.locator.idempotencyKey === committed.idempotencyKey &&
		sameInstant(authorized.receipt.completedAt, committed.completedAt) &&
		sameInstant(authorized.locator.completedAt, committed.completedAt)
	);
}

/** Evidence timestamps are canonicalized ISO strings; command results are not. */
function sameInstant(left: string, right: string): boolean {
	const leftMilliseconds: number = Date.parse(left);
	const rightMilliseconds: number = Date.parse(right);
	return Number.isFinite(leftMilliseconds) && leftMilliseconds === rightMilliseconds;
}

function remainingReceiptSeconds(expiresAt: string, now: Date): number {
	const remainingSeconds: number = Math.floor((Date.parse(expiresAt) - now.valueOf()) / 1000);
	if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) return 0;
	return Math.min(remainingSeconds, COMPLETED_RECEIPT_COOKIE_MAX_AGE_SECONDS);
}

function isInsecureLocalDevelopment(url: URL, allowed: boolean): boolean {
	if (!allowed || url.protocol !== 'http:') return false;
	return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}
