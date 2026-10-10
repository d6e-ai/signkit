/**
 * v1 release archives have no separate cf module-upload manifest. Accept only
 * the one prebundled ES module that existing installers upload without bundling.
 */
export function assertV1WorkerManifest(manifest) {
	const modules = manifest?.modules;
	const main = manifest?.mainModule;
	if (
		manifest?.type !== 'complete' ||
		typeof main !== 'string' ||
		!/^[a-zA-Z0-9._-]+\.m?js$/.test(main) ||
		typeof modules !== 'object' ||
		modules === null ||
		Array.isArray(modules) ||
		Object.keys(modules).length !== 1 ||
		modules[main]?.type !== 'esm'
	) {
		throw new Error('v1 release requires exactly one top-level prebundled ES Worker module');
	}
	return main;
}
