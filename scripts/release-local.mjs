#!/usr/bin/env node
/**
 * Maintainer-signed SignKit release from one Linux x86_64 machine, without
 * GitHub Actions. It mirrors `.github/workflows/release-cloudflare-bundle.yml`:
 * the same gates, build commands, asset names, SHA256SUMS, draft-first GitHub
 * Release, and npm-before-public ordering. The difference is the provenance:
 * instead of a workflow attestation, a maintainer pinned in
 * `packages/create-signkit/src/release/maintainer-signers.ts` signs an in-toto
 * statement with Sigstore keyless signing (GitHub account sign-in), and the
 * bundle is stored with GitHub's attestations API so create-signkit finds it
 * by digest exactly as before.
 *
 *   node scripts/release-local.mjs build   --tag vX.Y.Z [--dry-run]
 *   node scripts/release-local.mjs sign    --tag vX.Y.Z [--no-browser] [--dry-run]
 *   node scripts/release-local.mjs npm     --tag vX.Y.Z [--dry-run]
 *   node scripts/release-local.mjs publish --tag vX.Y.Z [--dry-run]
 *
 * Run the subcommands in that order (docs/release-checklist.md). `npm` comes
 * before `publish` for the same reason the workflow gates the public flip on
 * npm: a public release must never depend on an unpublished create-signkit.
 *
 * `build --rehearsal [--docker-image name:tag]` builds from a commit that is
 * not origin/main for a local trial; its output is marked and every later
 * subcommand refuses it.
 *
 * Only `sign` (Sigstore), `npm` (npm registry), and `publish` (GitHub) talk to
 * external services. `build` reads nothing remote except what pnpm, cargo, and
 * docker fetch for the build itself. Nothing here prints a token.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
	access,
	constants,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)));
const REPOSITORY = 'd6e-ai/signkit';
const RELEASE_DIR = join(ROOT, '.release');
const ASSETS_DIR = join(RELEASE_DIR, 'assets');
const STATEMENT_PATH = join(RELEASE_DIR, 'provenance-statement.json');
const BUNDLE_PATH = join(RELEASE_DIR, 'provenance.sigstore.json');
const EXPECTED_HASHES_PATH = join(RELEASE_DIR, 'expected-assets.sha256');
const CSK_DIR = join(ROOT, 'packages/create-signkit');
const MANIFEST_NAME = 'signkit-cloudflare-manifest.json';
const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
const SLSA_PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
const ATTESTATION_API_VERSION = '2026-03-10';
const ATTESTATION_BLOB_HOST = 'tmaproduction.blob.core.windows.net';
// Sigstore public-good OIDC (Dex). Fulcio writes the upstream connector id
// into the certificate issuer extension, so the GitHub connector yields
// https://github.com/login/oauth and the verified account email as subject.
const SIGSTORE_OIDC_ISSUER = 'https://oauth2.sigstore.dev/auth';
const SIGSTORE_OIDC_CLIENT_ID = 'sigstore';
const GITHUB_CONNECTOR_ID = 'https://github.com/login/oauth';
const OIDC_LOGIN_TIMEOUT_MS = 5 * 60_000;
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

const USAGE = `Usage: node scripts/release-local.mjs <build|sign|npm|publish> --tag vX.Y.Z [options]

  build    Gate, build, and checksum every release asset into .release/assets
           and write .release/provenance-statement.json.
           --rehearsal            allow HEAD != origin/main (output cannot be signed)
           --docker-image <name>  rehearsal only; default signkit:<tag>
  sign     Sign the statement with Sigstore keyless signing (browser sign-in
           with a pinned maintainer's GitHub account) and verify it locally.
           --no-browser           print the sign-in URL without opening a browser
  npm      Publish packages/create-signkit unless that version is on npm.
  publish  Create or reuse the draft GitHub Release, upload assets and the
           attestation, verify the draft with create-signkit, then publish it.

  --dry-run  run every check and print the mutations without performing them
`;

class UsageError extends Error {}

const commands = { build, sign, npm: publishNpm, publish };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	await main(process.argv.slice(2));
}

async function main(args) {
	try {
		const { positionals, values } = parseArgs({
			args,
			allowPositionals: true,
			options: {
				tag: { type: 'string' },
				'dry-run': { type: 'boolean', default: false },
				rehearsal: { type: 'boolean', default: false },
				'docker-image': { type: 'string' },
				'no-browser': { type: 'boolean', default: false },
				help: { type: 'boolean', short: 'h', default: false }
			}
		});
		const [name, ...extra] = positionals;
		if (values.help || !name) {
			process.stdout.write(USAGE);
			process.exit(values.help ? 0 : 2);
		}
		const command = commands[name];
		if (!command || extra.length > 0) {
			throw new UsageError(`unknown subcommand ${JSON.stringify(positionals.join(' '))}`);
		}
		if (!values.tag) throw new UsageError('--tag vX.Y.Z is required');
		if (name !== 'build' && (values.rehearsal || values['docker-image'])) {
			throw new UsageError('--rehearsal and --docker-image only apply to build');
		}
		if (name !== 'sign' && values['no-browser']) {
			throw new UsageError('--no-browser only applies to sign');
		}
		await command({ ...values, tag: assertTagFormat(values.tag) });
	} catch (error) {
		const usage = error instanceof UsageError || String(error?.code).startsWith('ERR_PARSE_ARGS');
		process.stderr.write(
			`\nrelease-local: ${error instanceof Error ? error.message : String(error)}\n`
		);
		if (usage) process.stderr.write(`\n${USAGE}`);
		process.exit(usage ? 2 : 1);
	}
}

// ---------------------------------------------------------------------------
// build

async function build(options) {
	const { tag, rehearsal } = options;
	const dryRun = options['dry-run'];
	if (process.platform !== 'linux' || process.arch !== 'x64') {
		throw new Error(
			`release assets name x86_64-unknown-linux-gnu; build on Linux x86_64, not ${process.platform}-${process.arch}`
		);
	}
	const dockerImage = options['docker-image'] ?? `signkit:${tag}`;
	if (!rehearsal && dockerImage !== `signkit:${tag}`) {
		throw new UsageError(
			'--docker-image is only for --rehearsal; a release archives signkit:<tag>'
		);
	}
	if (!/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(dockerImage)) {
		throw new UsageError(`invalid Docker image reference ${JSON.stringify(dockerImage)}`);
	}

	heading(`Preflight for ${tag}${rehearsal ? ' (rehearsal)' : ''}`);
	await assertCleanCheckout();
	const head = await gitHead();
	const originMain = await localOriginMain();
	if (head !== originMain) {
		if (!rehearsal) {
			throw new Error(
				`HEAD ${head} is not origin/main ${originMain ?? '(missing)'}; fetch origin, check out the verified main commit, and rerun`
			);
		}
		note(`rehearsal: HEAD ${head} is not origin/main; the output can never be signed or published`);
	}
	const versions = await readVersions();
	assertProductVersions(tag, versions);
	assertTagFormat(`v${versions.createSignkit}`);
	const toolchain = await readToolchain();
	if (await dockerImageExists(dockerImage)) {
		throw new Error(
			`Docker image ${dockerImage} already exists; remove it (docker image rm ${dockerImage}) so the archive holds only this build`
		);
	}
	log(`commit ${head}`);
	log(
		`versions: product ${versions.root}, Rust CLI ${versions.cli}, create-signkit ${versions.createSignkit}`
	);
	log(
		`toolchain: ${Object.entries(toolchain)
			.map(([key, value]) => `${key} ${value}`)
			.join('; ')}`
	);
	if (!process.version.startsWith('v24.')) {
		note(`the workflow builds with Node 24; this build uses ${process.version} (recorded)`);
	}
	if (!toolchain.rustc.startsWith('1.88.0 ')) {
		note(`the workflow builds the CLI with Rust 1.88.0; this build uses ${toolchain.rustc}`);
	}

	const env = { ...process.env, SIGNKIT_RELEASE_TAG: tag, GITHUB_SHA: head };
	const nodeAsset = join(ASSETS_DIR, `signkit-node-${tag}.tar.gz`);
	const rustAsset = join(ASSETS_DIR, `signkit-${tag}-x86_64-unknown-linux-gnu.tar.gz`);
	const dockerAsset = join(ASSETS_DIR, `signkit-docker-${tag}.tar.gz`);
	const steps = [
		['Install the locked workspace', 'pnpm', ['install', '--frozen-lockfile']],
		['Test create-signkit', 'pnpm', ['--filter', 'create-signkit', 'test']],
		['Build create-signkit', 'pnpm', ['run', 'build:create-signkit']],
		['Enforce tag and package semver', 'gate', []],
		['Build the Node profile', 'pnpm', ['run', 'build:node']],
		['Smoke-check the Node profile', 'pnpm', ['run', 'test:node-build']],
		['Archive the Node profile', 'tar', ['-czf', nodeAsset, 'build/node', 'package.json']],
		['Build the Cloudflare output', 'pnpm', ['run', 'build:cloudflare']],
		[
			'Build the Cloudflare release bundle',
			'node',
			['scripts/build-cloudflare-release-bundle.mjs']
		],
		[
			'Verify the Cloudflare release bundle',
			'node',
			['scripts/verify-cloudflare-release-bundle.mjs']
		],
		[
			'Build the Rust CLI release binary',
			'cargo',
			['build', '--locked', '--release', '--manifest-path', 'cli/Cargo.toml']
		],
		['Archive the Rust CLI', 'tar', ['-czf', rustAsset, '-C', 'cli/target/release', 'signkit']],
		['Build the Docker image', 'docker', ['build', '-t', dockerImage, '.']],
		[
			'Archive the Docker image',
			'bash',
			['-c', 'set -euo pipefail; docker save "$1" | gzip > "$2"', 'bash', dockerImage, dockerAsset]
		]
	];
	if (dryRun) {
		heading('Dry run: build steps (SIGNKIT_RELEASE_TAG and GITHUB_SHA set as in the workflow)');
		log(`rm -rf .release`);
		for (const [title, file, argv] of steps) {
			log(file === 'gate' ? `# ${title}` : `$ ${file} ${argv.join(' ')}`);
		}
		log('# SHA256SUMS, expected-assets.sha256, provenance-statement.json');
		return;
	}

	const startedOn = new Date().toISOString();
	await rm(RELEASE_DIR, { recursive: true, force: true });
	for (const [title, file, argv] of steps) {
		heading(title);
		if (file === 'gate') {
			const semver = await importCreateSignkit('release/semver.js');
			semver.parseReleaseTag(tag);
			semver.parseReleaseTag(`v${versions.createSignkit}`);
			log(
				`tag ${tag} is ${semver.channelFromReleaseTag(tag)}; create-signkit npm dist-tag ${semver.npmDistTagFromReleaseTag(`v${versions.createSignkit}`)}`
			);
			continue;
		}
		if (file === 'tar' || file === 'bash') await ensureAssetsDir();
		await run(file, argv, { env });
	}

	heading('Regenerate and verify unified checksums');
	const checksumNames = checksumAssetNames(tag);
	await run(
		'bash',
		[
			'-c',
			'set -euo pipefail; cd "$1"; shift; rm -f SHA256SUMS; sha256sum "$@" > SHA256SUMS; sha256sum -c SHA256SUMS',
			'bash',
			ASSETS_DIR,
			...checksumNames
		],
		{ env }
	);
	await run(
		'bash',
		[
			'-c',
			'set -euo pipefail; cd "$1"; shift; sha256sum "$@" | sort -k2 > ../expected-assets.sha256',
			'bash',
			ASSETS_DIR,
			'SHA256SUMS',
			...checksumNames
		],
		{ env }
	);
	await assertAssetSet(ASSETS_DIR, tag);
	await assertCleanCheckout('the build changed tracked or unignored files');

	const manifestModule = await importCreateSignkit('release/manifest.js');
	const semver = await importCreateSignkit('release/semver.js');
	const manifest = manifestModule.parseReleaseManifest(
		await readFile(join(ASSETS_DIR, MANIFEST_NAME), 'utf8'),
		{ tag, commit: head }
	);
	const channel = semver.channelFromReleaseTag(tag);
	if (channel !== manifest.channel) {
		throw new Error(
			`release tag ${tag} classified as ${channel} but manifest channel is ${manifest.channel}`
		);
	}
	const subjects = await hashAssets(ASSETS_DIR, releaseAssetNames(tag));
	await assertHashesMatchFile(subjects, EXPECTED_HASHES_PATH);
	const bundleSubject = subjects.find((subject) => subject.name === manifest.bundle.assetName);
	if (!bundleSubject || bundleSubject.sha256 !== manifest.bundle.sha256) {
		throw new Error('Cloudflare bundle digest does not match its manifest');
	}

	const { createMaintainerReleaseStatement } = await importCreateSignkit(
		'release/maintainer-statement.js'
	);
	const statement = createMaintainerReleaseStatement({
		tag,
		commit: head,
		subjects,
		internalParameters: {
			builder: 'scripts/release-local.mjs',
			rehearsal,
			platform: 'x86_64-unknown-linux-gnu',
			dockerImage,
			toolchain
		},
		startedOn,
		finishedOn: new Date().toISOString()
	});
	await writeFileAtomic(STATEMENT_PATH, `${JSON.stringify(statement, null, '\t')}\n`);

	heading(`Release assets for ${tag} (${channel})`);
	for (const subject of subjects) {
		const { size } = await stat(join(ASSETS_DIR, subject.name));
		log(`${subject.sha256}  ${String(size).padStart(11)}  ${subject.name}`);
	}
	log(
		`statement sha256 ${sha256Hex(await readFile(STATEMENT_PATH))}  .release/provenance-statement.json`
	);
	if (rehearsal) {
		note(`rehearsal output; remove the Docker image with: docker image rm ${dockerImage}`);
	} else {
		log(`next: node scripts/release-local.mjs sign --tag ${tag}`);
	}
}

// ---------------------------------------------------------------------------
// sign

async function sign(options) {
	const { tag } = options;
	const context = await loadReleaseContext(tag);
	const { MAINTAINER_SIGNERS } = await importCreateSignkit('release/maintainer-signers.js');
	if (MAINTAINER_SIGNERS.length === 0) {
		throw new Error(
			'packages/create-signkit/src/release/maintainer-signers.ts pins no maintainer; add the signing identity in a reviewed commit on main, then rebuild and sign'
		);
	}
	if (await exists(BUNDLE_PATH)) {
		heading('Verify the existing signature');
		const provenance = await verifyLocalBundle(context, await readBundle()).catch((error) => {
			throw new Error(
				`.release/provenance.sigstore.json does not verify (${error instanceof Error ? error.message : String(error)}); delete it to sign again`,
				{ cause: error }
			);
		});
		log(`already signed and verified: ${describeProvenance(provenance)}`);
		log(`next: node scripts/release-local.mjs npm --tag ${tag}`);
		return;
	}
	heading(`Sign ${tag}`);
	log(
		`statement sha256 ${sha256Hex(context.statementBytes)} (${context.statement.subject.length} subjects, commit ${context.commit})`
	);
	log(`${MAINTAINER_SIGNERS.length} maintainer identity(ies) are pinned in this commit.`);
	if (options['dry-run']) {
		log(
			'[dry-run] would sign in with Sigstore (GitHub account), sign the statement, and verify it'
		);
		return;
	}
	note(
		'Sigstore records the signing certificate, including the GitHub account email, in its public transparency log.'
	);
	const { token, claims } = await obtainSigstoreIdentityToken({
		openBrowser: !options['no-browser']
	});
	if (claims.federated_claims?.connector_id !== GITHUB_CONNECTOR_ID) {
		throw new Error('the Sigstore sign-in did not use a GitHub account; sign in with GitHub');
	}
	if (claims.email_verified !== true || typeof claims.email !== 'string') {
		throw new Error('the GitHub account email is not verified');
	}
	if (!MAINTAINER_SIGNERS.some((entry) => entry.email === claims.email)) {
		throw new Error(`${claims.email} is not a pinned maintainer; nothing was signed`);
	}
	log(`signing as ${claims.email} (GitHub account)`);
	const sigstore = requireFromCreateSignkit('sigstore');
	const bundle = await sigstore.attest(context.statementBytes, IN_TOTO_PAYLOAD_TYPE, {
		identityProvider: { getToken: async () => token },
		timeout: 30_000
	});
	heading('Verify the new signature with create-signkit');
	const provenance = await verifyLocalBundle(context, bundle);
	await writeFileAtomic(BUNDLE_PATH, `${JSON.stringify(bundle, null, '\t')}\n`);
	const logIndex = bundle?.verificationMaterial?.tlogEntries?.[0]?.logIndex;
	log(
		`verified: ${describeProvenance(provenance)}${logIndex ? `; Rekor log index ${logIndex}` : ''}`
	);
	log('wrote .release/provenance.sigstore.json');
	log(`next: node scripts/release-local.mjs npm --tag ${tag}`);
}

// ---------------------------------------------------------------------------
// npm

async function publishNpm(options) {
	const { tag } = options;
	const dryRun = options['dry-run'];
	const context = await loadReleaseContext(tag);
	heading('Verify the release signature before publishing to npm');
	const provenance = await verifyLocalBundle(context, await readBundle());
	log(`verified: ${describeProvenance(provenance)}`);

	heading('Select the lockfile-pinned npm CLI');
	const npmCli = await selectPinnedNpm();
	const packageVersion = context.versions.createSignkit;
	const semver = await importCreateSignkit('release/semver.js');
	const distTag = semver.npmDistTagFromReleaseTag(`v${packageVersion}`);
	if (distTag !== 'latest' && distTag !== 'beta') {
		throw new Error(`refusing to publish with unexpected npm dist-tag ${distTag}`);
	}
	if ((await npmPublishedStatus(npmCli, packageVersion)) === 'published') {
		log(`create-signkit@${packageVersion} is already published; nothing to do`);
		log(`next: node scripts/release-local.mjs publish --tag ${tag}`);
		return;
	}
	if (dryRun) {
		heading(`Dry run: npm publish create-signkit@${packageVersion} --tag ${distTag}`);
		await run(
			'pnpm',
			['exec', npmCli, 'publish', '--dry-run', '--access', 'public', '--tag', distTag],
			{
				cwd: CSK_DIR
			}
		);
		return;
	}
	const whoami = await capture(npmCli, ['whoami'], { cwd: CSK_DIR });
	if (whoami.code !== 0) {
		throw new Error(
			'npm is not logged in; run `npm login` with the package owner account and retry'
		);
	}
	heading(`Publish create-signkit@${packageVersion} with dist-tag ${distTag}`);
	log('npm asks for the account one-time password when two-factor authentication is enabled.');
	await run('pnpm', ['exec', npmCli, 'publish', '--access', 'public', '--tag', distTag], {
		cwd: CSK_DIR
	});
	const confirmed = await retry(
		async () => {
			if ((await npmPublishedStatus(npmCli, packageVersion)) !== 'published') {
				throw new Error('not visible yet');
			}
		},
		{ attempts: 6, delayMs: 5_000, label: `create-signkit@${packageVersion} on npm` }
	).then(
		() => true,
		() => false
	);
	if (!confirmed) {
		throw new Error(
			`npm publish exited 0 but create-signkit@${packageVersion} is not visible yet; check npm before publish`
		);
	}
	log(`create-signkit@${packageVersion} is on npm`);
	log(`next: node scripts/release-local.mjs publish --tag ${tag}`);
}

// ---------------------------------------------------------------------------
// publish

async function publish(options) {
	const { tag } = options;
	const dryRun = options['dry-run'];
	const context = await loadReleaseContext(tag);
	const { commit: head, channel } = context;
	const bundle = await readBundle();
	heading('Verify the release signature');
	const local = await verifyLocalBundle(context, bundle);
	log(`verified: ${describeProvenance(local)}`);

	heading('Check GitHub and npm (read-only)');
	const login = (await output('gh', ['api', 'user', '--jq', '.login'])).trim();
	log(`gh account: ${login}`);
	const remoteMain = (
		await output('gh', ['api', `repos/${REPOSITORY}/commits/main`, '--jq', '.sha'])
	).trim();
	if (remoteMain !== head) {
		throw new Error(`GitHub main is ${remoteMain}, not the built and signed commit ${head}`);
	}
	const tagCommit = await remoteTagCommit(tag);
	if (tagCommit && tagCommit !== head) {
		throw new Error(`tag ${tag} already exists at ${tagCommit}, not ${head}`);
	}
	const npmCli = await selectPinnedNpm();
	const packageVersion = context.versions.createSignkit;
	if ((await npmPublishedStatus(npmCli, packageVersion)) !== 'published') {
		const message = `create-signkit@${packageVersion} is not on npm; run \`node scripts/release-local.mjs npm --tag ${tag}\` first so no public release depends on an unpublished verifier`;
		if (!dryRun) throw new Error(message);
		note(message);
	}

	const prereleaseArg = channel === 'beta' ? '--prerelease' : '--prerelease=false';
	const expectedNames = releaseAssetNames(tag);
	const mutate = async (description, action) => {
		if (dryRun) {
			log(`[dry-run] would ${description}`);
			return undefined;
		}
		log(description);
		return action();
	};

	heading(`Draft release ${tag}`);
	const existing = await releaseView(tag);
	let remoteNames = [];
	if (!existing) {
		await mutate(`create draft release ${tag} at ${head} (${prereleaseArg})`, () =>
			run('gh', [
				'release',
				'create',
				tag,
				'--repo',
				REPOSITORY,
				'--draft',
				'--target',
				head,
				'--generate-notes',
				prereleaseArg
			])
		);
	} else {
		// Rerun path: the release is immutable from here unless it is still a
		// draft with matching metadata, target, and only expected asset names.
		if (existing.isDraft !== true) {
			throw new Error(`refusing to upload to existing public release ${tag}`);
		}
		if (existing.isPrerelease !== (channel === 'beta')) {
			throw new Error(
				`refusing to mutate draft release ${tag}: prerelease metadata does not match the tag channel`
			);
		}
		await assertDraftTarget(tag, existing, head);
		remoteNames = (existing.assets ?? []).map((asset) => asset.name);
		for (const name of remoteNames) {
			if (!expectedNames.includes(name)) {
				throw new Error(
					`refusing to mutate draft release ${tag}: unexpected existing asset ${name}`
				);
			}
		}
		log(`reusing draft release ${tag} (${remoteNames.length} existing assets)`);
	}

	heading('Upload release assets');
	const scratch = await mkdtemp(join(tmpdir(), 'signkit-release-'));
	try {
		for (const name of expectedNames) {
			const localPath = join(ASSETS_DIR, name);
			if (remoteNames.includes(name)) {
				const dir = await mkdtemp(join(scratch, 'asset-'));
				await run('gh', [
					'release',
					'download',
					tag,
					'--repo',
					REPOSITORY,
					'--pattern',
					name,
					'--dir',
					dir
				]);
				if (!(await sameBytes(localPath, join(dir, name)))) {
					throw new Error(
						`refusing to replace mismatched existing asset ${name} on draft release ${tag}`
					);
				}
				log(`reusing byte-identical draft asset ${name}`);
			} else {
				await mutate(`upload ${name}`, () =>
					run('gh', ['release', 'upload', tag, localPath, '--repo', REPOSITORY])
				);
			}
		}

		heading('Store the maintainer attestation with GitHub');
		const existingBundles = await listAttestationBundles(context.bundleSha256);
		const ourSignature = dsseSignature(bundle);
		if (existingBundles.some((candidate) => dsseSignature(candidate) === ourSignature)) {
			log('this signature is already stored for the Cloudflare bundle digest');
		} else {
			await mutate(
				`upload the attestation (${existingBundles.length} already stored for this digest)`,
				async () => {
					const body = join(scratch, 'attestation.json');
					await writeFile(body, JSON.stringify({ bundle }));
					const id = await output('gh', [
						'api',
						'--method',
						'POST',
						`repos/${REPOSITORY}/attestations`,
						'--input',
						body,
						'--jq',
						'.id'
					]);
					log(`stored attestation ${id.trim()}`);
				}
			);
		}
		if (dryRun) {
			log(
				'[dry-run] would re-download the draft, verify it with create-signkit, and mark it public'
			);
			return;
		}

		heading('Verify the draft exactly as create-signkit will');
		const verified = await verifyDraft(context, scratch);
		log(`verified draft: ${describeProvenance(verified)}`);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}

	heading(`Mark ${tag} public`);
	const final = await releaseView(tag);
	if (!final || final.isDraft !== true) {
		throw new Error(`release ${tag} is no longer a draft; refusing any further mutation`);
	}
	await assertDraftTarget(tag, final, head);
	await run('gh', ['release', 'edit', tag, '--repo', REPOSITORY, '--draft=false']);

	heading('Resolve the public release with create-signkit');
	const github = await importCreateSignkit('release/github.js');
	const http = (await importCreateSignkit('runtime/http.js')).createFetchHttpClient();
	try {
		const prepared = await retry(
			async () => {
				const resolver = github.createGithubReleaseResolver(http);
				const resolved = await resolver.resolve({ version: tag, channel });
				return resolver.prepareBundle(resolved);
			},
			{ attempts: 6, delayMs: 10_000, label: 'public release resolution' }
		);
		log(`create-signkit resolves ${tag}: ${describeProvenance(prepared.provenance)}`);
	} catch (error) {
		throw new Error(
			`${tag} is public, but create-signkit could not verify it: ${error instanceof Error ? error.message : String(error)}. ` +
				'Do not delete or retag the release; investigate and cut a patch release if needed.',
			{ cause: error }
		);
	}
}

async function verifyDraft(context, scratch) {
	const { tag, commit, channel } = context;
	const view = await releaseView(tag);
	if (!view || view.isDraft !== true) throw new Error(`expected draft release ${tag}`);
	const expected = [...releaseAssetNames(tag)].sort();
	const remote = (view.assets ?? []).map((asset) => asset.name).sort();
	if (expected.join('\n') !== remote.join('\n')) {
		throw new Error(
			`refusing to publish draft release ${tag}: remote asset set differs from the signed statement`
		);
	}
	const dir = await mkdtemp(join(scratch, 'draft-'));
	await run('gh', ['release', 'download', tag, '--repo', REPOSITORY, '--dir', dir]);
	const downloaded = (await readdir(dir)).sort();
	if (expected.join('\n') !== downloaded.join('\n')) {
		throw new Error(
			`refusing to publish draft release ${tag}: downloaded asset set is incomplete or unexpected`
		);
	}
	for (const subject of await hashAssets(dir, expected)) {
		if (context.subjects.get(subject.name) !== subject.sha256) {
			throw new Error(
				`refusing to publish draft release ${tag}: ${subject.name} differs from the signed statement`
			);
		}
	}
	const manifestModule = await importCreateSignkit('release/manifest.js');
	const github = await importCreateSignkit('release/github.js');
	const provenanceModule = await importCreateSignkit('release/provenance.js');
	const httpModule = await importCreateSignkit('runtime/http.js');
	const manifest = manifestModule.parseReleaseManifest(
		await readFile(join(dir, MANIFEST_NAME), 'utf8'),
		{
			tag,
			commit
		}
	);
	if (manifest.channel !== channel) {
		throw new Error(`draft manifest channel ${manifest.channel} does not match ${channel}`);
	}
	const bundleBytes = await readFile(join(dir, manifest.bundle.assetName));
	const digest = github.sha256Hex(bundleBytes);
	if (digest !== manifest.bundle.sha256 || bundleBytes.byteLength !== manifest.bundle.size) {
		throw new Error('draft Cloudflare bundle does not match its manifest');
	}
	// The resolver refuses drafts by design, so build the same resolved release
	// it would produce and run the unchanged online provenance verifier.
	const release = {
		tag,
		channel,
		prerelease: channel === 'beta',
		commit,
		manifest,
		manifestUrl: github.githubDownloadUrl(tag, MANIFEST_NAME),
		bundleUrl: github.githubDownloadUrl(tag, manifest.bundle.assetName)
	};
	const verifier = provenanceModule.createGithubProvenanceVerifier(
		httpModule.createFetchHttpClient()
	);
	const provenance = await retry(() => verifier.verify(release, digest), {
		attempts: 6,
		delayMs: 10_000,
		label: 'attestation lookup',
		retryIf: (error) => /provenance is missing|temporarily unavailable/.test(String(error?.message))
	});
	if (provenance.kind !== 'maintainer') {
		throw new Error(
			`draft provenance verified as ${provenance.kind}, not the maintainer signature`
		);
	}
	return provenance;
}

// ---------------------------------------------------------------------------
// release context shared by sign, npm, and publish

async function loadReleaseContext(tag) {
	heading(`Check the local ${tag} build`);
	let statementBytes;
	try {
		statementBytes = await readFile(STATEMENT_PATH);
	} catch {
		throw new Error(`.release/provenance-statement.json is missing; run build --tag ${tag} first`);
	}
	const statement = JSON.parse(statementBytes.toString('utf8'));
	if (!Array.isArray(statement?.subject)) {
		throw new Error('.release/provenance-statement.json has no subject list');
	}
	const definition = statement?.predicate?.buildDefinition;
	const parameters = definition?.externalParameters;
	if (definition?.internalParameters?.rehearsal !== false) {
		throw new Error('this is a rehearsal build; rebuild from origin/main without --rehearsal');
	}
	if (parameters?.ref !== `refs/tags/${tag}` || !/^[0-9a-f]{40}$/.test(parameters?.commit ?? '')) {
		throw new Error(`.release/provenance-statement.json was not built for ${tag}`);
	}
	const commit = parameters.commit;
	await assertCleanCheckout();
	const head = await gitHead();
	if (head !== commit) {
		throw new Error(`HEAD ${head} is not the built commit ${commit}`);
	}
	const originMain = await localOriginMain();
	if (originMain !== head) {
		throw new Error(`HEAD ${head} is not origin/main ${originMain ?? '(missing)'}`);
	}
	const versions = await readVersions();
	assertProductVersions(tag, versions);

	// Rebuild create-signkit so every check below runs the verifier and
	// pinned signer list of exactly this commit.
	await run('pnpm', ['run', 'build:create-signkit']);
	const { MAINTAINER_BUILD_TYPE } = await importCreateSignkit('release/maintainer-statement.js');
	const semver = await importCreateSignkit('release/semver.js');
	const manifestModule = await importCreateSignkit('release/manifest.js');
	if (
		definition.buildType !== MAINTAINER_BUILD_TYPE ||
		statement.predicateType !== SLSA_PREDICATE_TYPE
	) {
		throw new Error('.release/provenance-statement.json is not a maintainer release statement');
	}
	semver.parseReleaseTag(`v${versions.createSignkit}`);

	await assertAssetSet(ASSETS_DIR, tag);
	const subjects = new Map(
		statement.subject.map((subject) => [subject.name, subject.digest?.sha256])
	);
	const names = releaseAssetNames(tag);
	if (subjects.size !== names.length || statement.subject.length !== names.length) {
		throw new Error('the statement subjects are not exactly the release assets');
	}
	for (const subject of await hashAssets(ASSETS_DIR, names)) {
		if (subjects.get(subject.name) !== subject.sha256) {
			throw new Error(`${subject.name} changed after build; rebuild before signing or publishing`);
		}
	}
	await run('bash', [
		'-c',
		'set -euo pipefail; cd "$1"; sha256sum --quiet -c SHA256SUMS',
		'bash',
		ASSETS_DIR
	]);
	const manifest = manifestModule.parseReleaseManifest(
		await readFile(join(ASSETS_DIR, MANIFEST_NAME), 'utf8'),
		{
			tag,
			commit
		}
	);
	const channel = semver.channelFromReleaseTag(tag);
	if (channel !== manifest.channel) {
		throw new Error(
			`release tag ${tag} classified as ${channel} but manifest channel is ${manifest.channel}`
		);
	}
	const bundleSha256 = subjects.get(manifest.bundle.assetName);
	if (bundleSha256 !== manifest.bundle.sha256) {
		throw new Error('Cloudflare bundle digest does not match its manifest');
	}
	log(`assets match the statement for ${tag} at ${commit}`);
	return {
		tag,
		commit,
		channel,
		versions,
		statement,
		statementBytes,
		subjects,
		manifest,
		bundleSha256
	};
}

async function verifyLocalBundle(context, bundle) {
	const { verifyMaintainerReleaseBundle } = await importCreateSignkit('release/provenance.js');
	const github = await importCreateSignkit('release/github.js');
	const release = {
		tag: context.tag,
		channel: context.channel,
		prerelease: context.channel === 'beta',
		commit: context.commit,
		manifest: context.manifest,
		manifestUrl: github.githubDownloadUrl(context.tag, MANIFEST_NAME),
		bundleUrl: github.githubDownloadUrl(context.tag, context.manifest.bundle.assetName)
	};
	const payload = bundle?.dsseEnvelope?.payload;
	if (
		typeof payload !== 'string' ||
		!Buffer.from(payload, 'base64').equals(context.statementBytes)
	) {
		throw new Error('the signed payload is not .release/provenance-statement.json');
	}
	return verifyMaintainerReleaseBundle(bundle, release, context.bundleSha256);
}

async function readBundle() {
	try {
		return JSON.parse(await readFile(BUNDLE_PATH, 'utf8'));
	} catch {
		throw new Error('.release/provenance.sigstore.json is missing or invalid; run sign first');
	}
}

function describeProvenance(provenance) {
	return provenance.kind === 'maintainer'
		? `maintainer signature (pinned GitHub account) for ${provenance.subjectName} at ${provenance.sourceRef}, commit ${provenance.sourceCommit}`
		: `${provenance.workflow} at ${provenance.sourceRef}, commit ${provenance.sourceCommit}`;
}

// ---------------------------------------------------------------------------
// Sigstore keyless sign-in (authorization code + PKCE, loopback redirect)

/**
 * Signs in to Sigstore's OIDC provider in the browser and returns an ID token
 * for Fulcio. `issuer` and `onAuthorizationUrl` exist for the loopback test.
 */
export async function obtainSigstoreIdentityToken({
	openBrowser,
	issuer = SIGSTORE_OIDC_ISSUER,
	onAuthorizationUrl = printAuthorizationUrl
}) {
	const discovery = await fetchJson(`${issuer}/.well-known/openid-configuration`);
	if (discovery.issuer !== issuer) {
		throw new Error('unexpected Sigstore OIDC discovery issuer');
	}
	const authorizationEndpoint = assertIssuerEndpoint(discovery.authorization_endpoint, issuer);
	const tokenEndpoint = assertIssuerEndpoint(discovery.token_endpoint, issuer);
	const codeVerifier = base64url(randomBytes(32));
	const state = base64url(randomBytes(24));
	const nonce = base64url(randomBytes(24));

	const sockets = new Set();
	const server = createServer();
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
	});
	await new Promise((resolvePromise, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolvePromise);
	});
	const { port } = server.address();
	const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
	const authUrl = new URL(authorizationEndpoint);
	authUrl.search = new URLSearchParams({
		response_type: 'code',
		client_id: SIGSTORE_OIDC_CLIENT_ID,
		scope: 'openid email',
		redirect_uri: redirectUri,
		code_challenge: base64url(createHash('sha256').update(codeVerifier).digest()),
		code_challenge_method: 'S256',
		state,
		nonce,
		connector_id: GITHUB_CONNECTOR_ID
	}).toString();

	let readline;
	let timer;
	let code;
	try {
		code = await new Promise((resolvePromise, reject) => {
			const accept = (url, respond) => {
				const params = url.searchParams;
				if (!safeEqual(params.get('state') ?? '', state)) {
					respond?.(400, 'Sign-in state mismatch. Return to the terminal.');
					reject(new Error('sign-in callback state mismatch; run sign again'));
					return;
				}
				const failure = params.get('error');
				if (failure) {
					respond?.(400, 'Sign-in failed. Return to the terminal.');
					reject(
						new Error(`Sigstore sign-in failed (${failure.replace(/[^\w.-]/g, '').slice(0, 64)})`)
					);
					return;
				}
				const value = params.get('code');
				if (!value) {
					respond?.(400, 'No authorization code. Return to the terminal.');
					reject(new Error('sign-in callback carried no authorization code'));
					return;
				}
				respond?.(200, 'Signed in. Return to the terminal to finish signing.');
				resolvePromise(value);
			};
			server.on('request', (request, response) => {
				const url = new URL(request.url ?? '/', redirectUri);
				if (request.method !== 'GET' || url.pathname !== '/auth/callback') {
					response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
					return;
				}
				accept(url, (status, text) =>
					response
						.writeHead(status, {
							'content-type': 'text/plain; charset=utf-8',
							'cache-control': 'no-store'
						})
						.end(text)
				);
			});
			timer = setTimeout(
				() => reject(new Error('timed out waiting for the Sigstore sign-in')),
				OIDC_LOGIN_TIMEOUT_MS
			);

			onAuthorizationUrl(authUrl.toString(), redirectUri);
			if (process.stdin.isTTY) {
				log(
					'If the browser runs elsewhere, paste the full address it was sent to and press Enter.'
				);
				readline = createInterface({ input: process.stdin });
				readline.on('line', (line) => {
					try {
						const url = new URL(line.trim());
						if (url.origin === new URL(redirectUri).origin && url.pathname === '/auth/callback') {
							accept(url);
						}
					} catch {
						// Not a URL; keep waiting for the browser.
					}
				});
			}
			if (openBrowser && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
				const child = spawn('xdg-open', [authUrl.toString()], { stdio: 'ignore', detached: true });
				child.on('error', () => {});
				child.unref();
			}
		});
	} finally {
		clearTimeout(timer);
		if (readline) {
			readline.close();
			process.stdin.unref?.();
		}
		for (const socket of sockets) socket.destroy();
		server.close();
	}

	const response = await fetch(tokenEndpoint, {
		method: 'POST',
		redirect: 'error',
		signal: AbortSignal.timeout(30_000),
		headers: {
			authorization: `Basic ${Buffer.from(`${SIGSTORE_OIDC_CLIENT_ID}:`).toString('base64')}`,
			'content-type': 'application/x-www-form-urlencoded',
			accept: 'application/json'
		},
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
			code_verifier: codeVerifier
		}).toString()
	});
	if (!response.ok) {
		throw new Error(`Sigstore token exchange failed (HTTP ${response.status})`);
	}
	const token = (await response.json())?.id_token;
	if (typeof token !== 'string') {
		throw new Error('Sigstore token response carried no ID token');
	}
	const claims = decodeJwtClaims(token);
	if (claims.iss !== issuer || !safeEqual(String(claims.nonce ?? ''), nonce)) {
		throw new Error('Sigstore ID token issuer or nonce does not match this sign-in');
	}
	return { token, claims };
}

function printAuthorizationUrl(url, redirectUri) {
	log('');
	log('Open this URL and sign in with the GitHub account of a pinned maintainer:');
	log('');
	log(`  ${url}`);
	log('');
	log(`The browser returns to ${redirectUri} on this machine.`);
}

function assertIssuerEndpoint(value, issuer) {
	const url = new URL(String(value));
	if (url.origin !== new URL(issuer).origin || url.username || url.password) {
		throw new Error('Sigstore OIDC discovery returned an endpoint outside the issuer');
	}
	return url.toString();
}

export function decodeJwtClaims(token) {
	const part = token.split('.')[1];
	if (!part) throw new Error('Sigstore ID token is malformed');
	return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

// ---------------------------------------------------------------------------
// GitHub helpers (plain gh; run under the release owner's login)

async function releaseView(tag) {
	const result = await capture('gh', [
		'release',
		'view',
		tag,
		'--repo',
		REPOSITORY,
		'--json',
		'isDraft,isPrerelease,targetCommitish,assets'
	]);
	if (result.code !== 0) {
		if (/release not found|HTTP 404/i.test(result.stderr)) return undefined;
		throw new Error(`gh release view ${tag} failed: ${lastLine(result.stderr)}`);
	}
	return JSON.parse(result.stdout);
}

async function assertDraftTarget(tag, release, head) {
	const target = String(release.targetCommitish ?? '');
	const sha = (
		await output('gh', [
			'api',
			`repos/${REPOSITORY}/commits/${encodeURIComponent(target)}`,
			'--jq',
			'.sha'
		])
	).trim();
	if (sha !== head) {
		throw new Error(
			`refusing to publish draft release ${tag}: target ${target} resolves to ${sha}, not ${head}`
		);
	}
}

async function remoteTagCommit(tag) {
	const result = await capture('gh', [
		'api',
		`repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`
	]);
	if (result.code !== 0) {
		if (/HTTP 404/.test(result.stderr)) return undefined;
		throw new Error(`tag lookup failed: ${lastLine(result.stderr)}`);
	}
	const ref = JSON.parse(result.stdout);
	if (ref?.object?.type === 'tag') {
		const object = JSON.parse(
			await output('gh', ['api', `repos/${REPOSITORY}/git/tags/${ref.object.sha}`])
		);
		return object?.object?.sha;
	}
	return ref?.object?.sha;
}

async function listAttestationBundles(digest) {
	const predicate = encodeURIComponent(SLSA_PREDICATE_TYPE);
	const result = await capture('gh', [
		'api',
		'-H',
		`X-GitHub-Api-Version: ${ATTESTATION_API_VERSION}`,
		`repos/${REPOSITORY}/attestations/sha256:${digest}?predicate_type=${predicate}&per_page=10`
	]);
	if (result.code !== 0) {
		if (/HTTP 404/.test(result.stderr)) return [];
		throw new Error(`attestation lookup failed: ${lastLine(result.stderr)}`);
	}
	const bundles = [];
	for (const item of JSON.parse(result.stdout)?.attestations ?? []) {
		if (item?.bundle && typeof item.bundle === 'object') {
			bundles.push(item.bundle);
			continue;
		}
		const url = new URL(String(item?.bundle_url ?? ''));
		if (url.protocol !== 'https:' || url.hostname !== ATTESTATION_BLOB_HOST) {
			throw new Error('GitHub returned an attestation bundle URL outside its blob store');
		}
		const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
		if (!response.ok)
			throw new Error(`attestation bundle download failed (HTTP ${response.status})`);
		const { uncompress } = requireFromCreateSignkit('snappyjs');
		const decoded = uncompress(new Uint8Array(await response.arrayBuffer()), 4 * 1024 * 1024);
		bundles.push(JSON.parse(Buffer.from(decoded).toString('utf8')));
	}
	return bundles;
}

function dsseSignature(bundle) {
	const signature = bundle?.dsseEnvelope?.signatures?.[0]?.sig;
	return typeof signature === 'string' && signature.length > 0 ? signature : undefined;
}

// ---------------------------------------------------------------------------
// npm helpers (same rules as the workflow's publish-npm job)

async function selectPinnedNpm() {
	const rootPackage = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
	const expected = rootPackage.devDependencies?.npm;
	let selected = (await output('pnpm', ['exec', 'which', 'npm'])).trim();
	selected = await realpath(resolve(ROOT, selected));
	if (!isAbsolute(selected)) throw new Error(`npm CLI path is not absolute: ${selected}`);
	await access(selected, constants.X_OK).catch(() => {
		throw new Error(`npm CLI was not found at ${selected}`);
	});
	const version = (await output(selected, ['--version'])).trim();
	if (version !== expected) {
		throw new Error(`lockfile-pinned npm CLI mismatch: expected ${expected}, got ${version}`);
	}
	log(`npm ${version} (${selected})`);
	return selected;
}

async function npmPublishedStatus(npmCli, version) {
	const result = await capture(npmCli, ['view', `create-signkit@${version}`, 'version', '--json'], {
		cwd: ROOT
	});
	if (result.code !== 0) {
		if (/E404|404 Not Found|is not in this registry/.test(result.stderr)) return 'unpublished';
		throw new Error(
			`npm registry lookup failed; refusing to infer that create-signkit@${version} is unpublished`
		);
	}
	let value;
	try {
		value = JSON.parse(result.stdout);
	} catch {
		value = undefined;
	}
	if (value === version || (Array.isArray(value) && value.includes(version))) return 'published';
	throw new Error(
		`npm registry returned unexpected version metadata for create-signkit@${version}`
	);
}

// ---------------------------------------------------------------------------
// versions, assets, and checkout

export function assertTagFormat(tag) {
	if (!TAG_RE.test(tag) || Buffer.byteLength(tag, 'utf8') > 35) {
		throw new UsageError(
			`release tag must look like v1.2.3 or v1.2.3-beta.1 (at most 35 bytes), got ${JSON.stringify(tag)}`
		);
	}
	return tag;
}

async function readVersions() {
	const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;
	const createSignkit = JSON.parse(await readFile(join(CSK_DIR, 'package.json'), 'utf8')).version;
	const cargo = await readFile(join(ROOT, 'cli/Cargo.toml'), 'utf8');
	const match = cargo.match(/^version\s*=\s*"([^"]+)"/m);
	if (!match) throw new Error('cli version not found');
	return { root, cli: match[1], createSignkit };
}

function assertProductVersions(tag, versions) {
	const version = tag.slice(1);
	if (version !== versions.root || version !== versions.cli) {
		throw new Error(
			`release tag ${tag} does not match product versions root=${versions.root} cli=${versions.cli}`
		);
	}
}

export function checksumAssetNames(tag) {
	return [
		MANIFEST_NAME,
		`signkit-cloudflare-${tag}.tar.gz`,
		`signkit-node-${tag}.tar.gz`,
		`signkit-${tag}-x86_64-unknown-linux-gnu.tar.gz`,
		`signkit-docker-${tag}.tar.gz`
	];
}

export function releaseAssetNames(tag) {
	return ['SHA256SUMS', ...checksumAssetNames(tag)];
}

async function assertAssetSet(dir, tag) {
	const actual = (await readdir(dir)).sort();
	const expected = [...releaseAssetNames(tag)].sort();
	if (actual.join('\n') !== expected.join('\n')) {
		throw new Error(
			`.release/assets must contain exactly ${expected.join(', ')}; found ${actual.join(', ')}`
		);
	}
}

async function hashAssets(dir, names) {
	const subjects = [];
	for (const name of names) {
		subjects.push({ name, sha256: await sha256File(join(dir, name)) });
	}
	return subjects;
}

async function assertHashesMatchFile(subjects, path) {
	const listed = new Map(
		(await readFile(path, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => {
				const [sha256, name] = line.split(/\s+\*?/);
				return [name, sha256];
			})
	);
	if (
		listed.size !== subjects.length ||
		subjects.some((subject) => listed.get(subject.name) !== subject.sha256)
	) {
		throw new Error('sha256sum and the statement digests disagree');
	}
}

async function readToolchain() {
	const first = async (file, argv) => (await output(file, argv)).split('\n')[0].trim();
	return {
		node: process.version,
		pnpm: await first('pnpm', ['--version']),
		rustc: (await first('rustc', ['--version'])).replace(/^rustc\s+/, ''),
		cargo: (await first('cargo', ['--version'])).replace(/^cargo\s+/, ''),
		docker: await first('docker', ['version', '--format', '{{.Server.Version}}'])
	};
}

async function dockerImageExists(image) {
	return (await capture('docker', ['image', 'inspect', image])).code === 0;
}

async function assertCleanCheckout(reason = 'the checkout has uncommitted or untracked files') {
	const status = await output('git', ['status', '--porcelain=v1', '--untracked-files=all']);
	if (status.trim().length > 0) {
		const lines = status.trim().split('\n');
		throw new Error(
			`${reason}:\n${lines.slice(0, 20).join('\n')}${lines.length > 20 ? '\n...' : ''}`
		);
	}
}

async function gitHead() {
	return (await output('git', ['rev-parse', 'HEAD'])).trim();
}

async function localOriginMain() {
	const result = await capture('git', [
		'rev-parse',
		'--verify',
		'--quiet',
		'refs/remotes/origin/main^{commit}'
	]);
	return result.code === 0 ? result.stdout.trim() : undefined;
}

async function ensureAssetsDir() {
	await mkdir(ASSETS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// small utilities

async function importCreateSignkit(path) {
	return import(pathToFileURL(join(CSK_DIR, 'dist', path)).href);
}

function requireFromCreateSignkit(name) {
	return createRequire(join(CSK_DIR, 'package.json'))(name);
}

function run(file, argv, { cwd = ROOT, env = process.env } = {}) {
	log(`$ ${file} ${argv.join(' ')}`);
	return new Promise((resolvePromise, reject) => {
		const child = spawn(file, argv, { cwd, env, stdio: 'inherit' });
		child.on('error', reject);
		child.on('close', (code, signal) => {
			if (code === 0) resolvePromise();
			else reject(new Error(`${file} ${argv[0] ?? ''} exited with ${signal ?? code}`));
		});
	});
}

function capture(file, argv, { cwd = ROOT, env = process.env } = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(file, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
		const stdout = [];
		const stderr = [];
		child.stdout.on('data', (chunk) => stdout.push(chunk));
		child.stderr.on('data', (chunk) => stderr.push(chunk));
		child.on('error', reject);
		child.on('close', (code) =>
			resolvePromise({
				code,
				stdout: Buffer.concat(stdout).toString('utf8'),
				stderr: Buffer.concat(stderr).toString('utf8')
			})
		);
	});
}

async function output(file, argv, options) {
	const result = await capture(file, argv, options);
	if (result.code !== 0) {
		throw new Error(`${file} ${argv[0] ?? ''} failed: ${lastLine(result.stderr)}`);
	}
	return result.stdout;
}

async function retry(action, { attempts, delayMs, label, retryIf = () => true }) {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await action();
		} catch (error) {
			if (attempt >= attempts || !retryIf(error)) throw error;
			log(
				`${label}: ${error instanceof Error ? error.message : String(error)}; retrying in ${delayMs / 1000}s`
			);
			await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
		}
	}
}

async function fetchJson(url) {
	const response = await fetch(url, {
		redirect: 'error',
		signal: AbortSignal.timeout(30_000),
		headers: { accept: 'application/json' }
	});
	if (!response.ok) throw new Error(`GET ${url} failed (HTTP ${response.status})`);
	return response.json();
}

async function sha256File(path) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest('hex');
}

function sha256Hex(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

async function sameBytes(left, right) {
	const [a, b] = await Promise.all([stat(left), stat(right)]);
	return a.size === b.size && (await sha256File(left)) === (await sha256File(right));
}

async function writeFileAtomic(path, text) {
	const temporary = `${path}.tmp-${process.pid}`;
	await writeFile(temporary, text, { mode: 0o644 });
	await rename(temporary, path);
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function base64url(bytes) {
	return Buffer.from(bytes).toString('base64url');
}

function safeEqual(left, right) {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

function lastLine(text) {
	return text.trim().split('\n').at(-1) ?? '';
}

function heading(text) {
	process.stdout.write(`\n==> ${text}\n`);
}

function log(text) {
	process.stdout.write(`${text}\n`);
}

function note(text) {
	process.stdout.write(`NOTE: ${text}\n`);
}
