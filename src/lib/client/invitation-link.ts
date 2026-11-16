const STORAGE_KEY = 'signkit:pending-invitation';
const MAX_AGE_MS = 10 * 60 * 1000;
const TOKEN_PATTERN = /^ski1_[A-Za-z0-9_-]{43}$/;

/** Tab-scoped handoff through OAuth; the token never enters the return URL. */
export function readInvitationLink(
	browser: Pick<Window, 'location' | 'history' | 'sessionStorage'>,
	now = Date.now()
): string | null {
	const hash = browser.location.hash;
	if (hash) {
		const token = new URLSearchParams(hash.slice(1)).get('token');
		browser.history.replaceState(
			browser.history.state,
			'',
			browser.location.pathname + browser.location.search
		);
		clearInvitationLink(browser);
		if (!token || !TOKEN_PATTERN.test(token)) return null;
		try {
			browser.sessionStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({ token, expiresAt: now + MAX_AGE_MS })
			);
		} catch {
			// Already signed-in users can still accept in memory. A signed-out
			// user can reopen the email link after completing sign-in.
		}
		return token;
	}
	try {
		const pending: unknown = JSON.parse(browser.sessionStorage.getItem(STORAGE_KEY) ?? 'null');
		if (
			pending !== null &&
			typeof pending === 'object' &&
			'token' in pending &&
			typeof pending.token === 'string' &&
			TOKEN_PATTERN.test(pending.token) &&
			'expiresAt' in pending &&
			typeof pending.expiresAt === 'number' &&
			pending.expiresAt > now &&
			pending.expiresAt <= now + MAX_AGE_MS
		) {
			return pending.token;
		}
	} catch {
		// Missing, corrupt or inaccessible tab storage is not an invitation.
	}
	clearInvitationLink(browser);
	return null;
}

export function clearInvitationLink(browser: Pick<Window, 'sessionStorage'>): void {
	try {
		browser.sessionStorage.removeItem(STORAGE_KEY);
	} catch {
		// Storage may be unavailable in a privacy-restricted browser.
	}
}
