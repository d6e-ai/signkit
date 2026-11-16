/** Only this public landing page can capture an email link before sign-in. */
export function isInvitationSurfacePath(pathname: string): boolean {
	return /^\/(?:en\/|ja\/)?invitations\/accept\/?$/.test(pathname);
}
