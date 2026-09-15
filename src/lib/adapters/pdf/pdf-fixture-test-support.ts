/**
 * Hand-built PDFs for tests that need a document SignKit did not render
 * itself — an uploaded original, a rotated page, a non-zero MediaBox origin.
 * Lengths, offsets, and the xref table are computed, so a fixture stays valid
 * when its content changes.
 */

export interface FixturePage {
	/** Defaults to US Letter at the origin. */
	mediaBox?: readonly [number, number, number, number];
	rotate?: number;
	/** Content stream operators; a Helvetica resource is always available as `/F1`. */
	content: string;
}

export function buildFixturePdf(pages: readonly FixturePage[]): Uint8Array {
	const bodies: string[] = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'',
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
	];
	const pageIds: number[] = [];
	pages.forEach((page: FixturePage): void => {
		const contentId: number = bodies.length + 2;
		const pageId: number = bodies.length + 1;
		const box: readonly [number, number, number, number] = page.mediaBox ?? [0, 0, 612, 792];
		bodies.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [${box.join(' ')}]` +
				(page.rotate === undefined ? '' : ` /Rotate ${page.rotate}`) +
				` /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`
		);
		bodies.push(`<< /Length ${byteLength(page.content)} >>\nstream\n${page.content}\nendstream`);
		pageIds.push(pageId);
	});
	bodies[1] = `<< /Type /Pages /Kids [${pageIds.map((id: number): string => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

	let out: string = '%PDF-1.7\n';
	const offsets: number[] = [];
	bodies.forEach((body: string, index: number): void => {
		offsets.push(byteLength(out));
		out += `${index + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xrefOffset: number = byteLength(out);
	out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
	out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
	return new TextEncoder().encode(out);
}

/** A page whose only content is one line of text near its top. */
export function textPage(text: string, overrides: Omit<FixturePage, 'content'> = {}): FixturePage {
	return { ...overrides, content: `BT /F1 12 Tf 72 700 Td (${text}) Tj ET` };
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}
