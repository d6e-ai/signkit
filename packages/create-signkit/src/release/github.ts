import { createHash } from 'node:crypto';
import {
	GITHUB_ALLOWED_HOSTS,
	GITHUB_API_ORIGIN,
	GITHUB_DOWNLOAD_ORIGIN,
	MANIFEST_ASSET_NAME,
	MAX_BUNDLE_BYTES,
	MAX_MANIFEST_BYTES,
	MAX_RELEASE_LIST_BYTES,
	PACKAGE_NAME,
	PACKAGE_VERSION,
	SIGNKIT_REPOSITORY
} from '../constants.js';
import { generic, unavailable } from '../cli/errors.js';
import type { ReleaseChannel } from '../cli/parse.js';
import type { HttpClient } from '../runtime/http.js';
import { utf8 } from '../runtime/http.js';
import { parseReleaseManifest, type ReleaseManifest } from './manifest.js';
import {
	createGithubProvenanceVerifier,
	type ProvenanceVerifier,
	type ReleaseProvenance
} from './provenance.js';
import {
	compareReleaseTags,
	parseReleaseTag,
	tagHasSemverPrerelease,
	type ParsedReleaseTag
} from './semver.js';

export interface GithubReleaseAsset {
	name: string;
	size: number;
	browser_download_url: string;
	content_type?: string;
}

export interface GithubRelease {
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	target_commitish?: string;
	assets: GithubReleaseAsset[];
}

export interface ResolvedRelease {
	tag: string;
	channel: ReleaseChannel;
	prerelease: boolean;
	commit?: string;
	manifest: ReleaseManifest;
	manifestUrl: string;
	bundleUrl: string;
}

export interface ReleaseResolver {
	resolve(input: { version: string; channel: ReleaseChannel }): Promise<ResolvedRelease>;
	prepareBundle(release: ResolvedRelease): Promise<PreparedReleaseBundle>;
}

export interface PreparedReleaseBundle {
	bytes: Uint8Array;
	provenance: ReleaseProvenance;
}

const USER_AGENT = `${PACKAGE_NAME}/${PACKAGE_VERSION}`;
const ACCEPT_JSON = 'application/vnd.github+json';

export function createGithubReleaseResolver(
	http: HttpClient,
	provenance: ProvenanceVerifier = createGithubProvenanceVerifier(http)
): ReleaseResolver {
	return {
		resolve(input) {
			return resolveRelease(http, input);
		},
		async prepareBundle(release) {
			const bytes = await downloadValidatedBundle(http, release);
			const digest = sha256Hex(bytes);
			return { bytes, provenance: await provenance.verify(release, digest) };
		}
	};
}

export function githubDownloadUrl(tag: string, assetName: string): string {
	return `${GITHUB_DOWNLOAD_ORIGIN}/${SIGNKIT_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

export function githubApiUrl(path: string): string {
	return `${GITHUB_API_ORIGIN}/repos/${SIGNKIT_REPOSITORY}${path}`;
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
			throw generic(`asset API URL ${urlText} is not a SignKit release asset`);
		}
	}
	if (!GITHUB_ALLOWED_HOSTS.has(url.hostname)) {
		throw generic(`asset URL host ${url.hostname} is not allowed`);
	}
	return url;
}

async function resolveRelease(
	http: HttpClient,
	input: { version: string; channel: ReleaseChannel }
): Promise<ResolvedRelease> {
	const release = await selectRelease(http, input);
	assertSupportedReleaseTag(release.tag_name);
	if (release.draft) {
		throw generic(`refusing draft GitHub release ${release.tag_name}`);
	}
	const manifestAsset = release.assets.find((asset) => asset.name === MANIFEST_ASSET_NAME);
	if (!manifestAsset) {
		throw generic(`GitHub release ${release.tag_name} is missing ${MANIFEST_ASSET_NAME}`);
	}
	const manifestUrl = githubDownloadUrl(release.tag_name, manifestAsset.name);
	assertReleaseAssetUrl(manifestAsset.browser_download_url, release.tag_name, manifestAsset.name);
	const manifestResponse = await http.request({
		url: manifestUrl,
		maxBytes: MAX_MANIFEST_BYTES,
		allowedHosts: GITHUB_ALLOWED_HOSTS,
		headers: { 'user-agent': USER_AGENT, accept: 'application/json' }
	});
	if (manifestResponse.status !== 200) {
		throw unavailable(`failed to download release manifest (HTTP ${manifestResponse.status})`);
	}
	const commit = await resolveReleaseCommit(http, release);
	const manifest = parseReleaseManifest(utf8(manifestResponse.body), {
		tag: release.tag_name,
		commit
	});
	assertRequestedChannel(input.channel, release, manifest);
	const bundleUrl = githubDownloadUrl(release.tag_name, manifest.bundle.assetName);
	const bundleAsset = release.assets.find((asset) => asset.name === manifest.bundle.assetName);
	if (!bundleAsset) {
		throw generic(
			`GitHub release ${release.tag_name} is missing bundle asset ${manifest.bundle.assetName}`
		);
	}
	if (bundleAsset.size !== manifest.bundle.size) {
		throw generic(
			`bundle size on GitHub (${bundleAsset.size}) does not match the manifest (${manifest.bundle.size})`
		);
	}
	assertReleaseAssetUrl(
		bundleAsset.browser_download_url,
		release.tag_name,
		manifest.bundle.assetName
	);
	return {
		tag: release.tag_name,
		channel: manifest.channel,
		prerelease: Boolean(release.prerelease || tagHasSemverPrerelease(release.tag_name)),
		commit,
		manifest,
		manifestUrl,
		bundleUrl
	};
}

async function selectRelease(
	http: HttpClient,
	input: { version: string; channel: ReleaseChannel }
): Promise<GithubRelease> {
	if (input.version !== 'latest') {
		assertSupportedReleaseTag(input.version);
	}
	if (input.version === 'latest' && input.channel === 'stable') {
		const latest = await getJson<GithubRelease>(
			http,
			githubApiUrl('/releases/latest'),
			MAX_RELEASE_LIST_BYTES
		);
		if (latest.draft || latest.prerelease || tagHasSemverPrerelease(latest.tag_name)) {
			throw generic('GitHub /releases/latest returned a draft or prerelease');
		}
		return latest;
	}
	if (input.version === 'latest' && input.channel === 'beta') {
		const releases = await getJson<GithubRelease[]>(
			http,
			githubApiUrl('/releases?per_page=100'),
			MAX_RELEASE_LIST_BYTES
		);
		if (!Array.isArray(releases)) {
			throw generic('GitHub releases list is not an array');
		}
		const candidate = selectHighestSemverPrereleaseRelease(releases);
		if (!candidate) {
			throw generic(
				'no non-draft prerelease GitHub release is available for the beta channel; refusing to select a stable release'
			);
		}
		return candidate;
	}
	const tagged = await getJson<GithubRelease>(
		http,
		githubApiUrl(`/releases/tags/${encodeURIComponent(input.version)}`),
		MAX_RELEASE_LIST_BYTES
	);
	if (tagged.tag_name !== input.version) {
		throw generic(
			`GitHub release tag ${tagged.tag_name} does not match requested ${input.version}`
		);
	}
	return tagged;
}

async function resolveReleaseCommit(http: HttpClient, release: GithubRelease): Promise<string> {
	if (release.target_commitish && /^[0-9a-f]{40}$/.test(release.target_commitish)) {
		return release.target_commitish;
	}
	const ref = await getJson<{ object?: { sha?: string } }>(
		http,
		githubApiUrl(`/git/ref/tags/${encodeURIComponent(release.tag_name)}`),
		MAX_MANIFEST_BYTES
	);
	const sha = ref.object?.sha;
	if (typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha)) {
		const object = await getJson<{ sha?: string; object?: { sha?: string } }>(
			http,
			githubApiUrl(`/git/tags/${sha}`),
			MAX_MANIFEST_BYTES
		).catch(() => undefined);
		if (object?.object?.sha && /^[0-9a-f]{40}$/.test(object.object.sha)) {
			return object.object.sha;
		}
		return sha;
	}
	throw generic(`could not resolve a commit SHA for GitHub tag ${release.tag_name}`);
}

async function downloadValidatedBundle(
	http: HttpClient,
	release: ResolvedRelease
): Promise<Uint8Array> {
	const maxBytes = Math.min(release.manifest.bundle.size, MAX_BUNDLE_BYTES);
	if (release.manifest.bundle.size > MAX_BUNDLE_BYTES) {
		throw generic(`bundle size ${release.manifest.bundle.size} exceeds ${MAX_BUNDLE_BYTES}`);
	}
	assertReleaseAssetUrl(release.bundleUrl, release.tag, release.manifest.bundle.assetName);
	const response = await http.request({
		url: release.bundleUrl,
		maxBytes,
		allowedHosts: GITHUB_ALLOWED_HOSTS,
		headers: { 'user-agent': USER_AGENT, accept: 'application/octet-stream' }
	});
	if (response.status !== 200) {
		throw unavailable(`failed to download Cloudflare bundle (HTTP ${response.status})`);
	}
	if (response.body.byteLength !== release.manifest.bundle.size) {
		throw generic(
			`downloaded bundle size ${response.body.byteLength} does not match manifest size ${release.manifest.bundle.size}`
		);
	}
	const digest = sha256Hex(response.body);
	if (digest !== release.manifest.bundle.sha256) {
		throw generic('downloaded bundle SHA-256 does not match the release manifest');
	}
	return response.body;
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

export function selectHighestSemverPrereleaseRelease(
	releases: readonly GithubRelease[]
): GithubRelease | undefined {
	let winner: GithubRelease | undefined;
	for (const release of releases) {
		if (release.draft) continue;
		if (!tagHasSemverPrerelease(release.tag_name)) continue;
		if (!winner || compareReleaseTags(release.tag_name, winner.tag_name) > 0) {
			winner = release;
		}
	}
	return winner;
}

function assertSupportedReleaseTag(tag: string): ParsedReleaseTag {
	try {
		return parseReleaseTag(tag);
	} catch (error) {
		throw generic(error instanceof Error ? error.message : String(error));
	}
}

function assertRequestedChannel(
	requested: ReleaseChannel,
	release: GithubRelease,
	manifest: ReleaseManifest
): void {
	const tagChannel: ReleaseChannel = assertSupportedReleaseTag(release.tag_name).prerelease
		? 'beta'
		: 'stable';
	if (manifest.channel !== tagChannel) {
		throw generic(
			`release manifest channel ${manifest.channel} does not match semver prerelease of tag ${release.tag_name}`
		);
	}
	if (requested === 'stable' && (tagChannel === 'beta' || release.prerelease)) {
		throw generic(
			`stable channel refuses prerelease/beta release ${release.tag_name}; use --channel beta`
		);
	}
	if (requested === 'beta' && tagChannel !== 'beta') {
		throw generic(
			`beta channel refuses stable release ${release.tag_name}; use --channel stable or a prerelease tag`
		);
	}
}

async function getJson<T>(http: HttpClient, url: string, maxBytes: number): Promise<T> {
	const response = await http.request({
		url,
		maxBytes,
		allowedHosts: GITHUB_ALLOWED_HOSTS,
		headers: {
			'user-agent': USER_AGENT,
			accept: ACCEPT_JSON
		}
	});
	if (response.status === 404) {
		throw generic(`GitHub release was not found at ${url}`);
	}
	if (response.status !== 200) {
		throw unavailable(`GitHub API request failed (HTTP ${response.status})`);
	}
	try {
		return JSON.parse(utf8(response.body)) as T;
	} catch {
		throw generic('GitHub API response was not valid JSON');
	}
}
