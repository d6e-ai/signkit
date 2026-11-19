import {
	matchesPdfSealAuthorizationPolicy,
	pdfSealAuthorizationReference,
	validPdfSealAuthorizationRequest,
	type PdfSealAuthorizationPolicy,
	type PdfSealAuthorizationRequest,
	type PdfSealAuthorizationTrust
} from '../../../src/lib/application/pdf-seals/pdf-seal-authorization';
import { createAuthorizedPdfSealSubmitHandler } from '../../../src/lib/http/authorized-pdf-seal-provider';
import { UUID_V7_PATTERN } from '../../../src/lib/ids/uuid-v7';
import { sealServiceTokenPattern } from '../cloudflare/security';
import {
	D1ProviderSigningLedger,
	D1ReceiptStore,
	operationOf,
	type ReceiptRow,
	type Scope
} from './d1-store';

/** Bindings. The wrapper (not this module) decides how they are provisioned. */
export interface GatewayEnv {
	/** Internal service: POST /pdf-seal-authorizations/{id}. */
	ISSUER: Fetcher;
	/** Private signing microservice: POST /seal. */
	ENGINE: Fetcher;
	/** Provider-owned D1 (see schema.sql). */
	LEDGER: D1Database;
	/** Provider-owned R2 for immutable sealed results. */
	RESULTS: R2Bucket;
	SEAL_AUDIENCE: string;
	SEAL_ISSUER: string;
	SEAL_AUTHORIZATION_PUBLIC_KEY: string;
	SEAL_CERTIFICATE_SHA256: string;
	SEAL_POLICY_ID: string;
	VALIDATION_POLICY_ID: string;
	/** Application scheduling credential. Never authorizes key use by itself. */
	GATEWAY_TOKEN: string;
	/** Independent private bearer for the issuer service binding. */
	ISSUER_TOKEN: string;
	/** Private engine bearer, used only by this gateway. */
	ENGINE_TOKEN: string;
}

const MAX_AUTHORIZE_REQUEST_BYTES = 4_096;
const MAX_ISSUER_RESPONSE_BYTES = 8_192;
const MAX_ENGINE_GROWTH_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024 * 1024;
const ENGINE_TIMEOUT_MS = 25_000;
const ISSUER_TIMEOUT_MS = 10_000;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LABEL = /^[\x21-\x7e]{1,128}$/;
const PUBLIC_KEY = /^B[A-Za-z0-9_-]{86}$/;
const COMPACT_GRANT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

interface Config {
	scope: Scope;
	trust: PdfSealAuthorizationTrust;
	policy: PdfSealAuthorizationPolicy;
	gatewayToken: string;
	issuerToken: string;
	engineToken: string;
}

function configure(env: GatewayEnv): Config | null {
	const text = (value: unknown, pattern: RegExp): string | null =>
		typeof value === 'string' && pattern.test(value) ? value : null;
	const audience = text(env.SEAL_AUDIENCE, LABEL);
	const issuer = text(env.SEAL_ISSUER, LABEL);
	const publicKey = text(env.SEAL_AUTHORIZATION_PUBLIC_KEY, PUBLIC_KEY);
	const certificate = text(env.SEAL_CERTIFICATE_SHA256, SHA256);
	const sealPolicyId = text(env.SEAL_POLICY_ID, LABEL);
	const validationPolicyId = text(env.VALIDATION_POLICY_ID, LABEL);
	const gatewayToken = text(env.GATEWAY_TOKEN, sealServiceTokenPattern);
	const issuerToken = text(env.ISSUER_TOKEN, sealServiceTokenPattern);
	const engineToken = text(env.ENGINE_TOKEN, sealServiceTokenPattern);
	if (
		audience === null ||
		issuer === null ||
		publicKey === null ||
		certificate === null ||
		sealPolicyId === null ||
		validationPolicyId === null ||
		gatewayToken === null ||
		issuerToken === null ||
		engineToken === null ||
		new Set([gatewayToken, issuerToken, engineToken]).size !== 3 ||
		!env.ISSUER ||
		!env.ENGINE ||
		!env.LEDGER ||
		!env.RESULTS
	) {
		return null;
	}
	return {
		scope: { issuer, audience },
		trust: { issuer, audience, publicKey },
		// Fixed B-B: this gateway never signs or advertises a time-stamped profile.
		policy: {
			requestedProfile: 'pades-b-b',
			signerCertificateSha256: certificate,
			sealPolicyId,
			validationPolicyId,
			tsaPolicyId: null,
			tsaTrustBundleSha256: null
		},
		gatewayToken,
		issuerToken,
		engineToken
	};
}

export default {
	fetch: (request: Request, env: GatewayEnv, ctx: ExecutionContext): Promise<Response> =>
		handle(request, env, ctx)
};

export async function handle(
	request: Request,
	env: GatewayEnv,
	ctx: Pick<ExecutionContext, 'waitUntil'>
): Promise<Response> {
	try {
		const config = configure(env);
		if (config === null) return reply(503);
		const url = new URL(request.url);
		const route = /^\/(pdf-seal-authorizations|authorized-pdf-seals)\/([^/]+)(\/result)?$/.exec(
			url.pathname
		);
		// Any other path, including legacy bearer-only signing routes, does not exist.
		if (route === null || !UUID_V7_PATTERN.test(route[2])) return reply(404);
		const operationId = route[2];
		if (route[1] === 'pdf-seal-authorizations') {
			if (route[3] !== undefined) return reply(404);
			return request.method === 'POST'
				? await relayAuthorization(request, operationId, env, config)
				: reply(405);
		}
		if (route[3] !== undefined) {
			return request.method === 'GET'
				? await readResult(request, operationId, env, config)
				: reply(405);
		}
		if (request.method === 'PUT') return await submit(request, operationId, env, config, ctx);
		if (request.method === 'GET') return await readStatus(request, operationId, env, config);
		return reply(405);
	} catch {
		// Never surface or log provider detail.
		return reply(503);
	}
}

async function submit(
	request: Request,
	operationId: string,
	env: GatewayEnv,
	config: Config,
	ctx: Pick<ExecutionContext, 'waitUntil'>
): Promise<Response> {
	const receipts = new D1ReceiptStore(env.LEDGER, config.scope);
	const handler = createAuthorizedPdfSealSubmitHandler({
		authenticate: (incoming) => authenticate(incoming, config),
		trust: config.trust,
		policy: config.policy,
		ledger: new D1ProviderSigningLedger(env.LEDGER),
		// Runs only for the caller that won the durable reservation.
		sign: async (claims, source) => {
			const row = await receipts.read(claims.operationId);
			if (row === null || row.status !== 'pending') throw new Error('receipt_missing');
			// One signing fetch, scheduled once. Nothing else ever calls the engine.
			ctx.waitUntil(runSigning(env, config, receipts, claims.operationId, source));
			return operationOf(row);
		},
		// Replay/crash reconciliation reads only; it can never schedule key use.
		readAcceptedOperation: async (reference) => {
			const row = await receipts.read(reference.operationId);
			return row === null || row.envelope_id !== reference.envelopeId ? null : operationOf(row);
		}
	});
	return handler(request, operationId);
}

async function runSigning(
	env: GatewayEnv,
	config: Config,
	receipts: D1ReceiptStore,
	operationId: string,
	source: Uint8Array<ArrayBuffer>
): Promise<void> {
	let engineRequestId: string | null = null;
	try {
		if (!(await receipts.claim(operationId))) return;
		const row = await receipts.read(operationId);
		if (row === null) return;
		let response: Response;
		try {
			response = await env.ENGINE.fetch('https://engine.internal/seal', {
				method: 'POST',
				redirect: 'manual',
				signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
				headers: {
					authorization: `Bearer ${config.engineToken}`,
					accept: 'application/pdf',
					'accept-encoding': 'identity',
					'content-type': 'application/pdf',
					'x-signkit-seal-profile': row.requested_profile,
					'x-signkit-source-sha256': row.source_sha256,
					'x-signkit-signer-certificate-sha256': row.signer_certificate_sha256
				},
				body: source
			});
		} catch {
			await receipts.fail(operationId, 'engine_unavailable');
			return;
		}
		const reportedId = response.headers.get('x-signkit-kms-request-id');
		engineRequestId = reportedId !== null && SAFE_ID.test(reportedId) ? reportedId : null;
		const encoding = response.headers.get('content-encoding');
		if (
			response.status !== 200 ||
			response.redirected ||
			mediaType(response.headers.get('content-type')) !== 'application/pdf' ||
			(encoding !== null && encoding.toLowerCase() !== 'identity') ||
			engineRequestId === null
		) {
			await response.body?.cancel().catch(() => undefined);
			await receipts.fail(
				operationId,
				response.status === 200 ? 'engine_invalid_response' : 'engine_rejected',
				engineRequestId
			);
			return;
		}
		const limit = Math.min(row.source_byte_size + MAX_ENGINE_GROWTH_BYTES, MAX_RESULT_BYTES);
		const bytes = await readBounded(response, limit).catch(() => null);
		if (bytes === null || bytes.byteLength <= row.source_byte_size || !startsWithPdfMagic(bytes)) {
			await receipts.fail(operationId, 'engine_invalid_response', engineRequestId);
			return;
		}
		const sha256 = await sha256Hex(bytes);
		const key = await resultKey(config.scope, operationId);
		const stored = await storeResult(env.RESULTS, key, bytes, sha256, row, engineRequestId);
		if (!stored) {
			await receipts.fail(operationId, 'result_store_failed', engineRequestId);
			return;
		}
		await receipts.succeed(operationId, { sha256, byteSize: bytes.byteLength, engineRequestId });
	} catch {
		// A post-reservation failure is terminal; the key is never invoked again.
		await receipts.fail(operationId, 'signing_failed', engineRequestId).catch(() => undefined);
	}
}

async function storeResult(
	bucket: R2Bucket,
	key: string,
	bytes: Uint8Array<ArrayBuffer>,
	sha256: string,
	row: ReceiptRow,
	engineRequestId: string
): Promise<boolean> {
	try {
		await bucket.put(key, bytes, {
			// Write-once: fails (returns null) if any object already holds the key.
			onlyIf: { etagDoesNotMatch: '*' },
			sha256,
			httpMetadata: { contentType: 'application/pdf' },
			customMetadata: {
				operationId: row.operation_id,
				receiptId: row.receipt_id,
				sourceSha256: row.source_sha256,
				profile: row.requested_profile,
				resultSha256: sha256,
				resultByteSize: String(bytes.byteLength),
				engineRequestId
			}
		});
	} catch {
		// Fall through: the verification below decides whether the write landed.
	}
	const head = await bucket.head(key).catch(() => null);
	return (
		head !== null &&
		head.size === bytes.byteLength &&
		head.customMetadata?.resultSha256 === sha256 &&
		head.customMetadata?.receiptId === row.receipt_id
	);
}

async function readStatus(
	request: Request,
	operationId: string,
	env: GatewayEnv,
	config: Config
): Promise<Response> {
	if ((await authenticate(request, config)) !== config.scope.audience) return reply(401);
	const receipts = new D1ReceiptStore(env.LEDGER, config.scope);
	let row = await receipts.read(operationId);
	if (row === null) return reply(404);
	const refusal = checkRequestEcho(request, row, false);
	if (refusal !== null) return reply(refusal);
	if (row.status === 'processing')
		row = (await reconcileFromResults(env, config, receipts, row)) ?? row;
	return reply(200, operationOf(row));
}

/** Read-only repair: the sealed object landed but its receipt update did not. */
async function reconcileFromResults(
	env: GatewayEnv,
	config: Config,
	receipts: D1ReceiptStore,
	row: ReceiptRow
): Promise<ReceiptRow | null> {
	const head = await env.RESULTS.head(await resultKey(config.scope, row.operation_id)).catch(
		() => null
	);
	const meta = head?.customMetadata;
	if (
		head === null ||
		meta === undefined ||
		meta.receiptId !== row.receipt_id ||
		meta.operationId !== row.operation_id ||
		meta.sourceSha256 !== row.source_sha256 ||
		!SHA256.test(meta.resultSha256 ?? '') ||
		!SAFE_ID.test(meta.engineRequestId ?? '') ||
		meta.resultByteSize !== String(head.size) ||
		head.size <= row.source_byte_size
	) {
		return null;
	}
	await receipts.succeed(row.operation_id, {
		sha256: meta.resultSha256,
		byteSize: head.size,
		engineRequestId: meta.engineRequestId
	});
	return receipts.read(row.operation_id);
}

async function readResult(
	request: Request,
	operationId: string,
	env: GatewayEnv,
	config: Config
): Promise<Response> {
	if ((await authenticate(request, config)) !== config.scope.audience) return reply(401);
	const row = await new D1ReceiptStore(env.LEDGER, config.scope).read(operationId);
	if (row === null) return reply(404);
	const refusal = checkRequestEcho(request, row, true);
	if (refusal !== null) return reply(refusal);
	if (row.status !== 'succeeded' || row.result_sha256 === null || row.result_byte_size === null) {
		return reply(409);
	}
	const object = await env.RESULTS.get(await resultKey(config.scope, operationId));
	if (
		object === null ||
		object.size !== row.result_byte_size ||
		object.customMetadata?.resultSha256 !== row.result_sha256 ||
		object.customMetadata?.receiptId !== row.receipt_id
	) {
		return reply(503);
	}
	return new Response(object.body, {
		status: 200,
		headers: {
			'cache-control': 'no-store',
			'content-type': 'application/pdf',
			'content-length': String(row.result_byte_size),
			'x-content-type-options': 'nosniff',
			'x-signkit-operation-id': row.operation_id,
			'x-signkit-provider-receipt-id': row.receipt_id,
			'x-signkit-source-sha256': row.source_sha256,
			'x-signkit-source-byte-size': String(row.source_byte_size),
			'x-signkit-requested-profile': row.requested_profile,
			'x-signkit-achieved-profile': row.requested_profile,
			'x-signkit-signer-certificate-sha256': row.signer_certificate_sha256,
			'x-signkit-seal-policy-id': row.seal_policy_id,
			'x-signkit-validation-policy-id': row.validation_policy_id,
			'x-signkit-result-sha256': row.result_sha256
		}
	});
}

/**
 * The caller must restate the frozen operation. A pinned receipt header, when given (required for
 * result), must equal the stored receipt exactly. Returns an HTTP status to refuse with, or null.
 */
function checkRequestEcho(
	request: Request,
	row: ReceiptRow,
	receiptRequired: boolean
): number | null {
	const h = request.headers;
	const receipt = h.get('x-signkit-provider-receipt-id');
	if (receipt === null ? receiptRequired : receipt !== row.receipt_id) return 403;
	if (
		h.get('idempotency-key') !== row.operation_id ||
		h.get('x-signkit-operation-id') !== row.operation_id
	) {
		return 400;
	}
	if (
		h.get('x-signkit-source-sha256') !== row.source_sha256 ||
		h.get('x-signkit-source-byte-size') !== String(row.source_byte_size) ||
		h.get('x-signkit-requested-profile') !== row.requested_profile ||
		h.get('x-signkit-signer-certificate-sha256') !== row.signer_certificate_sha256 ||
		h.get('x-signkit-seal-policy-id') !== row.seal_policy_id ||
		h.get('x-signkit-validation-policy-id') !== row.validation_policy_id ||
		h.has('x-signkit-tsa-policy-id') ||
		h.has('x-signkit-tsa-trust-bundle-sha256')
	) {
		return 409;
	}
	return null;
}

/** The issuer can renew a grant; a replay can only read the accepted receipt. */
async function relayAuthorization(
	request: Request,
	operationId: string,
	env: GatewayEnv,
	config: Config
): Promise<Response> {
	if ((await authenticate(request, config)) !== config.scope.audience) return reply(401);
	if (
		request.headers.get('idempotency-key') !== operationId ||
		mediaType(request.headers.get('content-type')) !== 'application/json'
	) {
		return reply(400);
	}
	const body = await readBounded(request, MAX_AUTHORIZE_REQUEST_BYTES).catch((error: unknown) =>
		error instanceof RangeError && error.message === 'too_large' ? 413 : 400
	);
	if (typeof body === 'number') return reply(body);
	let input: PdfSealAuthorizationRequest;
	try {
		input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
	} catch {
		return reply(400);
	}
	if (!input || input.operationId !== operationId || !validPdfSealAuthorizationRequest(input)) {
		return reply(400);
	}
	if (!matchesPdfSealAuthorizationPolicy(input, config.policy)) return reply(403);
	const canonical = JSON.stringify(pdfSealAuthorizationReference(input));
	const upstream = await env.ISSUER.fetch(
		`https://issuer.internal/pdf-seal-authorizations/${encodeURIComponent(operationId)}`,
		{
			method: 'POST',
			redirect: 'manual',
			signal: AbortSignal.timeout(ISSUER_TIMEOUT_MS),
			headers: {
				authorization: `Bearer ${config.issuerToken}`,
				accept: 'application/json',
				'accept-encoding': 'identity',
				'content-type': 'application/json',
				'idempotency-key': operationId
			},
			body: canonical
		}
	);
	if (upstream.status === 403 || upstream.status === 409) {
		await upstream.body?.cancel().catch(() => undefined);
		return reply(upstream.status);
	}
	if (
		upstream.status !== 200 ||
		upstream.redirected ||
		mediaType(upstream.headers.get('content-type')) !== 'application/json'
	) {
		await upstream.body?.cancel().catch(() => undefined);
		return reply(503);
	}
	const bytes = await readBounded(upstream, MAX_ISSUER_RESPONSE_BYTES).catch(() => null);
	if (bytes === null) return reply(503);
	try {
		const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		const authorization = (parsed as { authorization?: unknown } | null)?.authorization;
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			Object.keys(parsed).length !== 1 ||
			typeof authorization !== 'string' ||
			!COMPACT_GRANT.test(authorization)
		) {
			return reply(503);
		}
		return reply(200, { authorization });
	} catch {
		return reply(503);
	}
}

/** Scheduling credential -> audience. Compares digests in constant time. */
async function authenticate(request: Request, config: Config): Promise<string | null> {
	const header = request.headers.get('authorization');
	if (header === null || !header.startsWith('Bearer ')) return null;
	const [given, expected] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(header.slice(7))),
		crypto.subtle.digest('SHA-256', encoder.encode(config.gatewayToken))
	]);
	const a = new Uint8Array(given);
	const b = new Uint8Array(expected);
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
	return diff === 0 ? config.scope.audience : null;
}

/** Bounded read for either a Request or a Response; rejects past `limit` without buffering more. */
async function readBounded(
	message: Request | Response,
	limit: number
): Promise<Uint8Array<ArrayBuffer>> {
	const declared = message.headers.get('content-length');
	if (declared !== null && !(Number(declared) <= limit)) {
		await message.body?.cancel().catch(() => undefined);
		throw new RangeError('too_large');
	}
	if (message.body === null) throw new RangeError('empty');
	const reader = message.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel('too_large').catch(() => undefined);
				throw new RangeError('too_large');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const out = new Uint8Array(new ArrayBuffer(total));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function startsWithPdfMagic(bytes: Uint8Array): boolean {
	return [0x25, 0x50, 0x44, 0x46, 0x2d].every((byte, index) => bytes[index] === byte);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	return hex(await crypto.subtle.digest('SHA-256', bytes));
}

async function resultKey(scope: Scope, operationId: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		encoder.encode(`${scope.issuer}\0${scope.audience}\0${operationId}`)
	);
	return `pdf-seals/${hex(digest)}.pdf`;
}

function hex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function mediaType(value: string | null): string | undefined {
	return value?.split(';', 1)[0].trim().toLowerCase();
}

function reply(status: number, body?: object): Response {
	const headers = { 'cache-control': 'no-store' };
	return body === undefined
		? new Response(null, { status, headers })
		: Response.json(body, { status, headers });
}
