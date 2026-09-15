import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { renderRecipientMarkdown } from '$lib/security/recipient-markdown';
import { renderAgreementPdf } from './agreement-pdf';
import { composePdf, type ComposePdfResult } from './pdf-composer';
import { drawnSignaturePng } from './png-image-test-support';

/**
 * The composer writes PDF syntax by hand, so its own parser agreeing with it
 * proves very little. These specs put the composed bytes through pdf.js — the
 * same engine that renders the agreement in a recipient's browser — and assert
 * that the base document text and the overlaid values both survive.
 */

async function textOfPage(bytes: Uint8Array, pageNumber: number): Promise<string> {
	const task = getDocument({ data: Uint8Array.from(bytes) });
	const document = await task.promise;
	try {
		const page = await document.getPage(pageNumber);
		const content = await page.getTextContent();
		return content.items
			.map((item: unknown): string =>
				typeof item === 'object' && item !== null && 'str' in item ? String(item.str) : ''
			)
			.join('');
	} finally {
		await task.destroy();
	}
}

function markdownPdf(body: string): Uint8Array {
	return renderAgreementPdf([{ title: 'agreement', nodes: renderRecipientMarkdown(body).nodes }])
		.bytes;
}

describe('composed PDF rendering', () => {
	it('renders the imported document text and the overlaid signature value together', async () => {
		const composed: ComposePdfResult = composePdf({
			sources: [
				{
					bytes: markdownPdf('The parties agree to the terms below.'),
					overlays: new Map([
						[
							0,
							[
								{
									kind: 'text',
									x: 60,
									baseline: 120,
									size: 16,
									text: 'Alex Signer',
									color: { red: 0.05, green: 0.05, blue: 0.1 }
								},
								{ kind: 'image', imageId: 'sig', x: 60, y: 160, width: 120, height: 40 }
							]
						]
					])
				}
			],
			images: [{ id: 'sig', pngBytes: drawnSignaturePng() }]
		});

		const text: string = await textOfPage(composed.bytes, 1);
		expect(text).toContain('The parties agree to the terms below.');
		expect(text).toContain('Alex Signer');
	});

	it('keeps each document readable at its own page in a multi-document composition', async () => {
		const composed: ComposePdfResult = composePdf({
			sources: [
				{ bytes: markdownPdf('First document clause.') },
				{ bytes: markdownPdf('Second document clause.') }
			]
		});

		await expect(textOfPage(composed.bytes, 1)).resolves.toContain('First document clause.');
		await expect(textOfPage(composed.bytes, 2)).resolves.toContain('Second document clause.');
	});
});
