import { describe, expect, it } from 'vitest';
import {
	createUuidV7Generator,
	InvalidUuidV7ClockError,
	InvalidUuidV7EntropyError,
	isUuidV7,
	MAX_UUID_V7_TIMESTAMP_MS,
	newUuidV7,
	UUID_V7_PATTERN,
	uuidV7TimestampMs,
	type UuidV7Generator
} from './uuid-v7';

function fixedEntropy(byte: number): () => Uint8Array {
	return (): Uint8Array => new Uint8Array(16).fill(byte);
}

function steppingClock(values: readonly number[]): () => number {
	const remaining: number[] = [...values];
	let last: number = values[0];
	return (): number => {
		last = remaining.shift() ?? last;
		return last;
	};
}

describe('UUIDv7 identifiers', () => {
	it('encodes the RFC 9562 version, variant, and millisecond timestamp', () => {
		const generator: UuidV7Generator = createUuidV7Generator({
			now: (): number => 1_764_547_200_123,
			randomBytes: fixedEntropy(0xab)
		});

		const id: string = generator();

		expect(id).toMatch(UUID_V7_PATTERN);
		expect(id).toBe(id.toLowerCase());
		expect(id[14]).toBe('7');
		expect(['8', '9', 'a', 'b']).toContain(id[19]);
		expect(uuidV7TimestampMs(id)).toBe(1_764_547_200_123);
		// Golden encoding: 0x019ad735847b is the 48-bit timestamp, `7` the
		// version nibble, `a` a variant-compliant `10xx` nibble.
		expect(id).toBe('019ad735-847b-72ba-aeae-afababababab');
	});

	it('keeps the same-millisecond sequence lexically ordered', () => {
		const generator: UuidV7Generator = createUuidV7Generator({
			now: (): number => 1_764_547_200_000,
			randomBytes: fixedEntropy(0x10)
		});

		const ids: readonly string[] = Array.from({ length: 50 }, (): string => generator());

		expect(new Set(ids).size).toBe(ids.length);
		expect([...ids].sort()).toStrictEqual(ids);
		for (const id of ids) {
			expect(uuidV7TimestampMs(id)).toBe(1_764_547_200_000);
			expect(isUuidV7(id)).toBe(true);
		}
	});

	it('never emits an identifier that sorts before an earlier one after a clock rollback', () => {
		const generator: UuidV7Generator = createUuidV7Generator({
			now: steppingClock([2_000_000_000_000, 1_000_000_000_000, 1_000_000_000_001]),
			randomBytes: fixedEntropy(0x20)
		});

		const first: string = generator();
		const rolledBack: string = generator();
		const stillBehind: string = generator();

		expect(uuidV7TimestampMs(first)).toBe(2_000_000_000_000);
		expect(uuidV7TimestampMs(rolledBack)).toBe(2_000_000_000_000);
		expect(uuidV7TimestampMs(stillBehind)).toBe(2_000_000_000_000);
		expect(rolledBack > first).toBe(true);
		expect(stillBehind > rolledBack).toBe(true);
	});

	it('advances to a later timestamp once the clock catches up', () => {
		const generator: UuidV7Generator = createUuidV7Generator({
			now: steppingClock([1_700_000_000_000, 1_699_000_000_000, 1_700_000_000_001]),
			randomBytes: fixedEntropy(0x30)
		});

		const ids: readonly string[] = [generator(), generator(), generator()];

		expect(ids.map(uuidV7TimestampMs)).toStrictEqual([
			1_700_000_000_000, 1_700_000_000_000, 1_700_000_000_001
		]);
		expect([...ids].sort()).toStrictEqual(ids);
	});

	it('borrows the next millisecond when the same-millisecond sequence is exhausted', () => {
		const exhausted: () => Uint8Array = (): Uint8Array => {
			const bytes: Uint8Array = new Uint8Array(16);
			bytes[6] = 0x7f;
			bytes[7] = 0xff;
			bytes[8] = 0xff;
			bytes[9] = 0xff;
			return bytes;
		};
		const generator: UuidV7Generator = createUuidV7Generator({
			now: (): number => 1_700_000_000_000,
			randomBytes: exhausted
		});

		const first: string = generator();
		const borrowed: string = generator();

		expect(uuidV7TimestampMs(first)).toBe(1_700_000_000_000);
		expect(uuidV7TimestampMs(borrowed)).toBe(1_700_000_000_001);
		expect(borrowed > first).toBe(true);
	});

	it('produces unique canonical identifiers from real entropy', () => {
		const ids: Set<string> = new Set<string>();
		for (let index: number = 0; index < 5_000; index += 1) {
			const id: string = newUuidV7();
			expect(isUuidV7(id)).toBe(true);
			ids.add(id);
		}

		expect(ids.size).toBe(5_000);
	});

	it('keeps independent generators independent', () => {
		const options = { now: (): number => 1_700_000_000_000, randomBytes: fixedEntropy(0x44) };

		expect(createUuidV7Generator(options)()).toBe(createUuidV7Generator(options)());
	});

	it('rejects a clock outside the 48-bit millisecond range', () => {
		for (const clock of [Number.NaN, -1, 1.5, MAX_UUID_V7_TIMESTAMP_MS + 1, Infinity]) {
			const generator: UuidV7Generator = createUuidV7Generator({
				now: (): number => clock,
				randomBytes: fixedEntropy(0x55)
			});

			expect(generator).toThrow(InvalidUuidV7ClockError);
		}
	});

	it('rejects an entropy source that does not return 16 bytes', () => {
		const generator: UuidV7Generator = createUuidV7Generator({
			now: (): number => 1_700_000_000_000,
			randomBytes: (): Uint8Array => new Uint8Array(8)
		});

		expect(generator).toThrow(InvalidUuidV7EntropyError);
	});

	it('rejects non-UUIDv7 values, including other UUID versions and uppercase text', () => {
		expect(isUuidV7('01900000-0000-7000-8000-000000000001')).toBe(true);
		expect(isUuidV7('01900000-0000-4000-8000-000000000001')).toBe(false);
		expect(isUuidV7('01900000-0000-8000-a000-000000000001')).toBe(false);
		expect(isUuidV7('01900000-0000-7000-c000-000000000001')).toBe(false);
		expect(isUuidV7('01900000-0000-7000-8000-00000000000G')).toBe(false);
		expect(isUuidV7('019ac1a7-b07b-7abc-8def-0123456789ab')).toBe(true);
		expect(isUuidV7('019ac1a7-b07b-7abc-8def-0123456789ab'.toUpperCase())).toBe(false);
		expect(isUuidV7('')).toBe(false);
		expect((): number => uuidV7TimestampMs('not-a-uuid')).toThrow(TypeError);
	});
});
