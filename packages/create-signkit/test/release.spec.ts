import { describe, expect, it } from 'vitest';
import {
	createGithubReleaseResolver,
	selectHighestSemverPrereleaseRelease,
	sha256Hex,
	type GithubRelease
} from '../src/release/github.js';
import { parseReleaseManifest } from '../src/release/manifest.js';
import { CliError } from '../src/cli/errors.js';
import {
	COMMIT,
	FakeHttp,
	githubReleaseJson,
	sampleBundleBytes,
	sampleManifest,
	sampleProvenance
} from './helpers.js';

const API = 'https://api.github.com/repos/d6e-ai/signkit';
const DL = 'https://github.com/d6e-ai/signkit/releases/download';

describe('GitHub release resolution', () => {
	it('resolves latest stable from /releases/latest, excluding drafts and prereleases', async () => {
		const http = new FakeHttp();
		const manifest = sampleManifest();
		const bundle = sampleBundleBytes();
		http.on(
			`${API}/releases/latest`,
			githubReleaseJson({ tag: 'v1.2.3', bundleSize: bundle.byteLength })
		);
		http.on(`${DL}/v1.2.3/signkit-cloudflare-manifest.json`, JSON.stringify(manifest));
		const resolved = await createGithubReleaseResolver(http).resolve({
			version: 'latest',
			channel: 'stable'
		});
		expect(resolved.tag).toBe('v1.2.3');
		expect(http.requests[0]?.url).toBe(`${API}/releases/latest`);
	});

	it('resolves latest beta from the highest semver prerelease, not GitHub API order', async () => {
		const http = new FakeHttp();
		const winner = 'v2.0.0-beta.11';
		const manifest = sampleManifest({ tag: winner, channel: 'beta' });
		const bundle = sampleBundleBytes();
		http.on(`${API}/releases?per_page=100`, [
			githubReleaseJson({
				tag: 'v2.0.0-beta.2',
				prerelease: true,
				bundleName: 'signkit-cloudflare-v1.2.3.tar.gz',
				bundleSize: bundle.byteLength
			}),
			githubReleaseJson({
				tag: winner,
				prerelease: true,
				bundleName: 'signkit-cloudflare-v1.2.3.tar.gz',
				bundleSize: bundle.byteLength
			})
		]);
		http.on(`${DL}/${winner}/signkit-cloudflare-manifest.json`, JSON.stringify(manifest));
		const resolved = await createGithubReleaseResolver(http).resolve({
			version: 'latest',
			channel: 'beta'
		});
		expect(resolved.tag).toBe(winner);
		expect(resolved.prerelease).toBe(true);
		expect(http.requests[0]?.url).toBe(`${API}/releases?per_page=100`);
		expect(http.requests.some((request) => request.url === `${API}/releases/latest`)).toBe(false);
	});

	it('resolves latest beta from a semver prerelease tag even if GitHub forgot the prerelease flag', async () => {
		const http = new FakeHttp();
		const manifest = sampleManifest({ tag: 'v2.0.0-beta.1', channel: 'beta' });
		const bundle = sampleBundleBytes();
		http.on(`${API}/releases?per_page=100`, [
			githubReleaseJson({
				tag: 'v2.0.0-beta.1',
				prerelease: false,
				bundleName: 'signkit-cloudflare-v1.2.3.tar.gz',
				bundleSize: bundle.byteLength
			})
		]);
		http.on(`${DL}/v2.0.0-beta.1/signkit-cloudflare-manifest.json`, JSON.stringify(manifest));
		const resolved = await createGithubReleaseResolver(http).resolve({
			version: 'latest',
			channel: 'beta'
		});
		expect(resolved.tag).toBe('v2.0.0-beta.1');
		expect(resolved.channel).toBe('beta');
	});

	it('refuses latest beta when only stable releases exist', async () => {
		const http = new FakeHttp();
		const bundle = sampleBundleBytes();
		http.on(`${API}/releases?per_page=100`, [
			githubReleaseJson({ tag: 'v9.0.0', draft: true, bundleSize: bundle.byteLength }),
			githubReleaseJson({ tag: 'v1.2.3', prerelease: false, bundleSize: bundle.byteLength })
		]);
		await expect(
			createGithubReleaseResolver(http).resolve({ version: 'latest', channel: 'beta' })
		).rejects.toThrow(/no non-draft prerelease/);
	});

	it('selects the highest valid semver prerelease from shuffled GitHub lists', async () => {
		const winner = 'v2.0.0-beta.11';
		const winnerBundle = `signkit-cloudflare-${winner}.tar.gz`;
		const bundle = sampleBundleBytes();
		const pool = [
			githubReleaseJson({ tag: 'v9.0.0-beta.1', draft: true, bundleSize: bundle.byteLength }),
			githubReleaseJson({ tag: 'v3.0.0', prerelease: false, bundleSize: bundle.byteLength }),
			githubReleaseJson({ tag: 'v4.0.0', prerelease: true, bundleSize: bundle.byteLength }),
			githubReleaseJson({ tag: 'v1.0.0+build.1', bundleSize: bundle.byteLength }),
			githubReleaseJson({ tag: 'not-a-semver', bundleSize: bundle.byteLength }),
			githubReleaseJson({
				tag: 'v2.0.0-beta.2',
				prerelease: true,
				bundleSize: bundle.byteLength
			}),
			githubReleaseJson({
				tag: 'v2.0.0-alpha.99',
				prerelease: true,
				bundleSize: bundle.byteLength
			}),
			githubReleaseJson({
				tag: 'v1.9.9-rc.1',
				prerelease: true,
				bundleSize: bundle.byteLength
			}),
			githubReleaseJson({
				tag: winner,
				prerelease: false,
				bundleName: winnerBundle,
				bundleSize: bundle.byteLength
			})
		] as GithubRelease[];

		for (const seed of [1, 2, 3, 7, 99, 12345, 0x9e3779b9, 42]) {
			const shuffled = shuffle(pool, seed);
			expect(selectHighestSemverPrereleaseRelease(shuffled)?.tag_name).toBe(winner);
		}

		const http = new FakeHttp();
		const manifest = sampleManifest({
			tag: winner,
			channel: 'beta',
			bundle: {
				...sampleManifest().bundle,
				assetName: winnerBundle
			}
		});
		const apiOrder = shuffle(pool, 99);
		http.on(`${API}/releases?per_page=100`, apiOrder);
		http.on(`${DL}/${winner}/signkit-cloudflare-manifest.json`, JSON.stringify(manifest));
		const resolved = await createGithubReleaseResolver(http).resolve({
			version: 'latest',
			channel: 'beta'
		});
		expect(resolved.tag).toBe(winner);
	});

	it('resolves an exact tag and refuses a missing tag', async () => {
		const http = new FakeHttp();
		const manifest = sampleManifest();
		http.on(
			`${API}/releases/tags/v1.2.3`,
			githubReleaseJson({ tag: 'v1.2.3', bundleSize: sampleBundleBytes().byteLength })
		);
		http.on(`${DL}/v1.2.3/signkit-cloudflare-manifest.json`, JSON.stringify(manifest));
		const resolved = await createGithubReleaseResolver(http).resolve({
			version: 'v1.2.3',
			channel: 'stable'
		});
		expect(resolved.tag).toBe('v1.2.3');

		const missing = new FakeHttp();
		await expect(
			createGithubReleaseResolver(missing).resolve({ version: 'v9.9.9', channel: 'stable' })
		).rejects.toThrow(/not found/);
	});

	it('refuses a stable-channel request for a semver prerelease tag', async () => {
		const http = new FakeHttp();
		const manifest = sampleManifest({ tag: 'v1.2.3-beta.1', channel: 'beta' });
		http.on(
			`${API}/releases/tags/v1.2.3-beta.1`,
			githubReleaseJson({
				tag: 'v1.2.3-beta.1',
				prerelease: true,
				bundleSize: sampleBundleBytes().byteLength
			})
		);
		http.on(`${DL}/v1.2.3-beta.1/signkit-cloudflare-manifest.json`, JSON.stringify(manifest));
		await expect(
			createGithubReleaseResolver(http).resolve({ version: 'v1.2.3-beta.1', channel: 'stable' })
		).rejects.toThrow(/stable channel refuses/);
	});

	it('refuses a beta-channel request for a stable tag', async () => {
		const http = new FakeHttp();
		const manifest = sampleManifest();
		http.on(
			`${API}/releases/tags/v1.2.3`,
			githubReleaseJson({ tag: 'v1.2.3', bundleSize: sampleBundleBytes().byteLength })
		);
		http.on(`${DL}/v1.2.3/signkit-cloudflare-manifest.json`, JSON.stringify(manifest));
		await expect(
			createGithubReleaseResolver(http).resolve({ version: 'v1.2.3', channel: 'beta' })
		).rejects.toThrow(/beta channel refuses stable/);
	});

	it('rejects build-metadata tags', async () => {
		expect(() =>
			parseReleaseManifest(JSON.stringify(sampleManifest({ tag: 'v1.2.3+build.1' })))
		).toThrow(/build metadata/);
		const http = new FakeHttp();
		http.on(
			`${API}/releases/tags/v1.2.3+build.1`,
			githubReleaseJson({ tag: 'v1.2.3+build.1', bundleSize: sampleBundleBytes().byteLength })
		);
		http.on(
			`${DL}/v1.2.3+build.1/signkit-cloudflare-manifest.json`,
			JSON.stringify(sampleManifest({ tag: 'v1.2.3' }))
		);
		await expect(
			createGithubReleaseResolver(http).resolve({ version: 'v1.2.3+build.1', channel: 'stable' })
		).rejects.toThrow(/build metadata/);
		expect(http.requests).toEqual([]);
	});
});

describe('manifest and bundle validation', () => {
	it('rejects a manifest for the wrong repository, tag, commit, size, or hash', async () => {
		expect(() =>
			parseReleaseManifest(JSON.stringify({ ...sampleManifest(), repository: 'evil/repo' }))
		).toThrow(/repository/);
		expect(() => parseReleaseManifest(JSON.stringify(sampleManifest()), { tag: 'v9.9.9' })).toThrow(
			/does not match expected tag/
		);
		expect(() =>
			parseReleaseManifest(JSON.stringify({ ...sampleManifest(), commit: 'deadbeef' }))
		).toThrow(/40-character/);
		expect(() =>
			parseReleaseManifest(JSON.stringify(sampleManifest()), {
				commit: `${COMMIT.replace('0', 'f')}`
			})
		).toThrow(/commit does not match/);
		expect(() =>
			parseReleaseManifest(
				JSON.stringify({
					...sampleManifest(),
					worker: { ...sampleManifest().worker, main: '../escape.js' }
				})
			)
		).toThrow(/relative POSIX path/);
		expect(() =>
			parseReleaseManifest(
				JSON.stringify({
					...sampleManifest(),
					requiredVars: ['SIGNKIT_PUBLIC_ORIGIN', 'SIGNKIT_PUBLIC_ORIGIN']
				})
			)
		).toThrow(/duplicate name/);
		expect(() =>
			parseReleaseManifest(
				JSON.stringify({
					...sampleManifest(),
					requiredSecrets: ['not-an-env']
				})
			)
		).toThrow(/environment identifiers/);
		expect(() =>
			parseReleaseManifest(JSON.stringify({ ...sampleManifest(), channel: 'beta' }))
		).toThrow(/does not match semver prerelease/);
		expect(() =>
			parseReleaseManifest(
				JSON.stringify({
					...sampleManifest(),
					migrationPolicy: {
						compatibility: sampleManifest().migrationPolicy.compatibility,
						notes: sampleManifest().migrationPolicy.notes
					}
				})
			)
		).toThrow(/schemaEpoch/);
		expect(() =>
			parseReleaseManifest(
				JSON.stringify({
					...sampleManifest(),
					migrationPolicy: {
						...sampleManifest().migrationPolicy,
						schemaEpoch: 'legacy-v0'
					}
				})
			)
		).toThrow(/schemaEpoch/);
	});

	it('refuses an asset URL that is not a GitHub release origin', async () => {
		const http = new FakeHttp();
		const manifest = sampleManifest();
		const evil = githubReleaseJson({ tag: 'v1.2.3', bundleSize: sampleBundleBytes().byteLength });
		(evil.assets as Array<{ browser_download_url: string }>)[0]!.browser_download_url =
			'https://evil.example/signkit-cloudflare-manifest.json';
		http.on(`${API}/releases/latest`, evil);
		http.on(`${DL}/v1.2.3/signkit-cloudflare-manifest.json`, JSON.stringify(manifest));
		await expect(
			createGithubReleaseResolver(http).resolve({ version: 'latest', channel: 'stable' })
		).rejects.toThrow(/not an allowed GitHub origin|does not match the expected/);
	});

	it('validates downloaded bundle size and SHA-256', async () => {
		const http = new FakeHttp();
		const bundle = sampleBundleBytes();
		const manifest = sampleManifest({
			bundle: {
				assetName: 'signkit-cloudflare-v1.2.3.tar.gz',
				contentType: 'application/gzip',
				size: bundle.byteLength,
				sha256: sha256Hex(bundle)
			}
		});
		http.on(
			`${API}/releases/latest`,
			githubReleaseJson({ tag: 'v1.2.3', bundleSize: bundle.byteLength })
		);
		http.on(`${DL}/v1.2.3/signkit-cloudflare-manifest.json`, JSON.stringify(manifest));
		http.on(`${DL}/v1.2.3/signkit-cloudflare-v1.2.3.tar.gz`, bundle);
		const resolver = createGithubReleaseResolver(http, {
			verify: async () => sampleProvenance(manifest)
		});
		const release = await resolver.resolve({ version: 'latest', channel: 'stable' });
		await expect(resolver.prepareBundle(release)).resolves.toMatchObject({ bytes: bundle });

		http.replace(
			`${DL}/v1.2.3/signkit-cloudflare-v1.2.3.tar.gz`,
			new TextEncoder().encode('tamperedxxxx')
		);
		await expect(resolver.prepareBundle(release)).rejects.toThrow(/SHA-256/);
	});

	it('bounds GitHub response sizes', async () => {
		const http = new FakeHttp();
		const bundle = sampleBundleBytes();
		http.on(
			`${API}/releases/latest`,
			githubReleaseJson({ tag: 'v1.2.3', bundleSize: bundle.byteLength })
		);
		http.on(`${DL}/v1.2.3/signkit-cloudflare-manifest.json`, 'x'.repeat(70_000));
		await expect(
			createGithubReleaseResolver(http).resolve({ version: 'latest', channel: 'stable' })
		).rejects.toThrow(/exceeded limit/);
	});

	it('does not contact real GitHub hosts in these tests', () => {
		const http = new FakeHttp();
		expect(http.requests).toEqual([]);
		expect(() => {
			throw new CliError('guard', 1, 'error');
		}).toThrow(CliError);
	});
});

function shuffle<T>(items: readonly T[], seed: number): T[] {
	const out = [...items];
	let state = seed >>> 0;
	for (let i = out.length - 1; i > 0; i -= 1) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		const j = state % (i + 1);
		const current = out[i]!;
		out[i] = out[j]!;
		out[j] = current;
	}
	return out;
}
