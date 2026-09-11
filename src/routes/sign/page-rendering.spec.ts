import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('recipient document rendering', () => {
	it('renders untrusted Markdown only through escaped Svelte text interpolation', () => {
		const source: string = readFileSync('src/routes/sign/+page.svelte', 'utf8');
		expect(source).toContain('{document.content}');
		expect(source).not.toContain('{@html');
		expect(source).not.toMatch(/<img[^>]+document\.content|href=\{document\.content\}/);
	});

	it('keeps the signing page server load free of recipient view mutations', () => {
		const source: string = readFileSync('src/routes/sign/+page.server.ts', 'utf8');
		expect(source).not.toContain('resolveRecipientViewedApplication');
		expect(source).not.toContain('/api/v1/signing/viewed');
		expect(source).not.toContain('recipient.viewed');
	});

	it('keeps terminal decline receipt rendering client-driven and explains the no-JavaScript case', () => {
		const source: string = readFileSync('src/routes/sign/+page.svelte', 'utf8');
		expect(source).toContain('let isDeclined = $state(false)');
		expect(source).toContain('{#if isDeclined}');
		expect(source).toContain('signing_declined_receipt_title');
		expect(source).toContain('signing_decline_no_js_explanation');
		expect(source).not.toContain('recipientStatus as string');
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
});
