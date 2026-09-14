#!/usr/bin/env node
/**
 * Regenerates `src/lib/adapters/pdf/fonts/document-font.ts` from an
 * OFL-licensed source TrueType font.
 *
 * SignKit renders the recipient-facing agreement PDF itself, so the glyphs it
 * needs have to travel inside the deployment bundle: Workers has no font
 * service, and fetching a typeface from another origin while a recipient is
 * reading their agreement is exactly the disclosure we refuse to make. The
 * committed module is therefore the gzipped font, base64-encoded, which every
 * deployment target (Cloudflare, Node, Vercel) can import identically.
 *
 * Only the tables the PDF embedder actually consumes are kept, and `post` is
 * rewritten to format 3 (no glyph names), because nothing downstream resolves
 * a glyph by name. Layout tables (GSUB/GPOS/GDEF/BASE) are dropped: the
 * renderer does not do shaping, and Japanese/Latin agreement text does not
 * need it.
 *
 * Usage:
 *   node scripts/build-pdf-font.mjs <path-to-source.ttf>
 *
 * The source used for the committed artifact is Zen Kaku Gothic New Regular
 * (SIL Open Font License 1.1, see fonts/OFL.txt), from
 * https://github.com/google/fonts/tree/main/ofl/zenkakugothicnew
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const KEPT_TABLES = new Set([
	'OS/2',
	'cmap',
	'glyf',
	'head',
	'hhea',
	'hmtx',
	'loca',
	'maxp',
	'name'
]);
const OUTPUT_PATH = new URL('../src/lib/adapters/pdf/fonts/document-font.ts', import.meta.url);
const BASE64_LINE_LENGTH = 120;

function main() {
	const sourcePath = process.argv[2];
	if (sourcePath === undefined) {
		console.error('usage: node scripts/build-pdf-font.mjs <path-to-source.ttf>');
		process.exit(2);
	}
	const source = readFileSync(sourcePath);
	const sourceSha256 = createHash('sha256').update(source).digest('hex');
	const stripped = stripTables(source);
	const compressed = gzipSync(stripped, { level: 9 });
	const strippedSha256 = createHash('sha256').update(stripped).digest('hex');

	const base64 = compressed.toString('base64');
	const lines = [];
	for (let offset = 0; offset < base64.length; offset += BASE64_LINE_LENGTH) {
		lines.push(`\t'${base64.slice(offset, offset + BASE64_LINE_LENGTH)}'`);
	}

	const module = `// GENERATED FILE -- do not edit by hand.
// Regenerate with: node scripts/build-pdf-font.mjs <path-to-source.ttf>
//
// Zen Kaku Gothic New Regular, (c) 2022 The Zen Kaku Gothic Project Authors,
// licensed under the SIL Open Font License 1.1. The full license text ships
// beside this file as OFL.txt and is reproduced in THIRD_PARTY_NOTICES.md.
//
// The bytes below are the gzip of a table-stripped copy of that font: only
// OS/2, cmap, glyf, head, hhea, hmtx, loca, maxp, name, and a format-3 post
// are retained, which is exactly what the PDF embedder reads.

/** SHA-256 of the upstream source font this artifact was derived from. */
export const DOCUMENT_FONT_SOURCE_SHA256: string =
	'${sourceSha256}';

/** SHA-256 of the decompressed, table-stripped font these bytes decode to. */
export const DOCUMENT_FONT_SHA256: string =
	'${strippedSha256}';

/** Byte length of the decompressed font, used to size the inflate buffer. */
export const DOCUMENT_FONT_BYTE_LENGTH: number = ${stripped.length};

/** gzip(font) as base64. Decoded and inflated once per isolate on first use. */
export const DOCUMENT_FONT_GZIP_BASE64: string = [
${lines.join(',\n')}
].join('');
`;
	writeFileSync(OUTPUT_PATH, module);
	console.log(
		`wrote ${OUTPUT_PATH.pathname}: source=${source.length}B stripped=${stripped.length}B gzip=${compressed.length}B base64=${base64.length}B`
	);
}

function stripTables(source) {
	const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
	if (view.getUint32(0) !== 0x00010000) {
		throw new Error('source must be a glyf-based TrueType font (sfnt version 1.0)');
	}
	const tableCount = view.getUint16(4);
	const kept = [];
	for (let index = 0; index < tableCount; index += 1) {
		const record = 12 + index * 16;
		const tag = String.fromCharCode(
			source[record],
			source[record + 1],
			source[record + 2],
			source[record + 3]
		);
		if (!KEPT_TABLES.has(tag)) continue;
		const offset = view.getUint32(record + 8);
		const length = view.getUint32(record + 12);
		kept.push({ tag, data: source.subarray(offset, offset + length) });
	}
	for (const tag of KEPT_TABLES) {
		if (!kept.some((table) => table.tag === tag)) throw new Error(`source is missing ${tag}`);
	}
	// Format 3 post: version 3.0, no glyph-name array.
	const post = Buffer.alloc(32);
	post.writeUInt32BE(0x00030000, 0);
	kept.push({ tag: 'post', data: post });
	kept.sort((left, right) => (left.tag < right.tag ? -1 : 1));

	let size = 12 + kept.length * 16;
	const offsets = [];
	for (const table of kept) {
		offsets.push(size);
		size += (table.data.length + 3) & ~3;
	}
	const out = Buffer.alloc(size);
	out.writeUInt32BE(0x00010000, 0);
	out.writeUInt16BE(kept.length, 4);
	const entrySelector = Math.floor(Math.log2(kept.length));
	out.writeUInt16BE(16 * 2 ** entrySelector, 6);
	out.writeUInt16BE(entrySelector, 8);
	out.writeUInt16BE(kept.length * 16 - 16 * 2 ** entrySelector, 10);
	kept.forEach((table, index) => {
		const record = 12 + index * 16;
		out.write(table.tag.padEnd(4), record, 'latin1');
		out.writeUInt32BE(checksum(table.data), record + 4);
		out.writeUInt32BE(offsets[index], record + 8);
		out.writeUInt32BE(table.data.length, record + 12);
		Buffer.from(table.data).copy(out, offsets[index]);
	});
	return out;
}

function checksum(data) {
	let sum = 0;
	for (let offset = 0; offset < data.length; offset += 4) {
		const word =
			((data[offset] ?? 0) << 24) |
			((data[offset + 1] ?? 0) << 16) |
			((data[offset + 2] ?? 0) << 8) |
			(data[offset + 3] ?? 0);
		sum = (sum + word) >>> 0;
	}
	return sum;
}

main();
