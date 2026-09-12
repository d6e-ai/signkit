import { describe, expect, it } from 'vitest';
import {
	base64UrlEncode,
	createOpaqueTokenGenerator,
	InsecureEntropyError,
	isOpaqueToken,
	newOpaqueToken,
	OPAQUE_TOKEN_BYTES,
	OPAQUE_TOKEN_PATTERN,
	randomTokenBytes,
	type OpaqueTokenGenerator
} from './opaque-token';

describe('opaque security tokens', () => {
	it('encodes 32 random bytes as canonical unpadded base64url', () => {
		const token: string = newOpaqueToken();

		expect(token).toMatch(OPAQUE_TOKEN_PATTERN);
		expect(token).toHaveLength(43);
		expect(token).not.toContain('=');
		expect(token).not.toContain('+');
		expect(token).not.toContain('/');
		expect(isOpaqueToken(token)).toBe(true);
	});

	it('is not a UUID of any version', () => {
		const token: string = newOpaqueToken();

		expect(token).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	});

	it('produces distinct tokens from real entropy', () => {
		const tokens: Set<string> = new Set<string>();
		for (let index: number = 0; index < 2_000; index += 1) {
			tokens.add(newOpaqueToken());
		}

		expect(tokens.size).toBe(2_000);
	});

	it('uses an injected entropy source verbatim', () => {
		const generator: OpaqueTokenGenerator = createOpaqueTokenGenerator({
			randomBytes: (byteLength: number): Uint8Array =>
				Uint8Array.from({ length: byteLength }, (_value: unknown, index: number): number => index)
		});

		const token: string = generator();

		expect(token).toBe(
			base64UrlEncode(
				Uint8Array.from(
					{ length: OPAQUE_TOKEN_BYTES },
					(_v: unknown, index: number): number => index
				)
			)
		);
		expect(token).toMatch(OPAQUE_TOKEN_PATTERN);
	});

	it('supports a larger token size for protocols that need one', () => {
		const generator: OpaqueTokenGenerator = createOpaqueTokenGenerator({ byteLength: 64 });

		expect(generator()).toMatch(/^[A-Za-z0-9_-]{86}$/);
	});

	it('refuses to mint below 32 bytes', () => {
		expect((): OpaqueTokenGenerator => createOpaqueTokenGenerator({ byteLength: 16 })).toThrow(
			InsecureEntropyError
		);
		expect((): Uint8Array => randomTokenBytes(8)).toThrow(InsecureEntropyError);
		expect((): Uint8Array => randomTokenBytes(32.5)).toThrow(InsecureEntropyError);
	});

	it('fails explicitly when an entropy source returns the wrong number of bytes', () => {
		const truncated: OpaqueTokenGenerator = createOpaqueTokenGenerator({
			randomBytes: (): Uint8Array => new Uint8Array(8)
		});

		expect(truncated).toThrow(InsecureEntropyError);
	});

	it('fails explicitly when the runtime has no cryptographic random source', () => {
		const original: Crypto = globalThis.crypto;
		try {
			Object.defineProperty(globalThis, 'crypto', {
				configurable: true,
				value: { subtle: original.subtle }
			});

			expect((): Uint8Array => randomTokenBytes()).toThrow(InsecureEntropyError);
			expect((): string => createOpaqueTokenGenerator()()).toThrow(
				/no cryptographic random source/
			);
		} finally {
			Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original });
		}
	});

	it('rejects values outside the canonical alphabet and length', () => {
		expect(isOpaqueToken('a'.repeat(43))).toBe(true);
		expect(isOpaqueToken('a'.repeat(42))).toBe(false);
		expect(isOpaqueToken(`${'a'.repeat(42)}+`)).toBe(false);
		expect(isOpaqueToken(`${'a'.repeat(42)}=`)).toBe(false);
		expect(isOpaqueToken('01900000-0000-7000-8000-000000000001')).toBe(false);
		expect(isOpaqueToken('')).toBe(false);
	});
});
