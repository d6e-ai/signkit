import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import {
	assertTagFormat,
	checksumAssetNames,
	decodeJwtClaims,
	obtainSigstoreIdentityToken,
	releaseAssetNames,
	uploadDraft,
	verifyDraft
} from './release-local.mjs';

const TAG = 'v1.2.3';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const SIGNATURE = `signkit-provenance-${TAG}.sigstore.json`;

test('release-local produces exactly the workflow asset names', async () => {
	const workflow = await readFile(
		new URL('../.github/workflows/release-cloudflare-bundle.yml', import.meta.url),
		'utf8'
	);
	const block = workflow.match(/expected_assets=\(\n([\s\S]*?)\n\s*\)/)?.[1];
	assert.ok(block, 'workflow expected_assets list not found');
	const workflowNames = [...block.matchAll(/"\.release\/assets\/([^"]+)"/g)].map((match) =>
		match[1].replaceAll('${tag}', 'v1.2.3-beta.1')
	);
	assert.deepEqual([...releaseAssetNames('v1.2.3-beta.1')].sort(), [...workflowNames].sort());
	assert.equal(workflowNames.length, 6);
});

test('release-local accepts only plain semver tags within the identity limit', () => {
	for (const tag of ['v0.1.18', 'v1.2.3-beta.1', `v1.2.3-${'a'.repeat(28)}`]) {
		assert.equal(assertTagFormat(tag), tag);
	}
	for (const tag of ['0.1.18', 'v1.2', 'v1.2.3+build.1', `v1.2.3-${'a'.repeat(29)}`, 'v1.2.3 ']) {
		assert.throws(() => assertTagFormat(tag), /release tag must look like/);
	}
});

test('Sigstore sign-in uses PKCE, the GitHub connector, and a loopback redirect', async (t) => {
	const provider = await fakeProvider(t);
	const token = await obtainSigstoreIdentityToken({
		openBrowser: false,
		issuer: provider.issuer,
		onAuthorizationUrl: async (url, redirectUri) => {
			const params = new URL(url).searchParams;
			assert.equal(new URL(url).origin, new URL(provider.issuer).origin);
			assert.equal(params.get('client_id'), 'sigstore');
			assert.equal(params.get('response_type'), 'code');
			assert.equal(params.get('scope'), 'openid email');
			assert.equal(params.get('connector_id'), 'https://github.com/login/oauth');
			assert.equal(params.get('code_challenge_method'), 'S256');
			assert.equal(params.get('redirect_uri'), redirectUri);
			assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
			provider.challenge = params.get('code_challenge');
			provider.nonce = params.get('nonce');
			provider.redirectUri = redirectUri;
			const response = await fetch(
				`${redirectUri}?code=fake-code&state=${encodeURIComponent(params.get('state'))}`
			);
			assert.equal(response.status, 200);
		}
	});
	assert.equal(token.claims.email, 'maintainer@example.com');
	assert.equal(token.claims.federated_claims.connector_id, 'https://github.com/login/oauth');
	assert.deepEqual(decodeJwtClaims(token.token), token.claims);
	assert.equal(provider.tokenRequests, 1);
});

test('Sigstore sign-in rejects a forged state or a provider error', async (t) => {
	const provider = await fakeProvider(t);
	for (const [query, message] of [
		['code=fake-code&state=forged', /state mismatch/],
		['error=access_denied', /state mismatch/]
	]) {
		await assert.rejects(
			obtainSigstoreIdentityToken({
				openBrowser: false,
				issuer: provider.issuer,
				onAuthorizationUrl: async (_url, redirectUri) => {
					const response = await fetch(`${redirectUri}?${query}`);
					assert.equal(response.status, 400);
				}
			}),
			message
		);
	}
	await assert.rejects(
		obtainSigstoreIdentityToken({
			openBrowser: false,
			issuer: provider.issuer,
			onAuthorizationUrl: async (url, redirectUri) => {
				const state = new URL(url).searchParams.get('state');
				await fetch(`${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}`);
			}
		}),
		/Sigstore sign-in failed \(access_denied\)/
	);
	assert.equal(provider.tokenRequests, 0);
});

test('Sigstore sign-in refuses discovery endpoints outside the issuer', async (t) => {
	const provider = await fakeProvider(t, { tokenEndpoint: 'https://attacker.example/token' });
	await assert.rejects(
		obtainSigstoreIdentityToken({
			openBrowser: false,
			issuer: provider.issuer,
			onAuthorizationUrl: () => assert.fail('must not start a sign-in')
		}),
		/outside the issuer/
	);
});

async function fakeProvider(t, overrides = {}) {
	const state = { tokenRequests: 0 };
	const server = createServer(async (request, response) => {
		const url = new URL(request.url, state.issuer);
		if (url.pathname === '/auth/.well-known/openid-configuration') {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(
				JSON.stringify({
					issuer: state.issuer,
					authorization_endpoint: `${state.issuer}/auth`,
					token_endpoint: overrides.tokenEndpoint ?? `${state.issuer}/token`
				})
			);
			return;
		}
		if (url.pathname === '/auth/token' && request.method === 'POST') {
			state.tokenRequests += 1;
			let body = '';
			for await (const chunk of request) body += chunk;
			const form = new URLSearchParams(body);
			const verifier = form.get('code_verifier') ?? '';
			const challenge = createHash('sha256').update(verifier).digest('base64url');
			if (
				request.headers.authorization !== `Basic ${Buffer.from('sigstore:').toString('base64')}` ||
				form.get('grant_type') !== 'authorization_code' ||
				form.get('code') !== 'fake-code' ||
				form.get('redirect_uri') !== state.redirectUri ||
				challenge !== state.challenge
			) {
				response.writeHead(400).end();
				return;
			}
			const claims = {
				iss: state.issuer,
				aud: 'sigstore',
				nonce: state.nonce,
				email: 'maintainer@example.com',
				email_verified: true,
				federated_claims: { connector_id: 'https://github.com/login/oauth', user_id: '1' }
			};
			const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(
				JSON.stringify({ id_token: `${encode({ alg: 'none' })}.${encode(claims)}.signature` })
			);
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	state.issuer = `http://127.0.0.1:${server.address().port}/auth`;
	return state;
}

test('the maintainer signature is a separate asset, not a SHA256SUMS or statement entry', () => {
	assert.equal(releaseAssetNames(TAG).includes(SIGNATURE), false);
	assert.equal(checksumAssetNames(TAG).includes(SIGNATURE), false);
});

test('publish dry run plans the draft with the signature asset and mutates nothing', async (t) => {
	const local = await localRelease(t);
	const github = fakeGithub();
	await uploadDraft({ ...local.args, dryRun: true, gh: github.ops });
	assert.deepEqual(
		github.calls.map(([name]) => name),
		['view']
	);
	assert.equal(github.release, undefined);
});

test('publish uploads all seven assets, then verifies the draft as create-signkit will', async (t) => {
	const local = await localRelease(t);
	const github = fakeGithub();
	await uploadDraft({ ...local.args, dryRun: false, gh: github.ops });
	assert.deepEqual(github.calls[1], ['createDraft', TAG, HEAD, '--prerelease=false']);
	assert.deepEqual(
		github.calls.filter(([name]) => name === 'upload').map(([, , name]) => name),
		[...releaseAssetNames(TAG), SIGNATURE]
	);
	assert.equal(
		github.calls.some(([name]) => name === 'attest'),
		false,
		'no attestations API call'
	);

	const csk = fakeCreateSignkit();
	const provenance = await verifyDraft({ ...local.verifyArgs, gh: github.ops, csk });
	assert.equal(provenance.kind, 'maintainer');
	const [release, digest] = csk.verified;
	assert.deepEqual(release.maintainerSignature, {
		assetName: SIGNATURE,
		size: local.signature.byteLength
	});
	assert.equal(digest, local.bundleSha256);
	assert.deepEqual(Buffer.from(csk.signatureBody), local.signature);
	assert.deepEqual(csk.networkUrls, ['https://api.github.com/attestations-lookup']);
});

test('publish reuses byte-identical draft assets and refuses a different signature', async (t) => {
	const local = await localRelease(t);
	const github = fakeGithub(await draftWith(local.files));
	await uploadDraft({ ...local.args, dryRun: false, gh: github.ops });
	assert.equal(
		github.calls.some(([name]) => name === 'upload' || name === 'createDraft'),
		false
	);

	const changed = fakeGithub(await draftWith(local.files));
	changed.release.assets.set(SIGNATURE, Buffer.from('{"other":"signature"}'));
	await assert.rejects(
		uploadDraft({ ...local.args, dryRun: false, gh: changed.ops }),
		new RegExp(`mismatched existing asset ${SIGNATURE.replaceAll('.', '\\.')}`)
	);
});

test('publish refuses a public release, other metadata, or unexpected assets', async (t) => {
	const local = await localRelease(t);
	const cases = [
		[(release) => (release.isDraft = false), /existing public release/],
		[(release) => (release.isPrerelease = true), /prerelease metadata/],
		[(release) => (release.targetCommitish = 'f'.repeat(40)), /resolves to/],
		[(release) => release.assets.set('extra.txt', Buffer.from('x')), /unexpected existing asset/]
	];
	for (const [mutate, message] of cases) {
		const github = fakeGithub(await draftWith(local.files));
		mutate(github.release);
		await assert.rejects(uploadDraft({ ...local.args, dryRun: false, gh: github.ops }), message);
	}
});

test('draft verification refuses a missing signature or changed bytes', async (t) => {
	const local = await localRelease(t);
	const missing = fakeGithub(await draftWith(local.files));
	missing.release.assets.delete(SIGNATURE);
	await assert.rejects(
		verifyDraft({ ...local.verifyArgs, gh: missing.ops, csk: fakeCreateSignkit() }),
		/remote asset set differs/
	);

	const changed = fakeGithub(await draftWith(local.files));
	changed.release.assets.set(`signkit-node-${TAG}.tar.gz`, Buffer.from('tampered'));
	await assert.rejects(
		verifyDraft({ ...local.verifyArgs, gh: changed.ops, csk: fakeCreateSignkit() }),
		/differs from the upload/
	);

	const workflow = fakeGithub(await draftWith(local.files));
	await assert.rejects(
		verifyDraft({
			...local.verifyArgs,
			gh: workflow.ops,
			csk: fakeCreateSignkit({ kind: 'workflow' })
		}),
		/not the maintainer signature/
	);
});

async function localRelease(t) {
	const dir = await mkdtemp(join(tmpdir(), 'release-local-test-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const bundle = Buffer.from('cloudflare bundle bytes');
	const bundleSha256 = createHash('sha256').update(bundle).digest('hex');
	const contents = new Map([
		['SHA256SUMS', Buffer.from('sums')],
		[
			'signkit-cloudflare-manifest.json',
			Buffer.from(
				JSON.stringify({
					tag: TAG,
					commit: HEAD,
					channel: 'stable',
					bundle: {
						assetName: `signkit-cloudflare-${TAG}.tar.gz`,
						size: bundle.byteLength,
						sha256: bundleSha256
					}
				})
			)
		],
		[`signkit-cloudflare-${TAG}.tar.gz`, bundle],
		[`signkit-node-${TAG}.tar.gz`, Buffer.from('node')],
		[`signkit-${TAG}-x86_64-unknown-linux-gnu.tar.gz`, Buffer.from('cli')],
		[`signkit-docker-${TAG}.tar.gz`, Buffer.from('docker')]
	]);
	const signature = Buffer.from('{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}');
	const files = new Map();
	const subjects = new Map();
	for (const [name, bytes] of contents) {
		await writeFile(join(dir, name), bytes);
		files.set(name, join(dir, name));
		subjects.set(name, createHash('sha256').update(bytes).digest('hex'));
	}
	await writeFile(join(dir, SIGNATURE), signature);
	files.set(SIGNATURE, join(dir, SIGNATURE));
	const scratch = await mkdtemp(join(tmpdir(), 'release-local-scratch-'));
	t.after(() => rm(scratch, { recursive: true, force: true }));
	return {
		files,
		signature,
		bundleSha256,
		args: { tag: TAG, head: HEAD, channel: 'stable', files, scratch },
		verifyArgs: {
			tag: TAG,
			commit: HEAD,
			channel: 'stable',
			files,
			subjects,
			signatureName: SIGNATURE,
			scratch,
			retryDelayMs: 0
		}
	};
}

async function draftWith(files) {
	const assets = new Map();
	for (const [name, path] of files) assets.set(name, await readFile(path));
	return { isDraft: true, isPrerelease: false, targetCommitish: HEAD, assets };
}

function fakeGithub(release) {
	const github = { release, calls: [] };
	github.ops = {
		async view(tag) {
			github.calls.push(['view', tag]);
			const current = github.release;
			return (
				current && {
					isDraft: current.isDraft,
					isPrerelease: current.isPrerelease,
					targetCommitish: current.targetCommitish,
					assets: [...current.assets].map(([name, bytes]) => ({ name, size: bytes.byteLength }))
				}
			);
		},
		async resolveCommit(target) {
			github.calls.push(['resolveCommit', target]);
			return target;
		},
		async createDraft(tag, head, prereleaseArg) {
			github.calls.push(['createDraft', tag, head, prereleaseArg]);
			github.release = {
				isDraft: true,
				isPrerelease: prereleaseArg === '--prerelease',
				targetCommitish: head,
				assets: new Map()
			};
		},
		async upload(tag, path) {
			github.calls.push(['upload', tag, basename(path)]);
			github.release.assets.set(basename(path), await readFile(path));
		},
		async download(tag, dir, name) {
			github.calls.push(['download', tag, name]);
			for (const [asset, bytes] of github.release.assets) {
				if (!name || asset === name) await writeFile(join(dir, asset), bytes);
			}
		},
		async markPublic(tag) {
			github.calls.push(['markPublic', tag]);
			github.release.isDraft = false;
		}
	};
	return github;
}

// Stands in for create-signkit's dist modules: the verifier fetches the
// signature asset through the HTTP client verifyDraft gives it, like the real
// one, and every other URL goes to the "network".
function fakeCreateSignkit({ kind = 'maintainer' } = {}) {
	const csk = {
		verified: undefined,
		signatureBody: undefined,
		networkUrls: [],
		parseReleaseManifest(text, expected) {
			const manifest = JSON.parse(text);
			assert.equal(manifest.tag, expected.tag);
			assert.equal(manifest.commit, expected.commit);
			return manifest;
		},
		sha256Hex: (bytes) => createHash('sha256').update(bytes).digest('hex'),
		githubDownloadUrl: (tag, name) =>
			`https://github.com/d6e-ai/signkit/releases/download/${tag}/${name}`,
		createFetchHttpClient: () => ({
			async request(request) {
				csk.networkUrls.push(request.url);
				return { url: request.url, status: 404, headers: {}, body: new Uint8Array() };
			}
		}),
		createGithubProvenanceVerifier: (http) => ({
			async verify(release, digest) {
				csk.verified = [release, digest];
				await http.request({ url: 'https://api.github.com/attestations-lookup', maxBytes: 1 });
				const response = await http.request({
					url: csk.githubDownloadUrl(release.tag, release.maintainerSignature.assetName),
					maxBytes: release.maintainerSignature.size
				});
				csk.signatureBody = response.body;
				return { kind, workflow: 'w', sourceRef: `refs/tags/${release.tag}`, sourceCommit: HEAD };
			}
		})
	};
	return csk;
}
