import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
	assertTagFormat,
	decodeJwtClaims,
	obtainSigstoreIdentityToken,
	releaseAssetNames
} from './release-local.mjs';

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
