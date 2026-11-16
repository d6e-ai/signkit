/** Navigate independently of the same-origin command that prepared the OAuth flow. */
export function navigateToAuthorization(url: string): void {
	window.location.assign(url);
}
