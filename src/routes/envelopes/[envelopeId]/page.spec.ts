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

	it('places fields on the rendered document PDF, by pointer and by keyboard', () => {
		// Placement happens against the same deterministic rendering a recipient
		// will be shown, so a box dropped on page 3 means page 3 for the signer.
		expect(source).toContain('<PdfDocumentView');
		expect(source).toContain('/document-pdf');
		expect(source).toContain('/document-pdf/pages');
		expect(source).toContain('documentPathForPage');
		expect(source).toContain('handlePageClick');
		expect(source).toContain('startDrag');
		expect(source).toContain('handleFieldKeydown');
		expect(source).toContain('clampGeometry');
		// The coordinate spinners are gone: geometry comes from the document.
		expect(source).not.toContain('id="geo-page"');
		expect(source).not.toContain('id="geo-x"');
		expect(source).not.toContain('setNewFieldNumber');
	});

	it('keeps every placed box finite, non-degenerate, and inside its page', () => {
		expect(source).toContain('const MIN_FIELD_SIZE = 0.02');
		expect(source).toContain('Math.min(1, Math.max(MIN_FIELD_SIZE, geometry.width))');
		expect(source).toContain('Math.min(1 - width, Math.max(0, geometry.x))');
		expect(source).toContain('Math.min(1 - height, Math.max(0, geometry.y))');
	});

	it('warns about invisible Unicode controls only when a document has them', () => {
		expect(source).toContain('rendered.hasVisibleUnicodeControls');
		expect(source).toContain('preview.hasVisibleUnicodeControls');
		expect(source).toContain('envelope_document_unicode_warning');
		// No unconditional rendering-policy sentence on any surface.
		expect(source).not.toContain('signing_document_rendering_policy');
		expect(source).not.toContain('m.signing_document_format()');
	});

	it('omits a document card header entirely when the document has no title', () => {
		expect(source).toContain('{#if title.length > 0}');
		expect(source).toContain("class={title.length > 0 ? undefined : 'pt-6'}");
	});

	it('keeps keyed each blocks and does not render raw HTML', () => {
		const eachMatches = [...source.matchAll(/\{#each\s+([^}]+)\}/g)];
		expect(eachMatches.length).toBeGreaterThan(0);
		for (const match of eachMatches) {
			expect(match[1]).toMatch(/\(.*?\)$/);
		}
		expect(source).not.toContain('{@html');
	});

	it('uses shadcn Select and Field for recipient role and language and shows locale after ready', () => {
		expect(source).toContain('<Select.Root type="single" bind:value={draftItem.role}>');
		expect(source).toContain('<Select.Root type="single" bind:value={draftItem.locale}>');
		expect(source).toContain('<Field.Field>');
		expect(source).toContain('<Field.FieldGroup>');
		expect(source).toContain('recipientLocaleLabel(recipient.locale)');
		expect(source).toContain('locale: draftItem.locale');
		expect(source).toContain("getLocale() === 'ja' ? 'ja' : 'en'");
		expect(source).not.toMatch(/<select[\s>]/);
	});

	it('renders localized recipient role and workflow status, never raw enums', () => {
		expect(source).toContain('recipientRoleLabel(recipient.role)');
		expect(source).toContain('recipientWorkflowStatusLabel(recipient.status)');
		expect(source).toContain('<Table.Cell>{recipientRoleLabel(recipient.role)}</Table.Cell>');
		expect(source).toContain(
			'<Table.Cell>{recipientWorkflowStatusLabel(recipient.status)}</Table.Cell>'
		);
		expect(source).not.toContain('<Table.Cell>{recipient.role}</Table.Cell>');
		expect(source).not.toContain('<Table.Cell>{recipient.status}</Table.Cell>');
		expect(source).not.toContain('<Table.Cell>{recipient.routingOrder}</Table.Cell>');
		const readyTable: string = source.slice(
			source.indexOf('{:else if readyRecipients.length > 0}')
		);
		expect(readyTable).not.toContain('envelope_recipient_col_order');
		expect(source).toContain('id={`recipient-order-${draftItem.key}`}');
	});

	it('joins delivery rows to recipients and localizes invitation delivery state', () => {
		expect(source).toContain('recipientForDelivery(item.recipientId)');
		expect(source).toContain('deliveryStateLabel(item.status)');
		expect(source).toContain('envelope_delivery_col_recipient');
		expect(source).not.toContain('envelope_delivery_col_order');
		expect(source).not.toContain('envelope_delivery_col_attempts');
		expect(source).not.toContain('<Table.Cell>{item.recipientRole}</Table.Cell>');
		expect(source).not.toContain('<Table.Cell>{item.routingOrder}</Table.Cell>');
		expect(source).not.toContain('<Table.Cell>{item.attempts}</Table.Cell>');
		expect(source).not.toContain('<Badge variant="secondary">{item.status}</Badge>');
		expect(source).toContain("case 'blocked':");
		expect(source).toContain("case 'processing':");
		expect(source).toContain("case 'delivered':");
		expect(source).toContain("case 'failed':");
		expect(source).toContain('envelope_delivery_status_pending');
	});
});
