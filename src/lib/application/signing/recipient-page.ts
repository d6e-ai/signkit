import {
	toPublicRecipientAccess,
	type PublicRecipientAccessContext,
	type RecipientAccessApplicationPort
} from './recipient-access';

export type RecipientPageState =
	| { state: 'active'; access: PublicRecipientAccessContext }
	| { state: 'invalid' }
	| { state: 'unavailable' };

interface RecipientPageContext {
	accessHint: string | null;
	cookie: string | null;
	clearSession(): void;
	platform?: Readonly<App.Platform>;
}

type ApplicationResolver = (context: {
	platform?: Readonly<App.Platform>;
}) => RecipientAccessApplicationPort | null | Promise<RecipientAccessApplicationPort | null>;

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
		const application: RecipientAccessApplicationPort | null = await resolveApplication({
			platform: context.platform
		});
		if (application === null) return { state: 'unavailable' };
		const signingContext = await application.resolve(token, now().toISOString());
		if (signingContext === null) {
			context.clearSession();
			return { state: 'invalid' };
		}
		return { state: 'active', access: toPublicRecipientAccess(signingContext) };
	} catch {
		console.error(JSON.stringify({ event: 'recipient_page_resolution_failed' }));
		return { state: 'unavailable' };
	}
}
