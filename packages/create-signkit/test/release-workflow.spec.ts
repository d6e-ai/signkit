import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	channelFromReleaseTag,
	compareReleaseTags,
	npmDistTagFromChannel,
	npmDistTagFromReleaseTag,
	parseReleaseTag,
	resolveReleaseTag
} from '../src/release/semver.js';

const buildScriptPath = fileURLToPath(
	new URL('../../../scripts/build-cloudflare-release-bundle.mjs', import.meta.url)
);
const verifyScriptPath = fileURLToPath(
	new URL('../scripts/verify-release-bundle.mjs', import.meta.url)
);
const workflowPath = fileURLToPath(
	new URL('../../../.github/workflows/release-cloudflare-bundle.yml', import.meta.url)
);
const rootPackagePath = fileURLToPath(new URL('../../../package.json', import.meta.url));
const lockfilePath = fileURLToPath(new URL('../../../pnpm-lock.yaml', import.meta.url));

describe('release-cloudflare-bundle workflow', () => {
	it('publishes create-signkit with the version-checked npm CLI, not pnpm publish', async () => {
		const yaml = await readFile(workflowPath, 'utf8');
		const rootPackage = JSON.parse(await readFile(rootPackagePath, 'utf8')) as {
			devDependencies: Record<string, string>;
		};
		const lockfile = await readFile(lockfilePath, 'utf8');
		expect(yaml).not.toMatch(/^\s*run:\s*pnpm publish\b/m);
		expect(yaml).not.toMatch(/npm install --prefix/);
		expect(yaml).not.toMatch(/npm@\^/);
		expect(rootPackage.devDependencies.npm).toBe('11.5.1');
		expect(lockfile).toMatch(/npm:\n\s+specifier: 11\.5\.1\n\s+version: 11\.5\.1/);
		expect(lockfile).toMatch(/npm@11\.5\.1:\n\s+resolution: \{integrity: sha512-/);
		expect(yaml).toMatch(/selected="\$\(pnpm exec which npm\)"/);
		expect(yaml).toMatch(/pnpm exec "\$NPM_CLI" publish --access public --tag "\$NPM_DIST_TAG"/);
		expect(yaml).not.toMatch(/pnpm exec "\$NPM_CLI" publish --access public\s*$/m);
		expect(yaml).toMatch('NODE_AUTH_TOKEN: ${{ secrets.NODE_AUTH_TOKEN }}');
		expect(yaml).not.toMatch(/echo[^|\n]*NODE_AUTH_TOKEN/);
		expect(yaml).toMatch(/lockfile-pinned npm CLI mismatch/);
		expect(yaml).toMatch(/prerelease_args\+=\(--prerelease\)/);
		expect(yaml).toMatch(/prerelease_args\+=\(--prerelease=false\)/);
		expect(yaml).not.toMatch(/gh release edit "\$tag" "\$\{prerelease_args\[@\]\}"/);
		expect(yaml).toMatch(/channelFromReleaseTag/);
		expect(yaml).toMatch(/npmDistTagFromReleaseTag/);
		expect(yaml).toMatch(/packages\/create-signkit\/dist\/release\/semver\.js/);
	});

	it('builds every artifact and publishes only expected names behind version gates', async () => {
		const yaml = await readFile(workflowPath, 'utf8');
		// Full-tag coverage: Node, Cloudflare, Rust, Docker.
		expect(yaml).toMatch(/pnpm run build:node/);
		expect(yaml).toMatch(/pnpm run test:node-build/);
		expect(yaml).toMatch(/node scripts\/build-cloudflare-release-bundle\.mjs/);
		expect(yaml).toMatch(/node scripts\/verify-cloudflare-release-bundle\.mjs/);
		expect(yaml).toMatch(/cargo build --locked --release/);
		expect(yaml).toMatch(/docker build/);
		expect(yaml).toMatch(/docker save/);
		// Unified checksums regenerated over all assets and verified before upload.
		expect(yaml).toMatch(/sha256sum -c SHA256SUMS/);
		// Every shippable family is attached in the single upload step.
		expect(yaml).toMatch(/signkit-cloudflare-\$\{tag\}\.tar\.gz/);
		expect(yaml).toMatch(/signkit-node-\$\{tag\}\.tar\.gz/);
		expect(yaml).toMatch(/x86_64-unknown-linux-gnu\.tar\.gz/);
		expect(yaml).toMatch(/signkit-docker-\$\{tag\}\.tar\.gz/);
		// Hard tag-equals-version gates cover all three versioned packages.
		expect(yaml).toMatch(/require\('\.\/package\.json'\)\.version/);
		expect(yaml).toMatch(/require\('\.\/packages\/create-signkit\/package\.json'\)\.version/);
		expect(yaml).toMatch(/cli\/Cargo\.toml/);
		// npm publish is hard-gated on the release job.
		expect(yaml).toMatch(/needs:\s*release/);
		// No deployment: no wrangler deploy, no registry push.
		expect(yaml).not.toMatch(/wrangler deploy[^-\n]/);
		expect(yaml).not.toMatch(/docker push/);
	});

	it('keeps the release draft until npm succeeds and refuses an existing public release', async () => {
		const yaml = await readFile(workflowPath, 'utf8');
		// Draft-first creation in the release job.
		expect(yaml).toMatch(/gh release create "\$tag" --draft/);
		// Rerun path inspects draft status before uploading/editing and fails
		// closed on an existing public release.
		expect(yaml).toMatch(/gh release view "\$tag" --json isDraft,isPrerelease,assets/);
		expect(yaml).toMatch(/is_draft/);
		expect(yaml).toMatch(/refusing to upload to existing public release/);
		expect(yaml).toMatch(/prerelease metadata does not match the tag channel/);
		expect(yaml).toMatch(/unexpected existing asset/);
		expect(yaml).not.toMatch(/--clobber/);
		expect(yaml).toMatch(/gh release download "\$tag" --pattern "\$asset_name"/);
		expect(yaml).toMatch(/cmp -s "\$local_asset" "\$verify_dir\/\$asset_name"/);
		expect(yaml).toMatch(/reusing byte-identical draft asset/);
		expect(yaml).toMatch(/refusing to replace mismatched existing asset/);
		// Never turn a public release back into a draft.
		expect(yaml).not.toMatch(/--draft=true/);
		expect(yaml).not.toMatch(/--draft true/);
		const draftFalseMatches = yaml.match(/--draft=false/g) ?? [];
		expect(draftFalseMatches).toHaveLength(1);
		// Public flip happens only after the npm gate succeeds.
		expect(yaml).toMatch(/needs:\s*publish-npm/);
		const publishReleaseSection = yaml.slice(yaml.indexOf('publish-release:'));
		expect(publishReleaseSection).toMatch(
			/release \$\{tag\} is already public; refusing any further mutation/
		);
		expect(publishReleaseSection).toMatch(/gh release edit "\$tag" --draft=false/);
		const releaseSection = yaml.slice(0, yaml.indexOf('publish-npm:'));
		expect(releaseSection).not.toMatch(/--draft=false/);
		expect(releaseSection).toMatch(/gh release upload "\$tag"/);
	});

	it('generates GitHub build provenance for the exact release assets', async () => {
		const yaml = await readFile(workflowPath, 'utf8');
		expect(yaml).toMatch(/id-token: write/);
		expect(yaml).toMatch(/attestations: write/);
		expect(yaml).toMatch(/artifact-metadata: write/);
		expect(yaml).toMatch(/uses: actions\/attest@v4/);
		expect(yaml).toMatch(/subject-path: \.release\/assets\/\*/);
		expect(yaml.indexOf('Generate GitHub build-provenance attestations')).toBeGreaterThan(
			yaml.indexOf('Publish release assets to a draft release')
		);
	});

	it('derives GitHub prerelease and npm dist-tag from the same semver channel', async () => {
		const yaml = await readFile(workflowPath, 'utf8');
		expect(yaml).toMatch(/channelFromReleaseTag\(process\.argv\[1\]\)/);
		expect(yaml).toMatch(/npmDistTagFromReleaseTag\(process\.argv\[1\]\)/);

		expect(npmDistTagFromChannel('stable')).toBe('latest');
		expect(npmDistTagFromChannel('beta')).toBe('beta');
		expect(npmDistTagFromReleaseTag('v1.2.3')).toBe('latest');
		expect(npmDistTagFromReleaseTag('1.2.3')).toBe('latest');
		expect(npmDistTagFromReleaseTag('v1.2.3-beta.1')).toBe('beta');
		expect(npmDistTagFromReleaseTag('1.2.3-rc.1')).toBe('beta');
		expect(npmDistTagFromReleaseTag('v0.0.0-ci')).toBe('beta');
		expect(() => npmDistTagFromReleaseTag('v1.2.3+build.1')).toThrow(/build metadata/);

		const cases: Array<{
			tag: string;
			channel: 'stable' | 'beta';
			distTag: 'latest' | 'beta';
		}> = [
			{ tag: 'v1.2.3', channel: 'stable', distTag: 'latest' },
			{ tag: 'v1.2.3-beta.1', channel: 'beta', distTag: 'beta' },
			{ tag: 'v1.2.3-hotfix.1', channel: 'beta', distTag: 'beta' }
		];
		for (const { tag, channel, distTag } of cases) {
			expect(channelFromReleaseTag(tag)).toBe(channel);
			expect(npmDistTagFromReleaseTag(tag)).toBe(distTag);
			expect(npmDistTagFromChannel(channel)).toBe(distTag);
			expect(invokeWorkflowClassifier('channelFromReleaseTag', tag)).toBe(channel);
			expect(invokeWorkflowClassifier('npmDistTagFromReleaseTag', tag)).toBe(distTag);
			expect(githubPrereleaseArgs(channel)).toEqual(
				channel === 'beta' ? ['--prerelease'] : ['--prerelease=false']
			);
			if (channel === 'beta') {
				expect(distTag).not.toBe('latest');
			}
		}
	});
});

describe('synthetic release tag precedence', () => {
	it('prefers SIGNKIT_RELEASE_TAG over GITHUB_REF_NAME', () => {
		expect(
			resolveReleaseTag({
				SIGNKIT_RELEASE_TAG: 'v0.0.0-ci',
				GITHUB_REF_NAME: 'codex/create-signkit-cloudflare'
			})
		).toBe('v0.0.0-ci');
		expect(resolveReleaseTag({ GITHUB_REF_NAME: 'v1.2.3' })).toBe('v1.2.3');
		expect(resolveReleaseTag({ SIGNKIT_RELEASE_TAG: '', GITHUB_REF_NAME: 'v1.2.3' })).toBe(
			'v1.2.3'
		);
	});

	it('is wired into both bundle build and verify scripts', async () => {
		const build = await readFile(buildScriptPath, 'utf8');
		const verify = await readFile(verifyScriptPath, 'utf8');
		expect(build).toMatch(/resolveReleaseTag\(process\.env\)/);
		expect(verify).toMatch(/resolveReleaseTag\(process\.env\)/);
		expect(build).toMatch(/channelFromReleaseTag\(tag\)/);
	});
});

describe('semver release tags', () => {
	it('classifies channel from the prerelease component, not a substring', () => {
		expect(channelFromReleaseTag('v1.2.3')).toBe('stable');
		expect(channelFromReleaseTag('v1.2.3-beta.1')).toBe('beta');
		expect(channelFromReleaseTag('v1.2.3-rc.1')).toBe('beta');
		expect(channelFromReleaseTag('v0.0.0-ci')).toBe('beta');
		expect(parseReleaseTag('v1.2.3-hotfix.1').prerelease).toBe('hotfix.1');
	});

	it('rejects build metadata', async () => {
		expect(() => parseReleaseTag('v1.2.3+build.1')).toThrow(/build metadata/);
		expect(() => parseReleaseTag('v1.2.3-beta.1+exp.sha')).toThrow(/build metadata/);
		const schema = JSON.parse(
			await readFile(new URL('../schema/release-manifest.v1.json', import.meta.url), 'utf8')
		) as { properties: { tag: { pattern: string } } };
		const tagPattern = new RegExp(schema.properties.tag.pattern);
		expect(tagPattern.test('v1.2.3')).toBe(true);
		expect(tagPattern.test('v1.2.3-beta.1')).toBe(true);
		expect(tagPattern.test('v1.2.3+build.1')).toBe(false);
		expect(tagPattern.test('v1.2.3-beta.1+exp.sha')).toBe(false);
	});

	it('compares prerelease identifiers with SemVer numeric vs string precedence', () => {
		expect(compareReleaseTags('v1.0.0-alpha', 'v1.0.0-alpha.1')).toBeLessThan(0);
		expect(compareReleaseTags('v1.0.0-alpha.1', 'v1.0.0-alpha.beta')).toBeLessThan(0);
		expect(compareReleaseTags('v1.0.0-alpha.beta', 'v1.0.0-beta')).toBeLessThan(0);
		expect(compareReleaseTags('v1.0.0-beta', 'v1.0.0-beta.2')).toBeLessThan(0);
		expect(compareReleaseTags('v1.0.0-beta.2', 'v1.0.0-beta.11')).toBeLessThan(0);
		expect(compareReleaseTags('v1.0.0-beta.11', 'v1.0.0-rc.1')).toBeLessThan(0);
		expect(compareReleaseTags('v1.0.0-rc.1', 'v1.0.0')).toBeLessThan(0);
		expect(compareReleaseTags('v1.0.0-1', 'v1.0.0-alpha')).toBeLessThan(0);
		expect(compareReleaseTags('v2.0.0-alpha', 'v1.99.99-rc.99')).toBeGreaterThan(0);
		expect(compareReleaseTags('v1.2.3-beta.1', 'v1.2.3-beta.1')).toBe(0);
		expect(compareReleaseTags('v1.2.3-beta.1', '1.2.3-beta.1')).toBe(0);

		const ordered = [
			'v1.0.0-alpha',
			'v1.0.0-alpha.1',
			'v1.0.0-alpha.beta',
			'v1.0.0-beta',
			'v1.0.0-beta.2',
			'v1.0.0-beta.11',
			'v1.0.0-rc.1'
		];
		for (const seed of [1, 2, 7, 99, 12345, 0x9e3779b9]) {
			const shuffled = shuffle(ordered, seed);
			expect([...shuffled].sort(compareReleaseTags)).toEqual(ordered);
		}
	});
});

function githubPrereleaseArgs(channel: 'stable' | 'beta'): string[] {
	return channel === 'beta' ? ['--prerelease'] : ['--prerelease=false'];
}

function invokeWorkflowClassifier(
	fn: 'channelFromReleaseTag' | 'npmDistTagFromReleaseTag',
	tag: string
): string {
	const moduleUrl = JSON.stringify(new URL('../src/release/semver.ts', import.meta.url).href);
	const source =
		fn === 'channelFromReleaseTag'
			? `import { channelFromReleaseTag } from ${moduleUrl}; ` +
				'process.stdout.write(channelFromReleaseTag(process.argv[1]));'
			: `import { npmDistTagFromReleaseTag } from ${moduleUrl}; ` +
				'process.stdout.write(npmDistTagFromReleaseTag(process.argv[1]));';
	return execFileSync(
		process.execPath,
		['--experimental-strip-types', '--input-type=module', '-e', source, tag],
		{ encoding: 'utf8' }
	);
}

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
