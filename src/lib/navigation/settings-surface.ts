export function isSettingsSurfacePath(pathname: string): boolean {
	const segments: string[] = pathname
		.split('/')
		.filter((segment: string): boolean => segment.length > 0);
	const routeIndex: number = segments[0] === 'en' || segments[0] === 'ja' ? 1 : 0;
	const route: string | undefined = segments[routeIndex];
	return route === 'settings';
}
