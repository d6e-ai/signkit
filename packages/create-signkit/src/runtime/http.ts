import { PACKAGE_NAME, PACKAGE_VERSION } from '../constants.js';

export interface HttpRequest {
	url: string;
	method?: 'GET' | 'HEAD';
	headers?: Record<string, string>;
	maxBytes: number;
	allowedHosts: ReadonlySet<string>;
	requireHttps?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface HttpResponse {
	url: string;
	status: number;
	headers: Record<string, string>;
	body: Uint8Array;
}

export interface HttpClient {
	request(request: HttpRequest): Promise<HttpResponse>;
}

const DEFAULT_MAX_REDIRECTS = 5;

export function createFetchHttpClient(fetchImpl: typeof fetch = fetch): HttpClient {
	return {
		async request(request) {
			return boundedFetch(fetchImpl, request);
		}
	};
}

export async function boundedFetch(
	fetchImpl: typeof fetch,
	request: HttpRequest
): Promise<HttpResponse> {
	const requireHttps = request.requireHttps !== false;
	let current = parseAllowedUrl(request.url, request.allowedHosts, requireHttps);
	const headers = new Headers(request.headers);
	headers.set('user-agent', headers.get('user-agent') ?? `${PACKAGE_NAME}/${PACKAGE_VERSION}`);
	const timeoutSignal =
		request.timeoutMs !== undefined ? AbortSignal.timeout(request.timeoutMs) : undefined;
	const signal = mergeAbortSignals(request.signal, timeoutSignal);

	for (let hop = 0; hop <= DEFAULT_MAX_REDIRECTS; hop += 1) {
		const response = await fetchImpl(current, {
			method: request.method ?? 'GET',
			headers,
			redirect: 'manual',
			signal
		});
		const location = response.headers.get('location');
		if (isRedirect(response.status) && location) {
			const next = new URL(location, current);
			current = parseAllowedUrl(next.toString(), request.allowedHosts, requireHttps);
			continue;
		}
		const body = await readBoundedBody(response, request.maxBytes);
		return {
			url: current.toString(),
			status: response.status,
			headers: Object.fromEntries(response.headers.entries()),
			body
		};
	}
	throw new Error(`too many redirects fetching ${request.url}`);
}

export function parseAllowedUrl(
	urlText: string,
	allowedHosts: ReadonlySet<string>,
	requireHttps = true
): URL {
	let url: URL;
	try {
		url = new URL(urlText);
	} catch {
		throw new Error(`invalid URL: ${urlText}`);
	}
	if (requireHttps && url.protocol !== 'https:') {
		throw new Error(`refusing non-HTTPS URL ${urlText}`);
	}
	if (url.username || url.password) {
		throw new Error(`refusing URL with userinfo: ${url.origin}${url.pathname}`);
	}
	if (!allowedHosts.has(url.hostname)) {
		throw new Error(`refusing download from unexpected host ${url.hostname}`);
	}
	return url;
}

function isRedirect(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function mergeAbortSignals(
	left: AbortSignal | undefined,
	right: AbortSignal | undefined
): AbortSignal | undefined {
	if (!left) return right;
	if (!right) return left;
	if (typeof AbortSignal.any === 'function') {
		return AbortSignal.any([left, right]);
	}
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (left.aborted || right.aborted) {
		controller.abort();
		return controller.signal;
	}
	left.addEventListener('abort', abort, { once: true });
	right.addEventListener('abort', abort, { once: true });
	return controller.signal;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
	const lengthHeader = response.headers.get('content-length');
	if (lengthHeader) {
		const length = Number(lengthHeader);
		if (Number.isFinite(length) && length > maxBytes) {
			throw new Error(`response content-length ${length} exceeds limit ${maxBytes}`);
		}
	}
	if (!response.body) {
		return new Uint8Array();
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		received += value.byteLength;
		if (received > maxBytes) {
			await reader.cancel();
			throw new Error(`response body exceeded limit ${maxBytes}`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

export function utf8(body: Uint8Array): string {
	return new TextDecoder().decode(body);
}
