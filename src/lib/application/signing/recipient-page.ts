import type { RecipientWorkspace, RecipientWorkspaceApplicationPort } from './recipient-workspace';
import { RecipientWorkspaceIntegrityError } from './recipient-workspace';
import { DraftIntegrityError } from '$lib/application/drafts/draft-persistence';

export type RecipientPageState =
	({ state: 'active' } & RecipientWorkspace) | { state: 'invalid' } | { state: 'unavailable' };

interface RecipientPageContext {
	accessHint: string | null;
	cookie: string | null;
	clearSession(): void;
	platform?: Readonly<App.Platform>;
}

type ApplicationResolver = (context: {
	platform?: Readonly<App.Platform>;
}) => RecipientWorkspaceApplicationPort | null | Promise<RecipientWorkspaceApplicationPort | null>;

type SessionUnsealer = (cookie: string) => Promise<string | null>;

export async function resolveRecipientPage(
	context: RecipientPageContext,
	resolveApplication: ApplicationResolver,
	unsealSession: SessionUnsealer,
	now: () => Date = (): Date => new Date()
): Promise<RecipientPageState> {
	if (context.accessHint === 'invalid') return { state: 'invalid' };
	if (context.accessHint === 'unavailable') return { state: 'unavailable' };
	if (context.cookie === null) return { state: 'invalid' };

	try {
		const token: string | null = await unsealSession(context.cookie);
		if (token === null) {
			context.clearSession();
			return { state: 'invalid' };
		}
		const application: RecipientWorkspaceApplicationPort | null = await resolveApplication({
			platform: context.platform
		});
		if (application === null) return { state: 'unavailable' };
		const workspace: RecipientWorkspace | null = await application.resolve(
			token,
			now().toISOString()
		);
		if (workspace === null) {
			context.clearSession();
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
