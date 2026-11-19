import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler } from '../lib/signer.mjs';
import signHandler from '../api/sign.mjs';

const TOKEN = 'A'.repeat(43);
const OPERATION_ID = '01890a5d-ac96-774b-bcce-b302099a8057';
const MESSAGE = Buffer.from('signed-attributes').toString('base64');
const SIGNATURE = 'A'.repeat(342);
const ENV = {
	VERCEL_SIGNER_TOKEN: TOKEN,
	VERCEL_KMS_ISSUER_ID: 'issuer_1',
	VERCEL_KMS_KEY_ID: 'key_1',
	VERCEL_KMS_FINGERPRINT: 'SHA256:abc'
};

function upstreamOk(overrides = {}, headers = { 'x-vercel-id': 'iad1::abc-123' }) {
	return new Response(
		JSON.stringify({
			keyId: 'key_1',
			algorithm: 'RS256',
			fingerprint: 'SHA256:abc',
			signature: SIGNATURE,
			...overrides
		}),
		{ status: 200, headers }
	);
}

function setup({ fetchImpl, env = ENV, getOidcToken = () => undefined } = {}) {
	const calls = [];
	const logs = [];
	const fetchFn =
		fetchImpl ??
		(async (url, init) => {
			calls.push({ url, init });
			return upstreamOk();
		});
	const wrapped = async (url, init) => {
		if (fetchImpl) calls.push({ url, init });
		return fetchFn(url, init);
	};
	const handler = createHandler({
		fetchImpl: wrapped,
		env,
		getOidcToken,
		log: (entry) => logs.push(entry),
		newRequestId: () => '11111111-1111-4111-8111-111111111111'
	});
	return { handler, calls, logs };
}

async function invoke(handler, { method = 'POST', headers = {}, body } = {}) {
	const req = {
		method,
		headers: {
			authorization: `Bearer ${TOKEN}`,
			'content-type': 'application/json',
			'x-vercel-oidc-token': 'header.payload.sig',
			...headers
		},
		body:
			body === undefined ? JSON.stringify({ operationId: OPERATION_ID, message: MESSAGE }) : body
	};
	const out = { headers: {} };
	const res = {
		setHeader: (k, v) => {
			out.headers[k] = v;
		},
		end: (text) => {
			out.text = text;
		}
	};
	await handler(req, res);
	return { status: res.statusCode, json: JSON.parse(out.text), headers: out.headers };
}

test('signs once with the fixed endpoint and OIDC bearer', async () => {
	const { handler, calls, logs } = setup();
	const r = await invoke(handler);
	assert.equal(r.status, 200);
	assert.deepEqual(r.json, {
		keyId: 'key_1',
		algorithm: 'RS256',
		fingerprint: 'SHA256:abc',
		signature: SIGNATURE,
		requestId: '11111111-1111-4111-8111-111111111111'
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://api.vercel.com/v1/kms/issuers/issuer_1/sign/message');
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(calls[0].init.redirect, 'error');
	assert.equal(calls[0].init.headers.authorization, 'Bearer header.payload.sig');
	assert.deepEqual(JSON.parse(calls[0].init.body), { message: MESSAGE });
	assert.deepEqual(logs, [
		{
			event: 'pdf_seal_sign',
			outcome: 'signed',
			requestId: '11111111-1111-4111-8111-111111111111',
			operationId: OPERATION_ID,
			upstreamRequestId: 'iad1::abc-123'
		}
	]);
	assert.ok(!JSON.stringify(logs).includes(MESSAGE));
	assert.ok(!JSON.stringify(logs).includes('header.payload.sig'));
});

test('falls back to injected OIDC provider', async () => {
	const { handler, calls } = setup({ getOidcToken: () => 'fake.oidc.token' });
	const r = await invoke(handler, { headers: { 'x-vercel-oidc-token': undefined } });
	assert.equal(r.status, 200);
	assert.equal(calls[0].init.headers.authorization, 'Bearer fake.oidc.token');
});

test('bad method, auth, and content type make no key calls', async () => {
	const cases = [
		[{ method: 'GET' }, 405],
		[{ headers: { authorization: undefined } }, 401],
		[{ headers: { authorization: `Bearer ${'B'.repeat(43)}` } }, 401],
		[{ headers: { authorization: TOKEN } }, 401],
		[{ headers: { 'content-type': 'text/plain' } }, 415]
	];
	for (const [opts, status] of cases) {
		const { handler, calls, logs } = setup();
		const r = await invoke(handler, opts);
		assert.equal(r.status, status);
		assert.equal(calls.length, 0);
		assert.equal(logs.length, 0);
	}
});

test('bad input makes no key calls and no logs', async () => {
	const bigMessage = Buffer.alloc(32769, 1).toString('base64');
	const bodies = [
		'not json',
		'[]',
		JSON.stringify({ operationId: OPERATION_ID }),
		JSON.stringify({ operationId: OPERATION_ID, message: MESSAGE, extra: 1 }),
		JSON.stringify({ operationId: OPERATION_ID.toUpperCase(), message: MESSAGE }),
		JSON.stringify({ operationId: '01890a5d-ac96-474b-bcce-b302099a8057', message: MESSAGE }),
		JSON.stringify({ operationId: OPERATION_ID, message: '' }),
		JSON.stringify({ operationId: OPERATION_ID, message: 'c2ln_-==' }),
		JSON.stringify({ operationId: OPERATION_ID, message: 'c2ln' + '\n' }),
		JSON.stringify({ operationId: OPERATION_ID, message: 'YR==' }),
		JSON.stringify({ operationId: OPERATION_ID, message: bigMessage }),
		JSON.stringify({ operationId: OPERATION_ID, message: 5 })
	];
	for (const body of bodies) {
		const { handler, calls, logs } = setup();
		const r = await invoke(handler, { body });
		assert.equal(r.status, 400, body.slice(0, 60));
		assert.deepEqual(r.json, { error: 'invalid_request' });
		assert.equal(calls.length, 0);
		assert.equal(logs.length, 0);
	}
	const { handler, calls } = setup();
	const r = await invoke(handler, { body: 'x'.repeat(60000) });
	assert.equal(r.status, 413);
	assert.equal(calls.length, 0);
});

test('accepts the maximum message size', async () => {
	const { handler } = setup();
	const message = Buffer.alloc(32768, 7).toString('base64');
	const r = await invoke(handler, { body: JSON.stringify({ operationId: OPERATION_ID, message }) });
	assert.equal(r.status, 200);
});

test('misconfiguration fails before any key call', async () => {
	for (const patch of [
		{ VERCEL_SIGNER_TOKEN: 'short' },
		{ VERCEL_KMS_ISSUER_ID: undefined },
		{ VERCEL_KMS_KEY_ID: 'bad key' },
		{ VERCEL_KMS_FINGERPRINT: undefined }
	]) {
		const { handler, calls } = setup({ env: { ...ENV, ...patch } });
		const r = await invoke(handler);
		assert.equal(r.status, 500);
		assert.deepEqual(r.json, { error: 'server_misconfigured' });
		assert.equal(calls.length, 0);
	}
});

test('upstream failures return a fixed error, are not retried, and are logged', async () => {
	const bad = [
		() => new Response('{}', { status: 500, headers: { 'x-vercel-id': 'id-1' } }),
		() => new Response('not json', { status: 200 }),
		() => upstreamOk({ algorithm: 'ES256' }),
		() => upstreamOk({ keyId: 'other' }),
		() => upstreamOk({ fingerprint: 'SHA256:other' }),
		() => upstreamOk({ signature: 'short' }),
		() => upstreamOk({ signature: 'A'.repeat(342) + '!' }),
		() => upstreamOk({ signature: undefined }),
		() => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
		() => {
			throw new Error('secret detail');
		}
	];
	for (const make of bad) {
		const { handler, calls, logs } = setup({ fetchImpl: async () => make() });
		const r = await invoke(handler);
		assert.equal(r.status, 502);
		assert.deepEqual(r.json, { error: 'upstream_failed' });
		assert.equal(calls.length, 1);
		assert.equal(logs.length, 1);
		assert.equal(logs[0].outcome, 'failed');
		assert.equal(logs[0].operationId, OPERATION_ID);
	}
});

test('missing OIDC token fails without an upstream call', async () => {
	const { handler, calls } = setup();
	const r = await invoke(handler, { headers: { 'x-vercel-oidc-token': undefined } });
	assert.equal(r.status, 502);
	assert.equal(calls.length, 0);
});

test('default export is a (req, res) handler', () => {
	assert.equal(typeof signHandler, 'function');
	assert.equal(signHandler.length, 2);
});
