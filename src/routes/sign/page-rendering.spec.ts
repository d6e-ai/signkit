import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('recipient document rendering', () => {
	it('never renders document source on the recipient surface', () => {
		const source: string = readFileSync('src/routes/sign/[envelopeId]/+page.svelte', 'utf8');
		expect(source).not.toContain('{document.content}');
		expect(source).not.toContain('signing_document_source_view');
		expect(source).not.toContain('signing_document_source_description');
		expect(source).not.toContain('renderRecipientMarkdown');
		expect(source).not.toContain('renderMarkdownNode');
		expect(source).not.toContain('{@html');
		// The agreement reaches the browser only as a rendered PDF fetched from a
		// same-origin, cookie-authenticated path -- never as Markdown in page
		// data, and never with a capability anywhere in the URL.
		expect(source).toContain('`/sign/${data.access.envelopeId}/agreement.pdf`');
		expect(source).toContain(
			'`/sign/${data.access.envelopeId}/documents/${selectedDocument.documentId}.pdf`'
		);
		expect(source).not.toMatch(/agreement\.pdf\?|agreement\.pdf#.*token/);
	});

	it('keeps the signing page server load free of recipient view mutations and Markdown', () => {
		const source: string = readFileSync('src/routes/sign/[envelopeId]/+page.server.ts', 'utf8');
		expect(source).not.toContain('resolveRecipientViewedApplication');
		expect(source).not.toContain('/api/v1/signing/viewed');
		expect(source).not.toContain('recipient.viewed');
		expect(source).not.toContain('renderRecipientMarkdown');
		expect(source).not.toContain('document.content');
	});

	it('serves the agreement PDF from a session-bound endpoint with no token in the URL', () => {
		const legacy: string = readFileSync(
			'src/routes/sign/[envelopeId]/agreement.pdf/+server.ts',
			'utf8'
		);
		const perDocument: string = readFileSync(
			'src/routes/sign/[envelopeId]/documents/[documentId].pdf/+server.ts',
			'utf8'
		);
		for (const source of [legacy, perDocument]) {
			expect(source).toContain('createRecipientSentPdfHandler');
			expect(source).toContain('unsealRecipientSession');
			expect(source).not.toContain('searchParams');
		}
		expect(legacy).toContain('envelope ID');
	});

	it('makes the authoritative terminal decline branch precede all document rendering', () => {
		const source: string = readFileSync('src/routes/sign/[envelopeId]/+page.svelte', 'utf8');
		expect(source).toContain('let optimisticDecline = $state<');
		expect(source).toContain('let isDeclined = $derived(');
		expect(source).toContain('optimisticDecline.envelopeId === data.access.envelopeId');
		expect(source).toContain('optimisticDecline.recipientId === data.access.recipientId');
		expect(source).toContain('declineControllerIdentity !== identity');
		expect(source).toContain('declineController?.destroy()');
		expect(source).toContain('ensureDeclineController()?.confirmDecline()');
		expect(source).toContain("{#if data.state === 'declined' || isDeclined}");
		expect(source).toContain("{:else if data.state === 'active'}");
		expect(source).toContain('onSuccess: () => void invalidateAll()');
		expect(source).toContain('onAmbiguousFailure: () => void invalidateAll()');
		expect(source).not.toContain('onTransientFailure: () => void invalidateAll()');
		expect(source).toContain('onTerminalFailure: () => void invalidateAll()');
		expect(source).toContain('signing_declined_receipt_title');
		expect(source.indexOf("{#if data.state === 'declined' || isDeclined}")).toBeLessThan(
			source.indexOf('<PdfDocumentView')
		);
		expect(source).toContain('{#key agreementPdfPath}');
		expect(source).not.toContain('recipientStatus as string');
	});

	it('offers exactly one decline affordance, in the summary card footer', () => {
		const source: string = readFileSync('src/routes/sign/[envelopeId]/+page.svelte', 'utf8');
		expect(source).toContain('{#snippet declineAction()}');
		expect(source).toContain('{@render declineAction()}');
		// One call site: the standalone decline card at the bottom of the page is
		// gone, so the destructive action cannot be offered from two places.
		expect(source.split('{@render declineAction()}').length - 1).toBe(1);
		expect(source).toContain('AlertDialog.Root bind:open={dialogOpen}');
		expect(source).not.toContain('signing_decline_no_js_explanation');
		expect(source).not.toContain('signing_controls_next');
	});

	it('resolves terminal receipt cookies without using the document workspace runtime', () => {
		const source: string = readFileSync('src/routes/sign/[envelopeId]/+page.server.ts', 'utf8');
		expect(source).toContain('resolveDeclinedReceiptPage');
		expect(source).toContain('resolveRecipientDeclinedReceiptApplication');
		expect(source).toContain('unsealDeclinedReceiptSession');
		// The completed-action receipt is a second, separately sealed terminal
		// cookie resolved after the declined one, never a document read.
		expect(source).toContain('resolveCompletedReceiptPage');
		expect(source).toContain('resolveRecipientCompletedReceiptApplication');
		expect(source).toContain('unsealCompletedReceiptSession');
		expect(source).toContain('readCompletedReceiptCookie');
		expect(source).not.toContain('renderActivePage');
		expect(source).toContain("if (declinedPage.state !== 'invalid') return declinedPage;");
	});

	it('keeps approval capability-bound and client-driven', () => {
		const source: string = readFileSync('src/routes/sign/[envelopeId]/+page.svelte', 'utf8');
		expect(source).toContain("fetchFn('/api/v1/signing/approve'");
		expect(source).toContain("credentials: 'same-origin'");
		expect(source).toContain("'idempotency-key': idempotencyKey");
		expect(source).toContain("data.access.role === 'approver'");
		expect(source).toContain("data.access.recipientStatus === 'viewed'");
		expect(source).toContain('signing_approve_no_js_explanation');
		expect(source).not.toContain('capabilityToken');
	});

	it('keeps signing capability-bound and client-driven with expectedFieldGeneration', () => {
		const source: string = readFileSync('src/routes/sign/[envelopeId]/+page.svelte', 'utf8');
		expect(source).toContain("fetchFn('/api/v1/signing/sign'");
		expect(source).toContain('expectedFieldGeneration');
		expect(source).toContain("data.access.role === 'signer'");
		expect(source).toContain('signing_sign_no_js_explanation');
		expect(source).not.toContain('Bearer');
	});

	it('lays the signing surface out inside the shared container', () => {
		const layout: string = readFileSync('src/routes/+layout.svelte', 'utf8');
		expect(layout).toContain('container mx-auto flex h-16 w-full items-center');
		expect(layout).toContain('<main class="container mx-auto w-full');
		const source: string = readFileSync('src/routes/sign/[envelopeId]/+page.svelte', 'utf8');
		expect(source).not.toContain('max-w-5xl');
	});

	it('fails closed on bare /sign without reading any recipient cookie', () => {
		const source: string = readFileSync('src/routes/sign/+page.server.ts', 'utf8');
		expect(source).not.toContain('cookies.get');
		expect(source).not.toContain('cookies.delete');
		expect(source).not.toContain('recipientSessionCookieName');
		expect(source).not.toContain('declinedReceiptCookieName');
		expect(source).not.toContain('unsealRecipientSession');
		expect(source).not.toContain('unsealDeclinedReceiptSession');
		expect(source).toContain("return { state: 'invalid' as const }");
	});

	it('binds the envelope page to a UUIDv7 path and envelope-scoped cookies', () => {
		const source: string = readFileSync('src/routes/sign/[envelopeId]/+page.server.ts', 'utf8');
		expect(source).toContain('isUuidV7(envelopeId)');
		expect(source).toContain('recipientSessionCookieName');
		expect(source).toContain('declinedReceiptCookieName');
		expect(source).toContain('readRecipientSessionCookie(cookies, envelopeId)');
		expect(source).toContain('readDeclinedReceiptCookie(cookies, envelopeId)');
		expect(source).not.toContain('deleteRecipientSessionCookie');
		expect(source).not.toContain('deleteDeclinedReceiptCookie');
		expect(source).not.toContain("cookies.get('signkit_recipient')");
		expect(source).not.toContain("cookies.get('signkit_declined_receipt')");
	});
});
