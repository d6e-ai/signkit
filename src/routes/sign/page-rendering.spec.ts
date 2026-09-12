import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('recipient document rendering', () => {
	it('renders only the server-sanitized node model through escaped Svelte interpolation', () => {
		const source: string = readFileSync('src/routes/sign/+page.svelte', 'utf8');
		expect(source).toContain('{document.content}');
		expect(source).toContain('{@render renderMarkdownNode(node)}');
		expect(source).toContain('<svelte:element this={node.tag} {...node.attributes}>');
		expect(source).not.toContain('{@html');
		expect(source).not.toMatch(/<img[^>]+document\.content|href=\{document\.content\}/);
	});

	it('keeps the signing page server load free of recipient view mutations', () => {
		const source: string = readFileSync('src/routes/sign/+page.server.ts', 'utf8');
		expect(source).not.toContain('resolveRecipientViewedApplication');
		expect(source).not.toContain('/api/v1/signing/viewed');
		expect(source).not.toContain('recipient.viewed');
	});

	it('makes the authoritative terminal decline branch precede all document rendering', () => {
		const source: string = readFileSync('src/routes/sign/+page.svelte', 'utf8');
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
			source.indexOf('{#each data.documents as document')
		);
		expect(source).toContain('signing_decline_no_js_explanation');
		expect(source).not.toContain('recipientStatus as string');
	});

	it('resolves terminal receipt cookies without using the document workspace runtime', () => {
		const source: string = readFileSync('src/routes/sign/+page.server.ts', 'utf8');
		expect(source).toContain('resolveDeclinedReceiptPage');
		expect(source).toContain('resolveRecipientDeclinedReceiptApplication');
		expect(source).toContain('unsealDeclinedReceiptSession');
		expect(source).toContain("if (page.state !== 'active') return page");
	});

	it('keeps approval capability-bound and client-driven', () => {
		const source: string = readFileSync('src/routes/sign/+page.svelte', 'utf8');
		expect(source).toContain("fetchFn('/api/v1/signing/approve'");
		expect(source).toContain("credentials: 'same-origin'");
		expect(source).toContain("'idempotency-key': idempotencyKey");
		expect(source).toContain("data.access.role === 'approver'");
		expect(source).toContain("data.access.recipientStatus === 'viewed'");
		expect(source).toContain('signing_approve_no_js_explanation');
		expect(source).not.toContain('capabilityToken');
	});

	it('keeps signing capability-bound and client-driven with expectedFieldGeneration', () => {
		const source: string = readFileSync('src/routes/sign/+page.svelte', 'utf8');
		expect(source).toContain("fetchFn('/api/v1/signing/sign'");
		expect(source).toContain('expectedFieldGeneration');
		expect(source).toContain("data.access.role === 'signer'");
		expect(source).toContain('signing_sign_no_js_explanation');
		expect(source).not.toContain('Bearer');
	});

	it('offsets sticky signing navigation below the shared h-16 header', () => {
		const source: string = readFileSync('src/routes/sign/+page.svelte', 'utf8');
		expect(source).toContain('sticky top-16');
		expect(source).not.toContain('sticky top-14');
	});
});
