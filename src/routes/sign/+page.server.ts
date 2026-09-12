import type { PageServerLoad } from './$types';
import { resolveRecipientWorkspaceApplication } from '$lib/application/signing/runtime';
import { resolveRecipientPage } from '$lib/application/signing/recipient-page';
import { renderRecipientMarkdown } from '$lib/security/recipient-markdown';
import {
	RECIPIENT_SESSION_COOKIE,
	RECIPIENT_SESSION_COOKIE_PATH,
	unsealRecipientSession
} from '$lib/server/recipient-session';

const MAX_RECIPIENT_DOCUMENTS = 50;
const MAX_RECIPIENT_TOTAL_SOURCE_BYTES = 1024 * 1024;

export const load: PageServerLoad = async ({ cookies, platform, setHeaders, url }) => {
	setHeaders({
		'cache-control': 'private, no-store',
		'referrer-policy': 'no-referrer',
		vary: 'Cookie',
		'x-content-type-options': 'nosniff'
	});
	const page = await resolveRecipientPage(
		{
			accessHint: url.searchParams.get('access'),
			cookie: cookies.get(RECIPIENT_SESSION_COOKIE) ?? null,
			clearSession: (): void =>
				cookies.delete(RECIPIENT_SESSION_COOKIE, { path: RECIPIENT_SESSION_COOKIE_PATH }),
			platform
		},
		resolveRecipientWorkspaceApplication,
		unsealRecipientSession
	);
	if (page.state !== 'active') return page;

	try {
		let totalSourceBytes = 0;
		if (page.documents.length > MAX_RECIPIENT_DOCUMENTS) throw new Error('document_count');
		const documents = page.documents.map((document) => {
			totalSourceBytes += new TextEncoder().encode(document.content).byteLength;
			if (totalSourceBytes > MAX_RECIPIENT_TOTAL_SOURCE_BYTES) {
				throw new Error('document_bytes');
			}
			return { ...document, rendered: renderRecipientMarkdown(document.content) };
		});
		return { ...page, documents };
	} catch {
		console.error(JSON.stringify({ event: 'recipient_page_render_failed' }));
		return { state: 'unavailable' as const };
	}
};
