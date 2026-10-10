import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';
import type { BrowserCommand } from 'vitest/node';

/**
 * A same-origin `<a download>` click is a real browser navigation, not a
 * `fetch()` call, so `vi.stubGlobal('fetch', ...)` (used everywhere else in
 * these specs) never sees it.
 *
 * A `context.route(...)`-fulfilled response reliably fails in Chromium:
 * Chromium won't commit a download whose initiating request was answered by
 * DevTools-protocol interception rather than its own network stack.
 *
 * Instead of spinning up an external loopback HTTP server (which is cross-origin
 * to the test runner iframe and ignores the `download` attribute in Chromium),
 * these fixtures are backed by a test-only Vite middleware running directly on
 * the same dev server. That preserves same-origin semantics so `<a download>`
 * completes normally without navigating the test runner iframe.
 */

export interface StartFixtureServerOptions {
	status: number;
	headers: Record<string, string>;
	/** Response body, base64-encoded so it survives the command's JSON-RPC channel intact. */
	bodyBase64: string;
	/** Optional specific URL path to bind to (e.g. /api/v1/envelopes/...) */
	urlPath?: string;
}

export interface CaptureDownloadOptions {
	timeoutMs?: number;
}

export interface CapturedDownload {
	suggestedFilename: string;
	byteLength: number;
	sha256: string;
}

export interface DownloadAttemptOptions {
	timeoutMs?: number;
}

export type DownloadAttemptResult = CapturedDownload | null;

interface FixtureRecord {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
}

const fixtures: Map<string, FixtureRecord> = ((globalThis as Record<string, unknown>)[
	'__signkit_test_download_fixtures__'
] ??= new Map<string, FixtureRecord>()) as Map<string, FixtureRecord>;
let fixtureCounter = 0;

/** Test-only Vite middleware to serve same-origin fixtures for downloads. */
export function testDownloadMiddleware(): Plugin {
	return {
		name: 'signkit-test-download-middleware',
		apply: 'serve',
		configureServer(server) {
			if (!process.env.VITEST) return;
			server.middlewares.use((req, res, next) => {
				if (!req.url) return next();
				const parsed = new URL(req.url, 'http://localhost');
				const full = parsed.pathname + parsed.search;

				const fixture = fixtures.get(full) ?? fixtures.get(parsed.pathname);
				if (fixture) {
					res.writeHead(fixture.status, fixture.headers);
					res.end(fixture.body);
					return;
				}
				next();
			});
		}
	};
}

/** Registers a test fixture on the same-origin Vite dev server. */
export const startFixtureServer: BrowserCommand<[StartFixtureServerOptions]> = async (
	_browserContext,
	{ status, headers, bodyBase64, urlPath }
) => {
	const body = Buffer.from(bodyBase64, 'base64');
	const path = urlPath ?? `/__test_download__/fixture-${++fixtureCounter}`;
	fixtures.set(path, { status, headers, body });
	return { url: path };
};

/** Clears all active download fixtures. */
export const stopFixtureServer: BrowserCommand<[]> = async () => {
	fixtures.clear();
};

async function readDownload(download: {
	path: () => Promise<string>;
	suggestedFilename: () => string;
	failure: () => Promise<string | null>;
}): Promise<CapturedDownload> {
	const failure = await download.failure();
	if (failure !== null) {
		throw new Error(`download failed: ${failure}`);
	}
	const path = await download.path();
	const bytes = await readFile(path);
	return {
		suggestedFilename: download.suggestedFilename(),
		byteLength: bytes.length,
		sha256: createHash('sha256').update(bytes).digest('hex')
	};
}

/** Waits for a download that a caller is expected to have already triggered (or is about to). */
export const captureDownload: BrowserCommand<[CaptureDownloadOptions?]> = async (
	browserContext,
	{ timeoutMs = 10_000 } = {}
) => {
	const download = await browserContext.page.waitForEvent('download', { timeout: timeoutMs });
	return readDownload(download);
};

/**
 * Same wait, but treats a timeout as a legitimate outcome (`null`) instead of
 * throwing: used for the unauthorized-response boundary, where whether the
 * browser turns an error response into a `download` event at all is a
 * browser-specific implementation detail, not the thing under test.
 */
export const attemptCaptureDownload: BrowserCommand<[DownloadAttemptOptions?]> = async (
	browserContext,
	{ timeoutMs = 2000 } = {}
) => {
	try {
		const download = await browserContext.page.waitForEvent('download', { timeout: timeoutMs });
		return await readDownload(download);
	} catch {
		return null;
	}
};

declare module 'vitest/browser' {
	interface BrowserCommands {
		startFixtureServer: (options: StartFixtureServerOptions) => Promise<{ url: string }>;
		stopFixtureServer: () => Promise<void>;
		captureDownload: (options?: CaptureDownloadOptions) => Promise<CapturedDownload>;
		attemptCaptureDownload: (options?: DownloadAttemptOptions) => Promise<DownloadAttemptResult>;
	}
}
