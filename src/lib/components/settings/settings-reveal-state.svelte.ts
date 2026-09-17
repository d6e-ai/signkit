import * as m from '$lib/paraglide/messages';

export interface RevealedApiKey {
	secret: string;
	keyId: string;
	keyName: string;
}

/**
 * A one-time API key secret must stay on screen across an in-app navigation
 * between the settings child routes. The invitation flow deliberately does
 * not use this state: invitation capabilities are delivered by email and are
 * never exposed to the inviter's browser.
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
	revealedApiKey: RevealedApiKey | null = $state(null);
	apiKeyCopied: boolean = $state(false);
	apiKeyCopyError: string | null = $state(null);
	#apiKeyCopyTimeoutId: ReturnType<typeof setTimeout> | undefined;

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
