/**
 * Whether `pathname` is a capability-link surface: recipient signing (`/s`,
 * `/sign`) or the post-completion receipt (`/c`). Visitors to any of these
 * are never SignKit account holders -- they authenticate with a capability
 * or completion-grant token, not a d6e-auth session -- so callers use this
 * to exempt the path from both the operator auth gate and the bare app
 * shell.
 */
export function isRecipientSurfacePath(pathname: string): boolean {
	const segments: string[] = pathname
		.split('/')
		.filter((segment: string): boolean => segment.length > 0);
	const routeIndex: number = segments[0] === 'en' || segments[0] === 'ja' ? 1 : 0;
	const route: string | undefined = segments[routeIndex];
	return route === 's' || route === 'sign' || route === 'c';
}
