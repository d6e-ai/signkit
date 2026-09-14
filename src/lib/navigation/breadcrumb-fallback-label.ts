/**
 * Derives a breadcrumb label for a path the breadcrumb component does not
 * otherwise recognize, from the last non-empty URL segment -- e.g.
 * `/some-route` becomes "Some Route". Returns `null` only when there is no
 * segment at all (the root path), in which case the caller renders just the
 * root crumb rather than a second crumb that repeats the brand name.
 */
export function breadcrumbFallbackLabel(pathname: string): string | null {
	const segments: string[] = pathname.split('/').filter((segment: string): boolean => segment.length > 0);
	const lastSegment: string | undefined = segments.at(-1);
	if (!lastSegment) return null;
	return lastSegment
		.split('-')
		.filter((part: string): boolean => part.length > 0)
		.map((part: string): string => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}
