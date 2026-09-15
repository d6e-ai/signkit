import { unzlibSync } from 'fflate';

/**
 * Bounded PNG decoder for compositing a drawn signature into a PDF.
 *
 * PDF has no PNG filter: an image has to be handed to the writer as raw
 * samples plus, for transparency, a separate soft-mask channel. A drawn
 * signature is a small, transparent-background raster, so the decode budget
 * here is deliberately tight — a signature is a line drawing, not a
 * photograph.
 *
 * Interlaced images are rejected rather than de-interlaced: nothing SignKit
 * produces is interlaced, and Adam7 would double this module's size for an
 * input that never legitimately appears.
 *
 * The decoder is a pure function of its input, so the same asset always
 * composites to the same bytes.
 */

export const MAX_PNG_DIMENSION: number = 4_096;
export const MAX_PNG_PIXELS: number = 4_000_000;
/** Ceiling on inflated raw scanline bytes, above the worst case for {@link MAX_PNG_PIXELS} at 16-bit RGBA. */
export const MAX_PNG_INFLATE_BYTES: number = 40 * 1024 * 1024;

export type PngDecodeReason =
	| 'invalid_signature'
	| 'damaged_chunk'
	| 'unsupported_color_type'
	| 'unsupported_bit_depth'
	| 'interlaced'
	| 'oversized'
	| 'missing_palette'
	| 'damaged_image_data';

export class PngDecodeError extends Error {
	readonly code = 'PNG_DECODE_ERROR';

	constructor(
		readonly reason: PngDecodeReason,
		message: string,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = 'PngDecodeError';
	}
}

export interface DecodedPngImage {
	width: number;
	height: number;
	/** One sample per pixel for `gray`, three for `rgb`. Always 8 bits per sample. */
	colorSpace: 'gray' | 'rgb';
	samples: Uint8Array;
	/** One 8-bit opacity sample per pixel, or `null` when the image is fully opaque. */
	alpha: Uint8Array | null;
}

const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface PngHeader {
	width: number;
	height: number;
	bitDepth: number;
	colorType: number;
}

export function isPngSignature(bytes: Uint8Array): boolean {
	if (bytes.byteLength < PNG_SIGNATURE.length) return false;
	return PNG_SIGNATURE.every(
		(expected: number, index: number): boolean => bytes[index] === expected
	);
}

export function decodePng(bytes: Uint8Array): DecodedPngImage {
	if (!isPngSignature(bytes)) throw fail('invalid_signature', 'PNG signature is missing');
	let header: PngHeader | null = null;
	let palette: Uint8Array | null = null;
	let transparency: Uint8Array | null = null;
	const data: Uint8Array[] = [];
	let compressedBytes: number = 0;
	let cursor: number = PNG_SIGNATURE.length;

	while (cursor + 8 <= bytes.byteLength) {
		const length: number = readUint32(bytes, cursor);
		const type: string = latin1(bytes.subarray(cursor + 4, cursor + 8));
		const start: number = cursor + 8;
		// Every chunk carries a trailing CRC we do not verify: the asset's own
		// SHA-256 is checked against its content-addressed reference before the
		// bytes ever reach this decoder, which is a stronger guarantee.
		if (length > bytes.byteLength || start + length + 4 > bytes.byteLength) {
			throw fail('damaged_chunk', 'PNG chunk runs past the end of the file');
		}
		const payload: Uint8Array = bytes.subarray(start, start + length);
		if (type === 'IHDR') {
			header = parseHeader(payload);
		} else if (type === 'PLTE') {
			if (payload.byteLength % 3 !== 0) throw fail('damaged_chunk', 'PNG palette is damaged');
			palette = payload;
		} else if (type === 'tRNS') {
			transparency = payload;
		} else if (type === 'IDAT') {
			compressedBytes += payload.byteLength;
			if (compressedBytes > MAX_PNG_INFLATE_BYTES) {
				throw fail('oversized', 'PNG image data exceeds the decode budget');
			}
			data.push(payload);
		} else if (type === 'IEND') {
			break;
		}
		cursor = start + length + 4;
	}

	if (header === null) throw fail('damaged_chunk', 'PNG is missing its IHDR chunk');
	if (data.length === 0) throw fail('damaged_image_data', 'PNG has no image data');
	if (header.colorType === 3 && palette === null) {
		throw fail('missing_palette', 'PNG palette image has no palette');
	}
	const raw: Uint8Array = inflateImageData(data);
	const scanlines: Uint8Array = unfilter(raw, header);
	return toSamples(header, scanlines, palette, transparency);
}

function parseHeader(payload: Uint8Array): PngHeader {
	if (payload.byteLength < 13) throw fail('damaged_chunk', 'PNG IHDR chunk is truncated');
	const width: number = readUint32(payload, 0);
	const height: number = readUint32(payload, 4);
	const bitDepth: number = payload[8];
	const colorType: number = payload[9];
	const compression: number = payload[10];
	const filter: number = payload[11];
	const interlace: number = payload[12];
	if (width < 1 || height < 1 || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION) {
		throw fail('oversized', 'PNG dimensions are outside the supported range');
	}
	if (width * height > MAX_PNG_PIXELS) {
		throw fail('oversized', 'PNG pixel count exceeds the decode budget');
	}
	if (compression !== 0 || filter !== 0) {
		throw fail('damaged_chunk', 'PNG uses an unsupported compression or filter method');
	}
	if (interlace !== 0) throw fail('interlaced', 'Interlaced PNGs are not supported');
	if (![0, 2, 3, 4, 6].includes(colorType)) {
		throw fail('unsupported_color_type', 'PNG color type is not supported');
	}
	if (!allowedBitDepths(colorType).includes(bitDepth)) {
		throw fail('unsupported_bit_depth', 'PNG bit depth is not supported for this color type');
	}
	return { width, height, bitDepth, colorType };
}

function allowedBitDepths(colorType: number): readonly number[] {
	if (colorType === 0) return [1, 2, 4, 8, 16];
	if (colorType === 3) return [1, 2, 4, 8];
	return [8, 16];
}

function inflateImageData(chunks: readonly Uint8Array[]): Uint8Array {
	let total: number = 0;
	for (const chunk of chunks) total += chunk.byteLength;
	const joined: Uint8Array = new Uint8Array(total);
	let offset: number = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let inflated: Uint8Array;
	try {
		inflated = unzlibSync(joined);
	} catch (error: unknown) {
		throw new PngDecodeError('damaged_image_data', 'PNG image data is damaged', { cause: error });
	}
	if (inflated.byteLength > MAX_PNG_INFLATE_BYTES) {
		throw fail('oversized', 'PNG image data exceeds the decode budget');
	}
	return inflated;
}

function channelsFor(colorType: number): number {
	if (colorType === 0 || colorType === 3) return 1;
	if (colorType === 2) return 3;
	if (colorType === 4) return 2;
	return 4;
}

/** Reverses the five PNG scanline filters in place, returning the unfiltered rows. */
function unfilter(raw: Uint8Array, header: PngHeader): Uint8Array {
	const channels: number = channelsFor(header.colorType);
	const bitsPerPixel: number = channels * header.bitDepth;
	const bytesPerPixel: number = Math.max(1, Math.ceil(bitsPerPixel / 8));
	const rowBytes: number = Math.ceil((header.width * bitsPerPixel) / 8);
	const expected: number = (rowBytes + 1) * header.height;
	if (raw.byteLength < expected) throw fail('damaged_image_data', 'PNG scanlines are truncated');
	const output: Uint8Array = new Uint8Array(rowBytes * header.height);
	for (let row: number = 0; row < header.height; row += 1) {
		const filterType: number = raw[row * (rowBytes + 1)];
		const source: number = row * (rowBytes + 1) + 1;
		const target: number = row * rowBytes;
		for (let index: number = 0; index < rowBytes; index += 1) {
			const value: number = raw[source + index];
			const left: number = index >= bytesPerPixel ? output[target + index - bytesPerPixel] : 0;
			const up: number = row > 0 ? output[target - rowBytes + index] : 0;
			const upLeft: number =
				row > 0 && index >= bytesPerPixel ? output[target - rowBytes + index - bytesPerPixel] : 0;
			let restored: number;
			if (filterType === 0) restored = value;
			else if (filterType === 1) restored = value + left;
			else if (filterType === 2) restored = value + up;
			else if (filterType === 3) restored = value + ((left + up) >> 1);
			else if (filterType === 4) restored = value + paeth(left, up, upLeft);
			else throw fail('damaged_image_data', 'PNG scanline filter is invalid');
			output[target + index] = restored & 0xff;
		}
	}
	return output;
}

function paeth(left: number, up: number, upLeft: number): number {
	const estimate: number = left + up - upLeft;
	const distanceLeft: number = Math.abs(estimate - left);
	const distanceUp: number = Math.abs(estimate - up);
	const distanceUpLeft: number = Math.abs(estimate - upLeft);
	if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
	if (distanceUp <= distanceUpLeft) return up;
	return upLeft;
}

function toSamples(
	header: PngHeader,
	scanlines: Uint8Array,
	palette: Uint8Array | null,
	transparency: Uint8Array | null
): DecodedPngImage {
	const { width, height, bitDepth, colorType } = header;
	const channels: number = channelsFor(colorType);
	const rowBytes: number = Math.ceil((width * channels * bitDepth) / 8);
	const pixels: number = width * height;
	const colorSpace: 'gray' | 'rgb' = colorType === 0 || colorType === 4 ? 'gray' : 'rgb';
	const componentsPerPixel: number = colorSpace === 'gray' ? 1 : 3;
	const samples: Uint8Array = new Uint8Array(pixels * componentsPerPixel);
	const alpha: Uint8Array = new Uint8Array(pixels);
	// For color types 0 and 2, tRNS names one fully transparent sample value
	// rather than carrying a channel; a signature exported that way would
	// otherwise composite as an opaque block over the agreement text.
	const colorKey: readonly number[] | null = colorKeyFrom(colorType, transparency);
	let hasTransparency: boolean = false;

	for (let row: number = 0; row < height; row += 1) {
		const reader: BitReader = new BitReader(scanlines, row * rowBytes, bitDepth);
		for (let column: number = 0; column < width; column += 1) {
			const index: number = row * width + column;
			let opacity: number = 255;
			if (colorType === 3) {
				const entry: number = reader.next();
				const offset: number = entry * 3;
				if (palette === null || offset + 2 >= palette.byteLength) {
					throw fail('damaged_image_data', 'PNG palette index is out of range');
				}
				samples[index * 3] = palette[offset];
				samples[index * 3 + 1] = palette[offset + 1];
				samples[index * 3 + 2] = palette[offset + 2];
				if (transparency !== null && entry < transparency.byteLength) {
					opacity = transparency[entry];
				}
			} else if (colorType === 0 || colorType === 4) {
				const gray: number = reader.next();
				samples[index] = scale(gray, bitDepth);
				if (colorType === 4) opacity = scale(reader.next(), bitDepth);
				else if (colorKey !== null && gray === colorKey[0]) opacity = 0;
			} else {
				const red: number = reader.next();
				const green: number = reader.next();
				const blue: number = reader.next();
				samples[index * 3] = scale(red, bitDepth);
				samples[index * 3 + 1] = scale(green, bitDepth);
				samples[index * 3 + 2] = scale(blue, bitDepth);
				if (colorType === 6) opacity = scale(reader.next(), bitDepth);
				else if (
					colorKey !== null &&
					red === colorKey[0] &&
					green === colorKey[1] &&
					blue === colorKey[2]
				) {
					opacity = 0;
				}
			}
			alpha[index] = opacity;
			if (opacity !== 255) hasTransparency = true;
		}
	}

	return { width, height, colorSpace, samples, alpha: hasTransparency ? alpha : null };
}

function colorKeyFrom(
	colorType: number,
	transparency: Uint8Array | null
): readonly number[] | null {
	if (transparency === null) return null;
	if (colorType === 0 && transparency.byteLength >= 2) {
		return [(transparency[0] << 8) | transparency[1]];
	}
	if (colorType === 2 && transparency.byteLength >= 6) {
		return [
			(transparency[0] << 8) | transparency[1],
			(transparency[2] << 8) | transparency[3],
			(transparency[4] << 8) | transparency[5]
		];
	}
	return null;
}

/** Normalizes one sample of any supported depth to the 8 bits PDF image XObjects use. */
function scale(value: number, bitDepth: number): number {
	if (bitDepth === 8) return value & 0xff;
	if (bitDepth === 16) return (value >> 8) & 0xff;
	const maximum: number = (1 << bitDepth) - 1;
	return Math.round((value / maximum) * 255);
}

class BitReader {
	readonly #bytes: Uint8Array;
	readonly #bitDepth: number;
	#byteOffset: number;
	#bitOffset: number = 0;

	constructor(bytes: Uint8Array, byteOffset: number, bitDepth: number) {
		this.#bytes = bytes;
		this.#byteOffset = byteOffset;
		this.#bitDepth = bitDepth;
	}

	next(): number {
		if (this.#bitDepth === 16) {
			const high: number = this.#bytes[this.#byteOffset] ?? 0;
			const low: number = this.#bytes[this.#byteOffset + 1] ?? 0;
			this.#byteOffset += 2;
			return (high << 8) | low;
		}
		if (this.#bitDepth === 8) {
			const value: number = this.#bytes[this.#byteOffset] ?? 0;
			this.#byteOffset += 1;
			return value;
		}
		const byte: number = this.#bytes[this.#byteOffset] ?? 0;
		const shift: number = 8 - this.#bitDepth - this.#bitOffset;
		const mask: number = (1 << this.#bitDepth) - 1;
		const value: number = (byte >> shift) & mask;
		this.#bitOffset += this.#bitDepth;
		if (this.#bitOffset >= 8) {
			this.#bitOffset = 0;
			this.#byteOffset += 1;
		}
		return value;
	}
}

function readUint32(bytes: Uint8Array, offset: number): number {
	return (
		bytes[offset] * 0x1000000 +
		(bytes[offset + 1] << 16) +
		(bytes[offset + 2] << 8) +
		bytes[offset + 3]
	);
}

function latin1(bytes: Uint8Array): string {
	let text: string = '';
	for (let index: number = 0; index < bytes.byteLength; index += 1) {
		text += String.fromCharCode(bytes[index]);
	}
	return text;
}

function fail(reason: PngDecodeReason, message: string): PngDecodeError {
	return new PngDecodeError(reason, message);
}
