import {
	DEFAULT_SMOKE_ATTEMPTS,
	DEFAULT_SMOKE_BACKOFF_MS,
	DEFAULT_SMOKE_TIMEOUT_MS,
	MAX_SMOKE_BYTES
} from '../../constants.js';
import { generic } from '../../cli/errors.js';
import type { HttpClient } from '../../runtime/http.js';
import { utf8 } from '../../runtime/http.js';

export interface SmokeCheckInput {
	url: string;
	http: HttpClient;
	fallbackUrl?: string;
	attempts?: number;
	backoffMs?: number;
	timeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

export interface SmokeCheckResult {
	ok: boolean;
	url: string;
	status?: number;
	detail: string;
	usedFallback?: boolean;
}

export function smokeBackoffDelay(attempt: number, backoffMs: number): number {
	if (backoffMs <= 0 || attempt < 1) {
		return 0;
	}
	return backoffMs * 2 ** (attempt - 1);
}

export function productionWorkersDevOrigin(
	urlText: string,
	workerName: string
): string | undefined {
	let url: URL;
	try {
		url = new URL(urlText);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'https:') {
		return undefined;
	}
	const host = url.hostname.toLowerCase();
	if (!host.endsWith('.workers.dev')) {
		return undefined;
	}
	const first = host.split('.')[0];
	if (first !== workerName.toLowerCase()) {
		return undefined;
	}
	return url.origin;
}

export function selectProductionWorkersDevOrigin(
	text: string,
	workerName: string
): string | undefined {
	const matches = text.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/gi) ?? [];
	for (const match of matches) {
		const origin = productionWorkersDevOrigin(match, workerName);
		if (origin) {
			return origin;
		}
	}
	return undefined;
}

export async function smokeCheck(input: SmokeCheckInput): Promise<SmokeCheckResult> {
	const sleep = input.sleep ?? defaultSleep;
	const attempts = input.attempts ?? DEFAULT_SMOKE_ATTEMPTS;
	const backoffMs = input.backoffMs ?? DEFAULT_SMOKE_BACKOFF_MS;
	const timeoutMs = input.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS;
	const primary = await smokeOrigin(input.url, input.http, attempts, backoffMs, timeoutMs, sleep);
	if (primary.ok) {
		return primary;
	}
	if (!isTransientSmokeFailure(primary) || !input.fallbackUrl) {
		return primary;
	}
	const fallbackOrigin = originOf(input.fallbackUrl);
	if (fallbackOrigin === originOf(input.url)) {
		return primary;
	}
	const fallback = await smokeOrigin(
		fallbackOrigin,
		input.http,
		attempts,
		backoffMs,
		timeoutMs,
		sleep
	);
	if (fallback.ok) {
		return { ...fallback, usedFallback: true };
	}
	return primary;
}

export function isTransientSmokeFailure(result: SmokeCheckResult): boolean {
	if (result.ok) {
		return false;
	}
	if (result.status === 404 || (result.status !== undefined && result.status >= 500)) {
		return true;
	}
	return /network|econnreset|econnrefused|etimedout|fetch failed|socket|dns|abort|timeout/i.test(
		result.detail
	);
}

export function capabilitiesUrl(origin: string): string {
	return new URL('/api/v1/system/capabilities', origin).toString();
}

async function smokeOrigin(
	origin: string,
	http: HttpClient,
	attempts: number,
	backoffMs: number,
	timeoutMs: number,
	sleep: (ms: number) => Promise<void>
): Promise<SmokeCheckResult> {
	const url = new URL(origin);
	if (url.protocol !== 'https:') {
		throw generic(`smoke check requires HTTPS, got ${url.protocol}`);
	}
	const target = capabilitiesUrl(url.origin);
	let last: SmokeCheckResult | undefined;
	const maxAttempts = Math.max(1, attempts);
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		last = await probeOnce(target, url.hostname, http, timeoutMs);
		if (last.ok || !isTransientSmokeFailure(last) || attempt === maxAttempts) {
			return last;
		}
		const delay = smokeBackoffDelay(attempt, backoffMs);
		if (delay > 0) {
			await sleep(delay);
		}
	}
	return (
		last ?? {
			ok: false,
			url: target,
			detail: 'HTTPS smoke check failed'
		}
	);
}

async function probeOnce(
	target: string,
	hostname: string,
	http: HttpClient,
	timeoutMs: number
): Promise<SmokeCheckResult> {
	try {
		const response = await http.request({
			url: target,
			maxBytes: MAX_SMOKE_BYTES,
			allowedHosts: new Set([hostname]),
			timeoutMs,
			headers: { accept: 'application/json' }
		});
		if (response.status < 200 || response.status >= 300) {
			return {
				ok: false,
				url: target,
				status: response.status,
				detail: `HTTPS smoke check failed with HTTP ${response.status}`
			};
		}
		const body = utf8(response.body);
		if (
			!body.includes('signkit') &&
			!body.includes('apiVersion') &&
			!body.includes('capabilities')
		) {
			return {
				ok: false,
				url: target,
				status: response.status,
				detail: 'HTTPS smoke check succeeded but the body was not a SignKit capabilities document'
			};
		}
		return { ok: true, url: target, status: response.status, detail: 'HTTPS smoke check passed' };
	} catch (error) {
		return {
			ok: false,
			url: target,
			detail: error instanceof Error ? error.message : String(error)
		};
	}
}

function originOf(url: string): string {
	return new URL(url).origin;
}

async function defaultSleep(ms: number): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
