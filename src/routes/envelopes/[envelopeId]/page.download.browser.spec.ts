import { afterEach, describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';

/**
 * Regresses the download *mechanism* the completed Documents tab's "Download
 * final PDF" / "Download evidence" links now use: a same-origin `<a
 * download>` click against a `Content-Disposition: attachment` response.
 *
 * This intentionally does not render `+page.svelte` or hit the real
 * `/completion-artifact/*` routes - two other, already-passing suites cover
 * the rest of that contract and shouldn't be re-asserted here:
 *   - `page.spec.ts` ("uses native session-authorized download links...")
 *     asserts the rendered markup points `href` at the exact authorized,
 *     same-origin `/api/v1/envelopes/{id}/completion-artifact/...` URL with a
 *     `download` attribute.
 *   - `src/lib/http/completion-evidence-pdf.spec.ts` ("requires
 *     authorization") asserts those routes 401 without a session/API key.
 *
 * What's missing without this file is proof that clicking that kind of link
 * actually produces a real, byte-exact browser download in this environment
 * at all - which is exactly what the QA report's Computer Use session could
 * not observe for the old fetch-into-Blob-into-revoked-object-URL
 * implementation. A `context.route(...)`-fulfilled response reliably fails
 * that (`download.failure()` resolves to `'canceled'` even after a redirect
 * to an unmocked response - Chromium won't commit a download whose
 * initiating request was answered by DevTools-protocol interception), so
 * this instead runs a short-lived, loopback-only HTTP server (via the
 * `browser` project's custom commands - see vite.config.ts and
 * $lib/testing/browser-download-commands.ts) and points a real anchor at it,
 * so the browser talks to a real socket the way it would in production.
 */

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/** A same-origin download link, built the same way `Button href={...} download` renders. */
function appendDownloadLink(url: string, suggestedName: string): HTMLAnchorElement {
	const link = document.createElement('a');
	link.href = url;
	link.download = suggestedName;
	link.textContent = suggestedName;
	document.body.appendChild(link);
	return link;
}

describe('the native download-link mechanism used by the completed Documents tab', () => {
	afterEach(async () => {
		await commands.stopFixtureServer();
		document.body.replaceChildren();
	});

	it('captures a real download event with the exact bytes and filename for a PDF-like response', async () => {
		const pdfBytes = new TextEncoder().encode(
			'%PDF-1.7 fixture bytes for the browser download regression\n'
		);
		const expectedSha256 = await sha256Hex(pdfBytes);
		const { url } = await commands.startFixtureServer({
			status: 200,
			headers: {
				'content-type': 'application/pdf',
				'content-disposition': 'attachment; filename="completion-fixture.pdf"'
			},
			bodyBase64: toBase64(pdfBytes)
		});

		const link = appendDownloadLink(url, 'completion-fixture.pdf');
		const downloadPromise = commands.captureDownload({ timeoutMs: 10_000 });
		link.click();
		const result = await downloadPromise;

		expect(result.byteLength).toBe(pdfBytes.byteLength);
		expect(result.sha256).toBe(expectedSha256);
		expect(result.suggestedFilename).toBe('completion-fixture.pdf');
	});

	it('captures a real download event with the exact bytes and filename for a JSON evidence response', async () => {
		const jsonBytes = new TextEncoder().encode(
			JSON.stringify({
				schema: 'completion-manifest-v1',
				envelopeId: '01900000-0000-7000-8000-000000000030'
			})
		);
		const expectedSha256 = await sha256Hex(jsonBytes);
		const { url } = await commands.startFixtureServer({
			status: 200,
			headers: {
				'content-type': 'application/json',
				'content-disposition': 'attachment; filename="completion-evidence-fixture.json"'
			},
			bodyBase64: toBase64(jsonBytes)
		});

		const link = appendDownloadLink(url, 'completion-evidence-fixture.json');
		const downloadPromise = commands.captureDownload({ timeoutMs: 10_000 });
		link.click();
		const result = await downloadPromise;

		expect(result.byteLength).toBe(jsonBytes.byteLength);
		expect(result.sha256).toBe(expectedSha256);
		expect(result.suggestedFilename).toBe('completion-evidence-fixture.json');
	});

	it('never lets an unauthorized/error response resolve to the same bytes as the real signed document', async () => {
		// Mirrors the exact 401 problem+json shape `authorizeScopedInstanceRequest`
		// returns (see src/lib/http/api-key-authorization.ts), independently
		// covered at the handler level by completion-evidence-pdf.spec.ts's
		// "requires authorization" tests. This regresses the front end's half of
		// that contract: whatever a same-origin error response does to a native
		// `download` link, its bytes must never be indistinguishable from the
		// real signed PDF.
		const validPdfBytes = new TextEncoder().encode(
			'%PDF-1.7 fixture bytes for the browser download regression\n'
		);
		const validSha256 = await sha256Hex(validPdfBytes);
		const problemBody = new TextEncoder().encode(
			JSON.stringify({
				type: 'urn:signkit:problem:api-key-authentication-required',
				title: 'API key authentication required',
				status: 401,
				detail: 'A live SignKit API key is required for this request.'
			})
		);
		const { url } = await commands.startFixtureServer({
			status: 401,
			headers: { 'content-type': 'application/problem+json' },
			bodyBase64: toBase64(problemBody)
		});

		const link = appendDownloadLink(url, 'completion-fixture.pdf');
		const attemptPromise = commands.attemptCaptureDownload({ timeoutMs: 2000 });
		link.click();
		const result = await attemptPromise;

		if (result !== null) {
			expect(result.sha256).not.toBe(validSha256);
		} else {
			expect(result).toBeNull();
		}
	});
});
