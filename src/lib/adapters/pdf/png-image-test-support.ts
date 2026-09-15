import { zlibSync } from 'fflate';

/**
 * A minimal, spec-correct PNG encoder for tests.
 *
 * Drawn signatures reach production as canvas exports, which no test can
 * produce; hand-writing chunk bytes in every spec would bury what each test is
 * actually proving. This writes real PNGs (correct CRCs included) so the
 * decoder and the executed-PDF compositor are exercised against the same shape
 * a browser emits.
 */

export interface TestPngInput {
	width: number;
	height: number;
	/** 0 gray, 2 RGB, 3 palette, 4 gray+alpha, 6 RGBA. */
	colorType: 0 | 2 | 3 | 4 | 6;
	bitDepth?: 1 | 2 | 4 | 8 | 16;
	/** Raw samples in scanline order, already at `bitDepth` packing for depths below 8. */
	samples: Uint8Array;
	palette?: Uint8Array;
	transparency?: Uint8Array;
	/** PNG filter type applied to every scanline. Defaults to 0 (None). */
	filterType?: 0 | 1 | 2 | 3 | 4;
	interlace?: 0 | 1;
}

export function encodeTestPng(input: TestPngInput): Uint8Array {
	const bitDepth: number = input.bitDepth ?? 8;
	const channels: number =
		input.colorType === 0 || input.colorType === 3
			? 1
			: input.colorType === 2
				? 3
				: input.colorType === 4
					? 2
					: 4;
	const rowBytes: number = Math.ceil((input.width * channels * bitDepth) / 8);
	const bytesPerPixel: number = Math.max(1, Math.ceil((channels * bitDepth) / 8));
	const filterType: number = input.filterType ?? 0;
	const rows: Uint8Array = new Uint8Array((rowBytes + 1) * input.height);
	for (let row: number = 0; row < input.height; row += 1) {
		rows[row * (rowBytes + 1)] = filterType;
		for (let index: number = 0; index < rowBytes; index += 1) {
			const raw = (r: number, i: number): number =>
				r < 0 || i < 0 ? 0 : (input.samples[r * rowBytes + i] ?? 0);
			const value: number = raw(row, index);
			const left: number = index >= bytesPerPixel ? raw(row, index - bytesPerPixel) : 0;
			const up: number = raw(row - 1, index);
			const upLeft: number = index >= bytesPerPixel ? raw(row - 1, index - bytesPerPixel) : 0;
			rows[row * (rowBytes + 1) + 1 + index] =
				(value - predictor(filterType, left, up, upLeft)) & 0xff;
		}
	}

	return encodePngChunks(input, bitDepth, rows);
}

/**
 * Builds an intentionally malformed fixture whose zlib stream does not match
 * the IHDR-derived scanline length. This exercises bounded inflate handling
 * without relying on a corrupted zlib wrapper.
 */
export function encodeTestPngWithInflatedScanlines(
	input: TestPngInput,
	inflatedScanlines: Uint8Array
): Uint8Array {
	const bitDepth: number = input.bitDepth ?? 8;
	return encodePngChunks(input, bitDepth, inflatedScanlines);
}

function encodePngChunks(
	input: TestPngInput,
	bitDepth: number,
	inflatedScanlines: Uint8Array
): Uint8Array {
	const header: Uint8Array = new Uint8Array(13);
	writeUint32(header, 0, input.width);
	writeUint32(header, 4, input.height);
	header[8] = bitDepth;
	header[9] = input.colorType;
	header[12] = input.interlace ?? 0;

	const chunks: Uint8Array[] = [
		Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header)
	];
	if (input.palette !== undefined) chunks.push(chunk('PLTE', input.palette));
	if (input.transparency !== undefined) chunks.push(chunk('tRNS', input.transparency));
	chunks.push(chunk('IDAT', zlibSync(inflatedScanlines, { level: 6 })));
	chunks.push(chunk('IEND', new Uint8Array(0)));
	return concat(chunks);
}

/** A small opaque-ink signature scribble on a transparent background. */
export function drawnSignaturePng(width: number = 24, height: number = 12): Uint8Array {
	const samples: Uint8Array = new Uint8Array(width * height * 4);
	for (let row: number = 0; row < height; row += 1) {
		for (let column: number = 0; column < width; column += 1) {
			const offset: number = (row * width + column) * 4;
			const onStroke: boolean = Math.abs(row - Math.floor((column * height) / width)) <= 1;
			samples[offset] = 20;
			samples[offset + 1] = 20;
			samples[offset + 2] = 40;
			samples[offset + 3] = onStroke ? 255 : 0;
		}
	}
	return encodeTestPng({ width, height, colorType: 6, samples });
}

/** The value each PNG filter subtracts; the decoder must add exactly this back. */
function predictor(filterType: number, left: number, up: number, upLeft: number): number {
	if (filterType === 1) return left;
	if (filterType === 2) return up;
	if (filterType === 3) return (left + up) >> 1;
	if (filterType === 4) {
		const estimate: number = left + up - upLeft;
		const distanceLeft: number = Math.abs(estimate - left);
		const distanceUp: number = Math.abs(estimate - up);
		const distanceUpLeft: number = Math.abs(estimate - upLeft);
		if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
		if (distanceUp <= distanceUpLeft) return up;
		return upLeft;
	}
	return 0;
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
	const out: Uint8Array = new Uint8Array(payload.byteLength + 12);
	writeUint32(out, 0, payload.byteLength);
	for (let index: number = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
	out.set(payload, 8);
	writeUint32(out, payload.byteLength + 8, crc32(out.subarray(4, payload.byteLength + 8)));
	return out;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
	let total: number = 0;
	for (const part of chunks) total += part.byteLength;
	const out: Uint8Array = new Uint8Array(total);
	let offset: number = 0;
	for (const part of chunks) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
	target[offset] = (value >>> 24) & 0xff;
	target[offset + 1] = (value >>> 16) & 0xff;
	target[offset + 2] = (value >>> 8) & 0xff;
	target[offset + 3] = value & 0xff;
}

const CRC_TABLE: Uint32Array = ((): Uint32Array => {
	const table: Uint32Array = new Uint32Array(256);
	for (let index: number = 0; index < 256; index += 1) {
		let value: number = index;
		for (let bit: number = 0; bit < 8; bit += 1) {
			value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let crc: number = 0xffffffff;
	for (let index: number = 0; index < bytes.byteLength; index += 1) {
		crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
