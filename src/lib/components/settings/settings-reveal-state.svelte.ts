import * as m from '$lib/paraglide/messages';

export interface RevealedInvitation {
	token: string;
	invitationId: string;
	email: string;
}

export interface RevealedApiKey {
	secret: string;
	keyId: string;
	keyName: string;
}

/**
 * A one-time secret (invitation token, API key) must stay on screen across an
 * in-app navigation between the settings child routes -- the sidebar and
 * breadcrumbs are ordinary SvelteKit links, and a caller who glances at
 * Members and comes back to Invitations must not lose the only copy of a
 * token they have not saved yet.
 *
 * This is deliberately plain module-level `$state`, not a per-component
 * store: the class below is instantiated exactly once when this module is
 * first imported, so the instance lives for as long as the browser tab does
 * -- surviving client-side navigation, but gone on an actual reload, exactly
 * like the requirement calls for. It is never written to localStorage,
 * sessionStorage, a cookie, the URL, or server data.
 *
 * Every mutator is guarded to browser-only execution. Nothing in this file
 * is ever called from a `load` function or during SSR, but the guard is
 * kept anyway as a hard backstop: a Cloudflare Worker isolate can reuse this
 * module's scope across unrelated requests, so a write that somehow
 * happened during server rendering would otherwise leak one caller's secret
 * into another caller's SSR output.
 */
class SettingsRevealState {
	revealedInvitation: RevealedInvitation | null = $state(null);
	invitationCopied: boolean = $state(false);
	invitationCopyError: string | null = $state(null);
	#invitationCopyTimeoutId: ReturnType<typeof setTimeout> | undefined;

	revealedApiKey: RevealedApiKey | null = $state(null);
	apiKeyCopied: boolean = $state(false);
	apiKeyCopyError: string | null = $state(null);
	#apiKeyCopyTimeoutId: ReturnType<typeof setTimeout> | undefined;

	// Replaces the revealed secret only once a fresh token has actually
	// arrived. A failed request, or a replay that discloses no token, must
	// leave the previous one-time token on screen: clearing it up front would
	// destroy the only copy the inviter will ever be shown.
	setRevealedInvitation(value: RevealedInvitation): void {
		if (typeof window === 'undefined') return;
		this.#resetInvitationCopyFeedback();
		this.revealedInvitation = value;
	}

	dismissRevealedInvitation(): void {
		if (typeof window === 'undefined') return;
		this.revealedInvitation = null;
		this.#resetInvitationCopyFeedback();
	}

	async copyInvitationToken(text: string): Promise<void> {
		if (typeof window === 'undefined') return;
		this.invitationCopyError = null;
		try {
			await navigator.clipboard.writeText(text);
			this.invitationCopied = true;
			clearTimeout(this.#invitationCopyTimeoutId);
			this.#invitationCopyTimeoutId = setTimeout(() => {
				this.invitationCopied = false;
				this.#invitationCopyTimeoutId = undefined;
			}, 2000);
		} catch {
			this.invitationCopyError = m.settings_clipboard_copy_failed();
		}
	}

	#resetInvitationCopyFeedback(): void {
		clearTimeout(this.#invitationCopyTimeoutId);
		this.#invitationCopyTimeoutId = undefined;
		this.invitationCopied = false;
		this.invitationCopyError = null;
	}

	// Called when the invitations panel unmounts (route navigation away). The
	// revealed token itself must survive -- only the transient copy feedback
	// and its timer do not, since the timer that would otherwise clear a
	// stale "Copied!" is gone once nothing is observing it, and a caller who
	// returns to this route should never see feedback for a copy action that
	// isn't fresh.
	teardownInvitationPanel(): void {
		if (typeof window === 'undefined') return;
		this.#resetInvitationCopyFeedback();
	}

	setRevealedApiKey(value: RevealedApiKey): void {
		if (typeof window === 'undefined') return;
		this.#resetApiKeyCopyFeedback();
		this.revealedApiKey = value;
	}

	dismissRevealedApiKey(): void {
		if (typeof window === 'undefined') return;
		this.revealedApiKey = null;
		this.#resetApiKeyCopyFeedback();
	}

	async copyApiKeySecret(text: string): Promise<void> {
		if (typeof window === 'undefined') return;
		this.apiKeyCopyError = null;
		try {
			await navigator.clipboard.writeText(text);
			this.apiKeyCopied = true;
			clearTimeout(this.#apiKeyCopyTimeoutId);
			this.#apiKeyCopyTimeoutId = setTimeout(() => {
				this.apiKeyCopied = false;
				this.#apiKeyCopyTimeoutId = undefined;
			}, 2000);
		} catch {
			this.apiKeyCopyError = m.settings_clipboard_copy_failed();
		}
	}

	#resetApiKeyCopyFeedback(): void {
		clearTimeout(this.#apiKeyCopyTimeoutId);
		this.#apiKeyCopyTimeoutId = undefined;
		this.apiKeyCopied = false;
		this.apiKeyCopyError = null;
	}

	teardownApiKeysPanel(): void {
		if (typeof window === 'undefined') return;
		this.#resetApiKeyCopyFeedback();
	}
}

export const settingsRevealState = new SettingsRevealState();
