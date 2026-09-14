import type { RecipientWorkspace, RecipientWorkspaceApplicationPort } from './recipient-workspace';
import { RecipientWorkspaceIntegrityError } from './recipient-workspace';
import type { RecipientDeclinedReceipt } from './recipient-declined-receipt';
import type {
	RecipientDeclinedReceiptApplicationPort,
	AuthorizedRecipientDeclinedReceipt
} from './recipient-declined-receipt';
import type { RecipientDeclinedReceiptLocator } from '$lib/ports/recipient-declined-receipt-store';
import { DraftIntegrityError } from '$lib/application/drafts/draft-persistence';
import {
	isDeclinedReceiptExpired,
	type DeclinedReceiptSessionLocator
} from '$lib/server/declined-receipt-session';

export type RecipientPageState =
	| ({ state: 'active' } & RecipientWorkspace)
	| ({ state: 'declined' } & RecipientDeclinedReceipt)
	| { state: 'invalid' }
	| { state: 'unavailable' };

interface RecipientPageContext {
	accessHint: string | null;
	envelopeId: string;
	cookie: string | null;
	recoverDeclined?: (token: string, at: Date) => Promise<RecipientDeclinedReceipt | null>;
	platform?: Readonly<App.Platform>;
}

type ApplicationResolver = (context: {
	platform?: Readonly<App.Platform>;
}) => RecipientWorkspaceApplicationPort | null | Promise<RecipientWorkspaceApplicationPort | null>;

type SessionUnsealer = (cookie: string, envelopeId: string) => Promise<string | null>;

interface DeclinedReceiptPageContext {
	envelopeId: string;
	cookie: string | null;
	platform?: Readonly<App.Platform>;
}

type DeclinedReceiptApplicationResolver = (context: {
	platform?: Readonly<App.Platform>;
}) =>
	| RecipientDeclinedReceiptApplicationPort
	| null
	| Promise<RecipientDeclinedReceiptApplicationPort | null>;

type DeclinedReceiptSessionUnsealer = (
	cookie: string,
	envelopeId: string
) => Promise<DeclinedReceiptSessionLocator | null>;

export async function resolveRecipientPage(
	context: RecipientPageContext,
	resolveApplication: ApplicationResolver,
	unsealSession: SessionUnsealer,
	now: () => Date = (): Date => new Date()
): Promise<RecipientPageState> {
	// Non-terminal invalid/unreadable/mismatch outcomes are overwrite-only:
	// they must not Set-Cookie delete, or a late response can wipe a newer
	// same-envelope /s exchange.
	if (context.accessHint === 'invalid') return { state: 'invalid' };
	if (context.accessHint === 'unavailable') return { state: 'unavailable' };
	if (context.cookie === null) return { state: 'invalid' };

	try {
		const token: string | null = await unsealSession(context.cookie, context.envelopeId);
		if (token === null) {
			return { state: 'invalid' };
		}
		const resolvedAt: Date = now();
		const declined: RecipientDeclinedReceipt | null =
			context.recoverDeclined === undefined
				? null
				: await context.recoverDeclined(token, resolvedAt);
		if (declined !== null) {
			if (declined.envelopeId !== context.envelopeId) {
				return { state: 'invalid' };
			}
			return { state: 'declined', ...declined };
		}

		const application: RecipientWorkspaceApplicationPort | null = await resolveApplication({
			platform: context.platform
		});
		if (application === null) return { state: 'unavailable' };
		const workspace: RecipientWorkspace | null = await application.resolve(
			token,
			resolvedAt.toISOString()
		);
		if (workspace === null) {
			return { state: 'invalid' };
		}
		if (workspace.access.envelopeId !== context.envelopeId) {
			return { state: 'invalid' };
		}
		return { state: 'active', ...workspace };
	} catch (error: unknown) {
		console.error(
			JSON.stringify({
				event:
					error instanceof DraftIntegrityError || error instanceof RecipientWorkspaceIntegrityError
						? 'recipient_page_integrity_failed'
						: 'recipient_page_resolution_failed'
			})
		);
		return { state: 'unavailable' };
	}
}

export async function resolveDeclinedReceiptPage(
	context: DeclinedReceiptPageContext,
	resolveApplication: DeclinedReceiptApplicationResolver,
	unsealSession: DeclinedReceiptSessionUnsealer,
	now: () => Date = (): Date => new Date()
): Promise<RecipientPageState> {
	if (context.cookie === null) return { state: 'invalid' };

	try {
		const locator: DeclinedReceiptSessionLocator | null = await unsealSession(
			context.cookie,
			context.envelopeId
		);
		const resolvedAt: Date = now();
		if (
			locator === null ||
			locator.envelopeId !== context.envelopeId ||
			isDeclinedReceiptExpired(locator, resolvedAt)
		) {
			return { state: 'invalid' };
		}
		const application: RecipientDeclinedReceiptApplicationPort | null = await resolveApplication({
			platform: context.platform
		});
		if (application === null) return { state: 'unavailable' };
		const receiptLocator: RecipientDeclinedReceiptLocator = {
			organizationId: locator.organizationId,
			envelopeId: locator.envelopeId,
			recipientId: locator.recipientId,
			idempotencyKey: locator.idempotencyKey,
			capabilityHash: locator.capabilityHash,
			declinedAt: locator.declinedAt,
			expiresAt: locator.expiresAt
		};
		const authorized: AuthorizedRecipientDeclinedReceipt | null = await application.resolveLocator(
			receiptLocator,
			resolvedAt
		);
		if (authorized === null || authorized.receipt.envelopeId !== context.envelopeId) {
			return { state: 'invalid' };
		}
		return { state: 'declined', ...authorized.receipt };
	} catch {
		console.error(JSON.stringify({ event: 'recipient_declined_receipt_page_resolution_failed' }));
		return { state: 'unavailable' };
	}
}
