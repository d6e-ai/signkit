import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { renderRecipientMarkdown } from '$lib/security/recipient-markdown';
import { renderAgreementPdf, type AgreementPdfDocument } from './agreement-pdf';
import {
	MAX_PDF_NODE_BUDGET,
	MAX_PDF_PAGE_TREE_DEPTH,
	MAX_PDF_PREV_CHAIN,
	parsePdfPageMetadata,
	PdfPageMetadataError,
	type PdfPageMetadataReason
} from './pdf-page-metadata';
import { MAX_UPLOADED_PDF_PAGES } from '$lib/application/documents/uploaded-pdf';

/** Minimal byte-level builder: PDF structure is ASCII, but stream payloads are binary. */
class ByteBuilder {
	#chunks: Uint8Array[] = [];
	#length: number = 0;

	get offset(): number {
		return this.#length;
	}

	text(value: string): this {
		return this.bytes(new TextEncoder().encode(value));
	}

	bytes(value: Uint8Array): this {
		this.#chunks.push(value);
		this.#length += value.byteLength;
		return this;
	}

	build(): Uint8Array {
		const out: Uint8Array = new Uint8Array(this.#length);
		let cursor: number = 0;
		for (const chunk of this.#chunks) {
			out.set(chunk, cursor);
			cursor += chunk.byteLength;
		}
		return out;
	}
}

interface ObjectSpec {
	num: number;
	body: string;
}

/** A single classic (table) xref section PDF: one generation, no incremental updates. */
function buildClassicPdf(objects: readonly ObjectSpec[], trailerFields: string): Uint8Array {
	const builder = new ByteBuilder().text('%PDF-1.7\n');
	const offsets: Map<number, number> = new Map();
	const maxNum: number = objects.reduce((max, o) => Math.max(max, o.num), 0);
	for (const obj of objects) {
		offsets.set(obj.num, builder.offset);
		builder.text(`${obj.num} 0 obj\n${obj.body}\nendobj\n`);
	}
	const xrefOffset: number = builder.offset;
	const size: number = maxNum + 1;
	builder.text(`xref\n0 ${size}\n0000000000 65535 f \n`);
	for (let n = 1; n < size; n += 1) {
		const offset: number | undefined = offsets.get(n);
		builder.text(
			offset === undefined
				? '0000000000 00000 f \n'
				: `${String(offset).padStart(10, '0')} 00000 n \n`
		);
	}
	builder.text(`trailer\n<< /Size ${size} ${trailerFields} >>\n`);
	builder.text(`startxref\n${xrefOffset}\n%%EOF`);
	return builder.build();
}

/** A page tree of a single Pages root over `count` flat Page leaves, sharing inherited geometry. */
function pageTreeObjects(
	count: number,
	inheritedFields: string,
	pageExtra: string = ''
): ObjectSpec[] {
	const objects: ObjectSpec[] = [];
	const kids: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const num: number = 10 + index;
		objects.push({ num, body: `<< /Type /Page /Parent 2 0 R${pageExtra} >>` });
		kids.push(`${num} 0 R`);
	}
	objects.unshift({ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' });
	objects.splice(1, 0, {
		num: 2,
		body: `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${count} ${inheritedFields} >>`
	});
	return objects;
}

function beUint(value: number, width: number): Uint8Array {
	const out: Uint8Array = new Uint8Array(width);
	let remaining: number = value;
	for (let index = width - 1; index >= 0; index -= 1) {
		out[index] = remaining & 0xff;
		remaining = Math.floor(remaining / 256);
	}
	return out;
}

/**
 * A minimal cross-reference-stream PDF, objects 0..5 contiguous:
 * 1 catalog, 2 pages, 3 page, 4 object stream (holding object 2, compressed), 5 the xref stream.
 */
function buildXrefStreamPdfImpl(
	compressPages: boolean,
	inflateBombBytes: number | undefined,
	catalogExtra: string | undefined
): Uint8Array {
	const builder = new ByteBuilder().text('%PDF-1.7\n');
	const entries: Map<number, { type: 0 | 1 | 2; field2: number; field3: number }> = new Map();
	entries.set(0, { type: 0, field2: 0, field3: 65535 });

	const catalogOffset: number = builder.offset;
	builder.text(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R${catalogExtra ?? ''} >>\nendobj\n`);
	entries.set(1, { type: 1, field2: catalogOffset, field3: 0 });

	const pagesBody: string = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
	if (compressPages) {
		const header: string = '2 0';
		const raw: Uint8Array = new TextEncoder().encode(`${header}\n${pagesBody}`);
		const first: number = new TextEncoder().encode(`${header}\n`).byteLength;
		const deflated: Uint8Array = deflateSync(raw);
		const objStmOffset: number = builder.offset;
		builder.text(
			`4 0 obj\n<< /Type /ObjStm /N 1 /First ${first} /Filter /FlateDecode /Length ${deflated.byteLength} >>\nstream\n`
		);
		builder.bytes(deflated);
		builder.text('\nendstream\nendobj\n');
		entries.set(2, { type: 2, field2: 4, field3: 0 });
		entries.set(4, { type: 1, field2: objStmOffset, field3: 0 });
	} else {
		const pagesOffset: number = builder.offset;
		builder.text(`2 0 obj\n${pagesBody}\nendobj\n`);
		entries.set(2, { type: 1, field2: pagesOffset, field3: 0 });
	}

	const pageOffset: number = builder.offset;
	builder.text('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>\nendobj\n');
	entries.set(3, { type: 1, field2: pageOffset, field3: 0 });

	const maxObjectNumber: number = 5;
	const size: number = maxObjectNumber + 1;
	// Fill in any unused slots (e.g. object 4 when pages are not compressed) as free.
	for (let n = 0; n < size - 1; n += 1) {
		if (!entries.has(n)) entries.set(n, { type: 0, field2: 0, field3: 0 });
	}

	const xrefStreamOffset: number = builder.offset;
	const widths: readonly [number, number, number] = [1, 4, 2];
	const rows: Uint8Array[] = [];
	for (let n = 0; n < size - 1; n += 1) {
		const entry = entries.get(n) as { type: 0 | 1 | 2; field2: number; field3: number };
		rows.push(beUint(entry.type, widths[0]));
		rows.push(beUint(entry.field2, widths[1]));
		rows.push(beUint(entry.field3, widths[2]));
	}
	// The xref stream object (number = maxObjectNumber) describes itself; its own offset is
	// known here because nothing before it depends on its value.
	rows.push(beUint(1, widths[0]));
	rows.push(beUint(xrefStreamOffset, widths[1]));
	rows.push(beUint(0, widths[2]));
	const rawXref: Uint8Array = new ByteBuilder().bytes(concatRows(rows)).build();
	const inflateBombPayload: Uint8Array | null =
		inflateBombBytes === undefined ? null : new Uint8Array(inflateBombBytes);
	const toDeflate: Uint8Array = inflateBombPayload ?? rawXref;
	const deflatedXref: Uint8Array = deflateSync(toDeflate);
	builder.text(
		`${maxObjectNumber} 0 obj\n<< /Type /XRef /Size ${size} /W [${widths.join(' ')}] /Root 1 0 R /Filter /FlateDecode /Length ${deflatedXref.byteLength} >>\nstream\n`
	);
	builder.bytes(deflatedXref);
	builder.text('\nendstream\nendobj\n');
	builder.text(`startxref\n${xrefStreamOffset}\n%%EOF`);
	return builder.build();
}

function concatRows(rows: readonly Uint8Array[]): Uint8Array {
	const total: number = rows.reduce((sum, row) => sum + row.byteLength, 0);
	const out: Uint8Array = new Uint8Array(total);
	let cursor: number = 0;
	for (const row of rows) {
		out.set(row, cursor);
		cursor += row.byteLength;
	}
	return out;
}

function expectReason(bytes: Uint8Array, reason: PdfPageMetadataReason): void {
	try {
		parsePdfPageMetadata(bytes);
		expect.fail(`expected ${reason} but parsing succeeded`);
	} catch (error: unknown) {
		expect(error).toBeInstanceOf(PdfPageMetadataError);
		expect((error as PdfPageMetadataError).reason).toBe(reason);
	}
}

describe('parsePdfPageMetadata', () => {
	it('reads page count and MediaBox from a real, multi-page generated PDF', () => {
		function document(title: string, markdown: string): AgreementPdfDocument {
			return { title, nodes: renderRecipientMarkdown(markdown).nodes };
		}
		const result = renderAgreementPdf([
			document('First', '# First\n\nShort.\n'),
			document('Second', '# Second\n\nAlso short.\n')
		]);
		const metadata = parsePdfPageMetadata(result.bytes);
		expect(metadata).toEqual({
			pageCount: result.pageCount,
			pageWidth: result.pageWidth,
			pageHeight: result.pageHeight
		});
	});

	it('reads a single-page hand-built classic-xref PDF', () => {
		const bytes = buildClassicPdf(
			[
				{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
				{ num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
				{ num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>' }
			],
			'/Root 1 0 R'
		);
		expect(parsePdfPageMetadata(bytes)).toEqual({ pageCount: 1, pageWidth: 200, pageHeight: 300 });
	});

	it('inherits /MediaBox from the Pages node when the Page omits it', () => {
		const bytes = buildClassicPdf(
			[
				{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
				{ num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 400 600] >>' },
				{ num: 3, body: '<< /Type /Page /Parent 2 0 R >>' }
			],
			'/Root 1 0 R'
		);
		expect(parsePdfPageMetadata(bytes)).toEqual({ pageCount: 1, pageWidth: 400, pageHeight: 600 });
	});

	it('swaps width and height for a 90-degree rotated page', () => {
		const bytes = buildClassicPdf(
			[
				{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
				{ num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
				{
					num: 3,
					body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Rotate 90 >>'
				}
			],
			'/Root 1 0 R'
		);
		expect(parsePdfPageMetadata(bytes)).toEqual({ pageCount: 1, pageWidth: 300, pageHeight: 200 });
	});

	it('inherits /Rotate from the Pages node', () => {
		const bytes = buildClassicPdf(
			[
				{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
				{
					num: 2,
					body: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 200 300] /Rotate 270 >>'
				},
				{ num: 3, body: '<< /Type /Page /Parent 2 0 R >>' }
			],
			'/Root 1 0 R'
		);
		expect(parsePdfPageMetadata(bytes)).toEqual({ pageCount: 1, pageWidth: 300, pageHeight: 200 });
	});

	it('reads a cross-reference-stream PDF with a normal (uncompressed) page tree', () => {
		const bytes = buildXrefStreamPdfImpl(false, undefined, undefined);
		expect(parsePdfPageMetadata(bytes)).toEqual({ pageCount: 1, pageWidth: 200, pageHeight: 300 });
	});

	it('reads a page tree object compressed inside an object stream', () => {
		const bytes = buildXrefStreamPdfImpl(true, undefined, undefined);
		expect(parsePdfPageMetadata(bytes)).toEqual({ pageCount: 1, pageWidth: 200, pageHeight: 300 });
	});

	it('rejects a PDF with no %PDF header', () => {
		expectReason(new TextEncoder().encode('not a pdf at all'), 'invalid_header');
	});

	it('rejects a PDF whose trailer is missing /Root', () => {
		const bytes = buildClassicPdf(
			[
				{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
				{ num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
				{ num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>' }
			],
			''
		);
		expectReason(bytes, 'damaged_xref');
	});

	it('rejects an encrypted PDF', () => {
		const bytes = buildClassicPdf(
			[
				{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
				{ num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
				{ num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>' }
			],
			'/Root 1 0 R /Encrypt 99 0 R'
		);
		expectReason(bytes, 'encrypted');
	});

	it('rejects a PDF whose page tree has zero pages', () => {
		const bytes = buildClassicPdf(
			[
				{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
				{ num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' }
			],
			'/Root 1 0 R'
		);
		expectReason(bytes, 'zero_pages');
	});

	it('rejects a PDF with more than the supported page count', () => {
		const objects = pageTreeObjects(MAX_UPLOADED_PDF_PAGES + 1, '/MediaBox [0 0 200 300]');
		const bytes = buildClassicPdf(objects, '/Root 1 0 R');
		expectReason(bytes, 'too_many_pages');
	});

	it('rejects a page with an oversized dimension', () => {
		const bytes = buildClassicPdf(
			[
				{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
				{ num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
				{ num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 20001 300] >>' }
			],
			'/Root 1 0 R'
		);
		expectReason(bytes, 'oversized_page');
	});

	it('rejects a self-referencing xref /Prev cycle', () => {
		expectReason(buildSelfPrevPdfFixed(), 'prev_cycle');
	});

	it('rejects a page-tree /Kids cycle', () => {
		const bytes = buildClassicPdf(
			[
				{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
				{ num: 2, body: '<< /Type /Pages /Kids [2 0 R] /Count 1 /MediaBox [0 0 200 300] >>' }
			],
			'/Root 1 0 R'
		);
		expectReason(bytes, 'page_tree_cycle');
	});

	it('rejects a page tree deeper than the supported depth', () => {
		const objects: ObjectSpec[] = [{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' }];
		const depth: number = MAX_PDF_PAGE_TREE_DEPTH + 2;
		for (let level = 0; level < depth; level += 1) {
			const selfNum: number = 2 + level;
			const childNum: number = level === depth - 1 ? 1000 : selfNum + 1;
			objects.push({ num: selfNum, body: `<< /Type /Pages /Kids [${childNum} 0 R] /Count 1 >>` });
		}
		objects.push({
			num: 1000,
			body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>'
		});
		const bytes = buildClassicPdf(objects, '/Root 1 0 R');
		expectReason(bytes, 'page_tree_too_deep');
	});

	it('rejects a page tree that exceeds the node budget', () => {
		const dummyNum: number = 3;
		const kids: string = Array.from(
			{ length: MAX_PDF_NODE_BUDGET + 2 },
			() => `${dummyNum} 0 R`
		).join(' ');
		const bytes = buildClassicPdf(
			[
				{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
				{
					num: 2,
					body: `<< /Type /Pages /Kids [${kids}] /Count 0 /MediaBox [0 0 200 300] >>`
				},
				{ num: dummyNum, body: '<< /Type /Pages >>' }
			],
			'/Root 1 0 R'
		);
		expectReason(bytes, 'node_budget_exceeded');
	});

	it('rejects an xref stream whose inflated payload exceeds the decode budget', () => {
		const bytes = buildXrefStreamPdfImpl(false, 33 * 1024 * 1024, undefined);
		expectReason(bytes, 'inflate_bomb');
	});

	it('rejects deeply nested dictionary/array literals', () => {
		const nesting: number = 100;
		const open: string = '<< /A '.repeat(nesting);
		const close: string = ' >>'.repeat(nesting);
		const bytes = buildClassicPdf(
			[
				{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
				{ num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
				{
					num: 3,
					body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /X ${open}1${close} >>`
				}
			],
			'/Root 1 0 R'
		);
		expectReason(bytes, 'nesting_overflow');
	});

	it('rejects a catalog carrying /OpenAction', () => {
		const bytes = buildXrefStreamPdfImpl(false, undefined, ' /OpenAction 99 0 R');
		expectReason(bytes, 'active_content_open_action');
	});

	it('rejects a catalog carrying additional actions (/AA)', () => {
		const bytes = buildXrefStreamPdfImpl(false, undefined, ' /AA << /WC 99 0 R >>');
		expectReason(bytes, 'active_content_aa');
	});

	it('rejects a catalog carrying /Names /JavaScript', () => {
		const bytes = buildClassicPdf(
			[
				{
					num: 1,
					body: '<< /Type /Catalog /Pages 2 0 R /Names << /JavaScript 4 0 R >> >>'
				},
				{ num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
				{ num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>' },
				{ num: 4, body: '<< /Names [] >>' }
			],
			'/Root 1 0 R'
		);
		expectReason(bytes, 'active_content_javascript');
	});

	it('rejects a catalog carrying /Names /EmbeddedFiles', () => {
		const bytes = buildClassicPdf(
			[
				{
					num: 1,
					body: '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles 4 0 R >> >>'
				},
				{ num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
				{ num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>' },
				{ num: 4, body: '<< /Names [] >>' }
			],
			'/Root 1 0 R'
		);
		expectReason(bytes, 'active_content_embedded_files');
	});

	it('rejects an xref /Prev chain longer than supported', () => {
		const bytes = buildLongPrevChain(MAX_PDF_PREV_CHAIN + 1);
		expectReason(bytes, 'prev_chain_too_long');
	});

	describe('recursive active-content rejection', () => {
		it('rejects a catalog carrying /AcroForm, which also covers nested /XFA', () => {
			const bytes = buildClassicPdf(
				[
					{
						num: 1,
						body: '<< /Type /Catalog /Pages 2 0 R ' + '/AcroForm << /Fields [] /XFA 4 0 R >> >>'
					},
					{ num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
					{ num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>' },
					{ num: 4, body: '<< /Length 0 >>\nstream\n\nendstream' }
				],
				'/Root 1 0 R'
			);
			expectReason(bytes, 'active_content_acroform');
		});

		it('rejects a page carrying additional actions (/AA)', () => {
			const bytes = buildClassicPdf(
				[
					{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
					{ num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
					{
						num: 3,
						body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /AA << /O 4 0 R >> >>'
					},
					{ num: 4, body: '<< /S /JavaScript /JS (app.alert(1)) >>' }
				],
				'/Root 1 0 R'
			);
			expectReason(bytes, 'active_content_page_aa');
		});

		it('rejects an annotation carrying additional actions (/AA)', () => {
			const bytes = buildClassicPdf(
				[
					{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
					{ num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
					{
						num: 3,
						body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [4 0 R] >>'
					},
					{
						num: 4,
						body: '<< /Type /Annot /Subtype /Widget /Rect [0 0 1 1] /AA << /Fo 5 0 R >> >>'
					},
					{ num: 5, body: '<< /S /JavaScript /JS (app.alert(1)) >>' }
				],
				'/Root 1 0 R'
			);
			// The /Widget subtype alone would already fail closed; /AA is checked
			// first, so this specifically exercises the annotation-AA path.
			expectReason(bytes, 'active_content_annotation_aa');
		});

		it.each(['RichMedia', 'FileAttachment', 'Screen', '3D', 'Widget', 'Sound', 'Movie'])(
			'rejects a /%s annotation regardless of whether it names an action',
			(subtype) => {
				const bytes = buildClassicPdf(
					[
						{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
						{ num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
						{
							num: 3,
							body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [4 0 R] >>'
						},
						{ num: 4, body: `<< /Type /Annot /Subtype /${subtype} /Rect [0 0 1 1] >>` }
					],
					'/Root 1 0 R'
				);
				expectReason(bytes, 'active_content_annotation_type');
			}
		);

		it.each(['Launch', 'JavaScript', 'SubmitForm', 'GoToR', 'ImportData', 'Named'])(
			'rejects a /%s annotation action',
			(actionSubtype) => {
				const bytes = buildClassicPdf(
					[
						{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
						{ num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
						{
							num: 3,
							body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [4 0 R] >>'
						},
						{
							num: 4,
							body: `<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /A << /S /${actionSubtype} >> >>`
						}
					],
					'/Root 1 0 R'
				);
				expectReason(bytes, 'active_content_action');
			}
		);

		it('rejects a disallowed action reached through a /Next action chain', () => {
			const bytes = buildClassicPdf(
				[
					{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
					{ num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
					{
						num: 3,
						body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [4 0 R] >>'
					},
					{
						num: 4,
						body: '<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /A << /S /URI /URI (https://example.com) /Next 5 0 R >> >>'
					},
					{ num: 5, body: '<< /S /Launch /F (calc.exe) >>' }
				],
				'/Root 1 0 R'
			);
			expectReason(bytes, 'active_content_action');
		});

		it('rejects an action chain longer than supported, whether or not it cycles', () => {
			const objects: ObjectSpec[] = [
				{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
				{ num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' }
			];
			// A cyclic /Next chain: each cheap node only costs one traversal
			// step, so this also proves the chain is bounded by an explicit
			// depth limit rather than relying solely on cycle detection.
			objects.push({
				num: 4,
				body: '<< /S /GoTo /D (page1) /Next 5 0 R >>'
			});
			objects.push({
				num: 5,
				body: '<< /S /GoTo /D (page1) /Next 4 0 R >>'
			});
			objects.push({
				num: 3,
				body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [6 0 R] >>'
			});
			objects.push({
				num: 6,
				body: '<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /A 4 0 R >>'
			});
			const bytes = buildClassicPdf(objects, '/Root 1 0 R');
			expectReason(bytes, 'active_content_action');
		});

		it('accepts a passive /URI and /GoTo Link annotation and a markup annotation with no action', () => {
			const bytes = buildClassicPdf(
				[
					{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
					{ num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
					{
						num: 3,
						body:
							'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] ' +
							'/Annots [4 0 R 5 0 R 6 0 R] >>'
					},
					{
						num: 4,
						body: '<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /A << /S /URI /URI (https://example.com) >> >>'
					},
					{
						num: 5,
						body: '<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /A << /S /GoTo /D (page1) >> >>'
					},
					{ num: 6, body: '<< /Type /Annot /Subtype /Text /Rect [0 0 1 1] /Contents (hi) >>' }
				],
				'/Root 1 0 R'
			);
			expect(parsePdfPageMetadata(bytes)).toEqual({
				pageCount: 1,
				pageWidth: 200,
				pageHeight: 300
			});
		});

		it('rejects an active-content annotation reached through an object stream', () => {
			const bytes = buildXrefStreamPdfWithCompressedAnnotation(
				'<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /A << /S /Launch /F (calc.exe) >> >>'
			);
			expectReason(bytes, 'active_content_action');
		});

		it('accepts a passive annotation reached through an object stream', () => {
			const bytes = buildXrefStreamPdfWithCompressedAnnotation(
				'<< /Type /Annot /Subtype /Text /Rect [0 0 1 1] /Contents (hi) >>'
			);
			expect(parsePdfPageMetadata(bytes)).toEqual({
				pageCount: 1,
				pageWidth: 200,
				pageHeight: 300
			});
		});
	});
});

function buildSelfPrevPdfFixed(): Uint8Array {
	const builder = new ByteBuilder().text('%PDF-1.7\n');
	const catalogOffset: number = builder.offset;
	builder.text('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
	const pagesOffset: number = builder.offset;
	builder.text('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
	const pageOffset: number = builder.offset;
	builder.text('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>\nendobj\n');
	const xrefOffset: number = builder.offset;
	builder.text(
		'xref\n0 4\n' +
			'0000000000 65535 f \n' +
			`${String(catalogOffset).padStart(10, '0')} 00000 n \n` +
			`${String(pagesOffset).padStart(10, '0')} 00000 n \n` +
			`${String(pageOffset).padStart(10, '0')} 00000 n \n`
	);
	// A trailer whose own /Prev points back at this very xref section's own start offset:
	// the chain loader visits `xrefOffset` once, follows /Prev to `xrefOffset` again, and
	// detects the revisit.
	builder.text(`trailer\n<< /Size 4 /Root 1 0 R /Prev ${xrefOffset} >>\n`);
	builder.text(`startxref\n${xrefOffset}\n%%EOF`);
	return builder.build();
}

/**
 * A single-page cross-reference-stream PDF whose page carries one `/Annots`
 * entry pointing at `annotationBody`, compressed inside an object stream
 * (object 5) rather than stored as a plain indirect object -- exercising
 * that the active-content walk resolves refs through `#loadCompressedObject`
 * the same way it resolves classic indirect objects.
 */
function buildXrefStreamPdfWithCompressedAnnotation(annotationBody: string): Uint8Array {
	const builder = new ByteBuilder().text('%PDF-1.7\n');
	const entries: Map<number, { type: 0 | 1 | 2; field2: number; field3: number }> = new Map();
	entries.set(0, { type: 0, field2: 0, field3: 65535 });

	const catalogOffset: number = builder.offset;
	builder.text('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
	entries.set(1, { type: 1, field2: catalogOffset, field3: 0 });

	const pagesOffset: number = builder.offset;
	builder.text('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
	entries.set(2, { type: 1, field2: pagesOffset, field3: 0 });

	const pageOffset: number = builder.offset;
	builder.text(
		'3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [4 0 R] >>\nendobj\n'
	);
	entries.set(3, { type: 1, field2: pageOffset, field3: 0 });

	const header: string = '4 0';
	const raw: Uint8Array = new TextEncoder().encode(`${header}\n${annotationBody}`);
	const first: number = new TextEncoder().encode(`${header}\n`).byteLength;
	const deflated: Uint8Array = deflateSync(raw);
	const objStmOffset: number = builder.offset;
	builder.text(
		`5 0 obj\n<< /Type /ObjStm /N 1 /First ${first} /Filter /FlateDecode /Length ${deflated.byteLength} >>\nstream\n`
	);
	builder.bytes(deflated);
	builder.text('\nendstream\nendobj\n');
	entries.set(4, { type: 2, field2: 5, field3: 0 });
	entries.set(5, { type: 1, field2: objStmOffset, field3: 0 });

	const maxObjectNumber: number = 6;
	const size: number = maxObjectNumber + 1;
	for (let n = 0; n < size - 1; n += 1) {
		if (!entries.has(n)) entries.set(n, { type: 0, field2: 0, field3: 0 });
	}

	const xrefStreamOffset: number = builder.offset;
	const widths: readonly [number, number, number] = [1, 4, 2];
	const rows: Uint8Array[] = [];
	for (let n = 0; n < size - 1; n += 1) {
		const entry = entries.get(n) as { type: 0 | 1 | 2; field2: number; field3: number };
		rows.push(beUint(entry.type, widths[0]));
		rows.push(beUint(entry.field2, widths[1]));
		rows.push(beUint(entry.field3, widths[2]));
	}
	rows.push(beUint(1, widths[0]));
	rows.push(beUint(xrefStreamOffset, widths[1]));
	rows.push(beUint(0, widths[2]));
	const rawXref: Uint8Array = new ByteBuilder().bytes(concatRows(rows)).build();
	const deflatedXref: Uint8Array = deflateSync(rawXref);
	builder.text(
		`${maxObjectNumber} 0 obj\n<< /Type /XRef /Size ${size} /W [${widths.join(' ')}] /Root 1 0 R /Filter /FlateDecode /Length ${deflatedXref.byteLength} >>\nstream\n`
	);
	builder.bytes(deflatedXref);
	builder.text('\nendstream\nendobj\n');
	builder.text(`startxref\n${xrefStreamOffset}\n%%EOF`);
	return builder.build();
}

function buildLongPrevChain(chainLength: number): Uint8Array {
	const builder = new ByteBuilder().text('%PDF-1.7\n');
	const catalogOffset: number = builder.offset;
	builder.text('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
	const pagesOffset: number = builder.offset;
	builder.text('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
	const pageOffset: number = builder.offset;
	builder.text('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>\nendobj\n');

	// Every trailer needs a /Root, even the trivial older links: #trailerFromDict validates
	// its presence unconditionally, though only the newest (first-processed) section's /Root
	// is ever actually used.
	let previousOffset: number | null = null;
	for (let step = 0; step < chainLength - 1; step += 1) {
		const offset: number = builder.offset;
		builder.text('xref\n0 1\n0000000000 65535 f \n');
		const prevField: string = previousOffset === null ? '' : ` /Prev ${previousOffset}`;
		builder.text(`trailer\n<< /Size 1 /Root 1 0 R${prevField} >>\n`);
		previousOffset = offset;
	}

	// The newest section, found via startxref, carries the real objects and is processed first.
	const newestOffset: number = builder.offset;
	builder.text(
		'xref\n0 4\n' +
			'0000000000 65535 f \n' +
			`${String(catalogOffset).padStart(10, '0')} 00000 n \n` +
			`${String(pagesOffset).padStart(10, '0')} 00000 n \n` +
			`${String(pageOffset).padStart(10, '0')} 00000 n \n`
	);
	const prevField: string = previousOffset === null ? '' : ` /Prev ${previousOffset}`;
	builder.text(`trailer\n<< /Size 4 /Root 1 0 R${prevField} >>\n`);
	builder.text(`startxref\n${newestOffset}\n%%EOF`);
	return builder.build();
}
