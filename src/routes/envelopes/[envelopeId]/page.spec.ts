import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('envelope authoring page contracts', () => {
	const source: string = readFileSync('src/routes/envelopes/[envelopeId]/+page.svelte', 'utf8');

	it('recovers send readiness and recipients from the durable envelope detail read', () => {
		expect(source).toContain('client.getDetail(envelopeId)');
		expect(source).toContain('readyAuditEventId = detail.readyAuditEventId');
		expect(source).toContain('readyRecipients = detail.recipients');
		expect(source).toContain('placedFields = detail.fields');
		expect(source).not.toContain('sessionStorage');
		expect(source).toContain('expectedReadyAuditEventId: readyAuditEventId');
	});

	it('wires DOCX import and export without storing DOCX in the draft editor', () => {
		expect(source).toContain('client.importDocx');
		expect(source).toContain('client.exportDocx');
		expect(source).toContain('envelope_import_docx_hint');
		expect(source).toContain(
			'accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"'
		);
	});

	it('places fields on the selected document preview while keeping keyboard geometry inputs', () => {
		expect(source).toContain('placementPreview');
		expect(source).toContain('visiblePlacementFields');
		expect(source).toContain('id="geo-page"');
		expect(source).toContain('id="geo-x"');
		expect(source).toContain('{@render renderMarkdownNode(node)}');
		expect(source).not.toContain('max-w-64 cursor-crosshair rounded-lg border bg-muted/20');
	});

	it('keeps keyed each blocks and does not render raw HTML', () => {
		const eachMatches = [...source.matchAll(/\{#each\s+([^}]+)\}/g)];
		expect(eachMatches.length).toBeGreaterThan(0);
		for (const match of eachMatches) {
			expect(match[1]).toMatch(/\(.*?\)$/);
		}
		expect(source).not.toContain('{@html');
	});
});
