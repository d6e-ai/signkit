import { describe, expect, it } from 'vitest';
import {
	decodePng,
	estimatePngDecodeMemory,
	MAX_PNG_DIMENSION,
	MAX_PNG_INFLATE_SCRATCH_BYTES,
	MAX_PNG_PIXELS,
	PngDecodeError,
	type DecodedPngImage,
	type PngDecodeMemoryEstimate
} from './png-image';
import {
	drawnSignaturePng,
	encodeTestPng,
	encodeTestPngWithInflatedScanlines
} from './png-image-test-support';

describe('decodePng', () => {
	it('decodes an 8-bit RGBA signature into RGB samples and a soft mask', () => {
		const image: DecodedPngImage = decodePng(drawnSignaturePng(8, 4));

		expect(image).toMatchObject({ width: 8, height: 4, colorSpace: 'rgb' });
		expect(image.samples.byteLength).toBe(8 * 4 * 3);
		expect(image.alpha).not.toBeNull();
		expect(image.alpha?.byteLength).toBe(8 * 4);
		// The stroke runs corner to corner, so both fully opaque and fully
		// transparent pixels must survive the decode.
		expect(new Set(image.alpha ?? [])).toEqual(new Set([0, 255]));
	});

	it('reports a fully opaque image as having no soft mask', () => {
		const samples: Uint8Array = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		const image: DecodedPngImage = decodePng(
			encodeTestPng({ width: 2, height: 2, colorType: 2, samples })
		);

		expect(image.alpha).toBeNull();
		expect([...image.samples]).toEqual([...samples]);
	});

	it.each([1, 2, 3, 4] as const)('reconstructs scanlines filtered with type %i', (filterType) => {
		const width: number = 4;
		const height: number = 3;
		const samples: Uint8Array = new Uint8Array(width * height * 3);
		for (let index: number = 0; index < samples.byteLength; index += 1) {
			samples[index] = (index * 7 + 11) & 0xff;
		}

		const image: DecodedPngImage = decodePng(
			encodeTestPng({ width, height, colorType: 2, samples, filterType })
		);

		expect([...image.samples]).toEqual([...samples]);
	});

	it('expands a 4-bit palette image with tRNS into RGB plus alpha', () => {
		// Two pixels per byte: indices 0,1 then 1,0.
		const samples: Uint8Array = Uint8Array.from([0x01, 0x10]);
		const palette: Uint8Array = Uint8Array.from([10, 20, 30, 40, 50, 60]);

		const image: DecodedPngImage = decodePng(
			encodeTestPng({
				width: 2,
				height: 2,
				colorType: 3,
				bitDepth: 4,
				samples,
				palette,
				transparency: Uint8Array.from([0, 255])
			})
		);

		expect([...image.samples]).toEqual([10, 20, 30, 40, 50, 60, 40, 50, 60, 10, 20, 30]);
		expect([...(image.alpha ?? [])]).toEqual([0, 255, 255, 0]);
	});

	it('honors a grayscale color key as full transparency', () => {
		const image: DecodedPngImage = decodePng(
			encodeTestPng({
				width: 2,
				height: 1,
				colorType: 0,
				samples: Uint8Array.from([0x00, 0xff]),
				transparency: Uint8Array.from([0x00, 0xff])
			})
		);

		expect(image.colorSpace).toBe('gray');
		expect([...(image.alpha ?? [])]).toEqual([255, 0]);
	});

	it('scales 16-bit samples down to the 8 bits a PDF image XObject carries', () => {
		const image: DecodedPngImage = decodePng(
			encodeTestPng({
				width: 1,
				height: 1,
				colorType: 2,
				bitDepth: 16,
				samples: Uint8Array.from([0xab, 0xcd, 0x12, 0x34, 0xff, 0x00])
			})
		);

		expect([...image.samples]).toEqual([0xab, 0x12, 0xff]);
	});

	it('is a pure function of its input bytes', () => {
		const bytes: Uint8Array = drawnSignaturePng(10, 6);

		expect(decodePng(bytes)).toEqual(decodePng(Uint8Array.from(bytes)));
	});

	it('rejects bytes that are not a PNG', () => {
		expect(() => decodePng(new TextEncoder().encode('%PDF-1.7'))).toThrowError(
			expect.objectContaining({ reason: 'invalid_signature' })
		);
	});

	it('rejects an interlaced image rather than mis-rendering it', () => {
		const bytes: Uint8Array = encodeTestPng({
			width: 2,
			height: 1,
			colorType: 2,
			samples: new Uint8Array(6),
			interlace: 1
		});

		expect(() => decodePng(bytes)).toThrowError(expect.objectContaining({ reason: 'interlaced' }));
	});

	it('rejects an image past the dimension bound', () => {
		const bytes: Uint8Array = encodeTestPng({
			width: MAX_PNG_DIMENSION + 1,
			height: 1,
			colorType: 2,
			samples: new Uint8Array(3)
		});

		expect(() => decodePng(bytes)).toThrowError(expect.objectContaining({ reason: 'oversized' }));
	});

	it('rejects truncated image data instead of padding it', () => {
		const bytes: Uint8Array = encodeTestPng({
			width: 4,
			height: 4,
			colorType: 2,
			samples: new Uint8Array(4 * 4 * 3)
		});
		const truncated: Uint8Array = bytes.subarray(0, bytes.byteLength - 30);

		expect(() => decodePng(truncated)).toThrowError(PngDecodeError);
	});

	it('bounds zlib output to the exact IHDR-derived scanline size before inflation', () => {
		const bytes: Uint8Array = encodeTestPngWithInflatedScanlines(
			{ width: 1, height: 1, colorType: 6, samples: new Uint8Array(4) },
			new Uint8Array(1024 * 1024)
		);

		expect(() => decodePng(bytes)).toThrowError(
			expect.objectContaining({ reason: 'damaged_image_data' })
		);
	});

	it('rejects a decode before buffer allocation when the caller working-set budget is too small', () => {
		const bytes: Uint8Array = drawnSignaturePng(8, 4);
		const estimate: PngDecodeMemoryEstimate = estimatePngDecodeMemory(bytes);

		expect(() =>
			decodePng(bytes, { maximumWorkingBytes: estimate.peakWorkingBytes - 1 })
		).toThrowError(expect.objectContaining({ reason: 'decoded_budget_exceeded' }));
		expect(
			decodePng(bytes, { maximumWorkingBytes: estimate.peakWorkingBytes }).samples.byteLength
		).toBe(96);
	});

	it('estimates maximum-dimension 16-bit RGBA buffers from headers without allocating them', () => {
		const width: number = MAX_PNG_DIMENSION;
		const height: number = Math.floor(MAX_PNG_PIXELS / width);
		const bytes: Uint8Array = encodeTestPngWithInflatedScanlines(
			{ width, height, colorType: 6, bitDepth: 16, samples: new Uint8Array(0) },
			Uint8Array.of(0)
		);
		const estimate: PngDecodeMemoryEstimate = estimatePngDecodeMemory(bytes);
		const pixels: number = width * height;
		const rowBytes: number = width * 8;

		expect(estimate.inflatedBytes).toBe((rowBytes + 1) * height + 1);
		expect(estimate.inflateScratchBytes).toBe(MAX_PNG_INFLATE_SCRATCH_BYTES);
		expect(estimate.unfilteredBytes).toBe(rowBytes * height);
		expect(estimate.sampleBytes).toBe(pixels * 3);
		expect(estimate.alphaBytes).toBe(pixels);
		expect(estimate.retainedBytes).toBe(pixels * 4);
		expect(estimate.peakWorkingBytes).toBe(
			estimate.compressedCopyBytes +
				estimate.inflatedBytes +
				estimate.inflateScratchBytes +
				estimate.unfilteredBytes +
				estimate.sampleBytes +
				estimate.alphaBytes
		);
		expect(estimate.peakWorkingBytes).toBeGreaterThan(64 * 1024 * 1024);
	});
});
