import {
	GITHUB_ALLOWED_HOSTS,
	GITHUB_API_ORIGIN,
	GITHUB_DOWNLOAD_ORIGIN,
	PACKAGE_NAME,
	PACKAGE_VERSION,
	SIGNKIT_REPOSITORY
} from '../constants.js';
import { generic, unavailable } from '../cli/errors.js';
import type { HttpClient } from '../runtime/http.js';

/** URL and download rules shared by every GitHub Release asset the CLI reads. */
export const RELEASE_USER_AGENT = `${PACKAGE_NAME}/${PACKAGE_VERSION}`;

export function githubDownloadUrl(tag: string, assetName: string): string {
	return `${GITHUB_DOWNLOAD_ORIGIN}/${SIGNKIT_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

export function assertReleaseAssetUrl(urlText: string, tag: string, assetName: string): URL {
	const expected = githubDownloadUrl(tag, assetName);
	const url = new URL(urlText);
	if (url.origin !== GITHUB_DOWNLOAD_ORIGIN && url.origin !== GITHUB_API_ORIGIN) {
		throw generic(`asset URL origin ${url.origin} is not an allowed GitHub origin`);
	}
	if (url.origin === GITHUB_DOWNLOAD_ORIGIN && url.toString() !== expected) {
		throw generic(`asset URL ${urlText} does not match the expected GitHub release download URL`);
	}
	if (url.origin === GITHUB_API_ORIGIN) {
		const allowed = new RegExp(
			`^/repos/${SIGNKIT_REPOSITORY.replace('/', '\\/')}/releases/assets/\\d+$`
		);
		if (!allowed.test(url.pathname)) {
			throw generic(`asset URL ${urlText} is not a SignKit release asset`);
		}
	}
	if (!GITHUB_ALLOWED_HOSTS.has(url.hostname)) {
		throw generic(`asset URL host ${url.hostname} is not allowed`);
	}
	return url;
}

/**
 * Downloads one release asset by name from the release download URL, with the
 * same host allowlist, redirect policy, and exact-size bound as the Cloudflare
 * bundle download. `size` is the size GitHub listed for the asset.
 */
export async function downloadReleaseAsset(
	http: HttpClient,
	input: { tag: string; assetName: string; size: number; maxBytes: number; label: string }
): Promise<Uint8Array> {
	if (!Number.isSafeInteger(input.size) || input.size <= 0) {
		throw generic(`${input.label} has an invalid size`);
	}
	if (input.size > input.maxBytes) {
		throw generic(`${input.label} size ${input.size} exceeds ${input.maxBytes}`);
	}
	const url = githubDownloadUrl(input.tag, input.assetName);
	assertReleaseAssetUrl(url, input.tag, input.assetName);
	const response = await http.request({
		url,
		maxBytes: input.size,
		allowedHosts: GITHUB_ALLOWED_HOSTS,
		headers: { 'user-agent': RELEASE_USER_AGENT, accept: 'application/octet-stream' }
	});
	if (response.status !== 200) {
		throw unavailable(`failed to download ${input.label} (HTTP ${response.status})`);
	}
	if (response.body.byteLength !== input.size) {
		throw generic(
			`downloaded ${input.label} size ${response.body.byteLength} does not match the release asset size ${input.size}`
		);
	}
	return response.body;
}
