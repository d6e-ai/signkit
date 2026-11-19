// Not matched by the default vitest `server` include (src/** only); the wrapper integration adds
// tools/pdf-seal-authority/gateway/**/*.spec.ts to that project.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { sqliteD1Database } from '../../../src/lib/adapters/db/sqlite-d1-test-support';
import {
	signPdfSealAuthorization,
	type PdfSealAuthorizationRequest
} from '../../../src/lib/application/pdf-seals/pdf-seal-authorization';
import { base64UrlEncode } from '../../../src/lib/security/opaque-token';
import { handle, type GatewayEnv } from './index';

const appToken = 'a'.repeat(43);
const engineToken = 'b'.repeat(43);
const issuerToken = 'c'.repeat(43);

const envelopeId = '01900000-0000-7000-8000-000000000601';
const otherEnvelopeId = '01900000-0000-7000-8000-000000000602';
const operationId = '01900000-0000-7000-8000-000000000603';
const certificate = 'a'.repeat(64);
const source = new TextEncoder().encode('%PDF-1.7\nexecuted bytes\n%%EOF');
const sealed = new TextEncoder().encode('%PDF-1.7\nexecuted bytes\n%%EOF\n%signature-update');
const kmsRequestId = 'kms-audit-request-7731';
let privateKey: CryptoKey;
let publicKey: string;
let reference: PdfSealAuthorizationRequest;

beforeAll(async () => {
	const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
		'sign',
		'verify'
	]);
	privateKey = keys.privateKey;
	publicKey = base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
	reference = {
		envelopeId,
		operationId,
		sourceSha256: await sha256(source),
		sourceByteSize: source.length,
		requestedProfile: 'pades-b-b',
		signerCertificateSha256: certificate,
		sealPolicyId: 'seal-policy',
		validationPolicyId: 'validator-policy',
		tsaPolicyId: null,
		tsaTrustBundleSha256: null
	};
});

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function harness() {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec(readFileSync('tools/pdf-seal-authority/gateway/schema.sql', 'utf8'));
	const objects = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>();
	const results = {
		put: vi.fn(async (key: string, bytes: Uint8Array, options: R2PutOptions) => {
			if (objects.has(key)) return null;
			objects.set(key, { bytes, customMetadata: options.customMetadata ?? {} });
			return {} as R2Object;
		}),
		head: vi.fn(async (key: string) => {
			const found = objects.get(key);
			return found
				? ({
						size: found.bytes.length,
						customMetadata: found.customMetadata
					} as unknown as R2Object)
				: null;
		}),
		get: vi.fn(async (key: string) => {
			const found = objects.get(key);
			return found
				? ({
						size: found.bytes.length,
						customMetadata: found.customMetadata,
						body: new Blob([found.bytes as Uint8Array<ArrayBuffer>]).stream()
					} as unknown as R2ObjectBody)
				: null;
		})
	};
	const issuer = vi.fn(async (_url: string, init: RequestInit) => {
		expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${issuerToken}`);
		const request = JSON.parse(init.body as string) as PdfSealAuthorizationRequest;
		const token = await signPdfSealAuthorization(
			request,
			{ evidenceSha256: 'b'.repeat(64), sentEventHash: 'c'.repeat(64) },
			{ issuer: 'independent-issuer', audience: 'provider' },
			async (input) =>
				new Uint8Array(
					await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, input)
				),
			new Date()
		);
		return Response.json({ authorization: token });
	});
	const engine = vi.fn(async (_url: string, init: RequestInit) => {
		const headers = init.headers as Record<string, string>;
		expect(headers.authorization).toBe(`Bearer ${engineToken}`);
		expect(headers['x-signkit-seal-profile']).toBe('pades-b-b');
		expect(headers['x-signkit-source-sha256']).toBe(reference.sourceSha256);
		expect(headers['x-signkit-signer-certificate-sha256']).toBe(certificate);
		return new Response(sealed, {
			headers: { 'content-type': 'application/pdf', 'x-signkit-kms-request-id': kmsRequestId }
		});
	});
	const env = {
		ISSUER: { fetch: issuer },
		ENGINE: { fetch: engine },
		LEDGER: sqliteD1Database(sqlite),
		RESULTS: results,
		SEAL_AUDIENCE: 'provider',
		SEAL_ISSUER: 'independent-issuer',
		SEAL_AUTHORIZATION_PUBLIC_KEY: publicKey,
		SEAL_CERTIFICATE_SHA256: certificate,
		SEAL_POLICY_ID: 'seal-policy',
		VALIDATION_POLICY_ID: 'validator-policy',
		GATEWAY_TOKEN: appToken,
		ENGINE_TOKEN: engineToken,
		ISSUER_TOKEN: issuerToken
	} as unknown as GatewayEnv;
	const pending: Promise<unknown>[] = [];
	const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) };
	return {
		sqlite,
		objects,
		issuer,
		engine,
		call: async (request: Request) => handle(request, env, ctx),
		settle: async () => void (await Promise.all(pending.splice(0)))
	};
}

function echoHeaders(extra: Record<string, string> = {}): Headers {
	return new Headers({
		authorization: `Bearer ${appToken}`,
		'idempotency-key': operationId,
		'x-signkit-operation-id': operationId,
		'x-signkit-source-sha256': reference.sourceSha256,
		'x-signkit-source-byte-size': String(source.length),
		'x-signkit-requested-profile': 'pades-b-b',
		'x-signkit-signer-certificate-sha256': certificate,
		'x-signkit-seal-policy-id': 'seal-policy',
		'x-signkit-validation-policy-id': 'validator-policy',
		...extra
	});
}

const url = (path: string): string => `https://gateway.example${path}`;

function authorize(body: object = reference, token = appToken): Request {
	return new Request(url(`/pdf-seal-authorizations/${operationId}`), {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			'idempotency-key': operationId
		},
		body: JSON.stringify(body)
	});
}

function put(grant: string | null, bytes = source): Request {
	const headers = echoHeaders({
		'content-type': 'application/pdf',
		'x-signkit-envelope-id': envelopeId
	});
	if (grant !== null) headers.set('x-signkit-seal-authorization', grant);
	return new Request(url(`/authorized-pdf-seals/${operationId}`), {
		method: 'PUT',
		headers,
		body: bytes as Uint8Array<ArrayBuffer>
	});
}

describe('managed key gateway', () => {
	it('uses the key exactly once and serves immutable, receipt-pinned results', async () => {
		const gw = harness();
		const granted = await gw.call(authorize());
		expect(granted.status).toBe(200);
		expect(granted.headers.get('cache-control')).toBe('no-store');
		const { authorization } = (await granted.json()) as { authorization: string };

		// A scheduling bearer alone, or with a stale/wrong grant, never reaches the engine.
		expect((await gw.call(put(null))).status).toBe(403);
		expect((await gw.call(put(authorization, new TextEncoder().encode('%PDF-other')))).status).toBe(
			403
		);
		expect(gw.engine).not.toHaveBeenCalled();

		const accepted = await gw.call(put(authorization));
		expect(accepted.status).toBe(200);
		const pendingBody = (await accepted.json()) as { status: string; providerReceiptId: string };
		expect(pendingBody.status).toBe('pending');
		await gw.settle();
		expect(gw.engine).toHaveBeenCalledTimes(1);

		// Replays, status polls and crash-style repeats never call the engine again.
		const replay = await gw.call(put(authorization));
		expect(replay.status).toBe(200);
		await gw.settle();
		const status = await gw.call(
			new Request(url(`/authorized-pdf-seals/${operationId}`), {
				headers: echoHeaders({ 'x-signkit-provider-receipt-id': pendingBody.providerReceiptId })
			})
		);
		const operation = (await status.json()) as Record<string, unknown>;
		expect(operation).toMatchObject({
			status: 'succeeded',
			providerReceiptId: pendingBody.providerReceiptId,
			achievedProfile: 'pades-b-b',
			resultSha256: await sha256(sealed),
			resultByteSize: sealed.length
		});
		expect(gw.engine).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(operation)).not.toContain(kmsRequestId);

		// Wrong receipt is refused; the right one streams the exact sealed bytes.
		const wrong = await gw.call(
			new Request(url(`/authorized-pdf-seals/${operationId}/result`), {
				headers: echoHeaders({ 'x-signkit-provider-receipt-id': 'other-receipt' })
			})
		);
		expect(wrong.status).toBe(403);
		const result = await gw.call(
			new Request(url(`/authorized-pdf-seals/${operationId}/result`), {
				headers: echoHeaders({ 'x-signkit-provider-receipt-id': pendingBody.providerReceiptId })
			})
		);
		expect(result.status).toBe(200);
		expect(result.headers.get('cache-control')).toBe('no-store');
		expect(result.headers.get('content-length')).toBe(String(sealed.length));
		expect(result.headers.get('x-signkit-result-sha256')).toBe(await sha256(sealed));
		expect([...result.headers.keys()].some((name) => name.includes('kms'))).toBe(false);
		expect(new Uint8Array(await result.arrayBuffer())).toEqual(sealed);
		expect([...gw.objects.values()][0].customMetadata.engineRequestId).toBe(kmsRequestId);
		expect(gw.sqlite.prepare('SELECT status FROM provider_signing_receipt').get()).toEqual({
			status: 'succeeded'
		});
	});

	it('revalidates an existing operation without a second key call and disables legacy routes', async () => {
		const gw = harness();
		const { authorization } = (await (await gw.call(authorize())).json()) as {
			authorization: string;
		};
		await gw.call(put(authorization));
		await gw.settle();
		expect(gw.issuer).toHaveBeenCalledTimes(1);

		const renewed = await gw.call(authorize());
		expect(renewed.status).toBe(200);
		const grant = (await renewed.json()) as { authorization: string };
		expect((await gw.call(put(grant.authorization))).status).toBe(200);
		await gw.settle();
		expect(gw.engine).toHaveBeenCalledTimes(1);
		expect(
			(await gw.call(authorize({ ...reference, operationId: otherOperationId(), envelopeId })))
				.status
		).toBe(400);
		expect(gw.issuer).toHaveBeenCalledTimes(2);

		for (const [method, path] of [
			['POST', '/seal'],
			['PUT', `/pdf-seals/${operationId}`],
			['GET', `/authorized-pdf-seals/${operationId}/extra/result`]
		] as const) {
			expect(
				(await gw.call(new Request(url(path), { method, headers: echoHeaders() }))).status
			).toBe(404);
		}
		const unauthenticated = await gw.call(
			new Request(url(`/authorized-pdf-seals/${operationId}`), {
				headers: echoHeaders({ authorization: 'Bearer nope' })
			})
		);
		expect(unauthenticated.status).toBe(401);
		expect(otherEnvelopeId).not.toBe(envelopeId);
	});

	it('marks the receipt failed and never retries when the engine fails', async () => {
		const gw = harness();
		gw.engine.mockResolvedValueOnce(
			new Response('nope', {
				status: 500,
				headers: { 'x-signkit-kms-request-id': kmsRequestId }
			})
		);
		const { authorization } = (await (await gw.call(authorize())).json()) as {
			authorization: string;
		};
		await gw.call(put(authorization));
		await gw.settle();
		await gw.call(put(authorization));
		await gw.settle();
		expect(gw.engine).toHaveBeenCalledTimes(1);
		expect(
			gw.sqlite
				.prepare('SELECT status, error_code, engine_request_id FROM provider_signing_receipt')
				.get()
		).toEqual({
			status: 'failed',
			error_code: 'engine_rejected',
			engine_request_id: kmsRequestId
		});
		expect(gw.objects.size).toBe(0);
	});

	it('commits the reservation and pending receipt together before dispatch', async () => {
		const gw = harness();
		const { authorization } = (await (await gw.call(authorize())).json()) as {
			authorization: string;
		};
		gw.sqlite.exec(`CREATE TRIGGER unavailable_receipt BEFORE INSERT ON provider_signing_receipt
			BEGIN SELECT RAISE(ABORT, 'receipt storage failure'); END;`);
		expect((await gw.call(put(authorization))).status).toBe(503);
		expect(
			gw.sqlite.prepare('SELECT count(*) AS count FROM provider_signing_replay').get()
		).toEqual({ count: 0 });
		expect(gw.engine).not.toHaveBeenCalled();

		gw.sqlite.exec('DROP TRIGGER unavailable_receipt');
		expect((await gw.call(put(authorization))).status).toBe(200);
		await gw.settle();
		expect(gw.engine).toHaveBeenCalledTimes(1);
	});

	it('keeps replay rows permanent', () => {
		const gw = harness();
		gw.sqlite.exec(
			`INSERT INTO provider_signing_replay VALUES ('i','a','e','o','${'a'.repeat(64)}',
				'2026-01-01T00:00:00.000Z','2026-01-01T00:05:00.000Z')`
		);
		expect(() => gw.sqlite.exec('DELETE FROM provider_signing_replay')).toThrow(/immutable/);
		expect(() => gw.sqlite.exec("UPDATE provider_signing_replay SET issuer = 'x'")).toThrow(
			/immutable/
		);
	});
});

function otherOperationId(): string {
	return '01900000-0000-7000-8000-000000000604';
}
