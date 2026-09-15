import { describe, expect, it } from 'vitest';
import { renderRecipientMarkdown } from '$lib/security/recipient-markdown';
import { renderAgreementPdf } from './agreement-pdf';
import {
	composePdf,
	displayToUserMatrix,
	displayedSize,
	fitOverlayTextSize,
	measureOverlayText,
	PdfCompositionError,
	type ComposePdfResult,
	type OverlayOperation
} from './pdf-composer';
import { buildFixturePdf, textPage } from './pdf-fixture-test-support';
import { PdfObjectReader } from './pdf-object-reader';
import { parsePdfPageMetadata } from './pdf-page-metadata';
import { drawnSignaturePng } from './png-image-test-support';

const INK = { red: 0.05, green: 0.05, blue: 0.1 };

function markdownPdf(body: string): Uint8Array {
	return renderAgreementPdf([{ title: 'agreement', nodes: renderRecipientMarkdown(body).nodes }])
		.bytes;
}

/** A single-page PDF with an explicitly offset MediaBox and a `/Rotate` value. */
function rotatedPdf(rotate: number): Uint8Array {
	return buildFixturePdf([textPage('base content', { mediaBox: [10, 20, 410, 820], rotate })]);
}

function text(
	operation: Partial<Extract<OverlayOperation, { kind: 'text' }>> = {}
): OverlayOperation {
	return {
		kind: 'text',
		x: 40,
		baseline: 60,
		size: 14,
		text: 'Alex Signer',
		color: INK,
		...operation
	};
}

describe('composePdf', () => {
	it('concatenates the pages of every source document in order', () => {
		const first: Uint8Array = markdownPdf('# One\n\nFirst document body.');
		const second: Uint8Array = markdownPdf('# Two\n\nSecond document body.');

		const result: ComposePdfResult = composePdf({
			sources: [{ bytes: first }, { bytes: second }]
		});

		const firstPages: number = parsePdfPageMetadata(first).pageCount;
		const secondPages: number = parsePdfPageMetadata(second).pageCount;
		expect(result.sourcePageCounts).toEqual([firstPages, secondPages]);
		expect(result.pageCount).toBe(firstPages + secondPages);
		expect(parsePdfPageMetadata(result.bytes).pageCount).toBe(firstPages + secondPages);
	});

	it('is byte-identical for identical inputs and differs when an overlay differs', () => {
		const base: Uint8Array = markdownPdf('Agreement body.');
		const overlays = new Map([[0, [text()]]]);

		const first: ComposePdfResult = composePdf({ sources: [{ bytes: base, overlays }] });
		const second: ComposePdfResult = composePdf({ sources: [{ bytes: base, overlays }] });
		const different: ComposePdfResult = composePdf({
			sources: [{ bytes: base, overlays: new Map([[0, [text({ text: 'Other Signer' })]]]) }]
		});

		expect([...first.bytes]).toEqual([...second.bytes]);
		expect([...first.bytes]).not.toEqual([...different.bytes]);
	});

	it('keeps the base page content and appends the overlay after it', () => {
		const base: Uint8Array = rotatedPdf(0);

		const composed: ComposePdfResult = composePdf({
			sources: [{ bytes: base, overlays: new Map([[0, [text()]]]) }]
		});

		const reader = new PdfObjectReader(composed.bytes);
		const page = reader.pages()[0];
		const contents = page.contents;
		expect(contents).toBeDefined();
		// q, the imported stream, Q, then SignKit's overlay.
		expect(contents).toMatchObject({ kind: 'array' });
		const items = (contents as { items: readonly unknown[] }).items;
		expect(items).toHaveLength(4);
		const imported = reader.indirect(items[1] as never);
		expect(new TextDecoder().decode(imported.stream ?? new Uint8Array())).toContain(
			'(base content) Tj'
		);
	});

	it('preserves the source MediaBox and /Rotate so imported pages keep their geometry', () => {
		const composed: ComposePdfResult = composePdf({
			sources: [{ bytes: rotatedPdf(90), overlays: new Map([[0, [text()]]]) }]
		});

		const page = new PdfObjectReader(composed.bytes).pages()[0];
		expect([...page.mediaBox]).toEqual([10, 20, 410, 820]);
		expect(page.rotate).toBe(90);
		// 400x800 media box displayed sideways.
		expect(displayedSize(page)).toEqual({ width: 800, height: 400 });
	});

	it('maps display coordinates back into user space for every rotation', () => {
		const mediaBox = [10, 20, 410, 820] as const;

		const apply = (rotate: number, x: number, y: number): readonly [number, number] => {
			const [a, b, c, d, e, f] = displayToUserMatrix(mediaBox, rotate);
			return [a * x + c * y + e, b * x + d * y + f];
		};

		// The display-space origin is the bottom-left of the page as read.
		expect(apply(0, 0, 0)).toEqual([10, 20]);
		expect(apply(90, 0, 0)).toEqual([410, 20]);
		expect(apply(180, 0, 0)).toEqual([410, 820]);
		expect(apply(270, 0, 0)).toEqual([10, 820]);
		// The opposite corner of the displayed page maps to the opposite corner
		// of the media box, whichever way the page is turned.
		expect(apply(0, 400, 800)).toEqual([410, 820]);
		expect(apply(90, 800, 400)).toEqual([10, 820]);
	});

	it('embeds a drawn signature as an image XObject with a soft mask', () => {
		const composed: ComposePdfResult = composePdf({
			sources: [
				{
					bytes: markdownPdf('Agreement body.'),
					overlays: new Map([
						[0, [{ kind: 'image', imageId: 'sig', x: 40, y: 40, width: 120, height: 40 }]]
					])
				}
			],
			images: [{ id: 'sig', pngBytes: drawnSignaturePng() }]
		});

		const raw: string = new TextDecoder('latin1').decode(composed.bytes);
		expect(raw).toContain('/Subtype /Image');
		expect(raw).toContain('/SMask');
		expect(raw).toContain('/ColorSpace /DeviceRGB');
	});

	it('gives overlay resources names that cannot collide with the source page', () => {
		const composed: ComposePdfResult = composePdf({
			sources: [{ bytes: rotatedPdf(0), overlays: new Map([[0, [text()]]]) }]
		});

		const page = new PdfObjectReader(composed.bytes).pages()[0];
		const reader = new PdfObjectReader(composed.bytes);
		const resources = reader.resolve(page.resources as never) as {
			entries: Map<string, unknown>;
		};
		const fonts = resources.entries.get('Font') as { entries: Map<string, unknown> };
		expect([...fonts.entries.keys()]).toEqual(['F1', 'SKF']);
	});

	it('rejects an overlay aimed at a page the source does not have', () => {
		expect(() =>
			composePdf({
				sources: [{ bytes: markdownPdf('Body.'), overlays: new Map([[7, [text()]]]) }]
			})
		).toThrowError(expect.objectContaining({ reason: 'invalid_overlay' }));
	});

	it('rejects an overlay referencing an image that was never supplied', () => {
		expect(() =>
			composePdf({
				sources: [
					{
						bytes: markdownPdf('Body.'),
						overlays: new Map([
							[0, [{ kind: 'image', imageId: 'missing', x: 1, y: 1, width: 2, height: 2 }]]
						])
					}
				]
			})
		).toThrowError(expect.objectContaining({ reason: 'unknown_image' }));
	});

	it('rejects a source that is not a readable PDF', () => {
		expect(() =>
			composePdf({ sources: [{ bytes: new TextEncoder().encode('not a pdf') }] })
		).toThrowError(expect.objectContaining({ reason: 'invalid_source' }));
	});

	it('fails closed when the composition exceeds its page budget', () => {
		expect(() =>
			composePdf({ sources: [{ bytes: markdownPdf('Body.') }], maxPages: 0 })
		).toThrowError(expect.objectContaining({ reason: 'too_many_pages' }));
	});

	it('fails closed when the composed output exceeds its size budget', () => {
		expect(() =>
			composePdf({ sources: [{ bytes: markdownPdf('Body.') }], maxOutputBytes: 64 })
		).toThrowError(expect.objectContaining({ reason: 'output_too_large' }));
	});

	it('rejects an empty source list', () => {
		expect(() => composePdf({ sources: [] })).toThrowError(PdfCompositionError);
	});
});

describe('overlay text measurement', () => {
	it('scales linearly with the font size', () => {
		expect(measureOverlayText('Alex', 20)).toBeCloseTo(measureOverlayText('Alex', 10) * 2, 6);
	});

	it('shrinks a long value to fit its box without going below the floor', () => {
		const wide: number = fitOverlayTextSize('Alex Signer', 200, 14, 5);
		const narrow: number = fitOverlayTextSize('Alex Signer', 20, 14, 5);

		expect(wide).toBe(14);
		expect(narrow).toBe(5);
		expect(
			measureOverlayText('Alex Signer', fitOverlayTextSize('Alex Signer', 60, 14, 5))
		).toBeLessThanOrEqual(60);
	});
});
