import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

const MAX_MESSAGE_BYTES = 32768;
const MAX_REQUEST_BYTES = 49152;
const MAX_RESPONSE_BYTES = 16384;
const MAX_OIDC_TOKEN_LENGTH = 8192;
const UPSTREAM_TIMEOUT_MS = 10000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ISSUER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9:+/_=-]{1,256}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/_-]{256,1400}={0,2}$/;
const UPSTREAM_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const OIDC_TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;

class HttpError extends Error {
	constructor(status, code) {
		super(code);
		this.status = status;
		this.code = code;
	}
}

function digest(value) {
	return createHash('sha256').update(value, 'utf8').digest();
}

function constantTimeEqual(a, b) {
	return timingSafeEqual(digest(a), digest(b));
}

function singleHeader(req, name) {
	const value = req.headers?.[name];
	return typeof value === 'string' ? value : undefined;
}

function readConfig(env) {
	const token = env.VERCEL_SIGNER_TOKEN;
	const issuerId = env.VERCEL_KMS_ISSUER_ID;
	const keyId = env.VERCEL_KMS_KEY_ID;
	const fingerprint = env.VERCEL_KMS_FINGERPRINT;
	if (
		typeof token !== 'string' ||
		!TOKEN_PATTERN.test(token) ||
		typeof issuerId !== 'string' ||
		!ISSUER_ID_PATTERN.test(issuerId) ||
		typeof keyId !== 'string' ||
		!KEY_ID_PATTERN.test(keyId) ||
		typeof fingerprint !== 'string' ||
		!FINGERPRINT_PATTERN.test(fingerprint)
	) {
		throw new HttpError(500, 'server_misconfigured');
	}
	return { token, issuerId, keyId, fingerprint };
}

function authenticate(req, config) {
	const header = singleHeader(req, 'authorization');
	const match = header === undefined ? null : /^Bearer ([^\s]+)$/.exec(header);
	// Always compare, so timing does not depend on header shape.
	const candidate = match ? match[1] : '';
	const ok = constantTimeEqual(candidate, config.token);
	if (!match || !ok) throw new HttpError(401, 'unauthorized');
}

async function readBody(req) {
	if (typeof req.body === 'string') {
		if (Buffer.byteLength(req.body, 'utf8') > MAX_REQUEST_BYTES) {
			throw new HttpError(413, 'payload_too_large');
		}
		return req.body;
	}
	if (req.body !== undefined && req.body !== null && !Buffer.isBuffer(req.body)) {
		// Already parsed by the platform; re-serialise for uniform strict validation.
		return JSON.stringify(req.body);
	}
	if (Buffer.isBuffer(req.body)) {
		if (req.body.length > MAX_REQUEST_BYTES) throw new HttpError(413, 'payload_too_large');
		return req.body.toString('utf8');
	}
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_REQUEST_BYTES) throw new HttpError(413, 'payload_too_large');
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

function parseInput(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new HttpError(400, 'invalid_request');
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new HttpError(400, 'invalid_request');
	}
	const keys = Object.keys(value).sort();
	if (keys.length !== 2 || keys[0] !== 'message' || keys[1] !== 'operationId') {
		throw new HttpError(400, 'invalid_request');
	}
	const { operationId, message } = value;
	if (typeof operationId !== 'string' || !UUID_V7_PATTERN.test(operationId)) {
		throw new HttpError(400, 'invalid_request');
	}
	if (
		typeof message !== 'string' ||
		message.length === 0 ||
		message.length % 4 !== 0 ||
		message.length > Math.ceil(MAX_MESSAGE_BYTES / 3) * 4 ||
		!BASE64_PATTERN.test(message)
	) {
		throw new HttpError(400, 'invalid_request');
	}
	const decoded = Buffer.from(message, 'base64');
	if (
		decoded.length === 0 ||
		decoded.length > MAX_MESSAGE_BYTES ||
		decoded.toString('base64') !== message
	) {
		throw new HttpError(400, 'invalid_request');
	}
	return { operationId, message };
}

function resolveOidcToken(req, getOidcToken) {
	const token = singleHeader(req, 'x-vercel-oidc-token') ?? getOidcToken?.();
	if (
		typeof token !== 'string' ||
		token.length === 0 ||
		token.length > MAX_OIDC_TOKEN_LENGTH ||
		!OIDC_TOKEN_PATTERN.test(token)
	) {
		throw new HttpError(502, 'upstream_failed');
	}
	return token;
}

async function readBounded(response) {
	const text = await response.text();
	if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
		throw new HttpError(502, 'upstream_failed');
	}
	return text;
}

async function sign({ config, message, oidcToken, fetchImpl }) {
	const url = `https://api.vercel.com/v1/kms/issuers/${config.issuerId}/sign/message`;
	let response;
	try {
		response = await fetchImpl(url, {
			method: 'POST',
			redirect: 'error',
			headers: {
				authorization: `Bearer ${oidcToken}`,
				'content-type': 'application/json',
				accept: 'application/json'
			},
			body: JSON.stringify({ message }),
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
		});
	} catch {
		throw new HttpError(502, 'upstream_failed');
	}

	const rawUpstreamId = response?.headers?.get?.('x-vercel-id');
	const upstreamRequestId =
		typeof rawUpstreamId === 'string' && UPSTREAM_REQUEST_ID_PATTERN.test(rawUpstreamId)
			? rawUpstreamId
			: undefined;
	const fail = () => {
		const error = new HttpError(502, 'upstream_failed');
		error.upstreamRequestId = upstreamRequestId;
		return error;
	};

	if (response.status !== 200 || response.redirected) throw fail();
	let parsed;
	try {
		parsed = JSON.parse(await readBounded(response));
	} catch {
		throw fail();
	}
	if (
		parsed === null ||
		typeof parsed !== 'object' ||
		Array.isArray(parsed) ||
		parsed.algorithm !== 'RS256' ||
		parsed.keyId !== config.keyId ||
		parsed.fingerprint !== config.fingerprint ||
		typeof parsed.signature !== 'string' ||
		!SIGNATURE_PATTERN.test(parsed.signature)
	) {
		throw fail();
	}
	return {
		result: {
			keyId: parsed.keyId,
			algorithm: parsed.algorithm,
			fingerprint: parsed.fingerprint,
			signature: parsed.signature
		},
		upstreamRequestId
	};
}

function send(res, status, payload) {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.end(JSON.stringify(payload));
}

export function createHandler({
	fetchImpl = globalThis.fetch,
	env = process.env,
	getOidcToken = () => process.env.VERCEL_OIDC_TOKEN,
	log = (entry) => console.info(JSON.stringify(entry)),
	newRequestId = randomUUID
} = {}) {
	return async function handler(req, res) {
		try {
			if (req.method !== 'POST') {
				res.setHeader('allow', 'POST');
				throw new HttpError(405, 'method_not_allowed');
			}
			const config = readConfig(env);
			authenticate(req, config);
			const contentType = singleHeader(req, 'content-type') ?? '';
			if (!/^application\/json\s*(;.*)?$/i.test(contentType)) {
				throw new HttpError(415, 'unsupported_media_type');
			}
			const { operationId, message } = parseInput(await readBody(req));

			// Request is accepted from here on: exactly one upstream call, no retries.
			const requestId = newRequestId();
			const oidcToken = (() => {
				try {
					return resolveOidcToken(req, getOidcToken);
				} catch (error) {
					log({ event: 'pdf_seal_sign', outcome: 'failed', requestId, operationId });
					throw error;
				}
			})();
			try {
				const { result, upstreamRequestId } = await sign({
					config,
					message,
					oidcToken,
					fetchImpl
				});
				log({
					event: 'pdf_seal_sign',
					outcome: 'signed',
					requestId,
					operationId,
					upstreamRequestId
				});
				send(res, 200, { ...result, requestId });
			} catch (error) {
				log({
					event: 'pdf_seal_sign',
					outcome: 'failed',
					requestId,
					operationId,
					upstreamRequestId: error?.upstreamRequestId
				});
				throw error;
			}
		} catch (error) {
			if (error instanceof HttpError) {
				send(res, error.status, { error: error.code });
			} else {
				send(res, 500, { error: 'internal_error' });
			}
		}
	};
}
