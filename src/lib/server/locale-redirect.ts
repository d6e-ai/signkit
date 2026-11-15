import { baseLocale, isLocale, toLocale, type Locale } from '$lib/paraglide/runtime';
import { isRecipientSurfacePath } from '$lib/navigation/recipient-surface';

/** Resolve only the destination of a locale-less page navigation. */
export function preferredRedirectLocale(
	savedLocale: string | undefined,
	acceptLanguage: string | null
): Locale {
	if (isLocale(savedLocale)) return savedLocale;
	let selected: Locale = baseLocale;
	let selectedQuality = 0;
	for (const preference of acceptLanguage?.split(',') ?? []) {
		const [rawRange, ...parameters] = preference.trim().split(';');
		const range = rawRange?.trim();
		if (!range || !/^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/i.test(range)) continue;
		let quality = 1;
		if (parameters.length > 0) {
			if (parameters.length !== 1) continue;
			const weight = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i.exec(parameters[0].trim());
			if (!weight) continue;
			quality = Number(weight[1]);
		}
		const locale = toLocale(range) ?? toLocale(range.split('-')[0]);
		if (locale && quality > selectedQuality) {
			selected = locale;
			selectedQuality = quality;
		}
	}
	return selected;
}

/** Called after the hook's machine-route exclusion, before Paraglide middleware. */
export function localePreferenceRedirect(
	url: URL,
	request: Request,
	savedLocale: string | undefined
): Response | null {
	if (request.method !== 'GET' && request.method !== 'HEAD') return null;
	const destination = request.headers.get('sec-fetch-dest');
	if (destination !== 'document') {
		if (destination !== null || !/\btext\/html\b/i.test(request.headers.get('accept') ?? '')) {
			return null;
		}
	}
	const firstSegment = url.pathname.split('/')[1];
	if (
		isLocale(firstSegment) ||
		isRecipientSurfacePath(url.pathname) ||
		firstSegment === '_app' ||
		url.pathname.split('/').at(-1)?.includes('.')
	) {
		return null;
	}
	const locale = preferredRedirectLocale(savedLocale, request.headers.get('accept-language'));
	return new Response(null, {
		status: 307,
		headers: {
			location: `/${locale}${url.pathname === '/' ? '' : url.pathname}${url.search}`,
			'cache-control': 'private, no-store',
			vary: 'Cookie, Accept-Language'
		}
	});
}
