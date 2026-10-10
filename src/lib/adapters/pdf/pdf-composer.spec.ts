import { describe, expect, it } from 'vitest';
import { renderRecipientMarkdown } from '$lib/security/recipient-markdown';
import { renderAgreementPdf } from './agreement-pdf';
import { documentFont } from './document-font';
import {
	composePdf,
	displayToUserMatrix,
	displayedSize,
	emittedImageStreamBytes,
	fitOverlayTextSize,
	MAX_COMPOSED_PDF_OBJECTS,
	MAX_COMPOSED_PDF_TEXT_LENGTH,
	maxDeflatedPdfStreamBytes,
	measureOverlayText,
	overlayOutputReserve,
	overlayReservedObjectCount,
	PdfCompositionError,
	type ComposePdfInput,
	type ComposePdfResult,
	type OverlayOperation
} from './pdf-composer';
import { buildFixturePdf, textPage } from './pdf-fixture-test-support';
import { PdfObjectReader } from './pdf-object-reader';
import { parsePdfPageMetadata } from './pdf-page-metadata';
import { deflatePdfStream } from './pdf-writer-primitives';
import {
	decodePng,
	estimatePngDecodeMemory,
	MAX_PNG_DIMENSION,
	MAX_PNG_PIXELS,
	type PngDecodeMemoryEstimate
} from './png-image';
import { drawnSignaturePng, encodeTestPngWithInflatedScanlines } from './png-image-test-support';

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

	it('accounts resident sources, retained planes, and current decode buffers at the threshold', () => {
		const signature: Uint8Array = drawnSignaturePng(8, 4);
		const source: Uint8Array = markdownPdf('Agreement body.');
		const estimate: PngDecodeMemoryEstimate = estimatePngDecodeMemory(signature);
		const residentSourceBytes: number = source.byteLength + signature.byteLength * 2;
		const twoImagePeak: number =
			residentSourceBytes + estimate.retainedBytes + estimate.peakWorkingBytes;
		const input: ComposePdfInput = {
			sources: [
				{
					bytes: source,
					overlays: new Map([
						[
							0,
							[
								{
									kind: 'image' as const,
									imageId: 'first',
									x: 40,
									y: 40,
									width: 120,
									height: 40
								},
								{
									kind: 'image' as const,
									imageId: 'second',
									x: 40,
									y: 100,
									width: 120,
									height: 40
								}
							]
						]
					])
				}
			],
			images: [
				{ id: 'first', pngBytes: signature },
				{ id: 'second', pngBytes: signature }
			]
		};
		expect(() =>
			composePdf({
				...input,
				maxImageWorkingSetBytes: twoImagePeak - 1
			})
		).toThrowError(expect.objectContaining({ reason: 'decoded_image_budget_exceeded' }));
		expect(
			composePdf({ ...input, maxImageWorkingSetBytes: twoImagePeak }).pageCount
		).toBeGreaterThan(0);
	});

	it('enforces the resident source budget when there are no overlay images', () => {
		const source: Uint8Array = markdownPdf('Agreement body.');

		expect(() =>
			composePdf({ sources: [{ bytes: source }], maxImageWorkingSetBytes: source.byteLength - 1 })
		).toThrowError(expect.objectContaining({ reason: 'decoded_image_budget_exceeded' }));
		expect(
			composePdf({ sources: [{ bytes: source }], maxImageWorkingSetBytes: source.byteLength })
				.pageCount
		).toBeGreaterThan(0);
	});

	it('rejects maximum-dimension 16-bit RGBA header math before attempting inflation', () => {
		const oversizedWorkingSet: Uint8Array = encodeTestPngWithInflatedScanlines(
			{
				width: MAX_PNG_DIMENSION,
				height: Math.floor(MAX_PNG_PIXELS / MAX_PNG_DIMENSION),
				colorType: 6,
				bitDepth: 16,
				samples: new Uint8Array(0)
			},
			Uint8Array.of(0)
		);

		expect(() =>
			composePdf({
				sources: [
					{
						bytes: markdownPdf('Agreement body.'),
						overlays: new Map([
							[
								0,
								[
									{
										kind: 'image',
										imageId: 'hostile',
										x: 40,
										y: 40,
										width: 120,
										height: 40
									}
								]
							]
						])
					}
				],
				images: [{ id: 'hostile', pngBytes: oversizedWorkingSet }]
			})
		).toThrowError(expect.objectContaining({ reason: 'decoded_image_budget_exceeded' }));
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

describe('overlay budget', () => {
	/** A rotated, offset page whose resource names force a longer overlay prefix (`SKX`). */
	function collidingRotatedPdf(): Uint8Array {
		const bytes: Uint8Array = rotatedPdf(90);
		// Same length, so every offset in the fixture's xref stays valid.
		return new TextEncoder().encode(new TextDecoder().decode(bytes).replaceAll('/F1', '/SK'));
	}

	function randomBytes(length: number, seed: number): Uint8Array {
		let state: number = seed;
		const bytes: Uint8Array = new Uint8Array(length);
		for (let index: number = 0; index < length; index += 1) {
			state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
			bytes[index] = state >>> 24;
		}
		return bytes;
	}

	it('bounds any zlib stream the PDF writer can emit for a given input length', () => {
		for (const length of [0, 1, 6_999, 7_000, 7_001, 200_000]) {
			expect(deflatePdfStream(randomBytes(length, length + 1)).byteLength).toBeLessThanOrEqual(
				maxDeflatedPdfStreamBytes(length)
			);
		}
	});

	it('counts reserved dry-run objects against the object budget', () => {
		expect(() =>
			composePdf({
				sources: [{ bytes: markdownPdf('Body.') }],
				reservedObjectCount: MAX_COMPOSED_PDF_OBJECTS
			})
		).toThrowError(expect.objectContaining({ reason: 'object_budget_exceeded' }));
	});

	it('bounds what worst-case operations add to a dry run with their objects reserved', () => {
		const source: Uint8Array = collidingRotatedPdf();
		const png: Uint8Array = drawnSignaturePng(600, 200);
		const far: number = -998.123;
		const ink = { red: 0.123, green: 0.456, blue: 0.789 };
		const operations: OverlayOperation[] = [
			{
				kind: 'text',
				x: far,
				baseline: far,
				size: far,
				color: ink,
				text: Array.from({ length: MAX_COMPOSED_PDF_TEXT_LENGTH }, (_unused, index: number) =>
					String.fromCodePoint(0x4e00 + index)
				).join('')
			},
			{ kind: 'image', imageId: 'signature', x: far, y: far, width: far, height: far },
			{
				kind: 'polyline',
				points: [
					[far, far],
					[far, far],
					[far, far]
				],
				stroke: ink,
				lineWidth: far
			}
		];
		const reader: PdfObjectReader = new PdfObjectReader(source);
		const reserve: number = overlayOutputReserve({
			pages: [
				{
					reader,
					page: reader.pages()[0],
					operations: [
						{ kind: 'text', maxLength: MAX_COMPOSED_PDF_TEXT_LENGTH },
						{ kind: 'image' },
						{ kind: 'polyline', points: 3 }
					],
					maxOperandMagnitude: 999
				}
			],
			imageCount: 1,
			maxImageStreamBytes: emittedImageStreamBytes(decodePng(png))
		});

		const dry: ComposePdfResult = composePdf({
			sources: [{ bytes: source }],
			reservedObjectCount: overlayReservedObjectCount(true, 1)
		});
		const real: ComposePdfResult = composePdf({
			sources: [{ bytes: source, overlays: new Map([[0, operations]]) }],
			images: [{ id: 'signature', pngBytes: png }]
		});

		expect(new TextDecoder().decode(real.bytes)).toContain('/SKXF');
		expect(real.bytes.byteLength).toBeLessThanOrEqual(dry.bytes.byteLength + reserve);
	});

	/**
	 * Exactly `length` UTF-16 units of what the signing normalizer lets
	 * through: CJK, PDF string delimiters, astral emoji, a lone surrogate,
	 * and characters the face does not map.
	 */
	function mixedSignableText(length: number): string {
		const pieces: readonly string[] = [
			'契',
			'\\',
			'(',
			')',
			'😀',
			'\ud800',
			'é',
			'<',
			'>',
			'\u{e0001}'
		];
		let value: string = '';
		for (let index: number = 0; value.length < length; index += 1) {
			const piece: string = pieces[index % pieces.length];
			value += value.length + piece.length <= length ? piece : 'a';
		}
		return value;
	}

	it('composes a maximum-length mixed text run within its reserve and rejects a longer one', () => {
		const source: Uint8Array = markdownPdf('Body.');
		const value: string = mixedSignableText(MAX_COMPOSED_PDF_TEXT_LENGTH);
		expect(value.length).toBe(MAX_COMPOSED_PDF_TEXT_LENGTH);
		const reader: PdfObjectReader = new PdfObjectReader(source);
		const reserve: number = overlayOutputReserve({
			pages: [
				{
					reader,
					page: reader.pages()[0],
					operations: [{ kind: 'text', maxLength: MAX_COMPOSED_PDF_TEXT_LENGTH }],
					maxOperandMagnitude: 999
				}
			],
			imageCount: 0,
			maxImageStreamBytes: 0
		});
		const dry: ComposePdfResult = composePdf({
			sources: [{ bytes: source }],
			reservedObjectCount: overlayReservedObjectCount(true, 0)
		});
		const real: ComposePdfResult = composePdf({
			sources: [{ bytes: source, overlays: new Map([[0, [text({ text: value })]]]) }]
		});
		expect(real.bytes.byteLength).toBeLessThanOrEqual(dry.bytes.byteLength + reserve);

		expect(() =>
			composePdf({
				sources: [{ bytes: source, overlays: new Map([[0, [text({ text: `${value}a` })]]]) }]
			})
		).toThrowError(expect.objectContaining({ reason: 'invalid_overlay' }));
		expect(() =>
			overlayOutputReserve({
				pages: [
					{
						reader,
						page: reader.pages()[0],
						operations: [{ kind: 'text', maxLength: MAX_COMPOSED_PDF_TEXT_LENGTH + 1 }],
						maxOperandMagnitude: 999
					}
				],
				imageCount: 0,
				maxImageStreamBytes: 0
			})
		).toThrowError(expect.objectContaining({ reason: 'invalid_overlay' }));
	});

	it('bounds the overlay font even when text uses every glyph the face maps', () => {
		const font = documentFont();
		const seen: Set<number> = new Set();
		const characters: string[] = [];
		for (let codePoint: number = 0x20; codePoint <= 0x3ffff; codePoint += 1) {
			if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
			const glyphId: number = font.glyphIdForCodePoint(codePoint);
			if (glyphId === 0 || seen.has(glyphId)) continue;
			seen.add(glyphId);
			characters.push(String.fromCodePoint(codePoint));
		}
		// Supplementary-plane characters are two UTF-16 units; 256 per run keeps every run legal.
		const runs: string[] = [];
		for (let start: number = 0; start < characters.length; start += 256) {
			runs.push(characters.slice(start, start + 256).join(''));
		}
		const operations: OverlayOperation[] = runs.map((run: string) => text({ text: run }));
		const source: Uint8Array = markdownPdf('Body.');
		const reader: PdfObjectReader = new PdfObjectReader(source);
		const reserve: number = overlayOutputReserve({
			pages: [
				{
					reader,
					page: reader.pages()[0],
					operations: runs.map(() => ({ kind: 'text' as const, maxLength: 512 })),
					maxOperandMagnitude: 999
				}
			],
			imageCount: 0,
			maxImageStreamBytes: 0
		});

		const dry: ComposePdfResult = composePdf({
			sources: [{ bytes: source }],
			reservedObjectCount: overlayReservedObjectCount(true, 0)
		});
		const real: ComposePdfResult = composePdf({
			sources: [{ bytes: source, overlays: new Map([[0, operations]]) }]
		});

		expect(real.bytes.byteLength).toBeLessThanOrEqual(dry.bytes.byteLength + reserve);
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
